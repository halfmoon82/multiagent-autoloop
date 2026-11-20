// nomoto-rename 节点（dev g1a1）边界测试：
// 仅把移动端壳的展示文案统一为 NoMoTo；appId、接口路径与设备授权逻辑零变化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'app');
const read = rel => readFileSync(path.join(APP_DIR, rel), 'utf8');

// RED 1：安装后桌面图标名 / appName 统一为 NoMoTo，appId 原样保留。
test('capacitor.config.json：appName=NoMoTo 且 appId 不变', () => {
  const config = JSON.parse(read('capacitor.config.json'));
  assert.equal(config.appName, 'NoMoTo', '安装后桌面图标名需为 NoMoTo');
  assert.equal(config.appId, 'cool.autoloop.console', 'appId 必须保持不变，保证覆盖安装与已绑定设备不丢');
  assert.equal(config.webDir, 'www');
});

// RED 2：manifest 名称统一为 NoMoTo。
test('manifest.webmanifest：name 与 short_name 均为 NoMoTo', () => {
  const manifest = JSON.parse(read('www/manifest.webmanifest'));
  assert.equal(manifest.name, 'NoMoTo');
  assert.equal(manifest.short_name, 'NoMoTo');
});

// RED 3：App 内标题与品牌区使用 NoMoTo，不再出现「Autoloop 控制台」。
test('index.html：标题与两处品牌区统一为 NoMoTo', () => {
  const html = read('www/index.html');
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
  assert.match(title, /NoMoTo/, 'App 内标题需含 NoMoTo');
  assert.ok(!html.includes('Autoloop 控制台'), '不得再出现「Autoloop 控制台」');

  const brands = [...html.matchAll(/<div class="brand">([\s\S]*?)<\/div>\s*<\/div>/g)].map(m => m[1]);
  assert.ok(brands.length >= 2, '锁定页与主界面两处品牌区都要重命名');
  for (const brand of brands) {
    assert.match(brand, /NoMoTo/, '品牌区需含 NoMoTo');
    assert.ok(!/Autoloop/.test(brand), '品牌区不得残留 Autoloop');
  }
});

// RED 4：文案以外的行为零变化——HTTPS 方案、绑定协议与固定 API 清单仍在。
test('文案以外的行为零变化：appId、绑定协议与固定 API 清单仍在', () => {
  const config = JSON.parse(read('capacitor.config.json'));
  assert.equal(config.server?.androidScheme, 'https');
  const shell = read('www/shell.mjs');
  assert.match(shell, /autoloop:\/\/bind/, '设备绑定协议不得改动');
  assert.match(shell, /MOBILE_API_KEYS/, '固定 API 清单不得改动');
});
