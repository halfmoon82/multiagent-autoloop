import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_WHISPER_PATH, DEFAULT_WHISPER_MODEL } from './whisper-transcribe.mjs';

// 调度会话全局上限：默认 6、允许 1–12。缺失/非法/越界都回退 6 并告警，绝不因配置错误阻止启动。
export const DEFAULT_MAX_SESSIONS = 6;
export const MAX_SESSIONS_UPPER_BOUND = 12;

export function maxSessionsIssue(value) {
  if (value === undefined || value === null || value === '') return '未配置，使用默认值';
  if (typeof value !== 'number' || !Number.isInteger(value)) return '不是整数';
  if (value < 1 || value > MAX_SESSIONS_UPPER_BOUND) return `值 ${value} 越界（允许 1–${MAX_SESSIONS_UPPER_BOUND}）`;
  return null;
}

export function resolveMaxSessions(value, issue = maxSessionsIssue(value)) {
  if (!issue) return value;
  console.warn(`[config] maxSessions ${issue}，回退为 ${DEFAULT_MAX_SESSIONS}（允许 1–${MAX_SESSIONS_UPPER_BOUND}）`);
  return DEFAULT_MAX_SESSIONS;
}

export function loadConsoleConfig(root = process.env.AGENT_AUTOLOOP_HOME) {
  if (!root) throw new Error('请设置 AGENT_AUTOLOOP_HOME 为试点数据目录');
  const file = path.join(root, 'config.json');
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`读不到 ${file}：${error.message}`); }
  if (!config.url || !config.owner) throw new Error(`${file} 缺少中台地址或本人密钥`);
  const hubUrl = new URL(config.url);
  if (!['http:', 'https:'].includes(hubUrl.protocol)) throw new Error('中台地址只支持 HTTP 或 HTTPS');
  const maxSessionsIssueText = maxSessionsIssue(config.maxSessions);
  return {
    root,
    hubUrl: hubUrl.toString().replace(/\/$/, ''),
    ownerKey: config.owner,
    // 调度会话全局上限（1–12）：越界回退 6 + 告警；告警原因透出给控制台如实展示。
    maxSessions: resolveMaxSessions(config.maxSessions, maxSessionsIssueText),
    maxSessionsWarning: maxSessionsIssueText,
    // 事件 API 用 source 密钥认证；缺失时保持 null，由调用处 fail closed，绝不回退 owner 密钥。
    sourceKey: typeof config.source?.key === 'string' && config.source.key ? config.source.key : null,
    rulesFile: path.join(root, 'rules.json'),
    cliPath: path.join(root, 'app', 'bin', 'agent-autoloop.ts'),
    host: '127.0.0.1',
    port: Number(process.env.AUTOLOOP_CONSOLE_PORT || 0),
    // 语音转写：本机 whisper CLI 路径与模型，可由 config.json 的 whisper 字段覆盖。
    whisper: {
      path: typeof config.whisper?.path === 'string' && config.whisper.path ? config.whisper.path : DEFAULT_WHISPER_PATH,
      model: typeof config.whisper?.model === 'string' && config.whisper.model ? config.whisper.model : DEFAULT_WHISPER_MODEL,
    },
    projectRoots: (process.env.AUTOLOOP_PROJECT_ROOTS || '').split(/[,:]/).map(item => item.trim()).filter(Boolean),
  };
}
