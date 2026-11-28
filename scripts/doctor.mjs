import { runDoctor, formatReport } from '../src/doctor.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const index = args.indexOf('--phase');
const phase = index >= 0 ? args[index + 1] : undefined;
const unknown = args.filter((arg, i) => !['--json', '--phase'].includes(arg) && args[i - 1] !== '--phase');
if (!['local', 'public'].includes(phase) || unknown.length) {
  console.error('用法：node scripts/doctor.mjs --phase local|public [--json]（--phase 必填）');
  process.exit(2);
}
try {
  const report = await runDoctor({ phase });
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exitCode = report.exitCode;
} catch (error) {
  console.error(`自检异常：${error.message}`);
  process.exitCode = 1;
}
