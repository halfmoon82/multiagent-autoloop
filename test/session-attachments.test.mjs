import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveSessionAttachments, attachmentPrompt, MAX_ATTACHMENT_BYTES } from '../src/session-attachments.mjs';

const root = () => mkdtempSync(path.join(tmpdir(), 'session-attachments-'));

test('文本与图片附件落盘，提示词含文本内容、图片路径和元信息', t => {
  const dir = root(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = saveSessionAttachments(dir, 'session-1', [
    { name: '../需求.md', type: 'text/markdown', dataBase64: Buffer.from('请支持附件').toString('base64') },
    { name: '截图.png', type: 'image/png', dataBase64: Buffer.from([1, 2, 3]).toString('base64') },
  ]);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].name, '需求.md');
  assert.equal(readFileSync(saved[0].path, 'utf8'), '请支持附件');
  assert.deepEqual(readFileSync(saved[1].path), Buffer.from([1, 2, 3]));
  const prompt = attachmentPrompt(saved);
  assert.match(prompt, /请支持附件/);
  assert.match(prompt, /截图\.png/);
  assert.match(prompt, /image\/png/);
  assert.ok(prompt.includes(saved[1].path));
});

test('附件数量、大小、编码和会话 id 全部 fail closed', t => {
  const dir = root(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => saveSessionAttachments(dir, 'bad/id', [{ name: 'a.txt', dataBase64: 'YQ==' }]), /会话标识/);
  assert.throws(() => saveSessionAttachments(dir, 's', [{ name: 'a.txt', dataBase64: '***' }]), /编码/);
  assert.throws(() => saveSessionAttachments(dir, 's', [{ name: 'a.txt', dataBase64: '' }]), /为空/);
  const huge = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1).toString('base64');
  assert.throws(() => saveSessionAttachments(dir, 's', [{ name: 'a.bin', dataBase64: huge }]), /超过/);
});
