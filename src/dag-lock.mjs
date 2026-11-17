// 每 run 控制器进程锁（启动占位）：O_EXCL 创建锁文件写入 pid；持锁进程已死则接管。
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export function acquireControllerLock({ directory, runId, pid = process.pid } = {}) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${runId}.controller.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(pid)); closeSync(fd);
      return { acquired: true, file, release() { try { if (readFileSync(file, 'utf8') === String(pid)) unlinkSync(file); } catch { /* 已释放 */ } } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(readFileSync(file, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return { acquired: false, reason: `run ${runId} 已有控制器在运行（pid ${holder}）` };
      try { unlinkSync(file); } catch { /* 他人已接管，重试 */ }
    }
  }
  return { acquired: false, reason: `run ${runId} 已有控制器在运行（接管竞争失败）` };
}
