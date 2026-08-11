/* ============================================================
 * NetTopo pdf.js —— 导出 PDF（图片嵌入方案，文字 100% 可靠显示）
 *   buildSvgImage(): 生成纯属性 SVG（无 CSS 依赖，供 canvas 渲染）
 *   buildImagePDF(): 把 JPEG 嵌入单页 PDF（手写 PDF，DCTDecode）
 * 纯函数，可在 Node 中测试。
 * ============================================================ */
(function (global) {
'use strict';
const U = global.TopoUtil;

/* ---------- 导出用 SVG（矢量，纯属性） ---------- */
function buildSvgImage(graph, opts) {
  opts = opts || {};
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  const M = 60; // 边距 px

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
  const W = Math.ceil(maxX - minX + M * 2), H = Math.ceil(maxY - minY + M * 2);
  const X = (px) => px - minX + M, Y = (py) => py - minY + M;

  const esc = U.escXml;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);

  // 连线（平行偏移）——坐标必须与节点一样经过 minX/minY 归一化！
  const geom = U.linkGeom(nodes, links);
  for (const l of links) {
    const g = geom[l.id];
    if (!g) continue;
    parts.push(`<line x1="${X(g.x1).toFixed(1)}" y1="${Y(g.y1).toFixed(1)}" x2="${X(g.x2).toFixed(1)}" y2="${Y(g.y2).toFixed(1)}" stroke="#8fa0b8" stroke-width="2"/>`);
  }

  // 标注（三行，先算位置再防碰撞推开）
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const pairIdx = new Map(), pairCount = new Map();
  for (const l of links) {
    const k = l.a < l.b ? l.a + '|' + l.b : l.b + '|' + l.a;
    pairIdx.set(l.id, pairCount.get(k) || 0);
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }
  const SIZE = 13;
  const labels = [];
  const labelData = [];
  for (const l of links) {
    const g = geom[l.id];
    if (!g) continue;
    const lines = U.labelLines(l);
    if (!lines.length) continue;
    const mx = X((g.x1 + g.x2) / 2), my = Y((g.y1 + g.y2) / 2);
    const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
    const len = Math.hypot(dx, dy) || 1;
    const pairOff = (pairIdx.get(l.id) || 0) * 67;
    const cx = mx + dx / len * 10;
    const cy = my + dy / len * 10 - 34 - pairOff;
    const maxLine = lines.reduce((a, b) => a.length > b.length ? a : b, '');
    labels.push({ x: cx, y: cy, w: U.measureText(maxLine, SIZE) + 12, h: lines.length * SIZE * 1.2 + 4 });
    labelData.push({ lines, cx, cy });
  }
  U.resolveLabelCollisions(labels, {
    pad: 6,
    obstacles: nodes.map(n => ({ x: X(n.x), y: Y(n.y + n.h), w: n.w, h: n.h }))
  });
  for (let i = 0; i < labels.length; i++) {
    const lb = labels[i], ld = labelData[i];
    const cx = lb.x, cy = lb.y;
    ld.lines.forEach((ln, k) => {
      const y = cy + (ld.lines.length / 2 - k - 0.5) * SIZE * 1.2;
      parts.push(`<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${SIZE}" fill="#334155" text-anchor="middle">${esc(ln)}</text>`);
    });
  }

  // 节点
  for (const n of nodes) {
    const t = U.getType(n.type);
    const x = X(n.x), y = Y(n.y), w = n.w, h = n.h;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${t.c1}" stroke="${t.stroke}" stroke-width="1.5"/>`);
    const cx = x + w / 2, cy = y + h / 2;
    const hasMgmt = !!(n.mgmt || '').trim();
    parts.push(`<text x="${cx}" y="${hasMgmt ? cy - 11 : cy - 4}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="13.5" font-weight="bold" fill="#ffffff" text-anchor="middle">${esc(n.name)}</text>`);
    parts.push(`<text x="${cx}" y="${hasMgmt ? cy + 5 : cy + 15}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="10" fill="rgba(255,255,255,0.8)" text-anchor="middle">${esc(t.label)}</text>`);
    if (hasMgmt) {
      parts.push(`<text x="${cx}" y="${cy + 19}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="10" fill="rgba(255,255,255,0.7)" text-anchor="middle">管理: ${esc(n.mgmt)}</text>`);
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/* ---------- JPEG → 单页 PDF（字节级组装） ---------- */
function buildImagePDF(jpegBytes, widthPx, heightPx, opts) {
  opts = opts || {};
  const W = Math.round(widthPx), H = Math.round(heightPx);
  const enc = new TextEncoder();

  const imgObj = `<</Type/XObject/Subtype/Image/Width ${W}/Height ${H}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpegBytes.length}>>\nstream\n`;
  const contentStream = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`;
  const contentObj = `<</Length ${enc.encode(contentStream).length}>>\nstream\n${contentStream}endstream`;

  // 对象顺序：1 Catalog, 2 Pages, 3 Page, 4 XObject(JPEG), 5 Contents
  const objTexts = [
    `<</Type/Catalog/Pages 2 0 R>>`,
    `<</Type/Pages/Kids[3 0 R]/Count 1>>`,
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${W} ${H}]/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>`,
    imgObj,
    contentObj
  ];

  const chunks = [];
  const offsets = [];
  let pos = 0;
  const pushStr = (s) => { const b = enc.encode(s); chunks.push(b); pos += b.length; };

  pushStr('%PDF-1.4\n');
  for (let i = 0; i < 5; i++) {
    offsets.push(pos);
    pushStr(`${i + 1} 0 obj\n${objTexts[i]}`);
    if (i === 3) {
      chunks.push(jpegBytes); pos += jpegBytes.length;   // JPEG 二进制
      pushStr('\nendstream\nendobj\n');
    } else {
      pushStr('\nendobj\n');
    }
  }
  const xrefPos = pos;
  pushStr(`xref\n0 6\n0000000000 65535 f \n`);
  for (const o of offsets) pushStr(String(o).padStart(10, '0') + ' 00000 n \n');
  pushStr(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

global.TopoPdf = { buildSvgImage, buildImagePDF };
})(typeof globalThis !== 'undefined' ? globalThis : this);
