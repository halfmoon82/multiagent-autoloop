import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewClaims, parseClaims, claimMarker } from '../src/review-claim.mjs';

// 假 gh：内存里维护 PR 的 head 与评论列表，按调用顺序给评论打服务器时间。
function fakeGh({ head = 'aaa1111', comments = [], clock = { t: Date.parse('2026-11-19T03:00:00Z') } } = {}) {
  const state = { head, comments: [...comments], merged: null, calls: [] };
  const runner = async (cmd, args) => {
    state.calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      return { stdout: JSON.stringify({ headRefOid: state.head, state: state.merged ? 'MERGED' : 'OPEN', comments: state.comments }) };
    }
    if (args[0] === 'pr' && args[1] === 'comment') {
      clock.t += 1000;
      state.comments.push({ body: args[args.indexOf('--body') + 1], createdAt: new Date(clock.t).toISOString() });
      return { stdout: '' };
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const match = args[args.indexOf('--match-head-commit') + 1];
      if (match !== state.head) throw new Error('head moved');
      state.merged = { args };
      return { stdout: '' };
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { state, runner, clock };
}
const at = iso => ({ now: () => Date.parse(iso) });

test('无人占位时 claim 成功并记录审阅时的 head', async () => {
  const gh = fakeGh();
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:05Z') });
  const result = await claims.claim({ pr: '116', holder: 'codex-a' });
  assert.equal(result.ok, true);
  assert.equal(result.head, 'aaa1111');
  assert.equal(parseClaims(gh.state.comments, Date.parse('2026-11-19T03:00:05Z')).active.holder, 'codex-a');
});

test('他人占位有效期内 claim 失败，不发评论、不合并', async () => {
  const gh = fakeGh({ comments: [{ body: claimMarker({ holder: 'claude-b', head: 'aaa1111', state: 'active' }), createdAt: '2026-11-19T02:50:00Z' }] });
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:00Z') });
  const result = await claims.claim({ pr: '116', holder: 'codex-a' });
  assert.deepEqual([result.ok, result.reason, result.holder], [false, 'held', 'claude-b']);
  assert.equal(gh.state.comments.length, 1);
});

test('同时抢占：以服务器时间先到者为准，后到者回读后判输', async () => {
  const gh = fakeGh();
  // 两方都先读到“空闲”，再各自发评论：模拟竞态。
  const claimsA = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:10Z') });
  const claimsB = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:10Z') });
  const [a, b] = await Promise.all([claimsA.claim({ pr: '116', holder: 'codex-a' }), claimsB.claim({ pr: '116', holder: 'claude-b' })]);
  const winners = [a, b].filter(r => r.ok);
  assert.equal(winners.length, 1, '只能有一方拿到占位');
  const loser = [a, b].find(r => !r.ok);
  assert.equal(loser.reason, 'held');
});

test('占位超过有效期视为放弃，他人可接手', async () => {
  const gh = fakeGh({ comments: [{ body: claimMarker({ holder: 'claude-b', head: 'aaa1111', state: 'active' }), createdAt: '2026-11-18T20:00:00Z' }] });
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:00Z'), ttlMs: 3 * 3600_000 });
  assert.equal((await claims.claim({ pr: '116', holder: 'codex-a' })).ok, true);
});

test('release 后他人可占位；非持有者的 release 不生效', async () => {
  const gh = fakeGh();
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:30Z') });
  await claims.claim({ pr: '116', holder: 'codex-a' });
  await claims.release({ pr: '116', holder: 'claude-b' });
  assert.equal((await claims.claim({ pr: '116', holder: 'claude-b' })).ok, false, '别人的 release 不能解开 codex-a 的占位');
  await claims.release({ pr: '116', holder: 'codex-a' });
  assert.equal((await claims.claim({ pr: '116', holder: 'claude-b' })).ok, true);
});

test('merge 必须持有占位：未占位拒绝合并', async () => {
  const gh = fakeGh({ comments: [{ body: claimMarker({ holder: 'codex-a', head: 'aaa1111', state: 'active' }), createdAt: '2026-11-19T02:59:00Z' }] });
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:00Z') });
  const result = await claims.merge({ pr: '116', holder: 'claude-b', head: 'aaa1111' });
  assert.deepEqual([result.ok, result.reason, result.holder], [false, 'not-holder', 'codex-a']);
  assert.equal(gh.state.merged, null);
});

test('merge 时 head 已变（审完后又有新提交）拒绝合并', async () => {
  const gh = fakeGh();
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:30Z') });
  await claims.claim({ pr: '116', holder: 'codex-a' });
  gh.state.head = 'bbb2222';
  const result = await claims.merge({ pr: '116', holder: 'codex-a', head: 'aaa1111' });
  assert.deepEqual([result.ok, result.reason], [false, 'head-moved']);
  assert.equal(gh.state.merged, null);
});

test('持有者 merge：按审过的 head squash 合并并释放占位', async () => {
  const gh = fakeGh();
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:30Z') });
  await claims.claim({ pr: '116', holder: 'codex-a' });
  const result = await claims.merge({ pr: '116', holder: 'codex-a', head: 'aaa1111', deleteBranch: true });
  assert.equal(result.ok, true);
  const args = gh.state.merged.args;
  assert.ok(args.includes('--squash') && args.includes('--delete-branch'));
  assert.equal(args[args.indexOf('--match-head-commit') + 1], 'aaa1111');
  assert.equal(parseClaims(gh.state.comments, Date.parse('2026-11-19T03:01:00Z')).active, null);
});

test('同一持有者重复 claim 视为续期，不被自己挡住', async () => {
  const gh = fakeGh();
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:30Z') });
  assert.equal((await claims.claim({ pr: '116', holder: 'codex-a' })).ok, true);
  assert.equal((await claims.claim({ pr: '116', holder: 'codex-a' })).ok, true);
});

test('非法输入：PR 号、持有者、repo 格式不合法直接报错，不调用 gh', async () => {
  const gh = fakeGh();
  const claims = createReviewClaims({ runner: gh.runner });
  await assert.rejects(claims.claim({ pr: '116; rm -rf /', holder: 'a' }));
  await assert.rejects(claims.claim({ pr: '116', holder: 'a b' }));
  await assert.rejects(claims.claim({ pr: '116', holder: 'a', repo: 'not a repo' }));
  assert.equal(gh.state.calls.length, 0);
});

test('伪造的普通评论文字不会被当成占位', () => {
  const comments = [{ body: 'review-claim holder=evil', createdAt: '2026-11-19T02:59:00Z' }];
  assert.equal(parseClaims(comments, Date.parse('2026-11-19T03:00:00Z')).active, null);
});

test('CLI：被他人占位时退出码 3，参数错误退出码 1', async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(path.join(tmpdir(), 'review-claim-'));
  const body = JSON.stringify(claimMarker({ holder: 'claude-b', head: 'aaa1111', state: 'active' }));
  const view = JSON.stringify({ headRefOid: 'aaa1111', state: 'OPEN', comments: [{ body: JSON.parse(body), createdAt: new Date().toISOString() }] });
  writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\n[ "$2" = view ] && cat <<'JSON'\n${view}\nJSON\nexit 0\n`);
  chmodSync(path.join(dir, 'gh'), 0o755);
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../scripts/review-claim.mjs', import.meta.url));
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const held = spawnSync(process.execPath, [script, 'claim', '--pr', '116', '--holder', 'codex-a'], { env, encoding: 'utf8' });
  assert.equal(held.status, 3, held.stderr);
  assert.equal(JSON.parse(held.stdout).holder, 'claude-b');
  const bad = spawnSync(process.execPath, [script, 'claim', '--pr', 'x', '--holder', 'codex-a'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('文档示例的持有者标识都能通过校验，含中文的标识被拒', async () => {
  const gh = fakeGh();
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:30Z') });
  for (const holder of ['codex-9f94e800', 'claude-8932a769', 'hub-pr-review-7712']) {
    assert.equal((await createReviewClaims({ runner: fakeGh().runner, ...at('2026-11-19T03:00:30Z') }).claim({ pr: '1', holder })).ok, true, holder);
  }
  await assert.rejects(claims.claim({ pr: '1', holder: 'hub-PR独立审阅' }));
});

test('旧占位过期后同一持有者再占，不能带着过期前的开始时间插队', () => {
  const t = iso => ({ createdAt: iso });
  const comments = [
    { body: claimMarker({ holder: 'codex-a', head: 'aaa1111', state: 'active' }), ...t('2026-11-19T00:00:00Z') },
    { body: claimMarker({ holder: 'claude-b', head: 'aaa1111', state: 'active' }), ...t('2026-11-19T04:00:01Z') },
    { body: claimMarker({ holder: 'codex-a', head: 'aaa1111', state: 'active' }), ...t('2026-11-19T04:00:02Z') },
  ];
  assert.equal(parseClaims(comments, Date.parse('2026-11-19T04:00:05Z')).active.holder, 'claude-b');
});

test('抢输后仍在排队的记录可由本人 release 清掉', async () => {
  const gh = fakeGh({ comments: [
    { body: claimMarker({ holder: 'claude-b', head: 'aaa1111', state: 'active' }), createdAt: '2026-11-19T02:59:00Z' },
    { body: claimMarker({ holder: 'codex-a', head: 'aaa1111', state: 'active' }), createdAt: '2026-11-19T02:59:30Z' },
  ] });
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:00Z') });
  assert.equal((await claims.release({ pr: '116', holder: 'codex-a' })).ok, true);
  assert.equal(parseClaims(gh.state.comments, Date.parse('2026-11-19T03:00:30Z')).live.some(h => h.holder === 'codex-a'), false);
});

test('合并报错但 PR 已被他人按别的提交合并：不报成功', async () => {
  const gh = fakeGh();
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:30Z') });
  await claims.claim({ pr: '116', holder: 'codex-a' });
  const original = gh.runner;
  const runner = async (cmd, args) => {
    if (args[1] === 'merge') { gh.state.head = 'ccc3333'; gh.state.merged = { args }; throw new Error('already merged'); }
    return original(cmd, args);
  };
  const result = await createReviewClaims({ runner, ...at('2026-11-19T03:00:40Z') }).merge({ pr: '116', holder: 'codex-a', head: 'aaa1111' });
  assert.deepEqual([result.ok, result.reason], [false, 'merged-by-other']);
});

test('合并成功但释放评论失败：仍报合并成功并带 warning', async () => {
  const gh = fakeGh();
  const claims = createReviewClaims({ runner: gh.runner, ...at('2026-11-19T03:00:30Z') });
  await claims.claim({ pr: '116', holder: 'codex-a' });
  const original = gh.runner;
  const runner = async (cmd, args) => {
    if (args[1] === 'comment') throw new Error('network down');
    return original(cmd, args);
  };
  const result = await createReviewClaims({ runner, ...at('2026-11-19T03:00:40Z') }).merge({ pr: '116', holder: 'codex-a', head: 'aaa1111' });
  assert.equal(result.ok, true);
  assert.match(result.warning, /释放占位评论失败/);
});
