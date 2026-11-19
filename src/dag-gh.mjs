// DAG publish 的生产 gh 适配器：只封装授权快照内允许的 PR 动作（查询/创建/合并/关闭）。
// 参数由控制器/from run.json 提供，不接收浏览器输入；runner 可注入以便 CI 离线测试。
// 必须实现 closePr：publish 换 attempt 发新 PR 时关闭被替代的旧 PR，缺此方法会 TypeError。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseClaims } from './review-claim.mjs';

const execFileAsync = promisify(execFile);
const defaultRunner = (command, args, options = {}) => execFileAsync(command, args, options);
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PR_URL = /^https?:\/\/[^\s"'<>]+$/;
const text = value => String(value ?? '').trim();

const branchOf = branch => {
  const value = text(branch);
  if (!BRANCH.test(value)) throw new Error(`分支名无效（只允许 [A-Za-z0-9][A-Za-z0-9._/-]*）：${value}`);
  return value;
};
const urlOf = url => {
  const value = text(url);
  if (!PR_URL.test(value)) throw new Error(`PR 链接无效（拒绝空白/控制字符）：${value}`);
  return value;
};

export function createGhAdapter({ runner = defaultRunner, cwd, gh = 'gh' } = {}) {
  const run = async args => {
    const { stdout } = await runner(gh, args, cwd == null ? {} : { cwd });
    return text(stdout ?? '');
  };
  const listArgs = ({ branch, base }) => {
    const args = ['pr', 'list', '--head', branchOf(branch), '--state', 'open', '--json', 'url,number'];
    if (base) args.push('--base', branchOf(base));
    return args;
  };
  return {
    async findPr(input = {}) {
      const rows = JSON.parse(await run(listArgs(input)) || '[]');
      return rows.length ? urlOf(rows[0].url) : null;
    },
    // gh 非交互式要求 --title 与 --body 同时存在；缺 --body 时 gh 直接报 usage 并失败，
    // 因此没有调用方文案时也要给一段默认说明，不能省略该参数。
    async createPr({ branch, title, base, body } = {}) {
      const head = branchOf(branch);
      const subject = text(title) || head;
      const args = ['pr', 'create', '--head', head, '--title', subject, '--body', text(body) || `由 DAG 控制器自动发布：${subject}`];
      if (base) args.push('--base', branchOf(base));
      return urlOf((await run(args)).split('\n').pop().trim());
    },
    async prHead(url) {
      return text(JSON.parse(await run(['pr', 'view', urlOf(url), '--json', 'headRefOid'])).headRefOid);
    },
    // 当前有效的审阅占位持有者（无占位为 null）；合并前由 publisher 判断是否他人正在审阅。
    async claimHolder(url) {
      const pr = JSON.parse(await run(['pr', 'view', urlOf(url), '--json', 'comments']) || '{}');
      return parseClaims(pr.comments, Date.now()).active?.holder ?? null;
    },
    async mergePr(url, { strategy = 'squash' } = {}) {
      if (strategy !== 'squash') throw new Error(`DAG publish 只允许 squash 合并，拒绝 ${strategy}`);
      await run(['pr', 'merge', urlOf(url), '--squash']);
      return {};
    },
    async closePr(url, { comment } = {}) {
      const args = ['pr', 'close', urlOf(url)];
      if (comment) args.push('--comment', text(comment).slice(0, 1000));
      await run(args);
      return { url: urlOf(url) };
    },
  };
}
