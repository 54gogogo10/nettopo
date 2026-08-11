const puppeteer = require('puppeteer-core');
const fs = require('fs');
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--disable-gpu', '--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto('file:///D:/pi/top/nettopo/test/e2e.html', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 500));
  const before = await page.evaluate(() => window.__topo ? window.__topo.state.nodes.length : 'no-hook');
  console.log('loadSample 前 nodes:', before);
  await page.evaluate(() => { window.confirm = () => true; window.__topo.loadSample(); });
  await new Promise(r => setTimeout(r, 2500));
  const after = await page.evaluate(() => ({ nodes: window.__topo.state.nodes.length, links: window.__topo.state.links.length }));
  console.log('loadSample 后:', JSON.stringify(after));
  await browser.close(); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
