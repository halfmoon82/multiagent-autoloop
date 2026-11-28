#!/usr/bin/env node
// 发布包组装 CLI：把控制台源码、docs/install/、examples/、README、LICENSE 组装成确定性发布目录与可选 tarball。
// 用法：
//   node scripts/release.mjs [--source <仓库根>] [--out <发布目录>] [--tarball] [--apk <apk路径>] [--json]
//   默认 --source=本仓库根，--out=<source>/dist/release/<name>-<version>；--tarball 另写 <out>.tar.gz。
// 排除：上游内核（根 app/）、node_modules、运行状态（config.json/rules.json/数据库/日志）。
// 守门（命中即构建失败并列出文件，不静默跳过）：内核路径、密钥文件、私钥/token 内容、本机绝对路径。
// 产物先写同级临时目录，成功后原子就位；失败不留半成品。APK 只作为 manifest 附件清单项，不入包。
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export class ReleaseError extends Error {
  constructor(message, hits = []) {
    super(message);
    this.name = 'ReleaseError';
    this.hits = hits;
  }
}

const ROOT_FILES = ['README.md', 'LICENSE', 'package.json', 'package-lock.json'];
const ROOT_DIRS = ['src', 'public', 'scripts', 'examples', 'docs/install'];
const REQUIRED = ['README.md', 'LICENSE', 'package.json', 'docs/install', 'src', 'public', 'examples'];

// 运行状态与依赖：在包含目录内遇到即排除（不是错误）
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git', '.worktrees', 'state', 'work']);
const EXCLUDED_NAMES = new Set(['config.json', 'rules.json', '.DS_Store']);
const EXCLUDED_SUFFIX = /\.(db|db-shm|db-wal|sqlite|sqlite3|log|pid)$/i;
// 密钥文件：遇到即守门失败
const SECRET_FILE = /(^|\/)(\.env(\..+)?|master\.key|[^/]+\.(pem|key|p12|pfx))$/i;
const SECRET_FILE_OK = /(^|\/)\.env\.example$/i;
// 上游内核：包含目录内任何 app/ 路径段（根 app/ 本就不在包含范围内）
const KERNEL_PATH = /(^|\/)app\//;

// 规则用字符类书写，保证本文件自身不含会触发规则的字面量
const CONTENT_RULES = [
  { name: '私钥', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: 'API key', re: /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/ },
  { name: '本机路径', re: /\/Users\/[^\s/]+|\/home\/[A-Za-z_][\w-]*\/|[A-Za-z]:\\Users\\/ }
];
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function isText(buffer) {
  return !buffer.subarray(0, 8000).includes(0);
}

function walk(absDir, relDir, out) {
  for (const name of readdirSync(absDir).sort()) {
    const rel = `${relDir}/${name}`;
    const abs = join(absDir, name);
    if (EXCLUDED_SEGMENTS.has(name) || EXCLUDED_NAMES.has(name) || EXCLUDED_SUFFIX.test(name)) continue;
    const st = lstatSync(abs);
    if (st.isDirectory()) walk(abs, rel, out);
    else out.push({ rel, abs, st });
  }
}

export function collectFiles(sourceRoot) {
  const missing = REQUIRED.filter((p) => !existsSync(join(sourceRoot, p)));
  if (missing.length) throw new ReleaseError(`发布源缺少必需内容：${missing.join('、')}`, missing);
  const files = [];
  for (const name of ROOT_FILES) {
    const abs = join(sourceRoot, name);
    if (existsSync(abs)) files.push({ rel: name, abs, st: lstatSync(abs) });
  }
  for (const dir of ROOT_DIRS) {
    const abs = join(sourceRoot, dir);
    if (existsSync(abs)) walk(abs, dir, files);
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

export function scanFiles(files) {
  const hits = [];
  for (const file of files) {
    if (file.st.isSymbolicLink()) { hits.push(`${file.rel}：符号链接`); continue; }
    if (KERNEL_PATH.test(file.rel)) hits.push(`${file.rel}：上游内核文件`);
    if (SECRET_FILE.test(file.rel) && !SECRET_FILE_OK.test(file.rel)) hits.push(`${file.rel}：密钥文件`);
    if (!file.st.isFile() || file.st.size > MAX_SCAN_BYTES) continue;
    const buffer = readFileSync(file.abs);
    if (!isText(buffer)) continue;
    const text = buffer.toString('utf8');
    for (const rule of CONTENT_RULES) {
      if (rule.re.test(text)) hits.push(`${file.rel}：${rule.name}`);
    }
  }
  return hits;
}

function tarHeader(name, size, mode) {
  const header = Buffer.alloc(512);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const idx = name.slice(0, 156).lastIndexOf('/');
    if (idx < 0 || Buffer.byteLength(name.slice(idx + 1)) > 100) throw new ReleaseError(`路径过长无法打包：${name}`);
    prefix = name.slice(0, idx);
    base = name.slice(idx + 1);
  }
  header.write(base, 0, 100);
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136); // mtime 固定为 0，保证确定性
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

export function buildTarball(entries, rootName) {
  const chunks = [];
  for (const { rel, data, mode } of entries) {
    chunks.push(tarHeader(`${rootName}/${rel}`, data.length, mode), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function apkAttachment(apkPath) {
  if (apkPath && existsSync(apkPath) && statSync(apkPath).isFile()) {
    const data = readFileSync(apkPath);
    return { kind: 'apk', name: basename(apkPath), status: 'present', sha256: sha256(data), size: data.length };
  }
  return { kind: 'apk', name: apkPath ? basename(apkPath) : 'NoMoTo.apk', status: 'pending', sha256: null, size: null };
}

export function buildRelease({ sourceRoot, outDir, tarball = false, apk = null } = {}) {
  const root = resolve(sourceRoot);
  const files = collectFiles(root);
  const hits = scanFiles(files);
  if (hits.length) throw new ReleaseError(`发布守门命中 ${hits.length} 处：\n${hits.map((h) => `  - ${h}`).join('\n')}`, hits);

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const name = String(pkg.name || 'release');
  const version = String(pkg.version || '0.0.0');
  const target = resolve(outDir || join(root, 'dist', 'release', `${name}-${version}`));
  if (target === root || root.startsWith(target + sep)) throw new ReleaseError('输出目录不能是发布源或其上级');

  const entries = files.map((file) => {
    const data = readFileSync(file.abs);
    const mode = file.st.mode & 0o111 ? 0o755 : 0o644;
    return { rel: file.rel, data, mode, sha256: sha256(data), size: data.length };
  });
  const manifest = {
    name,
    version,
    files: entries.map(({ rel, sha256: digest, size }) => ({ path: rel, sha256: digest, size })),
    attachments: [apkAttachment(apk)]
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), `.release-stage-${process.pid}-`));
  const backup = `${stage}.old`;
  const tarPath = `${target}.tar.gz`;
  try {
    for (const entry of entries) {
      const dest = join(stage, entry.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, entry.data);
      chmodSync(dest, entry.mode);
    }
    writeFileSync(join(stage, 'manifest.json'), manifestText);
    let tarStage = null;
    if (tarball) {
      const all = [...entries, { rel: 'manifest.json', data: Buffer.from(manifestText), mode: 0o644 }]
        .sort((a, b) => (a.rel < b.rel ? -1 : 1));
      tarStage = `${stage}.tar.gz`;
      writeFileSync(tarStage, buildTarball(all, `${name}-${version}`));
    }
    if (existsSync(target)) renameSync(target, backup);
    renameSync(stage, target);
    if (tarStage) renameSync(tarStage, tarPath);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    rmSync(`${stage}.tar.gz`, { force: true });
    if (existsSync(backup) && !existsSync(target)) renameSync(backup, target);
    throw error;
  }
  return {
    outDir: target,
    tarball: tarball ? tarPath : null,
    manifest,
    manifestSha256: sha256(Buffer.from(manifestText)),
    fileCount: entries.length
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    options[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    const result = buildRelease({
      sourceRoot: options.source && options.source !== true ? options.source : resolve(here, '..'),
      outDir: options.out && options.out !== true ? options.out : undefined,
      tarball: Boolean(options.tarball),
      apk: options.apk && options.apk !== true ? options.apk : null
    });
    if (options.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    else console.log(`发布包已生成：${result.outDir}（${result.fileCount} 个文件，manifest sha256=${result.manifestSha256.slice(0, 12)}）${result.tarball ? `\ntarball：${result.tarball}` : ''}`);
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(`发布构建失败：${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
