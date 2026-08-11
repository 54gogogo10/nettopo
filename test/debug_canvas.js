// 调试：浏览器内 SVG → canvas 渲染
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--disable-gpu', '--no-sandbox']
  });
  const page = await browser.newPage();
  await page.goto('file:///D:/pi/top/nettopo/test/e2e.html', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => { window.confirm = () => true; window.__topo.loadSample(); });
  await new Promise(r => setTimeout(r, 2000));

  const info = await page.evaluate(async () => {
    const svg = TopoPdf.buildSvgImage(window.__topo.state.nodes, window.__topo.state.links, {});
    const out = { svgLen: svg.length, svgHead: svg.slice(0, 120), svgHasText: svg.includes('<text'), svgHasRect: svg.includes('<rect') };
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    try {
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      out.imgW = img.width; out.imgH = img.height;
      const canvas = document.createElement('canvas');
      canvas.width = img.width * 2; canvas.height = img.height * 2;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      out.canvasW = canvas.width; out.canvasH = canvas.height;
      // 检查 canvas 像素（画了几个不同颜色）
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let colored = 0;
      for (let i = 0; i < d.length; i += 4000) {
        if (!(d[i] === 255 && d[i+1] === 255 && d[i+2] === 255)) colored++;
      }
      out.coloredSamples = colored;
      out.canvasDataUrl = canvas.toDataURL('image/png').slice(0, 50);
    } catch (e) {
      out.err = String(e);
    }
    return out;
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
