import { loadConsoleConfig } from '../src/config.mjs';
import { createConsoleServer } from '../src/server.mjs';
const config = loadConsoleConfig();
const server = createConsoleServer(config);
server.on('error', error => { console.error(`控制台启动失败：${error.message}`); process.exitCode = 1; });
server.listen(config.port, config.host, () => {
  console.log(`Autoloop 控制台：http://${config.host}:${server.address().port}`);
  console.log(`连接中台：${config.hubUrl}`);
  console.log('仅本机可访问；按 Ctrl+C 停止。');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
