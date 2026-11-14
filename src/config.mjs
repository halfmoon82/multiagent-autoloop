import { readFileSync } from 'node:fs';
import path from 'node:path';

export function loadConsoleConfig(root = process.env.AGENT_AUTOLOOP_HOME) {
  if (!root) throw new Error('请设置 AGENT_AUTOLOOP_HOME 为试点数据目录');
  const file = path.join(root, 'config.json');
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`读不到 ${file}：${error.message}`); }
  if (!config.url || !config.owner) throw new Error(`${file} 缺少中台地址或本人密钥`);
  const hubUrl = new URL(config.url);
  if (!['http:', 'https:'].includes(hubUrl.protocol)) throw new Error('中台地址只支持 HTTP 或 HTTPS');
  return {
    root,
    hubUrl: hubUrl.toString().replace(/\/$/, ''),
    ownerKey: config.owner,
    rulesFile: path.join(root, 'rules.json'),
    cliPath: path.join(root, 'app', 'bin', 'agent-autoloop.ts'),
    host: '127.0.0.1',
    port: Number(process.env.AUTOLOOP_CONSOLE_PORT || 0),
    projectRoots: (process.env.AUTOLOOP_PROJECT_ROOTS || '').split(/[,:]/).map(item => item.trim()).filter(Boolean),
  };
}
