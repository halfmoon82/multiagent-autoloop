// 服务端 vibe 规划适配器：固定封装 scan/plan/init 白名单、宿主环境清理、
// 版本预检（v5.2.7 阻塞式）、只读能力记录校验、initialization_required 与转录 specDigest。
// 全部 CLI 调用走 test/fixtures/vibe-5.2.7/bin/vibe 假可执行文件（录制 v5.2.7 真实 JSON 形态），CI 不装 Python、不调真实 CLI。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIBE_VERSION,
  VIBE_MAJOR_VERSION,
  HOST_ENV_DENYLIST,
  CAPABILITY_MAX_AGE_MS,
  VibeAdapterError,
  sanitizeHostEnv,
  buildVibeArgv,
  ensureVibeVersion,
  checkInitialization,
  checkCapabilities,
  extractProductSpec,
  computeSpecDigest,
  runVibe,
} from '../src/vibe-adapter.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vibe-5.2.7');
const fakeBin = path.join(fixtureDir, 'bin', 'vibe');

function makeGitRoot({ withState = false, state = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'vibe-adapter-test-'));
  mkdirSync(path.join(root, '.git'), { recursive: true });
  if (withState || state !== null) {
    mkdirSync(path.join(root, '.vibe'), { recursive: true });
    writeFileSync(path.join(root, '.vibe', 'state.json'), JSON.stringify(state ?? validState()));
  }
  return root;
}

function validState(overrides = {}) {
  return {
    version: 1,
    capabilities: {
      adapter: 'codex',
      attested_at: new Date().toISOString(),
      host_major_version: VIBE_MAJOR_VERSION,
      dispatch: 'visible',
      attest_command: 'vibe attest',
      ...overrides,
    },
  };
}

const FRESH_ISO = new Date().toISOString();

test('sanitizeHostEnv strips the full host denylist and keeps unrelated variables', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/tester',
    CODEX_THREAD_ID: 'thread-123',
    CODEX_SESSION_ID: 'session-456',
    CODEX_TURN_ID: 'turn-789',
    CLAUDE_SESSION_ID: 'claude-abc',
    CLAUDECODE: '1',
    CURSOR_SESSION_ID: 'cursor-def',
    AGENT_TASK_ID: 'agent-ghi',
  };
  const clean = sanitizeHostEnv(env);
  assert.ok(HOST_ENV_DENYLIST.includes('CODEX_THREAD_ID'));
  for (const key of HOST_ENV_DENYLIST) assert.equal(clean[key], undefined, `must strip ${key}`);
  assert.equal(clean.PATH, '/usr/bin');
  assert.equal(clean.HOME, '/home/tester');
  assert.deepEqual(Object.keys(clean).sort(), ['HOME', 'PATH']);
  assert.equal(env.CODEX_THREAD_ID, 'thread-123', 'does not mutate the input env');
});

test('buildVibeArgv only whitelists scan/plan/init and pins --adapter codex + --project-root', () => {
  const root = makeGitRoot();
  assert.deepEqual(buildVibeArgv('scan', { projectRoot: root }), ['scan', '--adapter', 'codex', '--project-root', root]);
  assert.deepEqual(buildVibeArgv('init', { projectRoot: root, confirm: true }), ['init', '--confirm', '--adapter', 'codex', '--project-root', root]);
  const prd = path.join(root, '.vibe', 'plans', 'demo-plan', 'product-spec.input.json');
  assert.deepEqual(buildVibeArgv('plan', { projectRoot: root, prdPath: prd }), ['plan', '--from-prd', prd, '--adapter', 'codex', '--project-root', root]);
  assert.throws(() => buildVibeArgv('exec', { projectRoot: root }), /白名单/);
  assert.throws(() => buildVibeArgv('scan', { projectRoot: root, extraArgs: ['--shell', 'rm -rf /'] }), /白名单/);
  // init 没有 confirm 不允许构造 argv
  assert.throws(() => buildVibeArgv('init', { projectRoot: root }), /confirm/);
});

test('buildVibeArgv rejects relative, traversal and non-git project roots', () => {
  assert.throws(() => buildVibeArgv('scan', { projectRoot: 'relative/path' }), /Git 仓/);
  assert.throws(() => buildVibeArgv('scan', { projectRoot: '/tmp/../etc' }), /Git 仓/);
  const notGit = mkdtempSync(path.join(tmpdir(), 'vibe-adapter-nogit-'));
  assert.throws(() => buildVibeArgv('scan', { projectRoot: notGit }), /Git 仓/);
  assert.throws(() => buildVibeArgv('scan', { projectRoot: '' }), /Git 仓/);
});

test('buildVibeArgv keeps prdPath inside the project .vibe plans directory', () => {
  const root = makeGitRoot();
  const inside = path.join(root, '.vibe', 'plans', 'demo-plan', 'product-spec.input.json');
  assert.doesNotThrow(() => buildVibeArgv('plan', { projectRoot: root, prdPath: inside }));
  assert.throws(() => buildVibeArgv('plan', { projectRoot: root, prdPath: '/etc/passwd' }), /from-prd/);
  assert.throws(() => buildVibeArgv('plan', { projectRoot: root, prdPath: path.join(root, 'src', 'x.json') }), /from-prd/);
  assert.throws(() => buildVibeArgv('plan', { projectRoot: root }), /from-prd/);
});

test('ensureVibeVersion returns the pinned 5.2.7 and parses the fake CLI output', async () => {
  const result = await ensureVibeVersion({ command: fakeBin });
  assert.deepEqual(result, { ok: true, version: VIBE_VERSION });
});

test('ensureVibeVersion blocks with version_mismatch and names the remediation path', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-fake-old-'));
  const oldBin = path.join(dir, 'vibe');
  writeFileSync(oldBin, `#!/bin/sh\necho "vibe 5.2.6"\n`);
  chmodSync(oldBin, 0o755);
  const result = await ensureVibeVersion({ command: oldBin });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'version_mismatch');
  assert.match(result.error.message, /5\.2\.7/);
  assert.match(result.error.remediation, /vibe/);
});

test('checkInitialization reports initialization_required only when .vibe/state.json is absent', () => {
  const empty = makeGitRoot();
  const missing = checkInitialization({ projectRoot: empty });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'initialization_required');
  assert.match(missing.error.remediation, /init --confirm/);
  const ready = makeGitRoot({ withState: true });
  assert.deepEqual(checkInitialization({ projectRoot: ready }), { ok: true });
});

test('checkCapabilities accepts a fresh codex attestation with a real dispatch form', () => {
  for (const dispatch of ['visible', 'background', 'in_session_sdd']) {
    const root = makeGitRoot({ state: validState({ attested_at: FRESH_ISO, dispatch }) });
    assert.deepEqual(checkCapabilities({ projectRoot: root }), { ok: true });
  }
});

test('checkCapabilities rejects missing attestation records with capability_attestation_required', () => {
  const root = makeGitRoot({ state: { version: 1 } });
  const result = checkCapabilities({ projectRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'capability_attestation_required');
  assert.match(result.error.remediation, /vibe attest/);
});

test('checkCapabilities rejects non-codex adapters, wrong attest provenance and unknown dispatch forms', () => {
  const wrongAdapter = checkCapabilities({ projectRoot: makeGitRoot({ state: validState({ adapter: 'claude' }) }) });
  assert.equal(wrongAdapter.error.code, 'capability_attestation_required');
  assert.match(wrongAdapter.error.message, /adapter/);

  const noProvenance = checkCapabilities({ projectRoot: makeGitRoot({ state: validState({ attest_command: 'hand-written' }) }) });
  assert.equal(noProvenance.error.code, 'capability_attestation_required');
  assert.match(noProvenance.error.message, /vibe attest/);

  const badDispatch = checkCapabilities({ projectRoot: makeGitRoot({ state: validState({ dispatch: 'telepathy' }) }) });
  assert.equal(badDispatch.error.code, 'capability_attestation_required');
  assert.match(badDispatch.error.message, /visible|background|in_session_sdd/);
});

test('checkCapabilities rejects attestations older than 72 hours', () => {
  const stale = new Date(Date.now() - CAPABILITY_MAX_AGE_MS - 60_000).toISOString();
  const result = checkCapabilities({ projectRoot: makeGitRoot({ state: validState({ attested_at: stale }) }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'capability_attestation_required');
  assert.match(result.error.message, /72/);
  const boundary = new Date(Date.now() - CAPABILITY_MAX_AGE_MS + 60_000).toISOString();
  assert.deepEqual(checkCapabilities({ projectRoot: makeGitRoot({ state: validState({ attested_at: boundary }) }) }), { ok: true });
});

test('checkCapabilities rejects a host major version drift', () => {
  const drifted = checkCapabilities({ projectRoot: makeGitRoot({ state: validState({ host_major_version: VIBE_MAJOR_VERSION + 1 }) }) });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.error.code, 'capability_attestation_required');
  assert.match(drifted.error.message, /大版本/);
  const result = checkCapabilities({ projectRoot: makeGitRoot({ state: validState() }), hostMajorVersion: VIBE_MAJOR_VERSION + 1 });
  assert.equal(result.error.code, 'capability_attestation_required');
});

test('checkCapabilities fails closed on unreadable or malformed state.json', () => {
  const root = makeGitRoot();
  mkdirSync(path.join(root, '.vibe'), { recursive: true });
  writeFileSync(path.join(root, '.vibe', 'state.json'), '{ not json');
  const result = checkCapabilities({ projectRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'capability_attestation_required');
});

test('extractProductSpec pulls the product-spec block and computes a deterministic specDigest', () => {
  const spec = { title: '多租户计费', objective: '租户账单隔离', decisions: [{ id: 'd1', selected: 'CSV', status: 'approved' }] };
  const transcript = [
    '设计会话转录开头，模型说了一些话。',
    '```product-spec',
    JSON.stringify(spec, null, 2),
    '```',
    '结尾说明。',
  ].join('\n');
  const result = extractProductSpec(transcript);
  assert.equal(result.ok, true);
  assert.deepEqual(result.productSpec, spec);
  assert.equal(result.specDigest, computeSpecDigest(spec));
  assert.equal(result.specDigest, extractProductSpec(transcript).specDigest, 'digest is deterministic');
  assert.match(result.specDigest, /^[0-9a-f]{64}$/);
});

test('extractProductSpec also accepts a json fenced block tagged with product-spec', () => {
  const transcript = '前文\n```json product-spec\n{"title":"t"}\n```\n后文';
  const result = extractProductSpec(transcript);
  assert.equal(result.ok, true);
  assert.deepEqual(result.productSpec, { title: 't' });
});

test('extractProductSpec reports structured errors for missing or malformed blocks', () => {
  const none = extractProductSpec('没有任何约定块');
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'spec_not_found');

  const badJson = extractProductSpec('```product-spec\n{ broken\n```');
  assert.equal(badJson.ok, false);
  assert.equal(badJson.error.code, 'invalid_spec_block');

  const notObject = extractProductSpec('```product-spec\n[1,2,3]\n```');
  assert.equal(notObject.ok, false);
  assert.equal(notObject.error.code, 'invalid_spec_block');

  for (const bad of [null, 42, {}, []]) {
    assert.throws(() => extractProductSpec(bad), /字符串/, 'non-string transcript is a programmer error');
  }
});

test('runVibe scan executes the fake CLI with sanitized env, whitelist argv and returns recorded JSON', async () => {
  const root = makeGitRoot({ withState: true });
  const record = path.join(root, 'record.json');
  const saved = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDECODE: process.env.CLAUDECODE,
  };
  process.env.CODEX_THREAD_ID = 'host-thread-should-not-leak';
  process.env.CLAUDECODE = '1';
  try {
    const result = await runVibe('scan', { projectRoot: root, command: fakeBin, env: { ...process.env, VIBE_FAKE_RECORD: record } });
    assert.equal(result.ok, true);
    assert.equal(result.version, VIBE_VERSION);
    assert.deepEqual(result.data, JSON.parse(readFileSync(path.join(fixtureDir, 'cli', 'scan.json'), 'utf8')));
    assert.equal(existsSync(record), true, 'fake CLI ran');
    const seen = JSON.parse(readFileSync(record, 'utf8'));
    assert.deepEqual(seen.argv, ['scan', '--adapter', 'codex', '--project-root', root], 'argv fully constructed inside the module');
    assert.equal(seen.env.CODEX_THREAD_ID, undefined, 'host CODEX_THREAD_ID stripped before exec');
    assert.equal(seen.env.CLAUDECODE, undefined);
    assert.equal(seen.env.VIBE_FAKE_RECORD, record, 'explicitly passed env survives');
  } finally {
    if (saved.CODEX_THREAD_ID === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = saved.CODEX_THREAD_ID;
    if (saved.CLAUDECODE === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved.CLAUDECODE;
  }
});

test('runVibe blocks everything when the installed version is not 5.2.7', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-fake-old2-'));
  const oldBin = path.join(dir, 'vibe');
  writeFileSync(oldBin, `#!/bin/sh\necho "vibe 5.2.6"\n`);
  chmodSync(oldBin, 0o755);
  const root = makeGitRoot({ withState: true });
  const result = await runVibe('scan', { projectRoot: root, command: oldBin });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'version_mismatch');
});

test('runVibe init refuses without explicit confirm and requires initialized state', async () => {
  const root = makeGitRoot();
  const refused = await runVibe('init', { projectRoot: root, command: fakeBin });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'confirmation_required');
  const initialized = await runVibe('init', { projectRoot: root, command: fakeBin, confirm: true });
  assert.equal(initialized.ok, true, 'init 本身就是初始化动作，不受 initialization_required 预检拦截');
  assert.equal(initialized.data.initialized, true);
  const blocked = await runVibe('scan', { projectRoot: makeGitRoot(), command: fakeBin });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'initialization_required');
});

test('runVibe plan pins --from-prd inside .vibe/plans and requires initialized project', async () => {
  const root = makeGitRoot({ withState: true });
  const planDir = path.join(root, '.vibe', 'plans', 'demo-plan');
  mkdirSync(planDir, { recursive: true });
  const prd = path.join(planDir, 'product-spec.input.json');
  cpSync(path.join(fixtureDir, 'product-spec.input.json'), prd);
  const result = await runVibe('plan', { projectRoot: root, prdPath: prd, command: fakeBin });
  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'draft');

  const escape = path.join(mkdtempSync(path.join(tmpdir(), 'vibe-adapter-escape-')), 'evil.json');
  writeFileSync(escape, '{}');
  const blocked = await runVibe('plan', { projectRoot: root, prdPath: escape, command: fakeBin });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'invalid_arguments');
  assert.match(blocked.error.message, /from-prd/);
});

test('VibeAdapterError exposes a stable code for structured error handling', () => {
  const error = new VibeAdapterError('capability_attestation_required', '能力记录缺失', '在真实 Codex 会话执行 vibe attest');
  assert.equal(error.code, 'capability_attestation_required');
  assert.equal(error.remediation, '在真实 Codex 会话执行 vibe attest');
  assert.ok(error instanceof Error);
});
