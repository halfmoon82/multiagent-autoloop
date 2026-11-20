// 调度会话产物：会话工作目录（目标项目仓库）下由会话生成的 md/html 文件只读发现与读取。
// 硬边界：只读、禁止越界（realpath 前缀校验 + 符号链接逃逸拒绝）、容量与深度封顶。
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const ARTIFACT_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);
// 可下载的交付物（二进制）：只给桌面控制台「下载」，不预览、不进手机产物页。
// 刻意不含 txt/json/csv：它们在仓库里到处都是，会把整个项目当成产物。
export const DOWNLOAD_EXTENSIONS = new Set(['.apk', '.ipa', '.zip', '.tgz', '.dmg', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.xlsx', '.docx', '.pptx']);
export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.worktrees', 'dist', 'build', 'coverage', '.next', '.cache']);
const MAX_DEPTH = 3;
const MAX_FILES = 50;
const MAX_BYTES = 500 * 1024;

function insideRoot(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function assertInside(root, relPath) {
  const relative = String(relPath || '');
  if (!relative || path.isAbsolute(relative)) throw new Error('路径越界：只允许会话工作目录内的相对路径');
  const rootReal = realpathSync(root);
  const target = path.resolve(rootReal, relative);
  if (!insideRoot(rootReal, target)) throw new Error('路径越界：只允许会话工作目录内的相对路径');
  let real;
  try { real = realpathSync(target); } catch { throw new Error(`产物文件不存在：${relative}`); }
  if (!insideRoot(rootReal, real)) throw new Error('路径越界：符号链接不能指向工作目录之外');
  return real;
}

// since：只收会话开始后新建/修改的文件（按 mtime），否则同项目所有会话看到的都是整个仓库的旧文档。
// 结果按修改时间倒序，上限先留给最新产物。
// includeFiles：桌面控制台额外列出可下载的二进制交付物（kind='file'）；缺省只列文档，手机产物页口径不变。
export function listArtifacts(cwd, { maxDepth = MAX_DEPTH, maxFiles = MAX_FILES, since = null, includeFiles = false } = {}) {
  if (!cwd) return [];
  const sinceMs = since ? Date.parse(since) : NaN;
  const root = realpathSync(cwd);
  const files = [];
  const walk = (dir, depth) => {
    if (depth >= maxDepth || files.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.')) continue; // 隐藏文件/目录一律跳过（.git/.claude/.github 等）
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Dirent 是 lstat 语义：符号链接目录 isDirectory() 为 false，天然不进这里
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const kind = ARTIFACT_EXTENSIONS.has(ext) ? 'doc' : includeFiles && DOWNLOAD_EXTENSIONS.has(ext) ? 'file' : null;
        if (!kind) continue;
        try {
          const stat = statSync(full);
          if (Number.isFinite(sinceMs) && stat.mtimeMs < sinceMs) continue;
          files.push({ path: path.relative(root, full), name: entry.name, size: stat.size, at: stat.mtime.toISOString(), ...(includeFiles ? { kind } : {}) });
        } catch { /* 读取失败跳过 */ }
      }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.at.localeCompare(a.at) || a.path.localeCompare(b.path));
}

export function readArtifact(cwd, relPath, { maxBytes = MAX_BYTES } = {}) {
  if (!cwd) throw new Error('会话没有工作目录');
  const relative = String(relPath || '');
  const real = assertInside(cwd, relative); // 越界/逃逸先于类型校验，绝对路径不外泄任何信息
  if (!ARTIFACT_EXTENSIONS.has(path.extname(relative).toLowerCase())) throw new Error(`不支持的产物类型：${path.extname(relative) || '(无扩展名)'}`);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`产物文件不存在：${relative}`);
  if (stat.size > maxBytes) throw new Error(`产物文件过大（${Math.round(stat.size / 1024)}KB，上限 ${Math.round(maxBytes / 1024)}KB）`);
  // 注意：stat 与读取之间存在文件增长窗口；本机单人控制台、产物来源为本机 worker，风险可接受
  return { path: relative, name: path.basename(real), content: readFileSync(real, 'utf8') };
}

// 下载：只返回已校验的真实路径与元信息，由调用方流式输出（不整文件读入内存）。
// 越界/符号链接逃逸先于类型校验；上限 300MB。
export function resolveDownload(cwd, relPath, { maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  if (!cwd) throw new Error('会话没有工作目录');
  const relative = String(relPath || '');
  const real = assertInside(cwd, relative);
  const ext = path.extname(relative).toLowerCase();
  if (!DOWNLOAD_EXTENSIONS.has(ext) && !ARTIFACT_EXTENSIONS.has(ext)) throw new Error(`不支持的产物类型：${ext || '(无扩展名)'}`);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`产物文件不存在：${relative}`);
  if (stat.size > maxBytes) throw new Error(`产物文件过大（${Math.round(stat.size / 1024 / 1024)}MB，上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
  return { real, name: path.basename(real), size: stat.size };
}

// ---- 全局产物页：跨会话只读汇总（DAG 节点 artifacts）----
// sessions 来自控制台自身状态（受信任）：[{ id, task, cwd, startedAt }]。
// 每个会话仍按自己的 cwd 走 listArtifacts 的越界/排除边界；这里只做汇总、标记与封顶。

export function listSessionArtifacts(sessions, { maxDepth = MAX_DEPTH, maxFiles = MAX_FILES } = {}) {
  if (!Array.isArray(sessions)) return [];
  const files = [];
  for (const session of sessions) {
    if (!session || typeof session !== 'object' || !session.cwd) continue;
    let found;
    try {
      found = listArtifacts(session.cwd, { maxDepth, maxFiles, since: session.startedAt || null });
    } catch { continue; }
    for (const artifact of found) {
      files.push({
        ...artifact,
        sessionId: String(session.id ?? ''),
        task: String(session.task ?? ''),
      });
    }
  }
  return files
    .sort((a, b) => b.at.localeCompare(a.at) || a.path.localeCompare(b.path) || a.sessionId.localeCompare(b.sessionId))
    .slice(0, maxFiles);
}

// 按会话定位并读取产物；拿不到会话或越界都给可读错误，不把外部路径回给移动端。
export function readSessionArtifact(sessions, sessionId, relPath, options = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const session = list.find(item => item && String(item.id ?? '') === String(sessionId));
  if (!session) throw new Error('产物所属会话不存在');
  if (!session.cwd) throw new Error('产物所属会话没有工作目录');
  const artifact = readArtifact(session.cwd, relPath, options);
  return { ...artifact, sessionId: String(session.id ?? ''), task: String(session.task ?? '') };
}

// 把服务端错误映射成固定可读文案：绝不回显可能含绝对路径的原始消息。
export function readableArtifactError(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return '读取产物失败，请稍后重试';
  if (/会话不存在/.test(message)) return '产物所属会话不存在';
  if (/越界|符号链接|outside/i.test(message)) return '产物路径越界，不能访问会话目录外的文件';
  if (/不存在|no such file|ENOENT/i.test(message)) return '产物不存在或已移出会话目录';
  if (/不支持|扩展名/.test(message)) return '不支持的产物类型，仅可阅读 Markdown 与 HTML';
  if (/过大|too large/i.test(message)) return '产物文件过大，无法在手机上预览';
  return '读取产物失败，请稍后重试';
}
