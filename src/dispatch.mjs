import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class DispatchError extends Error {
  constructor(message, { status = 400 } = {}) { super(message); this.name = 'DispatchError'; this.status = status; }
}

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_AGENT = 'Codex ACP';
const text = (value, label, { required = true, max = 4000 } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new DispatchError(`缺少字段：${label}`);
    return '';
  }
  if (typeof value !== 'string') throw new DispatchError(`${label} 必须是字符串`);
  const out = value.trim();
  if (required && !out) throw new DispatchError(`缺少字段：${label}`);
  if (out.length > max) throw new DispatchError(`${label} 不能超过 ${max} 字`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(out)) throw new DispatchError(`${label} 不能包含控制字符`);
  return out;
};

export function validateDispatchInput(body = {}) {
  const subject = text(body.subject, 'subject', { max: 64 });
  if (!SUBJECT.test(subject)) throw new DispatchError('subject 必须是无空格的稳定 ASCII 标识（字母数字开头，仅含字母数字 . _ -）');
  if (subject.includes('..') || subject.endsWith('.lock') || subject.endsWith('.')) throw new DispatchError('subject 不能作为分支名（含 ..、.lock 后缀或以 . 结尾）');
  return {
    subject,
    summary: text(body.summary, 'summary', { max: 500 }),
    detail: text(body.detail, 'detail', { required: false, max: 20000 }),
    project: text(body.project, 'project', { max: 1024 }),
    model: text(body.model, 'model', { max: 128 }),
    agent: text(body.agent, 'agent', { required: false, max: 64 }) || DEFAULT_AGENT,
  };
}

const defaultGit = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout));
});

export function buildWorkerPrompt(task) {
  return [
    `你是 ${task.project} 上由调度会话派发的 worker，任务标识 ${task.subject}。`,
    `你的工作目录是独立 worktree ${task.worktree}（分支 ${task.branch}），只在此范围内修改与提交；禁止触碰 main 与其他 worktree，禁止合并、禁止直推 main。`,
    `【任务摘要】${task.summary}`,
    task.detail ? `【详细说明】\n${task.detail}` : '',
    `【费用】如需上报用量，请只报告你自己统计到的真实数字，不要估算。`,
  ].filter(Boolean).join('\n');
}

// 任务登记：每个任务一个 JSON 文件落在 <root>/dispatch-tasks/，重启后重载。
export function createDispatcher({ root, sessions, git = defaultGit, now = () => new Date() } = {}) {
  if (!root) throw new Error('dispatch 需要运行目录 root');
  const dir = path.join(root, 'dispatch-tasks');
  const tasks = new Map();
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try { const task = JSON.parse(readFileSync(path.join(dir, name), 'utf8')); if (task?.id) tasks.set(task.id, task); } catch { /* 跳过损坏文件 */ }
    }
  } catch { /* 目录尚不存在 */ }

  const save = task => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${task.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(task, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  const touch = task => { task.updatedAt = now().toISOString(); save(task); return task; };
  const pub = task => ({ ...task, cost: { ...task.cost } });
  const fail = (task, error) => { task.status = 'failed'; task.error = String(error?.message || error).replace(/[\r\n]+/g, ' '); touch(task); };

  return {
    list: () => [...tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(pub),
    get(id) { const task = tasks.get(id); if (!task) throw new DispatchError('派发任务不存在', { status: 404 }); return pub(task); },
    async dispatch(input) {
      const project = path.resolve(input.project);
      if ([...tasks.values()].some(t => t.project === project && t.subject === input.subject)) throw new DispatchError(`项目 ${project} 已有同名任务 ${input.subject}`, { status: 409 });
      const createdAt = now().toISOString();
      const task = {
        id: randomUUID(), subject: input.subject, summary: input.summary, detail: input.detail, project,
        agent: input.agent, model: input.model, status: 'pending', sessionId: null, error: null,
        branch: `feat/${input.subject}`, worktree: path.join(project, '.worktrees', input.subject),
        cost: { status: 'unreported' }, createdAt, updatedAt: createdAt,
      };
      tasks.set(task.id, task); save(task);
      try { await git(project, ['worktree', 'add', task.worktree, '-b', task.branch]); }
      catch (error) { fail(task, error); throw new DispatchError(`创建 worktree 失败：${task.error}`, { status: 502 }); }
      try {
        const session = await sessions.start({ kind: 'normal', profile: 'worker', project: task.worktree, prompt: buildWorkerPrompt(task), model: task.model });
        task.sessionId = session.id; task.status = 'running'; touch(task);
      } catch (error) { fail(task, error); throw new DispatchError(`启动 worker 会话失败：${task.error}`, { status: 502 }); }
      return pub(task);
    },
    // 只信 Agent 自报：控制台绝不估算费用。
    async reportCost(id, report = {}) {
      const task = tasks.get(id);
      if (!task) throw new DispatchError('派发任务不存在', { status: 404 });
      const out = { status: 'reported' };
      for (const key of ['tokens', 'costUsd']) {
        if (report[key] === undefined) continue;
        if (typeof report[key] !== 'number' || !Number.isFinite(report[key]) || report[key] < 0) throw new DispatchError(`${key} 必须是非负数字`);
        out[key] = report[key];
      }
      if (out.tokens === undefined && out.costUsd === undefined) throw new DispatchError('费用上报需包含 tokens 或 costUsd');
      task.cost = out; touch(task);
      return pub(task);
    },
  };
}
