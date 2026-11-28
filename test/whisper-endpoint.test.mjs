// whisper-endpoint 节点契约：POST /api/speech/transcribe 鉴权、类型/大小/时长限制、冷却、
// 假 whisper 命令替身验证参数白名单/超时/清理/成功/失败/缺失。不调用真实 whisper。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { loadConsoleConfig } from '../src/config.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const FAKE_WHISPER = `#!/bin/sh
DIR="$(dirname "$0")"
echo "$@" > "$DIR/args.log"
MODE="$(cat "$DIR/mode" 2>/dev/null)"
OUT=""
while [ $# -gt 0 ]; do if [ "$1" = "--output_dir" ]; then OUT="$2"; fi; shift; done
INPUT="$(sed 's/ .*//' "$DIR/args.log")"
echo "$INPUT" > "$DIR/input.path"
echo "SECRET-STDERR-DETAIL" >&2
[ "$MODE" = "fail" ] && exit 3
[ "$MODE" = "hang" ] && exec sleep 30
BASE="$(basename "$INPUT")"; BASE="\${BASE%.*}"
printf ' 你好 世界 \\n' > "$OUT/$BASE.txt"
exit 0
`;

function wav(seconds, extra = 0) {
  const rate = 8000; const dataLen = seconds * rate;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataLen, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34);
  header.write('data', 36); header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, Buffer.alloc(extra)]);
}

async function setup(t, { whisperPath, cooldownMs = 0, timeoutMs = 60000, configure = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'whisper-ep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'fake-whisper.sh');
  writeFileSync(script, FAKE_WHISPER); chmodSync(script, 0o755);
  const hub = await fakeHub((req, res) => json(res, {}));
  const store = createDeviceStore({ file: path.join(root, 'device-auth.json') });
  const bound = store.bindDevice({ token: store.createBinding().token, name: '手机', platform: 'Android' });
  const server = createConsoleServer({
    hubUrl: hub.url, ownerKey: 'k', sourceKey: 's', host: '127.0.0.1', root,
    rulesFile: path.join(root, 'rules.json'), projectRoots: [], deviceAuth: store,
    ...(configure ? { whisper: { path: whisperPath ?? script, model: 'small', timeoutMs, cooldownMs, tmpRoot: root } } : {}),
  }, false);
  const url = await listen(server);
  t.after(async () => { await close(server); await close(hub.server); });
  return { url, root, script, token: bound.deviceToken, setMode: mode => writeFileSync(path.join(root, 'mode'), mode) };
}

const post = (ctx, body, { token = ctx.token, type = 'audio/wav', headers = {} } = {}) => fetch(`${ctx.url}/api/speech/transcribe`, {
  method: 'POST',
  headers: { 'x-forwarded-proto': 'https', ...(type ? { 'content-type': type } : {}), ...(token ? { 'x-device-token': token } : {}), ...headers },
  body,
  signal: AbortSignal.timeout(15000),
});
const leftovers = ctx => readdirSync(ctx.root).filter(name => name.startsWith('whisper-'));

test('成功：返回 {text}，参数白名单拼接，临时文件清理', async t => {
  const ctx = await setup(t);
  const response = await post(ctx, wav(2));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: '你好 世界' });
  const args = readFileSync(path.join(ctx.root, 'args.log'), 'utf8').trim().split(' ');
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'small');
  assert.ok(args.includes('--output_format') && args[args.indexOf('--output_format') + 1] === 'txt');
  assert.deepEqual(leftovers(ctx), [], '临时文件必须清理');
});

test('multipart 上传同样受理', async t => {
  const ctx = await setup(t);
  const boundary = 'XBOUNDARYX';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav(1), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await post(ctx, body, { type: `multipart/form-data; boundary=${boundary}` });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, '你好 世界');
});

test('未鉴权 401 / 无效设备 401，且不调用 whisper', async t => {
  const ctx = await setup(t);
  assert.equal((await post(ctx, wav(1), { token: null })).status, 401);
  assert.equal((await post(ctx, wav(1), { token: 'bogus' })).status, 401);
  assert.equal(existsSync(path.join(ctx.root, 'args.log')), false);
});

test('非 audio 类型拒绝 415', async t => {
  const ctx = await setup(t);
  assert.equal((await post(ctx, '{}', { type: 'application/json' })).status, 415);
  assert.equal((await post(ctx, 'x', { type: null })).status, 415);
});

test('超过 2MB 返回 413；WAV 头时长超 60s 返回 413', async t => {
  const ctx = await setup(t);
  assert.equal((await post(ctx, Buffer.alloc(2 * 1024 * 1024 + 1), { type: 'audio/ogg' })).status, 413);
  assert.equal((await post(ctx, wav(61, 61 * 8000))).status, 413);
  assert.equal(existsSync(path.join(ctx.root, 'args.log')), false);
});

test('同设备冷却内重复请求 429', async t => {
  const ctx = await setup(t, { cooldownMs: 3000 });
  assert.equal((await post(ctx, wav(1))).status, 200);
  assert.equal((await post(ctx, wav(1))).status, 429);
});

test('whisper 非零退出 502，统一文案且不回传 stderr，临时文件清理', async t => {
  const ctx = await setup(t); ctx.setMode('fail');
  const response = await post(ctx, wav(1));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /转写失败，请重试/);
  assert.doesNotMatch(text, /SECRET-STDERR/);
  assert.deepEqual(leftovers(ctx), []);
});

test('whisper 超时 504 并杀进程，临时文件清理', async t => {
  const ctx = await setup(t, { timeoutMs: 400 }); ctx.setMode('hang');
  const started = Date.now();
  const response = await post(ctx, wav(1));
  assert.equal(response.status, 504);
  assert.match(await response.text(), /转写失败，请重试/);
  assert.ok(Date.now() - started < 10000);
  assert.deepEqual(leftovers(ctx), []);
});

test('配置路径不可执行 503（客户端降级）；默认解析不可用同样 503', async t => {
  const ctx = await setup(t, { whisperPath: '/nonexistent/whisper' });
  assert.equal((await post(ctx, wav(1))).status, 503);
  assert.equal(existsSync(path.join(ctx.root, 'args.log')), false);
  // 未配置时只核对默认可用性判定，不发请求（本机可能真装 whisper，发请求会真跑模型）。
  // 用受控 env（空 PATH、无 AUTOLOOP_WHISPER_PATH）保证不依赖开发机真实安装。
  const { createWhisperTranscriber } = await import('../src/whisper-transcribe.mjs');
  const empty = mkdtempSync(path.join(tmpdir(), 'whisper-none-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const savedPath = process.env.PATH;
  const savedWhisper = process.env.AUTOLOOP_WHISPER_PATH;
  try {
    process.env.PATH = empty;
    delete process.env.AUTOLOOP_WHISPER_PATH;
    assert.throws(() => createWhisperTranscriber({}).assertAvailable(), error => error.status === 503);
  } finally {
    process.env.PATH = savedPath;
    if (savedWhisper === undefined) delete process.env.AUTOLOOP_WHISPER_PATH;
    else process.env.AUTOLOOP_WHISPER_PATH = savedWhisper;
  }
});

test('模型名非法时不拼进命令行（白名单）', async t => {
  const ctx = await setup(t);
  const { createWhisperTranscriber, WhisperError } = await import('../src/whisper-transcribe.mjs');
  assert.throws(() => createWhisperTranscriber({ path: ctx.script, model: 'small; rm -rf /' }), /模型/);
  assert.ok(WhisperError);
});

test('config.mjs 默认 whisper 路径走 env 解析，config.json 覆盖优先级最高', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'whisper-cfg-'));
  const savedPath = process.env.PATH;
  const savedWhisper = process.env.AUTOLOOP_WHISPER_PATH;
  try {
    // env 覆盖生效：无 config.json whisper 字段时取 AUTOLOOP_WHISPER_PATH。
    process.env.AUTOLOOP_WHISPER_PATH = '/opt/custom/whisper';
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', owner: 'o' }));
    const config = loadConsoleConfig(root);
    assert.equal(config.whisper.path, '/opt/custom/whisper');
    assert.equal(config.whisper.model, 'small');
    // config.json 覆盖优先级最高：压过 env。
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', owner: 'o', whisper: { path: '/x/w', model: 'base' } }));
    const custom = loadConsoleConfig(root);
    assert.equal(custom.whisper.path, '/x/w');
    assert.equal(custom.whisper.model, 'base');
    // env 未设置且 PATH 探测不到 → null（不可用，走 503 降级），不依赖开发机真实安装。
    delete process.env.AUTOLOOP_WHISPER_PATH;
    process.env.PATH = root;
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', owner: 'o' }));
    assert.equal(loadConsoleConfig(root).whisper.path, null);
  } finally {
    process.env.PATH = savedPath;
    if (savedWhisper === undefined) delete process.env.AUTOLOOP_WHISPER_PATH;
    else process.env.AUTOLOOP_WHISPER_PATH = savedWhisper;
    rmSync(root, { recursive: true, force: true });
  }
});
