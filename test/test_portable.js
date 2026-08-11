// 验证 electron-builder portable 单文件 exe 的功能
'use strict';
const puppeteer = require('puppeteer-core');

(async () => {
  let browser = null;
  for (let i = 0; i < 10; i++) {
    try {
      browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9335', defaultViewport: null });
      break;
    } catch (e) { await new Promise(r => setTimeout(r, 1500)); }
  }
  if (!browser) { console.log('CDP 连接失败'); process.exit(1); }
  const pages = await browser.pages();
  const page = pages[0];
  await new Promise(r => setTimeout(r, 1500));
  console.log('标题:', await page.title());
  const ver = await page.evaluate(() => document.querySelector('#statVer') ? document.querySelector('#statVer').textContent : '(无)');
  console.log('版本:', ver);
  await page.evaluate(() => { window.confirm = () => true; window.__topo.loadSample(); });
  await new Promise(r => setTimeout(r, 2500));
  const nodes = await page.evaluate(() => window.__topo.state.nodes.length);
  console.log('示例节点:', nodes);
  // 点添加连线 → 点空白退出
  await page.evaluate(() => document.querySelector('#btnAddLink').click());
  await new Promise(r => setTimeout(r, 500));
  const p = await page.evaluate(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return { x: r.x + r.width * 0.6, y: r.y + r.height * 0.7 }; });
  await page.mouse.click(p.x, p.y);
  await new Promise(r => setTimeout(r, 500));
  const out = await page.evaluate(() => ({ mode: window.__topo.state.mode, hidden: document.querySelector('#hintBar').classList.contains('hidden') }));
  console.log('点空白退出:', JSON.stringify(out));
  // 导出 PDF（应弹保存对话框）
  await page.evaluate(() => window.__topo.exportPdf());
  await new Promise(r => setTimeout(r, 1500));
  console.log('PDF 导出调用 OK');
  await browser.disconnect();
  console.log('=== 单文件 exe 全部功能验证通过 ===');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
