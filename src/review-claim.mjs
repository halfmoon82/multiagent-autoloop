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

// DAG 节点审阅占位的持有者标识：DAG自动审阅规则按此占位，控制器合并时只认这一个标识（跨模块约定，只在这里定义）。
export const dagReviewHolder = nodeId => `hub-dag-${String(nodeId)}`;

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
      // 旧占位已过期再续上时重新计起点，不能把过期前的开始时间带回来插队。
      holders.set(row.holder, { holder: row.holder, head: row.head, since: prev && row.at - prev.last < ttlMs ? prev.since : row.at, last: row.at });
    } else holders.delete(row.holder);
  }
  const live = [...holders.values()].filter(h => now - h.last < ttlMs).sort((a, b) => a.since - b.since);
  return { active: live[0] || null, live };
}

// CI 门：任一检查未跑完 → pending；任一失败/取消/超时 → failed；全部成功/跳过/中性或没有检查 → null（放行）。
const OK = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
export function checksVerdict(rollup) {
  let pending = false;
  for (const c of rollup || []) {
    const done = c.status ? c.status === 'COMPLETED' : !['PENDING', 'EXPECTED'].includes(c.state);
    const result = c.status ? c.conclusion : c.state;
    if (!done) pending = true;
    else if (!OK.has(String(result || '').toUpperCase())) return 'checks-failed';
  }
  return pending ? 'checks-pending' : null;
}

export function createReviewClaims({ runner = defaultRunner, gh = 'gh', now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const target = ({ pr, repo }) => {
    const args = [check(PR, pr, 'PR 号')];
    if (repo != null && repo !== '') args.push('-R', check(REPO, repo, '仓库'));
    return args;
  };
  const view = async input => {
    const { stdout } = await runner(gh, ['pr', 'view', ...target(input), '--json', 'headRefOid,state,comments,statusCheckRollup']);
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
    // 自己名下有有效记录就释放（包括抢输后撤回失败、仍在排队的记录），不要求是当前持有者。
    const mine = parseClaims((await view(input)).comments, now(), ttlMs).live.find(h => h.holder === holder);
    if (!mine) return { ok: false, reason: 'not-holder' };
    await comment(input, claimMarker({ holder, head: mine.head, state: 'released' }));
    return { ok: true };
  }

  async function merge(input) {
    const holder = check(HOLDER, input.holder, '持有者');
    const head = check(SHA, input.head, '审过的提交');
    const pr = await view(input);
    const current = parseClaims(pr.comments, now(), ttlMs).active;
    if (!current || current.holder !== holder) return { ok: false, reason: 'not-holder', holder: current?.holder ?? null };
    if (!String(pr.headRefOid || '').startsWith(head)) return { ok: false, reason: 'head-moved', head: pr.headRefOid };
    const checks = checksVerdict(pr.statusCheckRollup);
    if (checks) return { ok: false, reason: checks };
    const args = ['pr', 'merge', ...target(input), '--squash', '--match-head-commit', pr.headRefOid];
    if (input.deleteBranch) args.push('--delete-branch');
    let warning;
    try { await runner(gh, args); } catch (error) {
      // gh 合并成功但本地删分支失败（分支挂在 worktree 上）时也会报错：以 PR 实际状态为准。
      const after = await view(input);
      if (after.state !== 'MERGED') throw error;
      // 已合并但合进去的不是审过的提交：可能是别人绕过占位合并的，不能报成功。
      if (after.headRefOid !== pr.headRefOid) return { ok: false, reason: 'merged-by-other', head: after.headRefOid };
      warning = String(error.message || error).split('\n')[0];
    }
    try { await comment(input, claimMarker({ holder, head: pr.headRefOid, state: 'released' })); }
    catch (error) { warning = [warning, `合并已完成，但释放占位评论失败：${String(error.message || error).split('\n')[0]}`].filter(Boolean).join('；'); }
    return { ok: true, head: pr.headRefOid, ...(warning ? { warning } : {}) };
  }

  return { claim, release, merge };
}
