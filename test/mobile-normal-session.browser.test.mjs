import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createConsoleServer } from '../src/server.mjs';
import { createDeviceStore } from '../src/device-auth.mjs';
import { fakeHub, json, listen, close } from './helpers.mjs';

const skip = existsSync(chromium.executablePath()) ? false : '未安装 Playwright Chromium';

test('普通会话不伪造问题区，消息可见且可直接发送', { skip }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-normal-ui-'));
  const rulesFile = path.join(root,'rules.json'); writeFileSync(rulesFile,JSON.stringify({sources:{},agents:{},rules:[]}));
  const calls=[];
  const record={id:'normal-1',sessionId:'normal-1',kind:'normal',title:'普通会话',project:'/work/移动控制台',status:'idle',statusText:'待命',agent:'Codex',model:'GPT',prompt:'普通会话测试',messages:[{role:'agent',text:'这是普通会话的真实回复。',at:'2026-11-23T09:00:00Z'}],queue:[],queued:[],queuedCount:0,liveText:'',busy:false,createdAt:'2026-11-23T09:00:00Z',updatedAt:'2026-11-23T09:00:00Z'};
  const sessions={async list(){return[record]},async listArchived(){return[]},async send(id,text,opts){calls.push({id,text,opts});return record;}};
  const hub=await fakeHub((req,res)=>json(res,req.url==='/v1/state'?{runs:[],cards:[],lines:[],spending:{}}:{ok:true}));
  const deviceAuth=createDeviceStore({file:path.join(root,'device-auth.json')});
  const server=createConsoleServer({hubUrl:hub.url,ownerKey:'secret',host:'127.0.0.1',root,rulesFile,deviceAuth,projectRoots:[]},sessions);
  const url=await listen(server);const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await close(server);await close(hub.server);rmSync(root,{recursive:true,force:true});});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(()=>{let stored=null;window.AutoloopSecureStorage={async get(){return stored;},async set(v){stored=v;},async remove(){stored=null;}};window.AutoloopBiometric={async verify(){return true;}};});
  await page.goto(`${url}/mobile/`);await page.locator('#bind-payload').fill(deviceAuth.createBinding().qrPayload);await page.locator('#bind-submit').click();await page.locator('#unlock').click();await page.locator('[data-tab="sessions"]').click();await page.locator('.sessions-item').click();
  assert.match(await page.locator('.sessions-message').innerText(), /这是普通会话的真实回复。/);
  assert.equal(await page.locator('text=当前会话没有需要回答的事项').count(), 0, '普通会话不得显示假问题提示');
  await page.locator('.sessions-composer-input').fill('请继续回复');await page.locator('.sessions-composer-input').press('Enter');
  await page.waitForFunction(()=>document.querySelector('.sessions-composer-input').value==='');
  assert.equal(calls.length,1);assert.equal(calls[0].text,'请继续回复');
  await page.locator('.sessions-composer-input').fill('第一行');await page.locator('.sessions-composer-input').press('Shift+Enter');await page.locator('.sessions-composer-input').pressSequentially('第二行');
  assert.equal(await page.locator('.sessions-composer-input').inputValue(), '第一行\n第二行');
  await page.locator('.sessions-composer-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('.sessions-composer-input').value === '');
  assert.equal(calls.length,2);assert.equal(calls[1].text,'第一行\n第二行');
});
