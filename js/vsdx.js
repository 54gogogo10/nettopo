/* ============================================================
 * NetTopo vsdx.js —— 导出 Visio VSDX（Visio 2013+ 原生格式）
 *
 * VSDX = OPC 包（ZIP），结构参照真实 Visio 保存的文件：
 *   - Shape 使用扁平 <Cell N='PinX' V='...'/> 形式
 *   - 几何用 RelMoveTo/RelLineTo（相对 0..1）
 *   - 文本为 <Text> 混合内容，&#10; 换行
 *   - 连线标注用独立的 2D 文本框形状（Angle=0，永远水平）
 * 零依赖：内置 store 模式 ZIP 写入器 + CRC32。
 * 纯函数 buildVSDX(graph, opts) → Uint8Array，可在 Node 中测试。
 * ============================================================ */
(function (global) {
'use strict';
const U = global.TopoUtil;

/* ================= CRC32 ================= */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ================= Store ZIP 写入器 ================= */
function buildZip(entries) {
  // entries: [{name, data(Uint8Array)}]
  const enc = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;

  const dosTime = () => {
    const d = new Date(2024, 0, 1, 0, 0, 0);
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  };
  const dosDate = () => {
    const d = new Date(2024, 0, 1);
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  };

  const u16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
  const u32 = (v) => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];

  for (const e of entries) {
    const nameB = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const time = dosTime(), date = dosDate();

    const local = new Uint8Array(30 + nameB.length + data.length);
    local.set([0x50, 0x4B, 0x03, 0x04], 0);          // PK\x03\x04
    local.set(u16(20), 4);                            // version
    local.set(u16(0x0800), 6);                        // flags: UTF-8
    local.set(u16(0), 8);                             // method: store
    local.set(u16(time), 10);
    local.set(u16(date), 12);
    local.set(u32(crc), 14);
    local.set(u32(data.length), 18);                  // compressed size
    local.set(u32(data.length), 22);                  // uncompressed size
    local.set(u16(nameB.length), 26);
    local.set(u16(0), 28);                            // extra len
    local.set(nameB, 30);
    local.set(data, 30 + nameB.length);
    locals.push(local);

    const cd = new Uint8Array(46 + nameB.length);
    cd.set([0x50, 0x4B, 0x01, 0x02], 0);              // PK\x01\x02
    cd.set(u16(20), 4);                               // version made by
    cd.set(u16(20), 6);                               // version needed
    cd.set(u16(0x0800), 8);                           // flags
    cd.set(u16(0), 10);                               // method
    cd.set(u16(time), 12);
    cd.set(u16(date), 14);
    cd.set(u32(crc), 16);
    cd.set(u32(data.length), 20);
    cd.set(u32(data.length), 24);
    cd.set(u16(nameB.length), 28);
    cd.set(u16(0), 30);                               // extra
    cd.set(u16(0), 32);                               // comment
    cd.set(u16(0), 34);                               // disk
    cd.set(u16(0), 36);                               // int attrs
    cd.set(u32(0), 38);                               // ext attrs
    cd.set(u32(offset), 42);                          // local offset
    cd.set(nameB, 46);
    central.push(cd);
    offset += local.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  eocd.set([0x50, 0x4B, 0x05, 0x06], 0);             // PK\x05\x06
  eocd.set(u16(0), 4);                                // disk
  eocd.set(u16(0), 6);                                // cd disk
  eocd.set(u16(entries.length), 8);
  eocd.set(u16(entries.length), 10);
  eocd.set(u32(cdSize), 12);
  eocd.set(u32(offset), 16);
  eocd.set(u16(0), 20);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of locals) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

/* ================= 图片嵌入工具 ================= */
function b64ToBytes(b64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const map = {};
  for (let i = 0; i < chars.length; i++) map[chars[i]] = i;
  b64 = String(b64).replace(/=+$/, '');
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of b64) {
    if (map[ch] === undefined) continue;
    buf = (buf << 6) | map[ch];
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}
function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = mime.indexOf('png') >= 0 ? 'png' : mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0 ? 'jpg' : null;
  if (!ext) return null;
  return { bytes: b64ToBytes(m[2]), mime, ext };
}

/* ================= XML 工具 ================= */
const X = (v) => U.escXml(String(v));
const XRAW = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cell = (n, v, extra) => `<Cell N='${n}' V='${v}'${extra ? ' ' + extra : ''}/>`;
const ROW_REL = (t, ix, x, y) =>
  `<Row T='${t}' IX='${ix}'><Cell N='X' V='${x}'/><Cell N='Y' V='${y}'/></Row>`;

/* ================= VSDX 构建 ================= */
function buildVSDX(graph, opts) {
  opts = opts || {};
  const scale = opts.scale || 1 / 96;
  const margin = opts.margin != null ? opts.margin : 0.5;
  const pageName = opts.pageName || '网络拓扑图';
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  const IN = (v) => Math.round(v * 1000) / 1000;

  /* ---- 页面尺寸 ---- */
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  for (const t of (graph.texts || [])) {
    minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + (t.w || 160)); maxY = Math.max(maxY, t.y + (t.h || 40));
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
  const pad = margin / scale;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const pw = Math.max((maxX - minX) * scale, 8.5);
  const ph = Math.max((maxY - minY) * scale, 11);
  const Y = (y) => ph - (y - minY) * scale;

  /* ---- ID ---- */
  let sid = 2;
  const nodeShape = new Map();
  for (const n of nodes) nodeShape.set(n.id, sid++);
  const linkShape = new Map();
  for (const l of links) linkShape.set(l.id, sid++);

  /* ---- 形状 ---- */
  const shapes = [];

  // 设备
  const imageParts = new Map(); // dataURL -> {rId, idx, ext, bytes}
  let imgSid = 30000;
  for (const n of nodes) {
    const t = U.getType(n.type);
    const cx = (n.x + n.w / 2 - minX) * scale;
    const cy = Y(n.y + n.h / 2);
    const w = n.w * scale, h = n.h * scale;
    const id = nodeShape.get(n.id);
    // 自定义类型图片：以 Foreign 图片形状叠加在设备图标区（左上 6px、宽 44px、垂直居中）
    if (t && t.img) {
      const parsed = parseDataUrl(t.img);
      if (parsed) {
        let part = imageParts.get(t.img);
        if (!part) {
          const idx = imageParts.size + 1;
          part = { rId: 'rIdImg' + idx, idx, ext: parsed.ext, bytes: parsed.bytes };
          imageParts.set(t.img, part);
        }
        const imgW = 44 * scale, imgH = (n.h - 12) * scale;
        const pinX = (n.x - minX) * scale + 28 * scale; // 图标中心 x = 左边界 + 28px
        const pinY = cy; // 图标垂直居中
        const isid = imgSid++;
        shapes.push(`    <Shape ID='${isid}' Type='Foreign' LineStyle='0' FillStyle='0' TextStyle='0'>
      ${cell('PinX', IN(pinX))}
      ${cell('PinY', IN(pinY))}
      ${cell('Width', IN(imgW))}
      ${cell('Height', IN(imgH))}
      ${cell('LocPinX', IN(imgW / 2), "F='Width*0.5'")}
      ${cell('LocPinY', IN(imgH / 2), "F='Height*0.5'")}
      ${cell('Angle', 0)}
      ${cell('FlipX', 0)}
      ${cell('FlipY', 0)}
      ${cell('ResizeMode', 0)}
      ${cell('ImgOffsetX', 0, "F='ImgWidth*0'")}
      ${cell('ImgOffsetY', 0, "F='ImgHeight*0'")}
      ${cell('ImgWidth', IN(imgW), "F='Width*1'")}
      ${cell('ImgHeight', IN(imgH), "F='Height*1'")}
      <Cell N='ClippingPath' V='' F='""' E='#N/A'/>
      ${cell('TxtPinX', IN(imgW / 2), "F='Width*0.5'")}
      ${cell('TxtPinY', 0, "F='Height*0'")}
      ${cell('TxtWidth', IN(imgW), "F='Width*1'")}
      ${cell('TxtHeight', 0, "F='Height*0'")}
      ${cell('TxtLocPinX', IN(imgW / 2), "F='TxtWidth*0.5'")}
      ${cell('TxtLocPinY', 0, "F='TxtHeight*0.5'")}
      ${cell('TxtAngle', 0)}
      ${cell('VerticalAlign', 0)}
      <Section N='Geometry' IX='0'>
        ${cell('NoFill', 0)}
        ${cell('NoLine', 0)}
        ${cell('NoShow', 0)}
        ${cell('NoSnap', 0)}
        ${ROW_REL('RelMoveTo', 1, 0, 0)}
        ${ROW_REL('RelLineTo', 2, 1, 0)}
        ${ROW_REL('RelLineTo', 3, 1, 1)}
        ${ROW_REL('RelLineTo', 4, 0, 1)}
        ${ROW_REL('RelLineTo', 5, 0, 0)}
      </Section>
      <ForeignData ForeignType='Bitmap' CompressionType='${part.ext === 'jpg' ? 'JPEG' : 'PNG'}'><Rel r:id='${part.rId}'/></ForeignData>
    </Shape>`);
      }
    }
    shapes.push(`    <Shape ID='${id}' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>
      ${cell('PinX', IN(cx))}
      ${cell('PinY', IN(cy))}
      ${cell('Width', IN(w))}
      ${cell('Height', IN(h))}
      ${cell('LocPinX', IN(w / 2), "F='Width*0.5'")}
      ${cell('LocPinY', IN(h / 2), "F='Height*0.5'")}
      ${cell('Angle', 0)}
      ${cell('FlipX', 0)}
      ${cell('FlipY', 0)}
      ${cell('ResizeMode', 0)}
      ${cell('Para.HorzAlign', 1)}
      ${cell('VerticalAlign', 1)}
      ${cell('FillForegnd', t.c1)}
      ${cell('FillBkgnd', t.c2)}
      ${cell('FillPattern', 1)}
      ${cell('LineWeight', 0.01)}
      ${cell('LineColor', t.stroke)}
      ${cell('LinePattern', 1)}
      ${cell('Rounding', 0.08)}
      <Section N='Geometry' IX='0'>
        ${cell('NoFill', 0)}
        ${cell('NoLine', 0)}
        ${cell('NoShow', 0)}
        ${cell('NoSnap', 0)}
        ${ROW_REL('RelMoveTo', 1, 0, 0)}
        ${ROW_REL('RelLineTo', 2, 1, 0)}
        ${ROW_REL('RelLineTo', 3, 1, 1)}
        ${ROW_REL('RelLineTo', 4, 0, 1)}
        ${ROW_REL('RelLineTo', 5, 0, 0)}
      </Section>
      <Section N='Character'>
        <Row IX='0'>
          ${cell('Font', 1)}
          ${cell('Color', '#FFFFFF')}
          ${cell('Size', 0.1667)}
          ${cell('Style', 1)}
        </Row>
      </Section>
      <Text><cp IX='0'/><pp IX='0'/>${XRAW(n.name)}${(n.mgmt || '').trim() ? '\r\n管理: ' + XRAW(n.mgmt) : ''}\r\n</Text>
    </Shape>`);
  }

  // 连线（纯线，无文本）+ 独立文本框；双链路文本框垂直错开避免重叠
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  const labelBoxes = [];

  // 按无向设备对分组（平行链路错开标注）
  const pairIdx = new Map();
  const pairCount = new Map();
  for (const l of links) {
    const k = l.a < l.b ? l.a + '|' + l.b : l.b + '|' + l.a;
    pairIdx.set(l.id, pairCount.get(k) || 0);
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }

  // 连线几何复用 linkGeom（含平行链路偏移），与画布显示完全一致
  const geom = U.linkGeom(nodes, links);
  for (const l of links) {
    const a = byId[l.a], b = byId[l.b];
    if (!a || !b) continue;
    const g = geom[l.id];
    if (!g) continue;
    const bx = (g.x1 - minX) * scale, by = Y(g.y1);
    const ex = (g.x2 - minX) * scale, ey = Y(g.y2);
    const len = Math.hypot(ex - bx, ey - by);
    const mx = (bx + ex) / 2, my = (by + ey) / 2;
    const id = linkShape.get(l.id);

    // 独立 2D 文本框（永远水平）：先收集，全部算完后统一防碰撞
    const lines = opts.showLabels === false ? [] : U.labelLines(l);
    if (lines.length) {
      const FONT = 10; // pt
      const tw = Math.max(0.7, U.measureText(lines.reduce((a, b) => a.length > b.length ? a : b, ''), FONT) / 96 + 0.3);
      const th = 0.17 * lines.length + 0.10;
      const ux = len > 0.01 ? (ex - bx) / len : 0;
      const uy = len > 0.01 ? (ey - by) / len : 0;
      const pairOff = (pairIdx.get(l.id) || 0) * 0.7;
      labelBoxes.push({
        id: id + 10000,
        x: mx + ux * 0.1,
        y: my + uy * 0.1 + 0.35 + pairOff,
        w: tw, h: th, text: lines.join('\n')
      });
    }

    // 连线用 2-D 直线形状（Pin + Angle 旋转 + 直线几何）：
    // 裸 1-D 动态连接线在 Visio 中渲染不可靠（多连线时端点不跟随/线被截短），
    // 2-D 方式与节点一致，保证线严格按 Begin/End 方向正确绘制、按带宽着色。
    const angle = Math.atan2(ey - by, ex - bx);
    shapes.push(`    <Shape ID='${id}' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>
      ${cell('PinX', IN(mx))}
      ${cell('PinY', IN(my))}
      ${cell('Width', IN(len))}
      ${cell('Height', 0.02)}
      ${cell('LocPinX', IN(len / 2))}
      ${cell('LocPinY', 0.01)}
      ${cell('Angle', IN(angle))}
      ${cell('FlipX', 0)}
      ${cell('FlipY', 0)}
      ${cell('ResizeMode', 0)}
      ${cell('LineWeight', 0.025)}
      ${cell('LineColor', U.bwColor(l.bw))}
      ${cell('LinePattern', 1)}
      ${cell('BeginArrow', 0)}
      ${cell('EndArrow', 0)}
      <Section N='Geometry' IX='0'>
        ${cell('NoFill', 1)}
        ${cell('NoLine', 0)}
        ${cell('NoShow', 0)}
        ${cell('NoSnap', 0)}
        <Row T='MoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row>
        <Row T='LineTo' IX='2'><Cell N='X' V='${IN(len)}'/><Cell N='Y' V='0'/></Row>
      </Section>
    </Shape>`);
  }

  // 标注防碰撞：推开重叠的文本框后再生成
  if (labelBoxes.length) {
    U.resolveLabelCollisions(labelBoxes, {
      pad: 0.08,
      obstacles: nodes.map(n => ({ x: (n.x - minX) * scale, y: Y(n.y + n.h), w: n.w * scale, h: n.h * scale }))
    });
  }
  for (const lb of labelBoxes) {
    const tw = lb.w, th = lb.h, tpx = lb.x, tpy = lb.y, tid = lb.id;
    const text = lb.text;
    // 每行用 <pp> 段落标记分隔（与节点两行文字一致），否则 Visio 会把多行叠在同一行
    const textRuns = "<cp IX='0'/><pp IX='0'/>" + text.split('\n').map(XRAW).join('\r\n') + '\r\n';
    shapes.push(`    <Shape ID='${tid}' Type='Shape' NameU='Label${tid}' Name='标注'>
      ${cell('PinX', IN(tpx))}
      ${cell('PinY', IN(tpy))}
      ${cell('Width', tw)}
      ${cell('Height', th)}
      ${cell('LocPinX', tw / 2, "F='Width*0.5'")}
      ${cell('LocPinY', th / 2, "F='Height*0.5'")}
      ${cell('Angle', 0)}
      ${cell('FlipX', 0)}
      ${cell('FlipY', 0)}
      ${cell('ResizeMode', 0)}
      ${cell('Para.HorzAlign', 1)}
      ${cell('VerticalAlign', 1)}
      ${cell('FillPattern', 0)}
      ${cell('LinePattern', 0)}
      <Section N='Geometry' IX='0'>
        ${cell('NoFill', 1)}
        ${cell('NoLine', 1)}
        ${cell('NoShow', 0)}
        ${ROW_REL('RelMoveTo', 1, 0, 0)}
        ${ROW_REL('RelLineTo', 2, 1, 0)}
        ${ROW_REL('RelLineTo', 3, 1, 1)}
        ${ROW_REL('RelLineTo', 4, 0, 1)}
        ${ROW_REL('RelLineTo', 5, 0, 0)}
      </Section>
      <Section N='Character'>
        <Row IX='0'>
          ${cell('Font', 1)}
          ${cell('Color', '#334155')}
          ${cell('Size', 0.139)}
          ${cell('Style', 0)}
        </Row>
      </Section>
      <Text>${textRuns}</Text>
    </Shape>`);
  }

  // 画布文本框（自定义字体样式）
  {
    let tsid = 50000;
    for (const t of (graph.texts || [])) {
      const tw = (t.w || 160) * scale, th = (t.h || 40) * scale;
      const tpx = (t.x + (t.w || 160) / 2 - minX) * scale;
      const tpy = Y(t.y + (t.h || 40) / 2);
      const size = t.size || 16;
      const style = (t.bold ? 1 : 0) | (t.italic ? 2 : 0);
      const hAlign = t.align === 'center' ? 1 : (t.align === 'right' ? 2 : 0);
      const textRuns = "<cp IX='0'/><pp IX='0'/>" + String(t.text || '').split('\n').map(XRAW).join('\r\n') + '\r\n';
      shapes.push(`    <Shape ID='${tsid++}' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>
      ${cell('PinX', IN(tpx))}
      ${cell('PinY', IN(tpy))}
      ${cell('Width', IN(tw))}
      ${cell('Height', IN(th))}
      ${cell('LocPinX', IN(tw / 2), "F='Width*0.5'")}
      ${cell('LocPinY', IN(th / 2), "F='Height*0.5'")}
      ${cell('Angle', 0)}
      ${cell('FlipX', 0)}
      ${cell('FlipY', 0)}
      ${cell('ResizeMode', 0)}
      ${cell('Para.HorzAlign', hAlign)}
      ${cell('VerticalAlign', 0)}
      ${cell('FillPattern', t.bg ? 1 : 0)}
      ${cell('FillForegnd', t.bg || '#ffffff')}
      ${cell('LinePattern', 0)}
      <Section N='Geometry' IX='0'>
        ${cell('NoFill', t.bg ? 0 : 1)}
        ${cell('NoLine', 1)}
        ${cell('NoShow', 0)}
        ${cell('NoSnap', 0)}
        ${ROW_REL('RelMoveTo', 1, 0, 0)}
        ${ROW_REL('RelLineTo', 2, 1, 0)}
        ${ROW_REL('RelLineTo', 3, 1, 1)}
        ${ROW_REL('RelLineTo', 4, 0, 1)}
        ${ROW_REL('RelLineTo', 5, 0, 0)}
      </Section>
      <Section N='Character'>
        <Row IX='0'>
          ${cell('Font', 1)}
          ${cell('Color', t.color || '#1e293b')}
          ${cell('Size', IN(size / 96))}
          ${cell('Style', style)}
        </Row>
      </Section>
      <Text>${textRuns}</Text>
    </Shape>`);
    }
  }

  // 带宽图例：颜色标识带宽大小（不显示带宽文字）
  {
    const bwSet = new Map();
    for (const l of links) { const n = U.normalizeBw(l.bw); if (n && !bwSet.has(n)) bwSet.set(n, U.bwColor(n)); }
    if (bwSet.size) {
      let lx = 0.5, ly = 0.5;
      const sorted = [...bwSet.entries()].sort((a, b) => b[0] - a[0]);
      sorted.forEach((entry, i) => {
        const n = entry[0], color = entry[1];
        const lsid = 40000 + i * 2;
        shapes.push(`    <Shape ID='${lsid}' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>
      ${cell('PinX', IN(lx + 0.35))}
      ${cell('PinY', IN(ly))}
      ${cell('Width', 0.7)}
      ${cell('Height', 0.02)}
      ${cell('LocPinX', 0.35)}
      ${cell('LocPinY', 0.01)}
      ${cell('Angle', 0)}
      ${cell('FlipX', 0)}
      ${cell('FlipY', 0)}
      ${cell('ResizeMode', 0)}
      ${cell('LineWeight', 0.025)}
      ${cell('LineColor', color)}
      ${cell('LinePattern', 1)}
      <Section N='Geometry' IX='0'>
        ${cell('NoFill', 1)}
        ${cell('NoLine', 0)}
        ${cell('NoShow', 0)}
        ${cell('NoSnap', 0)}
        <Row T='MoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row>
        <Row T='LineTo' IX='2'><Cell N='X' V='0.7'/><Cell N='Y' V='0'/></Row>
      </Section>
    </Shape>`);
        const tsid = lsid + 1;
        const lab = U.formatBw(n);
        shapes.push(`    <Shape ID='${tsid}' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>
      ${cell('PinX', IN(lx + 0.95))}
      ${cell('PinY', IN(ly))}
      ${cell('Width', 0.9)}
      ${cell('Height', 0.25)}
      ${cell('LocPinX', 0.45)}
      ${cell('LocPinY', 0.125)}
      ${cell('Angle', 0)}
      ${cell('FlipX', 0)}
      ${cell('FlipY', 0)}
      ${cell('ResizeMode', 0)}
      ${cell('FillPattern', 0)}
      ${cell('LinePattern', 0)}
      <Section N='Geometry' IX='0'>
        ${cell('NoFill', 1)}
        ${cell('NoLine', 1)}
        ${cell('NoShow', 0)}
        ${cell('NoSnap', 0)}
        ${ROW_REL('RelMoveTo', 1, 0, 0)}
        ${ROW_REL('RelLineTo', 2, 1, 0)}
        ${ROW_REL('RelLineTo', 3, 1, 1)}
        ${ROW_REL('RelLineTo', 4, 0, 1)}
        ${ROW_REL('RelLineTo', 5, 0, 0)}
      </Section>
      <Section N='Character'>
        <Row IX='0'>
          ${cell('Font', 1)}
          ${cell('Color', '#334155')}
          ${cell('Size', 0.111)}
          ${cell('Style', 0)}
        </Row>
      </Section>
      <Text><cp IX='0'/><pp IX='0'/>${XRAW(lab)}\r\n</Text>
    </Shape>`);
        ly += 0.35;
      });
    }
  }

  // 2-D 直线不参与动态粘合（避免 Visio 对裸 1-D 连接线渲染不可靠），
  // 端点已直接落在设备边框上（anchorPoint 计算）。
  const connects = '';

  /* ---- 部件 ---- */
  const enc = new TextEncoder();
  const entry = (name, xml) => ({ name, data: xml instanceof Uint8Array ? xml : enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml) });

  const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${[...imageParts.values()].map(p => `<Default Extension="${p.ext}" ContentType="${p.ext === 'jpg' ? 'image/jpeg' : 'image/png'}"/>`).join('')}
<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>
<Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>
<Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>
<Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  const relsRoot = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const coreProps = `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${X(pageName)}</dc:title>
<dc:creator>NetTopo</dc:creator>
<cp:lastModifiedBy>NetTopo</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00Z</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">2024-01-01T00:00:00Z</dcterms:modified>
</cp:coreProperties>`;

  const appProps = `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Microsoft Visio</Application>
<DocSecurity>0</DocSecurity>
<ScaleCrop>false</ScaleCrop>
<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Pages</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>
<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${X(pageName)}</vt:lpstr></vt:vector></TitlesOfParts>
<Company>NetTopo</Company>
<LinksUpToDate>false</LinksUpToDate>
<SharedDoc>false</SharedDoc>
<HyperlinksChanged>false</HyperlinksChanged>
<AppVersion>16.0000</AppVersion>
</Properties>`;

  const docXml = `<VisioDocument xmlns='http://schemas.microsoft.com/office/visio/2012/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships' xml:space='preserve'>
<DocumentSettings TopPage='0' DefaultTextStyle='0' DefaultLineStyle='0' DefaultFillStyle='0' DefaultGuideStyle='0'>
<GlueSettings>9</GlueSettings>
<SnapSettings>15</SnapSettings>
<SnapExtensions>34</SnapExtensions>
<DynamicGridEnabled>1</DynamicGridEnabled>
</DocumentSettings>
<Colors>
<ColorEntry IX='0' RGB='#000000'/>
<ColorEntry IX='1' RGB='#FFFFFF'/>
</Colors>
<FaceNames>
<FaceName NameU='Arial' UnicodeRanges='-536859905 -1073711037 9 0' CharSets='1073742335 -65536' Panose='2 11 6 4 2 2 2 2 2 4' Flags='325'/>
<FaceName NameU='Microsoft YaHei' UnicodeRanges='-536859905 -1073711037 9 0' CharSets='1073742335 -65536' Panose='2 1 6 0 3 1 1 1 1 1' Flags='325'/>
</FaceNames>
<StyleSheets>
<StyleSheet ID='0' NameU='No Style' Name='No Style' IsCustomNameU='1' IsCustomName='1'>
<Cell N='EnableLineProps' V='1'/>
<Cell N='EnableFillProps' V='1'/>
<Cell N='EnableTextProps' V='1'/>
<Cell N='HideForApply' V='0'/>
<Cell N='LineWeight' V='0.01'/>
<Cell N='LineColor' V='0'/>
<Cell N='LinePattern' V='1'/>
<Cell N='BeginArrow' V='0'/>
<Cell N='EndArrow' V='0'/>
<Cell N='FillForegnd' V='1'/>
<Cell N='FillBkgnd' V='0'/>
<Cell N='FillPattern' V='1'/>
<Cell N='Char.Size' V='0.1667'/>
<Cell N='Char.Color' V='0'/>
<Cell N='Char.Font' V='1'/>
</StyleSheet>
</StyleSheets>
<DocumentSheet NameU='TheDoc' ID='0'>
<Cell N='PageWidth' V='${IN(pw)}'/>
<Cell N='PageHeight' V='${IN(ph)}'/>
</DocumentSheet>
</VisioDocument>`;

  const docRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/>
<Relationship Id="rId2" Type="http://schemas.microsoft.com/visio/2010/relationships/windows" Target="windows.xml"/>
</Relationships>`;

  const pagesXml = `<Pages xmlns='http://schemas.microsoft.com/office/visio/2012/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships' xml:space='preserve'>
<Page ID='0' NameU='Page-1' Name='${X(pageName)}'>
<PageSheet LineStyle='0' FillStyle='0' TextStyle='0'>
<Cell N='PageWidth' V='${IN(pw)}'/>
<Cell N='PageHeight' V='${IN(ph)}'/>
<Cell N='PageScale' V='1'/>
<Cell N='DrawingScale' V='1'/>
<Cell N='DrawingSizeType' V='3'/>
<Cell N='DrawingScaleType' V='3'/>
<Cell N='InhibitSnap' V='0'/>
</PageSheet>
<Rel r:id='rId1'/>
</Page>
</Pages>`;

  const pagesRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page1.xml"/>
</Relationships>`;

  const page1 = `<PageContents xmlns='http://schemas.microsoft.com/office/visio/2012/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships' xml:space='preserve'>
<Shapes>
${shapes.join('\n')}
</Shapes>
${connects ? `<Connects>
${connects}
</Connects>` : ''}
</PageContents>`;

  const windowsXml = `<Windows ClientWidth='1280' ClientHeight='720' xmlns='http://schemas.microsoft.com/office/visio/2012/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships' xml:space='preserve'>
<Window ID='0' WindowType='Drawing' WindowState='1073741824' WindowLeft='0' WindowTop='0' WindowWidth='1280' WindowHeight='720' ContainerType='Page' Page='0' ViewScale='1' ViewCenterX='0' ViewCenterY='0'>
<ShowRulers>1</ShowRulers>
<ShowGrid>1</ShowGrid>
<ShowPageBreaks>0</ShowPageBreaks>
<ShowGuides>1</ShowGuides>
<ShowConnectionPoints>0</ShowConnectionPoints>
<GlueSettings>9</GlueSettings>
<SnapSettings>15</SnapSettings>
<SnapExtensions>34</SnapExtensions>
<TabSplitterPos>0.5</TabSplitterPos>
</Window>
</Windows>`;

  const entries = [
    entry('[Content_Types].xml', contentTypes),
    entry('_rels/.rels', relsRoot),
    entry('docProps/core.xml', coreProps),
    entry('docProps/app.xml', appProps),
    entry('visio/document.xml', docXml),
    entry('visio/_rels/document.xml.rels', docRels),
    entry('visio/pages/pages.xml', pagesXml),
    entry('visio/pages/_rels/pages.xml.rels', pagesRels),
    entry('visio/pages/page1.xml', page1),
    ...(imageParts.size ? [
      entry('visio/pages/_rels/page1.xml.rels', [...imageParts.values()].map(p =>
        `<Relationship Id="${p.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${p.idx}.${p.ext}"/>`).join('\n')),
      ...[...imageParts.values()].map(p => entry(`visio/media/image${p.idx}.${p.ext}`, p.bytes))
    ] : []),
    entry('visio/windows.xml', windowsXml)
  ];

  return buildZip(entries);
}

global.TopoVsdx = { buildVSDX };
})(typeof globalThis !== 'undefined' ? globalThis : this);
