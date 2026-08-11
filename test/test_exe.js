// 验证打包后的 NetTopo.exe：启动 → CDP 连接 → 功能测试
'use strict';
const puppeteer = require('puppeteer-core');
const { spawn, execSync } = require('child_process');

(async () => {
  const exe = 'D:/pi/top/nettopo/dist/NetTopo-win32-x64/NetTopo.exe';
  const child = spawn(exe, ['--remote-debugging-port=9333'], { stdio: 'ignore' });
  console.log('exe 已启动, PID:', child.pid);
  await new Promise(r => setTimeout(r, 6000));

  // 连接 CDP
  let browser = null;
  for (let i = 0; i < 10; i++) {
    try {
      browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null });
      break;
    } catch (e) { await new Promise(r => setTimeout(r, 1500)); }
  }
  if (!browser) { console.log('CDP 连接失败'); child.kill(); process.exit(1); }

  const pages = await browser.pages();
  console.log('窗口数:', pages.length);
  const page = pages[0];
  await new Promise(r => setTimeout(r, 1500));
  const title = await page.title();
  console.log('页面标题:', title);
  const ver = await page.evaluate(() => document.querySelector('#statVer') ? document.querySelector('#statVer').textContent : '(无)');
  console.log('版本:', ver);

  // 加载示例
  await page.evaluate(() => { window.confirm = () => true; window.__topo.loadSample(); });
  await new Promise(r => setTimeout(r, 2500));
  const nodes = await page.evaluate(() => window.__topo.state.nodes.length);
  console.log('示例节点数:', nodes);

  // 连线模式 → 点空白退出
  await page.evaluate(() => document.querySelector('#btnAddLink').click());
  await new Promise(r => setTimeout(r, 500));
  const p = await page.evaluate(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return { x: r.x + r.width * 0.7, y: r.y + r.height * 0.75 }; });
  await page.mouse.click(p.x, p.y);
  await new Promise(r => setTimeout(r, 500));
  const out = await page.evaluate(() => ({ mode: window.__topo.state.mode, hidden: document.querySelector('#hintBar').classList.contains('hidden') }));
  console.log('点空白退出:', JSON.stringify(out));

  // 导出 PDF（下载弹窗会被触发——验证不崩溃）
  await page.evaluate(() => window.__topo.exportPdf());
  await new Promise(r => setTimeout(r, 1500));
  console.log('PDF 导出调用 OK（应弹出保存对话框）');

  // 截图
  await page.screenshot({ path: 'test/exe_render.png' });
  console.log('截图: test/exe_render.png');
  await browser.disconnect();
  child.kill();
  console.log('验证完成');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
