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
  const regions = graph.regions || [];
  const M = 60; // 边距 px

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  for (const t of (graph.texts || [])) {
    minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + (t.w || 160)); maxY = Math.max(maxY, t.y + (t.h || 40));
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
  const W = Math.ceil(maxX - minX + M * 2), H = Math.ceil(maxY - minY + M * 2);
  const X = (px) => px - minX + M, Y = (py) => py - minY + M;

  const esc = U.escXml;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);

  // 区域分组容器（设备底层背景框：浅色填充 + 虚线边 + 左上角标题）
  for (const r of regions) {
    const color = r.color || '#6366f1';
    const inside = nodes.filter(n =>
      n.x + n.w / 2 > r.x && n.x + n.w / 2 < r.x + r.w &&
      n.y + n.h / 2 > r.y && n.y + n.h / 2 < r.y + r.h).length;
    parts.push(`<rect x="${X(r.x)}" y="${Y(r.y)}" width="${r.w}" height="${r.h}" rx="14" fill="${color}" fill-opacity="0.06"/>`);
    parts.push(`<rect x="${X(r.x) + 0.5}" y="${Y(r.y) + 0.5}" width="${r.w - 1}" height="${r.h - 1}" rx="14" fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="10 6"/>`);
    parts.push(`<text x="${X(r.x) + 14}" y="${Y(r.y) + 30}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="13" font-weight="bold" fill="${color}" stroke="rgba(255,255,255,.55)" stroke-width="3" paint-order="stroke">${esc(r.name)}${inside ? ' · ' + inside + ' 台' : ''}</text>`);
  }

  // 连线（平行偏移；opts.ortho 时走直角折线）——坐标必须与节点一样经过 minX/minY 归一化！
  const geom = U.linkGeom(nodes, links, { ortho: !!(opts && opts.ortho) });
  for (const l of links) {
    const g = geom[l.id];
    if (!g) continue;
    if (g.pts) {
      const ptsAttr = g.pts.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
      parts.push(`<polyline points="${ptsAttr}" fill="none" stroke="${U.bwColor(l.bw)}" stroke-width="2"/>`);
    } else {
      parts.push(`<line x1="${X(g.x1).toFixed(1)}" y1="${Y(g.y1).toFixed(1)}" x2="${X(g.x2).toFixed(1)}" y2="${Y(g.y2).toFixed(1)}" stroke="${U.bwColor(l.bw)}" stroke-width="2"/>`);
    }
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
    const lines = opts.showLabels === false ? [] : U.labelLines(l).map(s => U.truncate(s, 40));
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
    // SVG 坐标系 Y 向下：节点矩形左上角为 (X(n.x), Y(n.y))。
    // （旧写法用底边 Y(n.y + n.h)，障碍物整体下移一个节点高度，导致覆盖在节点上的标注不被推开）
    obstacles: nodes.map(n => ({ x: X(n.x), y: Y(n.y), w: n.w, h: n.h }))
  });
  for (let i = 0; i < labels.length; i++) {
    const lb = labels[i], ld = labelData[i];
    const cx = lb.x, cy = lb.y;
    ld.lines.forEach((ln, k) => {
      const y = cy + (ld.lines.length / 2 - k - 0.5) * SIZE * 1.2;
      parts.push(`<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${SIZE}" fill="#334155" text-anchor="middle">${esc(ln)}</text>`);
    });
  }

  // 文本框（自定义字体样式）
  for (const t of (graph.texts || [])) {
    const x = X(t.x), y = Y(t.y), w = t.w || 160, h = t.h || 40;
    if (t.bg) parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${t.bg}"/>`);
    const anchor = t.align === 'center' ? 'middle' : (t.align === 'right' ? 'end' : 'start');
    const tx = t.align === 'center' ? x + w / 2 : (t.align === 'right' ? x + w : x + 8);
    const size = t.size || 16;
    String(t.text || '').split('\n').forEach((ln, i) => {
      parts.push(`<text x="${tx}" y="${y + size + 6 + i * size * 1.25}" font-family="${esc(t.font || 'Microsoft YaHei')}" font-size="${size}" fill="${t.color || '#1e293b'}" font-weight="${t.bold ? '700' : '400'}" font-style="${t.italic ? 'italic' : 'normal'}" text-anchor="${anchor}">${esc(ln)}</text>`);
    });
  }

  // 节点
  for (const n of nodes) {
    const t = U.getType(n.type);
    const x = X(n.x), y = Y(n.y), w = n.w, h = n.h;
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${t.c1}" stroke="${t.stroke}" stroke-width="1.5"/>`);
    const cx = x + w / 2, cy = y + h / 2;
    const hasMgmt = !!(n.mgmt || '').trim();
    // 超长设备名截断：SVG text 无裁剪直接溢出绘制，200 字符名会压盖相邻设备（画布上有 _fitName，导出同口径收敛）
    parts.push(`<text x="${cx}" y="${hasMgmt ? cy - 11 : cy - 4}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="13.5" font-weight="bold" fill="#ffffff" text-anchor="middle">${esc(U.truncate(n.name, 40))}</text>`);
    parts.push(`<text x="${cx}" y="${hasMgmt ? cy + 5 : cy + 15}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="10" fill="rgba(255,255,255,0.8)" text-anchor="middle">${esc(t.label)}</text>`);
    if (hasMgmt) {
      parts.push(`<text x="${cx}" y="${cy + 19}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="10" fill="rgba(255,255,255,0.7)" text-anchor="middle">管理: ${esc(U.truncate(U.nodeMgmts(n).join(', '), 60))}</text>`);
    }
  }

  // 带宽图例（颜色标识带宽大小）
  const bwSet = new Map();
  for (const l of links) { const n = U.normalizeBw(l.bw); if (n && !bwSet.has(n)) bwSet.set(n, U.bwColor(n)); }
  if (bwSet.size) {
    const entries = [...bwSet.entries()].sort((a, b) => b[0] - a[0]);
    let lx = 14;
    parts.push(`<text x="${lx}" y="${H - 22}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="10" fill="#64748b">带宽：</text>`);
    lx += 34;
    for (const [n, color] of entries) {
      const lab = U.formatBw(n);
      parts.push(`<line x1="${lx}" y1="${H - 18}" x2="${lx + 16}" y2="${H - 18}" stroke="${color}" stroke-width="3"/>`);
      parts.push(`<text x="${lx + 22}" y="${H - 14}" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="10" fill="#334155">${esc(lab)}</text>`);
      lx += 22 + U.measureText(lab, 10) + 14;
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
