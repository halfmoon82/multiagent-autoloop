// PR 审阅占位：同一 PR 同一时间只允许一个审阅方审阅并合并。
// 占位记录写在 GitHub PR 评论里（机器可读的 HTML 注释），Codex / Claude / Hub 规则都能看到，不依赖单机状态。
// 判定以 GitHub 服务器给评论打的时间为准：同时抢占时最早的有效占位获胜，后到者回读后撤回。
// 合并只能由占位持有者发起，并用 --match-head-commit 锁定审过的提交，审完后又有新提交则拒绝合并。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultRunner = (command, args, options = {}) => execFileAsync(command, args, options);
const PR = /^[1-9][0-9]{0,6}$/;
const HOLDER = /^[A-Za-z0-9._:-]{1,64}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{7,40}$/;
const MARK = /<!-- review-claim:v1 (\{[^\n]*?\}) -->/;
export const DEFAULT_TTL_MS = 3 * 3600_000;

const check = (re, value, label) => {
  const text = String(value ?? '').trim();
  if (!re.test(text)) throw new Error(`${label}格式无效：${text}`);
  return text;
};

export function claimMarker({ holder, head, state }) {
  return `<!-- review-claim:v1 ${JSON.stringify({ holder, head, state })} -->\n审阅占位：${state === 'active' ? `${holder} 正在审阅（head ${head}）` : `${holder} 已释放`}`;
}

// 按服务器时间重放占位评论，得出当前有效持有者（最早开始且未过期、未释放的那一方）。
export function parseClaims(comments, now, ttlMs = DEFAULT_TTL_MS) {
  const holders = new Map();
  const rows = (comments || [])
    .map(c => { const m = MARK.exec(c.body || ''); if (!m) return null; try { return { ...JSON.parse(m[1]), at: Date.parse(c.createdAt) }; } catch { return null; } })
    .filter(r => r && HOLDER.test(r.holder || '') && Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);
  for (const row of rows) {
    if (row.state === 'active') {
      const prev = holders.get(row.holder);
      holders.set(row.holder, { holder: row.holder, head: row.head, since: prev ? prev.since : row.at, last: row.at });
    } else holders.delete(row.holder);
  }
  const live = [...holders.values()].filter(h => now - h.last < ttlMs).sort((a, b) => a.since - b.since);
  return { active: live[0] || null };
}

export function createReviewClaims({ runner = defaultRunner, gh = 'gh', now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const target = ({ pr, repo }) => {
    const args = [check(PR, pr, 'PR 号')];
    if (repo != null && repo !== '') args.push('-R', check(REPO, repo, '仓库'));
    return args;
  };
  const view = async input => {
    const { stdout } = await runner(gh, ['pr', 'view', ...target(input), '--json', 'headRefOid,state,comments']);
    return JSON.parse(String(stdout || '{}'));
  };
  const comment = (input, body) => runner(gh, ['pr', 'comment', ...target(input), '--body', body]);

  async function claim(input) {
    const holder = check(HOLDER, input.holder, '持有者');
    target(input);
    const before = await view(input);
    if (before.state && before.state !== 'OPEN') return { ok: false, reason: 'not-open', state: before.state };
    const current = parseClaims(before.comments, now(), ttlMs).active;
    if (current && current.holder !== holder) return { ok: false, reason: 'held', holder: current.holder };
    await comment(input, claimMarker({ holder, head: before.headRefOid, state: 'active' }));
    const after = await view(input);
    const winner = parseClaims(after.comments, now(), ttlMs).active;
    if (winner && winner.holder !== holder) {
      await comment(input, claimMarker({ holder, head: before.headRefOid, state: 'released' }));
      return { ok: false, reason: 'held', holder: winner.holder };
    }
    return { ok: true, holder, head: after.headRefOid };
  }

  async function release(input) {
    const holder = check(HOLDER, input.holder, '持有者');
    const current = parseClaims((await view(input)).comments, now(), ttlMs).active;
    if (!current || current.holder !== holder) return { ok: false, reason: 'not-holder', holder: current?.holder ?? null };
    await comment(input, claimMarker({ holder, head: current.head, state: 'released' }));
    return { ok: true };
  }

  async function merge(input) {
    const holder = check(HOLDER, input.holder, '持有者');
    const head = check(SHA, input.head, '审过的提交');
    const pr = await view(input);
    const current = parseClaims(pr.comments, now(), ttlMs).active;
    if (!current || current.holder !== holder) return { ok: false, reason: 'not-holder', holder: current?.holder ?? null };
    if (!String(pr.headRefOid || '').startsWith(head)) return { ok: false, reason: 'head-moved', head: pr.headRefOid };
    const args = ['pr', 'merge', ...target(input), '--squash', '--match-head-commit', pr.headRefOid];
    if (input.deleteBranch) args.push('--delete-branch');
    let warning;
    try { await runner(gh, args); } catch (error) {
      // gh 合并成功但本地删分支失败（分支挂在 worktree 上）时也会报错：以 PR 实际状态为准。
      if ((await view(input)).state !== 'MERGED') throw error;
      warning = String(error.message || error).split('\n')[0];
    }
    await comment(input, claimMarker({ holder, head: pr.headRefOid, state: 'released' }));
    return { ok: true, head: pr.headRefOid, ...(warning ? { warning } : {}) };
  }

  return { claim, release, merge };
}
