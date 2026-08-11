// 真实可见 Chrome 窗口测试：file:// 与 http:// 两种方式
'use strict';
const puppeteer = require('puppeteer-core');

async function test(browser, url, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 950 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => { window.confirm = () => true; window.__topo.loadSample(); });
  await new Promise(r => setTimeout(r, 2200));

  const ver = await page.evaluate(() => document.querySelector('#statVer').textContent);
  // 进连线模式
  await page.evaluate(() => document.querySelector('#btnAddLink').click());
  await new Promise(r => setTimeout(r, 300));
  const mode1 = await page.evaluate(() => window.__topo.state.mode);
  // 真实鼠标点空白
  const p = await page.evaluate(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return { x: r.x + r.width * 0.75, y: r.y + r.height * 0.8 }; });
  await page.mouse.click(p.x, p.y);
  await new Promise(r => setTimeout(r, 400));
  const after1 = await page.evaluate(() => ({ mode: window.__topo.state.mode, hidden: document.querySelector('#hintBar').classList.contains('hidden') }));
  // 再进模式，点提示条 ✕
  await page.evaluate(() => document.querySelector('#btnAddLink').click());
  await new Promise(r => setTimeout(r, 300));
  const hb = await page.evaluate(() => { const r = document.querySelector('#hintBar .hb-x').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.click(hb.x, hb.y);
  await new Promise(r => setTimeout(r, 400));
  const after2 = await page.evaluate(() => ({ mode: window.__topo.state.mode, hidden: document.querySelector('#hintBar').classList.contains('hidden') }));
  // 倒计时自动消失
  await page.evaluate(() => document.querySelector('#btnAddLink').click());
  await new Promise(r => setTimeout(r, 3800));
  const after3 = await page.evaluate(() => ({ hidden: document.querySelector('#hintBar').classList.contains('hidden'), mode: window.__topo.state.mode }));
  await page.screenshot({ path: label + '.png' });
  console.log(`[${label}] 版本=${ver} | 进模式=${mode1} | 点空白→${JSON.stringify(after1)} | 点✕→${JSON.stringify(after2)} | 倒计时→${JSON.stringify(after3)} | 页面错误=${errors.length ? errors.join(';') : '无'}`);
  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: false,           // 真实可见窗口
    args: ['--window-size=1680,1000', '--no-sandbox']
  });
  await test(browser, 'file:///D:/pi/top/nettopo/index.html', 'file_mode');
  await test(browser, 'http://localhost:8765/', 'http_mode');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
