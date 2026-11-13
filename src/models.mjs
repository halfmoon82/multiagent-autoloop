import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const HOME_DIR = process.env.HOME;
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const latestWorkBuddyModel = () => {
  if (!HOME_DIR) return null;
  try {
    const days = readdirSync(path.join(HOME_DIR, '.codebuddy', 'logs'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(HOME_DIR, '.codebuddy', 'logs', d.name));
    const files = days.flatMap(day => readdirSync(day).map(name => path.join(day, name))).map(file => ({ file, mtime: statSync(file).mtimeMs })).sort((a, b) => b.mtime - a.mtime).slice(0, 5);
    for (const { file } of files) {
      const text = readFileSync(file, 'utf8');
      const matches = [...text.matchAll(/"model":"([^"]+)"/g)].map(m => m[1]).filter(name => !['gpt-5.6-luna'].includes(name));
      if (matches.length) return matches.at(-1);
    }
  } catch {}
  return null;
};
const firstModel = (value) => {
  if (!value || typeof value !== 'object') return null;
  if (value.modelId) return String(value.modelId);
  for (const item of Object.values(value)) { const found = firstModel(item); if (found) return found; }
  return null;
};
export function modelLabels() {
  if (!HOME_DIR) return { codex: '默认模型', workbuddy: 'ACP 当前配置', claude: '默认模型' };
  let codex = null;
  try {
    const config = readFileSync(path.join(HOME_DIR, '.codex', 'config.toml'), 'utf8');
    codex = config.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  } catch {}
  const workbuddy = latestWorkBuddyModel() || firstModel(readJson(path.join(HOME_DIR, '.codebuddy', 'settings.json')));
  const claude = firstModel(readJson(path.join(HOME_DIR, '.claude', 'settings.json')));
  return { codex: codex || '默认模型', workbuddy: workbuddy || 'ACP 当前配置', claude: claude || '默认模型' };
}
