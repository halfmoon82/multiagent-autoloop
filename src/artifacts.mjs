// 调度会话产物：会话工作目录（目标项目仓库）下由会话生成的 md/html 文件只读发现与读取。
// 硬边界：只读、禁止越界（realpath 前缀校验 + 符号链接逃逸拒绝）、容量与深度封顶。
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const ARTIFACT_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);
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

export function listArtifacts(cwd, { maxDepth = MAX_DEPTH, maxFiles = MAX_FILES } = {}) {
  if (!cwd) return [];
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
      } else if (entry.isFile() && ARTIFACT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const stat = statSync(full);
          files.push({ path: path.relative(root, full), name: entry.name, size: stat.size, at: stat.mtime.toISOString() });
        } catch { /* 读取失败跳过 */ }
      }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
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
