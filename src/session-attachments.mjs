// 会话附件：大小/数量/文件名安全校验、会话目录落盘与提示词上下文。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SchedulingSessionError } from './scheduling-session.mjs';

export const MAX_ATTACHMENT_FILES = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 12 * 1024 * 1024;
const TEXT_BYTES = 32 * 1024;
const TEXT_CHARS = 1200;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.mjs', '.js', '.ts', '.css', '.html', '.csv', '.yaml', '.yml', '.xml', '.log']);
const fail = message => { throw new SchedulingSessionError(message, { status: 400 }); };
const safeName = value => {
  const name = path.basename(String(value || '')).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return name || 'attachment.bin';
};
const safeType = value => /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(String(value || '')) ? String(value).toLowerCase() : 'application/octet-stream';

export function saveSessionAttachments(root, sessionId, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  if (attachments.length > MAX_ATTACHMENT_FILES) fail(`附件最多 ${MAX_ATTACHMENT_FILES} 个`);
  if (!/^[A-Za-z0-9._:-]+$/.test(String(sessionId || ''))) fail('会话标识无效');
  const directory = path.join(root, 'session-attachments', sessionId, randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let total = 0;
  const saved = [];
  for (const item of attachments) {
    const name = safeName(item?.name);
    const type = safeType(item?.type);
    const encoded = String(item?.dataBase64 || '');
    if (!encoded) fail(`附件 ${name} 为空`);
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) fail(`附件 ${name} 的内容编码无效`);
    const bytes = Buffer.from(encoded.replace(/\r?\n/g, ''), 'base64');
    if (!bytes.length) fail(`附件 ${name} 为空`);
    if (Number.isInteger(item?.size) && item.size !== bytes.length) fail(`附件 ${name} 的大小校验失败`);
    if (bytes.length > MAX_ATTACHMENT_BYTES) fail(`附件 ${name} 超过 ${MAX_ATTACHMENT_BYTES} 字节`);
    total += bytes.length;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) fail('附件总大小超限');
    const real = path.join(directory, name);
    writeFileSync(real, bytes, { flag: 'wx', mode: 0o600 });
    saved.push({ name, type, size: bytes.length, path: real });
  }
  return saved;
}

export function attachmentPrompt(saved) {
  if (!Array.isArray(saved) || !saved.length) return '';
  const lines = ['本次消息附带以下文件；需要查看附件时可按绝对路径读取：'];
  for (const file of saved) {
    lines.push(`- ${file.name}（${file.type}，${file.size} 字节）：${file.path}`);
    if (file.type.startsWith('text/') || TEXT_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
      const text = readFileSync(file.path, 'utf8').slice(0, TEXT_CHARS);
      lines.push(`  文本附件内容（最多 ${TEXT_CHARS} 字）：\n${text}`);
    }
  }
  return lines.join('\n');
}
