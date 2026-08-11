const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--disable-gpu', '--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file:///D:/pi/top/nettopo/test/e2e.html', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => { window.confirm = () => true; window.__topo.loadSample(); });
  await new Promise(r => setTimeout(r, 2000));
  const r = await page.evaluate(() => {
    const n = window.__topo.state.nodes.length;
    const svg = TopoPdf.buildSvgImage(window.__topo.state.nodes, window.__topo.state.links, {});
    return { nodes: n, svgLen: svg.length };
  });
  console.log(JSON.stringify(r));
  await browser.close(); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
