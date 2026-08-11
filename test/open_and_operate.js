// 打开可见 Chrome 窗口，自动执行操作流程，窗口保持开启
'use strict';
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const root = 'D:/pi/top/nettopo';

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(root, p);
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      });
    });
    server.on('error', () => resolve(null)); // 端口被占用则复用现有服务
    server.listen(8765, () => resolve(server));
  });
}

(async () => {
  const mine = await startServer();
  console.log('服务就绪: http://localhost:8765');

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: false,
    userDataDir: 'D:/pi/top/nettopo/test/_chrome_profile',
    args: ['--window-size=1680,1000', '--no-sandbox', '--start-maximized']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 950 });
  await page.goto('http://localhost:8765/', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => { window.confirm = () => true; window.__topo.loadSample(); });
  await new Promise(r => setTimeout(r, 2500));
  console.log('页面已打开，示例已加载');

  // 1) 进入连线模式
  await page.evaluate(() => document.querySelector('#btnAddLink').click());
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: 'D:/pi/top/nettopo/test/op_step1_mode.png' });
  console.log('步骤1: 已进入连线模式（提示条+倒计时显示，截图 op_step1_mode.png）');

  // 2) 点画布空白退出
  const p = await page.evaluate(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return { x: r.x + r.width * 0.7, y: r.y + r.height * 0.75 }; });
  await page.mouse.click(p.x, p.y);
  await new Promise(r => setTimeout(r, 800));
  const s1 = await page.evaluate(() => ({ mode: window.__topo.state.mode, hidden: document.querySelector('#hintBar').classList.contains('hidden') }));
  await page.screenshot({ path: 'D:/pi/top/nettopo/test/op_step2_blank.png' });
  console.log('步骤2: 点空白后 → 模式=' + s1.mode + ' 提示条隐藏=' + s1.hidden);

  // 3) 再进模式，点 ✕ 退出
  await page.evaluate(() => document.querySelector('#btnAddLink').click());
  await new Promise(r => setTimeout(r, 600));
  const hb = await page.evaluate(() => { const r = document.querySelector('#hintBar .hb-x').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(hb.x, hb.y);
  await new Promise(r => setTimeout(r, 800));
  const s2 = await page.evaluate(() => ({ mode: window.__topo.state.mode, hidden: document.querySelector('#hintBar').classList.contains('hidden') }));
  await page.screenshot({ path: 'D:/pi/top/nettopo/test/op_step3_x.png' });
  console.log('步骤3: 点✕后 → 模式=' + s2.mode + ' 提示条隐藏=' + s2.hidden);

  // 4) 再进模式，等倒计时自动消失
  await page.evaluate(() => document.querySelector('#btnAddLink').click());
  await new Promise(r => setTimeout(r, 4200));
  const s3 = await page.evaluate(() => ({ hidden: document.querySelector('#hintBar').classList.contains('hidden') }));
  console.log('步骤4: 倒计时结束后提示条隐藏=' + s3.hidden);

  console.log('');
  console.log('==============================================');
  console.log('  Chrome 窗口保持打开，您可以亲自操作验证');
  console.log('  截图: test/op_step1_mode.png ~ op_step3_x.png');
  console.log('==============================================');
  // 保持窗口 120 秒供用户查看
  await new Promise(r => setTimeout(r, 120000));
  await browser.close();
  if (mine) mine.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
