// 浏览器完整流程导出 PDF 并保存样本
'use strict';
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--disable-gpu', '--no-sandbox']
  });
  const page = await browser.newPage();
  const fs = require('fs');
  // 拦截下载
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: 'D:/pi/top/nettopo/test' });

  await page.goto('file:///D:/pi/top/nettopo/test/e2e.html', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => { window.confirm = () => true; window.__topo.loadSample(); });
  await new Promise(r => setTimeout(r, 2000));

  // 直接调用导出（绕过下载，拿 blob 内容）
  const pdfBase64 = await page.evaluate(async () => {
    const svg = TopoPdf.buildSvgImage({ nodes: window.__topo.state.nodes, links: window.__topo.state.links }, {});
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL('image/jpeg', 0.92);
    const jbin = atob(jpeg.split(',')[1]);
    const bytes = new Uint8Array(jbin.length);
    for (let i = 0; i < jbin.length; i++) bytes[i] = jbin.charCodeAt(i);
    const pdf = TopoPdf.buildImagePDF(bytes, canvas.width, canvas.height, {});
    const arr = Array.from(pdf);
    let pbin = '';
    const CH = 0x8000;
    for (let i = 0; i < arr.length; i += CH) pbin += String.fromCharCode.apply(null, arr.slice(i, i + CH));
    return btoa(pbin);
  });

  fs.writeFileSync('sample_topology.pdf', Buffer.from(pdfBase64, 'base64'));
  console.log('PDF 已保存: sample_topology.pdf');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
