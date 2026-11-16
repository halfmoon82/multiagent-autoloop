// 设计会话 publish：product-spec 确认后在目标项目独立分支提交 PRD 并开 PR。
// git 走真实临时仓 + 本地裸 origin；gh 与 vibe 走注入/假 CLI，CI 不联网、不调真实模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishProductSpec, buildPublishSnapshot, PUBLISH_ACTIONS } from '../src/design-publish.mjs';
import { extractProductSpec, VIBE_MAJOR_VERSION } from '../src/vibe-adapter.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vibe-5.2.7');
const fakeVibe = path.join(fixtureDir, 'bin', 'vibe');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const SPEC = { title: '账单导出', goals: ['导出 CSV'], decisions: [] };
const TRANSCRIPT = `设计完成。\n\n\`\`\`product-spec\n${JSON.stringify(SPEC)}\n\`\`\`\n`;
const DIGEST = extractProductSpec(TRANSCRIPT).specDigest;

function makeProject({ attested = true } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'design-publish-'));
  const origin = path.join(base, 'origin.git');
  const root = path.join(base, 'project');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  writeFileSync(path.join(root, 'README.md'), 'hello\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-u', 'origin', 'main');
  mkdirSync(path.join(root, '.vibe', 'plans', 'demo-plan'), { recursive: true });
  writeFileSync(path.join(root, '.vibe', '.keep'), '');
  const state = { version: 1, capabilities: attested ? {
    adapter: 'codex', attested_at: new Date().toISOString(), host_major_version: VIBE_MAJOR_VERSION,
    dispatch: 'visible', attest_command: 'vibe attest',
  } : undefined };
  writeFileSync(path.join(root, '.vibe', 'state.json'), JSON.stringify(state));
  // .vibe 属于规划产物，不进入提交
  writeFileSync(path.join(root, '.git', 'info', 'exclude'), '.vibe/\n');
  // 模拟 vibe plan 产物（假 CLI 只回 JSON，不落盘）
  cpSync(path.join(fixtureDir, 'plan.json'), path.join(root, '.vibe', 'plans', 'demo-plan', 'plan.json'));
  cpSync(path.join(fixtureDir, 'nodes.json'), path.join(root, '.vibe', 'plans', 'demo-plan', 'nodes.json'));
  return { root, origin };
}

function makeRunner({ existingPr = null, failGh = false } = {}) {
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    if (command === 'git') return { stdout: execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8', env: options.env }) };
    if (command === 'gh') {
      if (failGh) throw new Error('gh boom');
      if (args[0] === 'pr' && args[1] === 'list') return { stdout: JSON.stringify(existingPr ? [existingPr] : []) };
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: 'https://github.com/owner/repo/pull/7\n' };
    }
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  return { runner, calls };
}

const base = (root, runner, extra = {}) => ({
  projectRoot: root, planId: 'demo-plan', transcript: TRANSCRIPT, specDigest: DIGEST, confirm: true,
  runner, vibeCommand: fakeVibe, ...extra,
});

test('publish snapshot is server-built, whitelisted, and refuses deploy/release/credential/external actions', () => {
  const snap = buildPublishSnapshot({ planId: 'demo-plan', baseBranch: 'main' });
  assert.deepEqual(snap.actions, PUBLISH_ACTIONS);
  assert.deepEqual([...PUBLISH_ACTIONS], ['push-branch', 'create-pr']);
  assert.equal(snap.branch, 'docs/demo-plan');
  assert.throws(() => buildPublishSnapshot({ planId: 'demo-plan', baseBranch: 'main', actions: ['push-branch', 'deploy'] }), /禁止/);
  assert.throws(() => buildPublishSnapshot({ planId: 'demo-plan', baseBranch: 'main', actions: ['merge'] }), /授权/);
  assert.throws(() => buildPublishSnapshot({ planId: '../x', baseBranch: 'main' }), /planId/);
  assert.throws(() => buildPublishSnapshot({ planId: 'demo-plan', baseBranch: 'docs/demo-plan' }), /基线/);
});

test('publish requires confirm=true and a matching specDigest before touching anything', async () => {
  const { root } = makeProject();
  const { runner, calls } = makeRunner();
  let r = await publishProductSpec(base(root, runner, { confirm: false }));
  assert.equal(r.ok, false); assert.equal(r.error.code, 'confirmation_required');
  r = await publishProductSpec(base(root, runner, { specDigest: 'deadbeef' }));
  assert.equal(r.error.code, 'spec_digest_mismatch');
  r = await publishProductSpec(base(root, runner, { transcript: '没有 spec' }));
  assert.equal(r.error.code, 'spec_not_found');
  assert.equal(calls.length, 0);
  assert.equal(existsSync(path.join(root, '.vibe', 'plans', 'demo-plan', 'product-spec.input.json')), false);
});

test('publish blocks before any git/gh action when the capability attestation is missing', async () => {
  const { root } = makeProject({ attested: false });
  const { runner, calls } = makeRunner();
  const r = await publishProductSpec(base(root, runner));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'capability_attestation_required');
  assert.equal(calls.length, 0);
});

test('publish pushes docs/<planId> from a temp worktree, opens a PR, and leaves main and the checkout untouched', async () => {
  const { root, origin } = makeProject();
  const mainBefore = git(origin, 'rev-parse', 'main');
  const { runner, calls } = makeRunner();
  const r = await publishProductSpec(base(root, runner));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.prUrl, 'https://github.com/owner/repo/pull/7');
  assert.equal(r.branch, 'docs/demo-plan');
  assert.equal(r.reused, false);
  // 原文写到 .vibe/plans/<planId>/product-spec.input.json
  const input = JSON.parse(readFileSync(path.join(root, '.vibe', 'plans', 'demo-plan', 'product-spec.input.json'), 'utf8'));
  assert.deepEqual(input, SPEC);
  // 远端有独立分支，main 不动
  assert.equal(git(origin, 'rev-parse', 'main'), mainBefore);
  assert.notEqual(git(origin, 'rev-parse', 'docs/demo-plan'), mainBefore);
  const files = git(origin, 'ls-tree', '-r', '--name-only', 'docs/demo-plan').split('\n');
  assert.ok(files.includes('docs/prd/demo-plan/product-spec.json'));
  assert.ok(files.includes('docs/prd/demo-plan/plan.json'));
  assert.ok(files.includes('docs/prd/demo-plan/nodes.json'));
  assert.ok(!files.some(f => f.startsWith('.vibe/')));
  // 主 checkout 仍在 main，工作区干净，临时 worktree 已清理
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
  // 只执行快照内动作：没有 merge/release/deploy，push 目标只有 docs 分支
  const pushes = calls.filter(c => c.command === 'git' && c.args.includes('push'));
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].args.includes('HEAD:refs/heads/docs/demo-plan'));
  assert.ok(!pushes.some(p => p.args.some(a => /(^|[:/])main$/.test(a) || a.includes('--force'))));
  const gh = calls.filter(c => c.command === 'gh').map(c => c.args.slice(0, 2).join(' '));
  assert.deepEqual(gh, ['pr list', 'pr create']);
  const create = calls.find(c => c.command === 'gh' && c.args[1] === 'create');
  assert.deepEqual([create.args[create.args.indexOf('--base') + 1], create.args[create.args.indexOf('--head') + 1]], ['main', 'docs/demo-plan']);
  assert.equal(r.authorizationSnapshot.targetRepository, undefined);
  assert.deepEqual(r.authorizationSnapshot.actions, ['push-branch', 'create-pr']);
});

test('publish is idempotent: reruns reuse the branch and the existing PR instead of duplicating', async () => {
  const { root, origin } = makeProject();
  await publishProductSpec(base(root, makeRunner().runner));
  const head = git(origin, 'rev-parse', 'docs/demo-plan');
  const { runner, calls } = makeRunner({ existingPr: { url: 'https://github.com/owner/repo/pull/7', number: 7 } });
  const r = await publishProductSpec(base(root, runner));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reused, true);
  assert.equal(r.prUrl, 'https://github.com/owner/repo/pull/7');
  assert.equal(git(origin, 'rev-parse', 'docs/demo-plan'), head);
  assert.ok(!calls.some(c => c.command === 'gh' && c.args[1] === 'create'));
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
});

test('publish refuses when the current branch is detached or equals the publish branch, and cleans up after gh failure', async () => {
  const { root } = makeProject();
  git(root, 'checkout', '-b', 'docs/demo-plan');
  let r = await publishProductSpec(base(root, makeRunner().runner));
  assert.equal(r.error.code, 'invalid_base_branch');
  git(root, 'checkout', 'main');
  r = await publishProductSpec(base(root, makeRunner({ failGh: true }).runner));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'publish_failed');
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});
