/* ============================================================
 * NetTopo util.js —— 通用工具（纯函数为主，可被 Node 测试）
 * ============================================================ */
(function (global) {
'use strict';

const U = {};

/* 应用发布版本（唯一版本来源；index.html 中的静态版本仅作加载兜底） */
U.APP_VERSION = 'v20260905a';

/* ---------- DOM 快捷 ---------- */
U.$ = (s, el) => (el || document).querySelector(s);
U.$$ = (s, el) => Array.from((el || document).querySelectorAll(s));

/* ---------- ID 生成 ---------- */
const counters = {};
U.uid = (prefix) => {
  counters[prefix] = (counters[prefix] || 0) + 1;
  return prefix + counters[prefix];
};

/* 从已有图中恢复 ID 计数器（页面刷新后避免新 ID 与恢复节点冲突） */
U.seedCounters = (nodes, links, texts, regions) => {
  const scan = (prefix, lists) => {
    let max = 0;
    for (const list of lists) {
      for (const o of (list || [])) {
        const id = o && o.id;
        if (typeof id === 'string' && id.startsWith(prefix)) {
          const n = parseInt(id.slice(prefix.length), 10);
          if (Number.isFinite(n) && n > max) max = n;
        }
      }
    }
    counters[prefix] = max;
  };
  scan('n', [nodes, links]);
  scan('l', [nodes, links]);
  scan('t', [texts]);
  scan('r', [regions]);
};

/* ---------- 字符串 ---------- */
U.escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

U.escXml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '&#10;').replace(/\r/g, '')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // XML 1.0 非法控制字符剔除，防导出文件被 Visio 拒开

U.truncate = (s, n) => {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  if (s.length <= n) return s;
  // 尽量按字符截断
  const cut = s.slice(0, n - 1);
  return cut + '…';
};

U.clamp = (v, a, b) => Math.max(a, Math.min(b, v));

U.fmtSize = (n) => {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
};
U.fmtDateTime = (d) => {
  d = d || new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
};
U.fmtDate = (d) => {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};


/* ---------- ZIP 打包（无压缩 STORE，UTF-8 文件名，供批量导出配置） ---------- */
U.zipFiles = (files) => {
  files = (Array.isArray(files) ? files : []).filter(f => f && typeof f.name === 'string' && f.name.length > 0);
  // 条目名安全校验（zip-slip 生成面防护）：拒绝路径穿越（..）、反斜杠、绝对路径、盘符、NUL
  files = files.filter(f => {
    const n = f.name;
    if (n.indexOf('..') >= 0) return false;
    if (n.indexOf('\\') >= 0) return false;
    if (n.indexOf('\u0000') >= 0) return false;
    if (n.startsWith('/')) return false;
    if (/^[a-zA-Z]:/.test(n)) return false;
    return true;
  });
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const enc = (s) => new TextEncoder().encode(s);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = enc(f.name);
    const dataBuf = enc(String(f.content == null ? '' : f.content));
    const crc = crc32(dataBuf);
    const lh = new Uint8Array(30);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);  // UTF-8 文件名
    dv.setUint16(8, 0, true);       // STORE
    dv.setUint32(14, crc, true);
    dv.setUint32(18, dataBuf.length, true);
    dv.setUint32(22, dataBuf.length, true);
    dv.setUint16(26, nameBuf.length, true);
    parts.push(lh, nameBuf, dataBuf);
    const ch = new Uint8Array(46);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 0x0800, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, dataBuf.length, true);
    cdv.setUint32(24, dataBuf.length, true);
    cdv.setUint16(28, nameBuf.length, true);
    cdv.setUint32(42, offset, true);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + dataBuf.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdStart, true);
  const total = offset + cdSize + 22;
  const all = new Uint8Array(total);
  let pos = 0;
  for (const part of [...parts, ...central, eocd]) { all.set(part, pos); pos += part.length; }
  return all;
};

/* ---------- 下载 ---------- */
U.download = (filename, blob) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
};

/* ---------- 文件读取：自动识别 UTF-8 / GBK ---------- */
U.decodeBytes = (buf) => {
  const bytes = new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    try { return new TextDecoder('gbk').decode(bytes); }
    catch (e2) { return new TextDecoder('utf-8').decode(bytes); }
  }
};

U.readFile = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve({ name: file.name, buffer: fr.result });
  fr.onerror = () => reject(fr.error);
  fr.readAsArrayBuffer(file);
});

/* ---------- CSV 解析（RFC4180 子集，支持引号/换行） ---------- */
U.detectDelim = (text) => {
  const first = text.slice(0, 4000);
  let best = ','; let bestScore = 0;
  for (const d of [',', '\t', ';']) {
    // 按出现总次数计票（而非「含该分隔符的行数」）：100 行各 1 个逗号不应压过 99 行各 10 个分号
    let score = 0;
    for (const line of first.split(/[\n\r]+/)) {
      for (const ch of line) if (ch === d) score++;
    }
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
};

U.parseCSV = (text) => {
  text = text.replace(/^\uFEFF/, '');
  if (!text.trim()) return [];
  const delim = U.detectDelim(text);
  const rows = [];
  let row = [], field = '', q = false;
  const pushF = () => { row.push(field); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      q = true;
    } else if (c === delim) {
      pushF();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushF();
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { pushF(); rows.push(row); }
  return rows;
};

/* ---------- 单元格公式注入防护（Excel/CSV 打开时以 = + - @ 开头会被当公式执行） ---------- */
U.sanitizeCell = (v) => {
  v = v == null ? '' : String(v);
  // 先剔除前导空白/零宽不换行空格/零宽空格再判定：Excel 打开时先 trim 再判定公式，
  // 故 " =1+1"、"\u200B=1+1"（\s 不含 \u200B）都能绕过前缀防护
  const t = v.replace(/^[\s\uFEFF\u200B\u200C\u200D\u2060]+/, '');
  return /^[=+\-@]/.test(t) ? "'" + v : v;
};

/* ---------- CSV 构建（Excel 兼容：带 BOM + 引号转义 + 公式注入防护） ---------- */
U.buildCSV = (rows, opts) => {
  opts = opts || {};
  const delim = opts.delim || ',';
  // 判定加引号的条件必须包含实际分隔符：按 ; / \t 分隔导出时，字段值本身含该字符
  // 却不加引号，导出文件再解析会列错位
  const escRe = new RegExp('["\\r\\n' + String(delim).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ']');
  const esc = (v) => {
    v = U.sanitizeCell(v);
    return escRe.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return '\uFEFF' + rows.map(r => r.map(esc).join(delim)).join('\r\n');
};

/* ---------- 几何 ---------- */
// 从节点中心 (cx,cy) 指向 (ox,oy)，与矩形边框的交点
U.anchorPoint = (cx, cy, hw, hh, ox, oy) => {
  const dx = ox - cx, dy = oy - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  let t = Infinity;
  if (dx !== 0) t = Math.min(t, hw / Math.abs(dx));
  if (dy !== 0) t = Math.min(t, hh / Math.abs(dy));
  t = Math.min(t, 1);
  return { x: cx + dx * t, y: cy + dy * t };
};

U.dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

U.pointSegDist = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return U.dist(px, py, x1, y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = U.clamp(t, 0, 1);
  return U.dist(px, py, x1 + dx * t, y1 + dy * t);
};

// 平行链路偏移 + 两端标签定位。返回每个 link 的完整几何：
// { x1,y1,x2,y2, labelA:{x,y,text}, labelB:{x,y,text}, mid:{x,y,text}, side }
U.linkGeom = (nodes, links, opts) => {
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  // 按无向设备对分组，同一对设备的多条链路做垂直偏移
  const groups = new Map();
  const keyOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  for (const l of links) {
    const k = keyOf(l.a, l.b);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const out = {};
  for (const [k, g] of groups) {
    const [ia, ib] = k.split('|');
    const na = byId[ia], nb = byId[ib];
    if (!na || !nb) continue;
    const cxa = na.x + na.w / 2, cya = na.y + na.h / 2;
    const cxb = nb.x + nb.w / 2, cyb = nb.y + nb.h / 2;
    let dx = cxb - cxa, dy = cyb - cya;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux; // 垂直单位向量
    const kk = g.length;
    g.forEach((l, i) => {
      const off = (i - (kk - 1) / 2) * 16;
      const p1 = U.anchorPoint(cxa, cya, na.w / 2, na.h / 2, cxb, cyb);
      const p2 = U.anchorPoint(cxb, cyb, nb.w / 2, nb.h / 2, cxa, cya);
      const x1 = p1.x + px * off, y1 = p1.y + py * off;
      const x2 = p2.x + px * off, y2 = p2.y + py * off;
      const labA = (l.aIf || '').trim(), labB = (l.bIf || '').trim();
      const ipA = (l.aIp || '').trim(), ipB = (l.bIp || '').trim();
      const t1 = 0.16, t2 = 0.84;
      // 正交（直角）走线：经中转竖直段连接两锚点；平行链路的中转段随序号偏移。
      // 两锚点近等高时退化为直线（pts=null）。x1/y1/x2/y2 始终为端点（消费方兼容）。
      let pts = null;
      if (opts && opts.ortho) {
        const mx = (p1.x + p2.x) / 2 + px * off;
        if (Math.abs(p1.y - p2.y) >= 2) pts = [[x1, y1], [mx, y1], [mx, y2], [x2, y2]];
      }
      out[l.id] = {
        x1, y1, x2, y2, pts,
        labelA: {
          x: x1 + (x2 - x1) * t1 + px * 12,
          y: y1 + (y2 - y1) * t1 + py * 12,
          text: U.truncate([labA, ipA].filter(Boolean).join('  '), 30),
          anchor: 'start'
        },
        labelB: {
          x: x1 + (x2 - x1) * t2 - px * 12,
          y: y1 + (y2 - y1) * t2 - py * 12,
          text: U.truncate([labB, ipB].filter(Boolean).join('  '), 30),
          anchor: 'end'
        },
        mid: {
          x: (x1 + x2) / 2 + px * 8,
          y: (y1 + y2) / 2 + py * 8,
          text: String(l.bw || '').trim() ? U.truncate(String(l.bw), 16) : '',
          anchor: 'middle'
        }
      };
    });
  }
  return out;
};

/* ---------- 设备类型配色与图标 ---------- */
U.TYPES = {
  router:   { key: 'router',   label: '路由器', c1: '#4338ca', c2: '#6366f1', stroke: '#3730a3' },
  switch:   { key: 'switch',   label: '交换机', c1: '#0f766e', c2: '#14b8a6', stroke: '#115e59' },
  firewall: { key: 'firewall', label: '防火墙', c1: '#c2410c', c2: '#f97316', stroke: '#9a3412' },
  server:   { key: 'server',   label: '服务器', c1: '#6d28d9', c2: '#8b5cf6', stroke: '#5b21b6' },
  pc:       { key: 'pc',       label: '终端',   c1: '#0369a1', c2: '#0ea5e9', stroke: '#075985' },
  cloud:    { key: 'cloud',    label: '云/外网', c1: '#334155', c2: '#64748b', stroke: '#1e293b' },
  other:    { key: 'other',    label: '其他',   c1: '#4b5563', c2: '#6b7280', stroke: '#374151' }
};
U.TYPE_ORDER = ['router', 'switch', 'firewall', 'server', 'pc', 'cloud', 'other'];

U.typeOf = (name) => {
  const s = String(name || '').toLowerCase();
  if (/云|internet|互联网|cloud/.test(s)) return 'cloud';
  if (/防火|fw|firewall/.test(s)) return 'firewall';
  // rt 加边界约束（前后不能是英文字母）：裸子串会把 PortChannel1 / support / export 误判为路由器
  if (/路由|router|rtr|(?:^|[^a-z])rt(?![a-z])/.test(s)) return 'router';
  if (/交换|sw|switch/.test(s)) return 'switch';
  if (/服务|srv|server/.test(s)) return 'server';
  if (/pc|终端|主机|电脑|计算机|办公|client|host|打印机|print/.test(s)) return 'pc';
  return 'other';
};

/* ============ 自定义设备类型 ============ */
U.CUSTOM_KEY = 'nettopo.customTypes';
U.OVERRIDE_KEY = 'nettopo.typeOverrides';
U.PALETTE = ['#0ea5e9', '#10b981', '#e11d48', '#f59e0b', '#8b5cf6', '#14b8a6', '#ec4899', '#84cc16', '#f97316', '#06b6d4'];
U.customTypes = []; // {key, label, c1, c2, stroke, img}
U.typeOverrides = {}; // { key: { c1?, c2?, img? } }  —— 内置/自定义类型均可覆盖颜色与图片

U.loadCustomTypes = () => {
  try {
    const raw = localStorage.getItem(U.CUSTOM_KEY);
    if (raw) U.customTypes = JSON.parse(raw);
    const ov = localStorage.getItem(U.OVERRIDE_KEY);
    if (ov) U.typeOverrides = JSON.parse(ov);
    const cleaned = U.sanitizeTypeData(U.typeOverrides, U.customTypes);
    U.typeOverrides = cleaned.overrides;
    U.customTypes = cleaned.customTypes;
  } catch (e) { U.customTypes = []; U.typeOverrides = {}; }
};
U.saveCustomTypes = () => {
  try { localStorage.setItem(U.CUSTOM_KEY, JSON.stringify(U.customTypes)); } catch (e) { /* 超限时忽略 */ }
};
U.saveTypeOverrides = () => {
  try { localStorage.setItem(U.OVERRIDE_KEY, JSON.stringify(U.typeOverrides)); } catch (e) { /* 超限时忽略 */ }
};

/* ---------- 类型数据安全校验（防止恶意工程/本地存储注入 HTML/SVG） ---------- */
U.isValidColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
/* 图片 dataURL 白名单：data:image MIME + 纯 base64 字符载荷 + 总长上限。
 * 前缀正则之外必须限定载荷字符集——否则 '……base64,QUFB" onerror="x' 会穿透前缀校验（R4/F-2）。
 * opts.svg=true 用于节点级图标（编辑器允许上传 SVG，渲染面为 image/href 安全上下文）。 */
U.MAX_IMG_CHARS = 1500 * 1024;
U.isValidImg = (v, opts) => {
  if (v === '') return true;
  if (typeof v !== 'string' || v.length > U.MAX_IMG_CHARS) return false;
  const mime = (opts && opts.svg) ? '(?:png|jpe?g|gif|webp|svg\\+xml)' : '(?:png|jpe?g|gif|webp)';
  return new RegExp('^data:image\\/' + mime + ';base64,[A-Za-z0-9+/=\\s]*$', 'i').test(v);
};
/* 清洗 typeOverrides / customTypes：剔除非法颜色与图片，避免拼入 innerHTML/SVG 时注入 */
U.sanitizeTypeData = (overrides, customTypes) => {
  const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
  // 原型键名能通过「普通字符串」正则但会命中原型 setter（__proto__ 赋值改写对象原型而非自有属性）
  const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const ov = {};
  for (const [key, o] of Object.entries(overrides || {})) {
    if (!SAFE_KEY.test(key)) continue; // 非法 key 直接丢弃，避免拼入 HTML/SVG 属性
    if (DANGEROUS_KEYS.has(key)) continue;
    if (!o || typeof o !== 'object') continue;
    const clean = {};
    if (U.isValidColor(o.c1)) { clean.c1 = o.c1; clean.c2 = U.isValidColor(o.c2) ? o.c2 : o.c1; clean.stroke = U.isValidColor(o.stroke) ? o.stroke : o.c1; }
    if (U.isValidImg(o.img)) clean.img = o.img;
    if (Object.keys(clean).length) ov[key] = clean;
  }
  const arr = Array.isArray(customTypes) ? customTypes.filter(t => t && typeof t === 'object') : [];
  const known = new Set(U.TYPE_ORDER);
  for (const t of arr) {
    const k = typeof t.key === 'string' ? t.key : '';
    if (SAFE_KEY.test(k) && !DANGEROUS_KEYS.has(k)) known.add(k);
  }
  let seq = 1;
  const ct = arr.map(t => {
    if (typeof t.label !== 'string') return null;
    let key = (typeof t.key === 'string' && SAFE_KEY.test(t.key) && !DANGEROUS_KEYS.has(t.key) && !U.TYPE_ORDER.includes(t.key)) ? t.key : null;
    if (!key) { do { key = 'ct' + (seq++); } while (known.has(key)); known.add(key); }
    const clean = { key, label: t.label.slice(0, 64), c1: t.c1, c2: t.c2 || t.c1, stroke: t.stroke || t.c1, img: '' };
    if (!U.isValidColor(clean.c1)) clean.c1 = U.PALETTE[0];
    if (!U.isValidColor(clean.c2)) clean.c2 = clean.c1;
    if (!U.isValidColor(clean.stroke)) clean.stroke = clean.c1;
    if (U.isValidImg(t.img)) clean.img = t.img; else clean.img = '';
    return clean;
  }).filter(Boolean);
  return { overrides: ov, customTypes: ct };
};

/* 文本框可用字体白名单（防止工程文件注入任意字体名/样式串） */
U.TEXT_FONTS = ['Microsoft YaHei', 'SimSun', 'SimHei', 'DengXian', 'KaiTi', 'Arial', 'Consolas', 'Georgia', 'Times New Roman'];

/* 清洗工程图数据：保证节点/连线/文本框字段类型正确（防缺失字段、NaN 坐标、畸形数据） */
U.sanitizeGraph = (nodes, links, texts) => {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const coord = (v, d) => Math.max(-1e6, Math.min(1e6, num(v, d))); // 坐标钳制，防超大坐标几何 DoS
  const str = (v) => typeof v === 'string' ? v : String(v == null ? '' : v);
  const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const usedN = new Set(), usedL = new Set(), usedT = new Set();
  const fresh = (prefix, used) => { let id; do { id = U.uid(prefix); } while (used.has(id)); used.add(id); return id; };
  const idMap = new Map(); // 旧 id -> 新 id（仅在不合法/重复时记录）
  const cleanNodes = (Array.isArray(nodes) ? nodes : []).map(n => {
    if (!n || typeof n !== 'object') return null;
    const oldId = str(n.id);
    const id = SAFE_ID.test(oldId) && !usedN.has(oldId) ? oldId : fresh('n', usedN);
    usedN.add(id);
    // 记录旧 id → 新 id；重复 id 以首个为准（后续重复的旧 id 不再覆盖）
    if (!idMap.has(oldId)) idMap.set(oldId, id);
    const rawType = typeof n.type === 'string' ? n.type : '';
    return {
      id, name: str(n.name).slice(0, 200),
      type: SAFE_ID.test(rawType) ? rawType : 'other',
      vendor: str(n.vendor).slice(0, 64), // 设备级图标：内置 key 或图片 dataURL
      icon: (typeof n.icon === 'string' && U.NODE_ICON_KEYS.includes(n.icon)) ? n.icon
        : (U.isValidImg(n.icon, { svg: true }) ? n.icon : ''), // 设备级图标：内置 key 或白名单 dataURL（与 isValidImg 同口径）
      x: coord(n.x, 0), y: coord(n.y, 0),
      // 宽高与坐标同口径双向钳制：只钳下限时 w:1e300 之类的畸形数据能通过清洗，画布/导出几何异常
      w: Math.max(Math.min(num(n.w, U.NODE_W), 1e5), 40), h: Math.max(Math.min(num(n.h, U.NODE_H), 1e5), 24),
      mgmt: str(n.mgmt).slice(0, 200), note: str(n.note).slice(0, 2000), web: U.normalizeWebUrl(n.web) || '',
      model: str(n.model).slice(0, 64), osver: str(n.osver).slice(0, 64), // 设备型号 / 软件版本（资产清单；SNMP 识别可自动回填版本）
      mgmts: (Array.isArray(n.mgmts) ? n.mgmts : []).map(str).filter(Boolean).slice(0, 20).map(s => s.slice(0, 200)),
      // 三层 VLAN 接口（interface vlan）：[{id, ip}]，最多 32 个
      vlans: (Array.isArray(n.vlans) ? n.vlans : []).map(v => {
        if (!v || typeof v !== 'object') return null;
        const id = str(v.id).trim().slice(0, 16);
        const ip = str(v.ip).trim().slice(0, 64);
        const m = parseInt(v.mask, 10);
        return (id && ip) ? { id, ip, mask: Number.isFinite(m) && m >= 0 && m <= 32 ? m : 24 } : null;
      }).filter(Boolean).slice(0, 32)
    };
  }).filter(Boolean);
  const nodeIds = new Set(cleanNodes.map(n => n.id));
  const cleanLinks = (Array.isArray(links) ? links : []).map(l => {
    if (!l || typeof l !== 'object') return null;
    const oldId = str(l.id);
    const id = SAFE_ID.test(oldId) && !usedL.has(oldId) ? oldId : fresh('l', usedL);
    usedL.add(id);
    const a = idMap.get(str(l.a)) || str(l.a);
    const b = idMap.get(str(l.b)) || str(l.b);
    if (!nodeIds.has(a) || !nodeIds.has(b)) return null; // 引用不存在/非法的节点则丢弃
    const vlanModeOf = (v) => (v === 'access' || v === 'trunk' || v === 'hybrid') ? v : '';
    // 字符串字段统一限长：20MB 恶意工程可携超长文本拖慢渲染/存储（转义正确，无 XSS，纯 DoS 面）
    return {
      id, a, b, aIf: str(l.aIf).slice(0, 64), aIp: str(l.aIp).slice(0, 64), bIf: str(l.bIf).slice(0, 64), bIp: str(l.bIp).slice(0, 64), bw: str(l.bw).slice(0, 32), note: str(l.note).slice(0, 500),
      // 链路聚合组（同名 = 同一聚合组，如 Eth-Trunk1；空 = 普通链路）
      agg: str(l.agg).trim().slice(0, 32),
      // 二层接口 / VLAN 配置 / 掩码位（生成配置时使用）
      aL2: !!l.aL2, bL2: !!l.bL2,
      aVlan: str(l.aVlan).trim().slice(0, 16), bVlan: str(l.bVlan).trim().slice(0, 16),
      aVlanMode: vlanModeOf(l.aVlanMode), bVlanMode: vlanModeOf(l.bVlanMode),
      aMask: num(l.aMask, 24), bMask: num(l.bMask, 24)
    };
  }).filter(Boolean);
  const cleanTexts = (Array.isArray(texts) ? texts : []).map(t => {
    if (!t || typeof t !== 'object') return null;
    const oldId = str(t.id);
    const id = SAFE_ID.test(oldId) && !usedT.has(oldId) ? oldId : fresh('t', usedT);
    usedT.add(id);
    return {
      id, x: coord(t.x, 0), y: coord(t.y, 0),
      w: Math.max(Math.min(num(t.w, 220), 1e5), 40), h: Math.max(Math.min(num(t.h, 56), 1e5), 24),
      text: str(t.text).slice(0, 10000), font: U.TEXT_FONTS.includes(str(t.font)) ? str(t.font) : 'Microsoft YaHei',
      size: Math.max(Math.min(num(t.size, 16), 200), 8),
      color: U.isValidColor(t.color) ? t.color : '#1e293b',
      bold: !!t.bold, italic: !!t.italic,
      align: ['left', 'center', 'right'].includes(t.align) ? t.align : 'left',
      bg: U.isValidColor(t.bg) ? t.bg : ''
    };
  }).filter(Boolean);
  return { nodes: cleanNodes, links: cleanLinks, texts: cleanTexts };
};

/* 区域分组容器清洗（工程/备份回读）：id 白名单、名称限长、坐标钳制、颜色白名单。
 * 区域为几何容器（设备是否属于某区域由设备中心点是否落在框内决定，不存成员表）。 */
U.sanitizeRegions = (regions) => {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const used = new Set();
  return (Array.isArray(regions) ? regions : []).map(r => {
    if (!r || typeof r !== 'object') return null;
    const oldId = typeof r.id === 'string' ? r.id : '';
    let id = SAFE_ID.test(oldId) && !used.has(oldId) ? oldId : null;
    if (!id) { do { id = U.uid('r'); } while (used.has(id)); }
    used.add(id);
    return {
      id,
      name: String(r.name == null ? '' : r.name).trim().slice(0, 64) || '区域',
      x: Math.max(-1e6, Math.min(1e6, num(r.x, 0))),
      y: Math.max(-1e6, Math.min(1e6, num(r.y, 0))),
      w: Math.min(Math.max(num(r.w, 480), 60), 1e6),
      h: Math.min(Math.max(num(r.h, 320), 60), 1e6),
      color: U.isValidColor(r.color) ? r.color : '#6366f1'
    };
  }).filter(Boolean);
};

/* 修改类型颜色（内置/自定义均可） */
U.setTypeColor = (key, c1, c2) => {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(c1 || ''))) return; // 仅接受 #rrggbb
  const o = U.typeOverrides[key] || (U.typeOverrides[key] = {});
  if (c1) { o.c1 = c1; o.c2 = c2 || c1; o.stroke = shade(c1, -0.18); }
  U.saveTypeOverrides();
};

/* 设置 / 清除类型图片（内置/自定义均可） */
U.setTypeImage = (key, img) => {
  const o = U.typeOverrides[key] || (U.typeOverrides[key] = {});
  if (img) o.img = img;
  else delete o.img;
  U.saveTypeOverrides();
};

/* 简单颜色加深（用于描边） */
function shade(hex, f) {
  const v = parseInt(hex.slice(1), 16);
  const c = (x) => Math.round(U.clamp(x + x * f, 0, 255));
  return '#' + [c(v >> 16 & 255), c(v >> 8 & 255), c(v & 255)]
    .map(x => x.toString(16).padStart(2, '0')).join('');
}

U.addCustomType = (label, img) => {
  // 删除中间类型后 length+1 可能与已有 key 冲突，循环找不冲突的序号
  const keys = new Set(U.customTypes.map(t => t.key));
  let seq = U.customTypes.length + 1;
  let key = 'ct' + seq;
  while (keys.has(key)) { seq++; key = 'ct' + seq; }
  const c = U.PALETTE[U.customTypes.length % U.PALETTE.length];
  const t = { key, label: String(label || '').trim(), c1: c, c2: c, stroke: c, img: img || '' };
  U.customTypes.push(t);
  U.saveCustomTypes();
  return t;
};

U.removeCustomType = (key) => {
  U.customTypes = U.customTypes.filter(t => t.key !== key);
  delete U.typeOverrides[key];
  U.saveCustomTypes();
  U.saveTypeOverrides();
};

/* 取类型（内置或自定义 + 用户覆盖），未知回退 other */
U.getType = (key) => {
  const base = U.TYPES[key] || U.customTypes.find(t => t.key === key) || U.TYPES.other;
  const ov = U.typeOverrides[key];
  if (!ov) return base;
  return {
    key: base.key,
    label: base.label,
    c1: ov.c1 || base.c1,
    c2: ov.c2 || base.c2,
    stroke: ov.stroke || base.stroke,
    img: ov.img != null ? ov.img : (base.img || '')
  };
};

/* 全部类型选项 [{key,label}]：内置 + 自定义 */
U.typeList = () => U.TYPE_ORDER.map(k => ({ key: k, label: U.TYPES[k].label }))
  .concat(U.customTypes.map(t => ({ key: t.key, label: t.label })));

/* 图片文件 → 96×96 cover 裁切的 PNG dataURL（控制 localStorage 体积） */
U.imageToDataURL = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      const S = 96;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      const scale = Math.max(S / img.width, S / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = fr.result;
  };
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(file);
});

/* ---------- SVG 图标（24×24，stroke 风格） ---------- */
const I = {
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0l-4.5 4.5M12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>',
  wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L15.5 8.5M13 5l2-2 3 3-2 2"/><path d="M6 8l-1.5 1.5L6 11l1.5-1.5L6 8zM16 15l-1.5 1.5L16 18l1.5-1.5L16 15zM20 6l-1 1 1 1 1-1-1-1z"/></svg>',
  node: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="7" width="14" height="10" rx="2.5"/><circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="13" cy="12" r="1.1" fill="currentColor" stroke="none"/><path d="M16.5 12h2M2 12h1.5M20.5 12H22"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 4h4M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/></svg>',
  layout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.2"/><circle cx="19" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M6.8 7.4l3.6 8.8M17.2 7.4l-3.6 8.8M7.2 6h9.6"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H4v5M15 3h5v5M9 21H4v-5M15 21h5v-5"/><path d="M8.5 12h7" stroke-dasharray="1.5 2.5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 0 0-6 6v1"/></svg>',
  csv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-6z"/><path d="M13 3v6h6"/><path d="M8 14h2.5M8 17h2.5M14 14.5l3 4.5M17 14.5l-3 4.5"/></svg>',
  xlsx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-6z"/><path d="M13 3v6h6"/><path d="M8.5 14l3 3.5M11.5 14l-3 3.5"/></svg>',
  visio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/><path d="M9.5 14l2.5 4M14.5 14l-2.5 4M8 14h1.5M12 18h.5M16.5 14h-1.5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.3 9a2.8 2.8 0 0 1 5.4 1c0 1.8-2.7 2.2-2.7 3.7"/><circle cx="12" cy="17.2" r=".4" fill="currentColor" stroke="none"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5L16 16"/></svg>',
  panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 6h18M3 12h12M3 18h18M18 9v6M21 12h-3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1L20 7.5a2.1 2.1 0 0 0-3-3L5.5 16 4 20z"/><path d="M14.5 6l3 3"/></svg>',
  locate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/><path d="M9 13l1.5 4 1.5-4M8 17h5"/></svg>',
  fileplus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/><path d="M12 13v5M9.5 15.5h5"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9z"/><circle cx="8.5" cy="8.5" r="1.4" fill="currentColor" stroke="none"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 3.5 3.5L16 13l4 4"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h8V4M8 20v-6h8v6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.6-2.9 7.6-7 9-4.1-1.4-7-4.4-7-9V6l7-3z"/><path d="M9 12l2.2 2.2L15.5 9.5"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5"/><path d="M4 19h16"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 7L4 12l4.5 5M15.5 7L20 12l-4.5 5M13.5 4l-3 16"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>',
  git: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"6\" cy=\"6\" r=\"2.4\"/><circle cx=\"18\" cy=\"6\" r=\"2.4\"/><circle cx=\"6\" cy=\"18\" r=\"2.4\"/><path d=\"M8.2 7.4v9.2M15.8 7.4v9.2M8.4 6h7.2M6 8.4v7.2M18 8.4v7.2\"/></svg>',
  clock: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3.5 2\"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7.5" width="17" height="11" rx="2"/><path d="M3.5 7.5v-2h17v2M9.5 12h5"/></svg>',
  terminal: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4.5\" width=\"18\" height=\"15\" rx=\"2.5\"/><path d=\"M6.5 9.5l3 2.5-3 2.5\"/><path d=\"M12 14.5h5.5\"/></svg>',
  web: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18M12 3c2.5 2.5 3.8 5.6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z\"/></svg>',
  about: '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 11v5.5\"/><circle cx=\"12\" cy=\"7.8\" r=\"1.1\" fill=\"currentColor\" stroke=\"none\"/></svg>',
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12 2.5-6h5"/></svg>'
};
I.grid = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>';
I.tray = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.5V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9"/><path d="M4 14.5a3.5 3.5 0 0 0 3.5 3.5h9a3.5 3.5 0 0 0 3.5-3.5"/><path d="M9 14.5h6"/></svg>';
I.doc = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8L18.5 8v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4.5 20v-15A1.5 1.5 0 0 1 6 3.5z"/><path d="M14 3.5V8h4.5"/><path d="M8.5 13h7M8.5 16.5h7"/></svg>';
I.router = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="10" width="17" height="6" rx="3"/><path d="M8.5 10V7.5h7V10"/><path d="M12 7.5V4.5"/><circle cx="7" cy="13" r=".9" fill="currentColor" stroke="none"/><circle cx="10.5" cy="13" r=".9" fill="currentColor" stroke="none"/><circle cx="14" cy="13" r=".9" fill="currentColor" stroke="none"/><path d="M17.5 13h1.5"/></svg>';
I.switch = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7.5" width="17" height="9" rx="2"/><circle cx="7" cy="12" r=".9" fill="currentColor" stroke="none"/><circle cx="10.5" cy="12" r=".9" fill="currentColor" stroke="none"/><circle cx="14" cy="12" r=".9" fill="currentColor" stroke="none"/><path d="M17.5 12h1.5"/><path d="M7 7.5V4.5M12 7.5V4.5M17 7.5V4.5"/></svg>';
I.firewall = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l6.5 2.6v4.8c0 4.3-2.6 7.6-6.5 9.1-3.9-1.5-6.5-4.8-6.5-9.1V6.1z"/><path d="M9.5 11.5l1.8 1.8 3.4-3.6"/></svg>';
I.server = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3.5" width="16" height="5.5" rx="1.5"/><rect x="4" y="10.5" width="16" height="5.5" rx="1.5"/><rect x="4" y="17.5" width="16" height="3.5" rx="1.5"/><circle cx="7.5" cy="6.2" r=".8" fill="currentColor" stroke="none"/><circle cx="7.5" cy="13.2" r=".8" fill="currentColor" stroke="none"/><circle cx="7.5" cy="19.2" r=".8" fill="currentColor" stroke="none"/><path d="M16.5 5.5h2M16.5 12.5h2M16.5 18.5h2"/></svg>';
I.pc = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="11" rx="1.5"/><path d="M9 19.5h6M12 15.5v4"/><path d="M6.5 8h11"/></svg>';
I.cloud = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7.2 17.5a4.3 4.3 0 0 1-.7-8.55 5.6 5.6 0 0 1 10.7-1.25 4.1 4.1 0 0 1-.5 8.16z"/><path d="M9 13.5l2.2 2.2L16 10.5"/></svg>';
I.other = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.3a2.4 2.4 0 0 1 4.5 1.1c0 1.6-2.3 2.1-2.3 3.6"/><path d="M12 17.2h.01"/></svg>';
U.ICONS = I;

/* 节点可用图标 key（设备级自定义图标选择器） */
U.NODE_ICON_KEYS = ['router', 'switch', 'firewall', 'server', 'pc', 'cloud', 'other', 'ap', 'camera', 'printer', 'nas'];
U.NODE_ICON_LABELS = {
  router: '路由器', switch: '交换机', firewall: '防火墙', server: '服务器',
  pc: '终端', cloud: '云/外网', other: '其他', ap: '无线AP', camera: '摄像头', printer: '打印机', nas: '存储NAS'
};
/* 补充的节点图标（与 U.ICONS 同一集合，供渲染器取用） */
U.ICONS.ap = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 18.5v.01"/><path d="M7.5 15a6.4 6.4 0 0 1 9 0"/><path d="M4.9 11.6a10.9 10.9 0 0 1 14.2 0"/><path d="M2.4 8a15.4 15.4 0 0 1 19.2 0"/></svg>';
U.ICONS.camera = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l1.4-2.2A1.5 1.5 0 0 1 9.6 4h4.8a1.5 1.5 0 0 1 1.2.8L17 7h2.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.2"/></svg>';
U.ICONS.printer = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8V4.5A1.5 1.5 0 0 1 8.5 3h7A1.5 1.5 0 0 1 17 4.5V8"/><rect x="3.5" y="8" width="17" height="8" rx="2"/><path d="M7 15.5h10v4.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 20z"/><circle cx="17.5" cy="12" r=".9" fill="currentColor" stroke="none"/></svg>';
U.ICONS.nas = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="10" rx="2"/><path d="M3 15h18v4a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19z"/><circle cx="7" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="11" cy="9" r="1.1" fill="currentColor" stroke="none"/><path d="M16.5 8.5h2M16.5 11.5h2M6.5 18h2.5"/></svg>';

/* 填充所有 .ic 元素 */
U.fillIcons = () => {
  if (typeof document === 'undefined') return;
  U.$$('.ic[data-ic]').forEach(el => {
    const n = el.getAttribute('data-ic');
    if (I[n]) el.innerHTML = I[n];
  });
};

/* 标注防碰撞：迭代推开重叠的标签框（布局无关）。
 * labels：矩形中心坐标 {x,y,w,h}（x/y 为中心）
 * obstacles：不可压过的矩形，与 DOM 一致用左上角坐标 {x,y,w,h}（x/y 为左上角）
 */
U.resolveLabelCollisions = (labels, opts) => {
  opts = opts || {};
  const pad = opts.pad != null ? opts.pad : 4;
  // 障碍物统一换算为中心坐标，与标签同坐标系再参与碰撞
  const obstacles = (opts.obstacles || []).map(o => ({
    x: o.x + o.w / 2, y: o.y + o.h / 2, w: o.w, h: o.h
  }));
  const MAX_STEP = 200; // 单次最大推开距离，防止振荡
  const push = (a, b, lockB) => {
    const ox = (a.w + b.w) / 2 + pad - Math.abs(a.x - b.x);
    const oy = (a.h + b.h) / 2 + pad - Math.abs(a.y - b.y);
    if (ox <= 0 || oy <= 0) return false;
    let sx = 0, sy = 0;
    if (ox < oy) {
      sx = (a.x <= b.x ? -1 : 1) * Math.min(ox, MAX_STEP) / (lockB ? 1 : 2);
    } else {
      sy = (a.y <= b.y ? -1 : 1) * Math.min(oy, MAX_STEP) / (lockB ? 1 : 2);
    }
    // a 始终远离 b 移动；lockB 时 b（障碍物）保持不动
    a.x += sx; a.y += sy;
    if (!lockB) { b.x -= sx; b.y -= sy; }
    return true;
  };
  // 大输入（大量标注/节点）使用空间哈希只检查邻近对，避免 O(n²×迭代)；小输入保持原逻辑（行为不变）
  const maxDim = (() => {
    let m = 0;
    for (const lb of labels) m = Math.max(m, lb.w, lb.h);
    for (const ob of obstacles) m = Math.max(m, ob.w, ob.h);
    return m;
  })();
  const big = labels.length * (labels.length + obstacles.length) > 60000;
  if (!big) {
    for (let iter = 0; iter < 200; iter++) {
      let moved = false;
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          if (push(labels[i], labels[j], false)) moved = true;
        }
      }
      for (const lb of labels) {
        for (const ob of obstacles) {
          if (push(lb, ob, true)) moved = true;
        }
      }
      if (!moved) break;
    }
    return labels;
  }
  const CELL = Math.max(1, Math.ceil(maxDim + pad + 1));
  const cellKey = (x, y) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
  const grid = new Map();
  const items = labels.map((lb, idx) => ({ lb, idx, kind: 0 }));
  for (const ob of obstacles) items.push({ lb: ob, idx: -1, kind: 1 });
  for (const it of items) {
    const k = cellKey(it.lb.x, it.lb.y);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(it);
  }
  const near = (it) => {
    const kx = Math.floor(it.lb.x / CELL), ky = Math.floor(it.lb.y / CELL);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get((kx + dx) + ',' + (ky + dy));
        if (arr) for (const o of arr) if (o !== it) out.push(o);
      }
    }
    return out;
  };
  for (let iter = 0; iter < 200; iter++) {
    let moved = false;
    for (let i = 0; i < labels.length; i++) {
      const it = { lb: labels[i] };
      for (const o of near(it)) {
        if (o.kind === 1) { if (push(labels[i], o.lb, true)) moved = true; }
        else if (o.idx > i) { if (push(labels[i], o.lb, false)) moved = true; }
      }
    }
    if (!moved) break;
  }
  return labels;
};

/* ---------- 带宽：统一为 Mbps 数值，图上用颜色标识 ---------- */
U.BW_LEVELS = [
  { min: 100000, label: '100G', color: '#dc2626' },
  { min: 40000,  label: '40G',  color: '#f59e0b' },
  { min: 10000,  label: '10G',  color: '#8b5cf6' },
  { min: 1000,   label: '1G',   color: '#0ea5e9' },
  { min: 100,    label: '100M', color: '#64748b' },
  { min: 10,     label: '10M',  color: '#94a3b8' }
];
/* 把文字/数字带宽归一化为 Mbps 数值；无法识别返回 '' */
U.normalizeBw = (v) => {
  if (v == null) return '';
  const s = String(v).trim().toLowerCase();
  if (!s) return '';
  // 每个分支都必须 ^ 锚定：否则 "21gbps" 会被 "1gbps" 分支、 "x100gbps" 会被 "100gbps" 分支误命中
  const table = [
    [/^(?:100g|100gbps|100000m)/, 100000],
    [/^(?:40g|40gbps|40000m)/, 40000],
    [/^(?:10g|10gbps|10000m|万兆)/, 10000],
    [/^(?:1g|1gbps|1000m|千兆)/, 1000],
    [/^(?:100m|100mbps|百兆)/, 100],
    [/^(?:10m|10mbps)/, 10]
  ];
  for (const [re, val] of table) if (re.test(s)) return val;
  // 通用单位：2g / 2.5g / 200m / 800mbps 等（表内未列出的取值）
  const un = /^(\d+(?:\.\d+)?)\s*(g|gbps|m|mbps)$/.exec(s);
  if (un) {
    const n = parseFloat(un[1]);
    if (Number.isFinite(n) && n > 0) return Math.round(un[2][0] === 'g' ? n * 1000 : n);
  }
  const n = parseFloat(s);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return '';
};
U.formatBw = (v) => {
  const n = U.normalizeBw(v);
  if (!n) return '';
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'G';
  return n + 'M';
};
U.bwColor = (v) => {
  const n = U.normalizeBw(v);
  if (!n) return '#8fa0b8';
  for (const lv of U.BW_LEVELS) if (n >= lv.min) return lv.color;
  return '#94a3b8';
};

/* 标注两行文本（接口IP / 对端接口IP）；带宽用线色+图例标识，不再显示文字。
 * 链路聚合组（l.agg 非空）追加第三行「聚合: 组名」，画布/PDF/VSDX 导出同步携带。 */
U.labelLines = (l) => {
  const out = [
    [l.aIf, l.aIp].filter(Boolean).join('  '),
    [l.bIf, l.bIp].filter(Boolean).join('  ')
  ].filter(Boolean);
  const agg = String((l && l.agg) || '').trim();
  if (agg) out.push('聚合: ' + U.truncate(agg, 20));
  return out;
};

/* 链路标注两行按设备在画布上的上下方位排序（交互画布显示用）：
 * 下方设备的行排在下、上方设备的行排在上。lines 约定 [a端行, b端行]（渲染时 index0 在下、index1 在上）。
 * 设备水平等高（y 相同）时不交换，保持默认顺序；单行/缺节点原样返回。 */
U.orderLabelLines = (lines, na, nb) => {
  if (!lines || lines.length !== 2 || !na || !nb) return lines;
  return (na.y + na.h / 2) < (nb.y + nb.h / 2) ? [lines[1], lines[0]] : lines;
};

/* ---------- 资产清单行构建（导出 Excel/CSV 用；纯函数，Node 测试可调用） ---------- */
U.buildInventoryRows = (nodes, monStatus, backupInfo) => {
  nodes = Array.isArray(nodes) ? nodes : [];
  monStatus = monStatus || {};
  backupInfo = backupInfo || {}; // 设备名 -> { lastAt, count }
  const label = (t) => {
    const def = U.TYPES[t] || U.TYPES.other;
    const ct = (Array.isArray(U.customTypes) ? U.customTypes : []).find(x => x && x.key === t);
    return (ct && ct.label) || def.label || String(t || 'other');
  };
  const rows = [['设备名', '类型', '管理地址', '设备型号', '软件版本', '备注', '监控状态', '最近配置备份', '备份份数']];
  for (const n of nodes) {
    if (!n) continue;
    const st = monStatus[n.id] || {};
    const bi = backupInfo[n.name] || backupInfo[n.id] || {};
    const mgmts = U.nodeMgmts(n);
    rows.push([
      String(n.name || ''),
      label(n.type),
      (mgmts.length ? mgmts : [n.mgmt]).filter(Boolean).join(' / '),
      String(n.model || ''),
      String(n.osver || ''),
      String(n.note || ''),
      String(st.text || st.state || '未监控'),
      bi.lastAt ? U.fmtDate(new Date(bi.lastAt)) : '',
      bi.count != null ? String(bi.count) : ''
    ]);
  }
  return rows;
};

/* ---------- 配置合规基线检查（对备份库 running-config 的本地规则扫描；纯函数可测） ----------
 * 规则带 group 分组（界面按组显示分割线）；禁止类规则用 (?!undo\b|no\b) 负向前瞻排除
 * 「undo telnet server enable / no ip http server」这类【已关闭】的好配置行，避免误报。 */
U.COMPLIANCE_DEFAULT_RULES = [
  { id: 'ntp',      name: '必须配置 NTP',              group: '时间同步',    pattern: 'ntp', negate: false, enabled: true, note: '存在 NTP 相关配置行' },
  { id: 'syslog',   name: '必须配置日志主机',          group: '日志审计',    pattern: 'info-center loghost|logging (?:host\\s+)?\\d', negate: false, enabled: true, note: '华为 info-center loghost / 思科 logging <主机>' },
  { id: 'aaa',      name: '必须启用 AAA',              group: '认证与授权',  pattern: 'aaa', negate: false, enabled: true, note: '存在 AAA 配置段' },
  { id: 'timeout',  name: '必须配置登录超时',          group: '认证与授权',  pattern: 'idle-timeout|exec-timeout', negate: false, enabled: true, note: 'VTY/Console 空闲超时（华为 idle-timeout / 思科 exec-timeout）' },
  { id: 'pwdpolicy',name: '必须启用密码复杂度策略',    group: '认证与授权',  pattern: 'password policy|password-complexity|security passwords min-length', negate: false, enabled: true, note: '华为 password-policy / 思科 security passwords min-length' },
  { id: 'vtyacl',   name: '必须配置 VTY 访问控制',     group: '认证与授权',  pattern: 'access-class|acl\\s+\\d+', negate: false, enabled: true, note: 'VTY 绑定 ACL（思科 access-class / 华为 user-interface 下 acl 编号）' },
  { id: 'banner',   name: '必须配置登录警示 banner',   group: '认证与授权',  pattern: 'banner|header login|login block', negate: false, enabled: true, note: '存在登录提示/警示信息（华为 header login / 思科 banner）' },
  { id: 'telnet',   name: '禁止启用 Telnet 服务',      group: '服务与协议',  pattern: '^(?!\\s*(?:undo|no)\\b).*(?:\\btelnet server enable|transport input\\s+(?:ssh\\s+)?(?:telnet|all)|protocol inbound (?:telnet|all))', negate: true, enabled: true, note: 'VTY/服务层不应放行 Telnet（仅 SSH）；undo/no 前缀的关闭命令不算违规' },
  { id: 'http',     name: '禁止启用 HTTP 管理服务',    group: '服务与协议',  pattern: '^(?!\\s*(?:undo|no)\\b).*(?:http server enable|ip http server(?!\\s*secure))', negate: true, enabled: true, note: '明文 HTTP 管理面应关闭（HTTPS 的 ip http secure-server 不算）；undo/no 前缀不算违规' },
  { id: 'snmpv2',   name: '禁止 SNMP v1/v2c community', group: '服务与协议', pattern: '^(?!\\s*(?:undo|no)\\b).*(?:snmp(?:-agent)? community|snmp-server community)', negate: true, enabled: true, note: '应仅使用 SNMPv3（usm-user / snmp-server user）；undo/no 前缀的删除命令不算违规' },
  { id: 'gw',       name: '必须配置默认路由',          group: '路由与网关',  pattern: 'ip\\s+route(?:-static)?\\s+0\\.0\\.0\\.0', negate: false, enabled: true, note: '存在静态默认路由（华为 ip route-static 0.0.0.0 / 思科 ip route 0.0.0.0）' }
];
const COMPLIANCE_KEY = 'nettopo.complianceRules';
const COMPLIANCE_TPL_KEY = 'nettopo.complianceTemplates';

/* ---------- 合规模板包 ----------
 * 内置多套基线模板（U.COMPLIANCE_PACKS），用户也可把当前规则另存为多套自定义模板
 * （localStorage nettopo.complianceTemplates），检查时按需选择加载。
 * 内置模板按设备厂家 / 场景分化：pattern 采用对应厂家的命令风格，降低误报/漏报。 */
U.COMPLIANCE_PACKS = [
  {
    key: 'default', name: '等保通用基线（推荐）', desc: '11 条全量基线，与「恢复默认规则」一致',
    rules: U.COMPLIANCE_DEFAULT_RULES
  },
  {
    key: 'minimal', name: '最小基线（快速检查）', desc: '5 条核心项：NTP/AAA/默认路由/禁 Telnet/禁 SNMP v1v2c',
    rules: [
      { id: 'ntp',    name: '必须配置 NTP',    group: '时间同步',   pattern: 'ntp', negate: false, enabled: true, note: '存在 NTP 相关配置行' },
      { id: 'aaa',    name: '必须启用 AAA',    group: '认证与授权', pattern: 'aaa', negate: false, enabled: true, note: '存在 AAA 配置段' },
      { id: 'gw',     name: '必须配置默认路由', group: '路由与网关', pattern: 'ip\\s+route(?:-static)?\\s+0\\.0\\.0\\.0', negate: false, enabled: true, note: '存在静态默认路由' },
      { id: 'telnet', name: '禁止启用 Telnet 服务', group: '服务与协议', pattern: '^(?!\\s*(?:undo|no)\\b).*(?:\\btelnet server enable|transport input\\s+(?:ssh\\s+)?(?:telnet|all)|protocol inbound (?:telnet|all))', negate: true, enabled: true, note: 'undo/no 前缀的关闭命令不算违规' },
      { id: 'snmpv2', name: '禁止 SNMP v1/v2c community', group: '服务与协议', pattern: '^(?!\\s*(?:undo|no)\\b).*(?:snmp(?:-agent)? community|snmp-server community)', negate: true, enabled: true, note: 'undo/no 前缀的删除命令不算违规' }
    ]
  },
  {
    key: 'huawei', name: '华为 VRP 设备基线', desc: '按华为命令风格：stelnet/info-center/password-policy 等',
    rules: [
      { id: 'hw-ntp',    name: '必须配置 NTP',             group: '时间同步',   pattern: 'ntp', negate: false, enabled: true, note: '存在 ntp-service 配置' },
      { id: 'hw-log',    name: '必须配置日志主机',         group: '日志审计',   pattern: 'info-center loghost', negate: false, enabled: true, note: 'info-center loghost <主机>' },
      { id: 'hw-aaa',    name: '必须启用 AAA',             group: '认证与授权', pattern: 'aaa', negate: false, enabled: true, note: '存在 aaa 配置段' },
      { id: 'hw-idle',   name: '必须配置登录超时',         group: '认证与授权', pattern: 'idle-timeout', negate: false, enabled: true, note: 'VTY/Console 下 idle-timeout' },
      { id: 'hw-pwd',    name: '必须启用密码复杂度策略',   group: '认证与授权', pattern: 'password-policy|password-complexity', negate: false, enabled: true, note: 'aaa 下的 password-policy' },
      { id: 'hw-vtyacl', name: '必须配置 VTY 访问控制',    group: '认证与授权', pattern: 'acl\\s+\\d+', negate: false, enabled: true, note: 'user-interface vty 下 acl 编号' },
      { id: 'hw-ssh',    name: '必须启用 SSH（stelnet）',  group: '服务与协议', pattern: 'stelnet server enable|ssh server enable', negate: false, enabled: true, note: 'stelnet server enable' },
      { id: 'hw-telnet', name: '禁止启用 Telnet 服务',     group: '服务与协议', pattern: '^(?!\\s*undo\\b).*\\btelnet server enable', negate: true, enabled: true, note: 'undo 前缀与 stelnet server enable（SSH）不算违规' },
      { id: 'hw-http',   name: '禁止启用 HTTP 管理服务',   group: '服务与协议', pattern: '^(?!\\s*undo\\b).*http server enable', negate: true, enabled: true, note: 'undo http server enable 不算违规' },
      { id: 'hw-snmpv2', name: '禁止 SNMP v1/v2c community', group: '服务与协议', pattern: '^(?!\\s*undo\\b).*snmp-agent community', negate: true, enabled: true, note: 'undo snmp-agent community 不算违规' },
      { id: 'hw-gw',     name: '必须配置默认路由',         group: '路由与网关', pattern: 'ip route-static 0\\.0\\.0\\.0', negate: false, enabled: true, note: 'ip route-static 0.0.0.0' }
    ]
  },
  {
    key: 'cisco', name: '思科 IOS 设备基线', desc: '按思科命令风格：aaa new-model/exec-timeout/access-class 等',
    rules: [
      { id: 'ci-ntp',    name: '必须配置 NTP',             group: '时间同步',   pattern: 'ntp server', negate: false, enabled: true, note: 'ntp server <主机>' },
      { id: 'ci-log',    name: '必须配置日志主机',         group: '日志审计',   pattern: 'logging (?:host\\s+)?\\d', negate: false, enabled: true, note: 'logging <主机>' },
      { id: 'ci-aaa',    name: '必须启用 AAA',             group: '认证与授权', pattern: 'aaa new-model', negate: false, enabled: true, note: 'aaa new-model' },
      { id: 'ci-exec',   name: '必须配置登录超时',         group: '认证与授权', pattern: 'exec-timeout', negate: false, enabled: true, note: 'line vty 下 exec-timeout' },
      { id: 'ci-pwd',    name: '必须启用密码复杂度策略',   group: '认证与授权', pattern: 'security passwords min-length', negate: false, enabled: true, note: 'security passwords min-length' },
      { id: 'ci-acl',    name: '必须配置 VTY 访问控制',    group: '认证与授权', pattern: 'access-class', negate: false, enabled: true, note: 'line vty 下 access-class' },
      { id: 'ci-banner', name: '必须配置登录警示 banner',  group: '认证与授权', pattern: 'banner', negate: false, enabled: true, note: 'banner motd/login' },
      { id: 'ci-ssh',    name: '必须启用 SSH（VTY 仅 SSH）', group: '服务与协议', pattern: 'transport input ssh', negate: false, enabled: true, note: 'transport input ssh' },
      { id: 'ci-telnet', name: '禁止 VTY 放行 Telnet',     group: '服务与协议', pattern: '^(?!\\s*no\\b).*(?:transport input\\s+(?:ssh\\s+)?(?:telnet|all))', negate: true, enabled: true, note: 'no 前缀的关闭命令不算违规' },
      { id: 'ci-http',   name: '禁止启用 HTTP 管理服务',   group: '服务与协议', pattern: '^(?!\\s*no\\b).*ip http server(?!\\s*secure)', negate: true, enabled: true, note: 'ip http secure-server（HTTPS）不算违规' },
      { id: 'ci-snmpv2', name: '禁止 SNMP v1/v2c community', group: '服务与协议', pattern: '^(?!\\s*no\\b).*snmp-server community', negate: true, enabled: true, note: 'no 前缀的删除命令不算违规' },
      { id: 'ci-gw',     name: '必须配置默认路由',         group: '路由与网关', pattern: 'ip route 0\\.0\\.0\\.0', negate: false, enabled: true, note: 'ip route 0.0.0.0' }
    ]
  },
  {
    key: 'access', name: '接入层交换机基线', desc: '无默认路由/VTY ACL 要求（接入层常缺省），保留安全底线',
    rules: [
      { id: 'ac-ntp',    name: '必须配置 NTP',             group: '时间同步',   pattern: 'ntp', negate: false, enabled: true, note: '存在 NTP 相关配置行' },
      { id: 'ac-log',    name: '必须配置日志主机',         group: '日志审计',   pattern: 'info-center loghost|logging (?:host\\s+)?\\d', negate: false, enabled: true, note: '华为 info-center loghost / 思科 logging <主机>' },
      { id: 'ac-aaa',    name: '必须启用 AAA',             group: '认证与授权', pattern: 'aaa', negate: false, enabled: true, note: '存在 AAA 配置段' },
      { id: 'ac-idle',   name: '必须配置登录超时',         group: '认证与授权', pattern: 'idle-timeout|exec-timeout', negate: false, enabled: true, note: 'VTY/Console 空闲超时' },
      { id: 'ac-pwd',    name: '必须启用密码复杂度策略',   group: '认证与授权', pattern: 'password policy|password-policy|password-complexity|security passwords min-length', negate: false, enabled: true, note: '密码复杂度/最小长度策略' },
      { id: 'ac-telnet', name: '禁止启用 Telnet 服务',     group: '服务与协议', pattern: '^(?!\\s*(?:undo|no)\\b).*(?:\\btelnet server enable|transport input\\s+(?:ssh\\s+)?(?:telnet|all)|protocol inbound (?:telnet|all))', negate: true, enabled: true, note: 'undo/no 前缀的关闭命令不算违规' },
      { id: 'ac-http',   name: '禁止启用 HTTP 管理服务',   group: '服务与协议', pattern: '^(?!\\s*(?:undo|no)\\b).*(?:http server enable|ip http server(?!\\s*secure))', negate: true, enabled: true, note: 'undo/no 前缀不算违规；HTTPS 不算' },
      { id: 'ac-snmpv2', name: '禁止 SNMP v1/v2c community', group: '服务与协议', pattern: '^(?!\\s*(?:undo|no)\\b).*(?:snmp(?:-agent)? community|snmp-server community)', negate: true, enabled: true, note: 'undo/no 前缀不算违规' }
    ]
  }
];

/* 规则对象 → 可持久化字段（剔除编译后的 re） */
const complianceStorableRule = (r) => ({
  id: r.id, name: r.name, pattern: r.pattern, negate: !!r.negate,
  enabled: r.enabled !== false, group: typeof r.group === 'string' ? r.group.slice(0, 24) : '',
  note: typeof r.note === 'string' ? r.note.slice(0, 128) : ''
});

/* ---------- 自定义合规模板（多套保存、按需加载；localStorage 持久化） ---------- */
U.complianceTemplates = []; // [{name, rules:[{id,name,pattern,negate,enabled,group,note}]}]

U.loadComplianceTemplates = () => {
  let arr = [];
  try {
    const raw = JSON.parse(localStorage.getItem(COMPLIANCE_TPL_KEY) || 'null');
    if (Array.isArray(raw)) arr = raw;
  } catch (e) { arr = []; }
  const seen = new Set();
  U.complianceTemplates = (Array.isArray(arr) ? arr : []).map(t => {
    if (!t || typeof t !== 'object') return null;
    const name = typeof t.name === 'string' ? t.name.trim().slice(0, 32) : '';
    if (!name || seen.has(name)) return null;
    seen.add(name);
    const rules = U.cleanComplianceRules(t.rules).map(complianceStorableRule);
    return { name, rules };
  }).filter(Boolean);
  return U.complianceTemplates;
};

U.saveComplianceTemplates = () => {
  try {
    localStorage.setItem(COMPLIANCE_TPL_KEY, JSON.stringify(
      U.complianceTemplates.map(t => ({ name: t.name, rules: t.rules.map(complianceStorableRule) }))
    ));
  } catch (e) { /* 存储超限忽略 */ }
};

/** 保存（或覆盖同名）一套自定义模板；规则经白名单清洗（最多 32 条），清洗后为空则不保存；返回模板数组 */
U.saveComplianceTemplate = (name, rules) => {
  name = String(name == null ? '' : name).trim().slice(0, 32);
  if (!name) return U.complianceTemplates;
  const clean = U.cleanComplianceRules(rules).map(complianceStorableRule);
  if (!clean.length) return U.complianceTemplates; // 无有效规则（如正则全部非法）不落模板
  U.loadComplianceTemplates();
  const exist = U.complianceTemplates.find(t => t.name === name);
  if (exist) exist.rules = clean;
  else U.complianceTemplates.push({ name, rules: clean });
  U.saveComplianceTemplates();
  return U.complianceTemplates;
};

U.deleteComplianceTemplate = (name) => {
  name = String(name == null ? '' : name).trim().slice(0, 32);
  U.loadComplianceTemplates();
  U.complianceTemplates = U.complianceTemplates.filter(t => t.name !== name);
  U.saveComplianceTemplates();
  return U.complianceTemplates;
};

/** 规则白名单清洗：id/名称/可编译正则/长度与数量上限；返回带编译后 re 的规则数组 */
U.cleanComplianceRules = (raw) => {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(raw) ? raw : [])) {
    if (!r || typeof r !== 'object' || out.length >= 32) break;
    const id = (typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(r.id) && !seen.has(r.id)) ? r.id : '';
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 64) : '';
    const pattern = typeof r.pattern === 'string' ? r.pattern.trim().slice(0, 256) : '';
    if (!id || !name || !pattern) continue;
    // 启发式拒绝嵌套量词（如 (a+)+ / (a?)+ / (a|aa)*）：逐行同步扫描，尽力避免灾难性回溯卡死界面
    // （与主进程 compileComplianceRules / 告警关键字同口径，非完备防线）
    if (/\([^()]*[+*?{|][^()]*\)[+*{]/.test(pattern)) continue;
    let re = null;
    try { re = new RegExp(pattern, 'i'); } catch (e) { continue; } // 非法正则整条丢弃
    seen.add(id);
    out.push({ id, name, pattern, negate: !!r.negate, enabled: r.enabled !== false, group: typeof r.group === 'string' ? r.group.trim().slice(0, 24) : '', note: typeof r.note === 'string' ? r.note.slice(0, 128) : '', re });
  }
  return out;
};
U.loadComplianceRules = () => {
  let rules = [];
  try { rules = U.cleanComplianceRules(JSON.parse(localStorage.getItem(COMPLIANCE_KEY) || 'null')); }
  catch (e) { rules = []; }
  if (!rules.length) rules = U.cleanComplianceRules(U.COMPLIANCE_DEFAULT_RULES);
  U.complianceRules = rules;
  return rules;
};
U.saveComplianceRules = (rules) => {
  U.complianceRules = U.cleanComplianceRules(rules);
  try {
    localStorage.setItem(COMPLIANCE_KEY, JSON.stringify(
      U.complianceRules.map(r => ({ id: r.id, name: r.name, pattern: r.pattern, negate: r.negate, enabled: r.enabled, group: r.group || '', note: r.note }))
    ));
  } catch (e) { /* 存储超限忽略 */ }
  return U.complianceRules;
};
/** 对一份配置文本执行检查：每条启用规则返回 {pass, lines}（禁止类为命中行，必须类为已匹配行） */
U.checkCompliance = (text, rules) => {
  // 单行限长：防超大行（压缩/粘贴异常）拖慢逐行正则扫描
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n')
    .map(l => l.length > 10000 ? l.slice(0, 10000) : l);
  const results = [];
  let passed = 0, failed = 0;
  for (const r of (Array.isArray(rules) ? rules : [])) {
    if (!r || !r.re || r.enabled === false) continue;
    const hit = [];
    for (const ln of lines) {
      if (hit.length >= 20) break;
      if (r.re.test(ln)) hit.push(ln.trim().slice(0, 200));
    }
    const pass = r.negate ? hit.length === 0 : hit.length > 0;
    if (pass) passed++; else failed++;
    results.push({ id: r.id, name: r.name, negate: !!r.negate, note: r.note || '', pass, lines: hit });
  }
  return { results, passed, failed };
};

/** 合规扫描结果 → 报告行（导出 Excel/CSV 用；scanRows: [{device, host, time, rep}]，time 已格式化） */
U.buildComplianceReportRows = (scanRows) => {
  const rows = [['设备', '管理地址', '规则', '类型', '结果', '命中行/说明', '备份时间']];
  for (const r of (Array.isArray(scanRows) ? scanRows : [])) {
    if (!r || !r.rep || !Array.isArray(r.rep.results)) continue;
    for (const res of r.rep.results) {
      rows.push([
        String(r.device || ''), String(r.host || ''),
        String(res.name || ''),
        res.negate ? '禁止出现' : '必须存在',
        res.pass ? '通过' : '违规',
        res.lines && res.lines.length ? res.lines[0] : (res.negate ? '（无命中）' : '（未找到匹配行）'),
        String(r.time || '')
      ]);
    }
  }
  return rows;
};

/* ---------- 工程文件口令加密（PBKDF2-SHA256 + AES-GCM，浏览器/Node 通用 WebCrypto） ---------- */
const _subtle = () => ((typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto.subtle : null);
U.isProjectCryptoAvailable = () => !!_subtle();
const _b64enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const _b64dec = (s) => { const bin = atob(String(s || '')); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
/** 加密工程文本 → 信封 JSON（{"app":"NetTopo-Enc",salt,iv,ct}） */
U.encryptProjectText = async (text, pass) => {
  const subtle = _subtle();
  if (!subtle) throw new Error('当前环境不支持 WebCrypto');
  pass = String(pass == null ? '' : pass);
  if (!pass) throw new Error('口令为空');
  const te = new TextEncoder();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const dk = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, dk, te.encode(String(text))));
  return JSON.stringify({ app: 'NetTopo-Enc', v: 1, kdf: 'PBKDF2-SHA256-120000', salt: _b64enc(salt), iv: _b64enc(iv), ct: _b64enc(ct) });
};
/** 解密信封 JSON → 原文本；口令错误/损坏时抛错 */
U.decryptProjectText = async (envText, pass) => {
  const subtle = _subtle();
  if (!subtle) throw new Error('当前环境不支持 WebCrypto');
  let env;
  try { env = JSON.parse(String(envText)); } catch (e) { throw new Error('信封格式损坏'); }
  if (!env || env.app !== 'NetTopo-Enc' || !env.salt || !env.iv || !env.ct) throw new Error('不是加密工程文件');
  const te = new TextEncoder();
  const key = await subtle.importKey('raw', te.encode(String(pass == null ? '' : pass)), 'PBKDF2', false, ['deriveKey']);
  const dk = await subtle.deriveKey({ name: 'PBKDF2', salt: _b64dec(env.salt), iterations: 120000, hash: 'SHA-256' }, key, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: _b64dec(env.iv) }, dk, _b64dec(env.ct));
  return new TextDecoder().decode(pt);
};

/* ---------- 子网分组（按 /24 网段归类设备） ---------- */
U.ipv4ToInt = (ip) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some(v => v > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
};
U.intToIpv4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
U.subnetOf = (ip, bits) => {
  bits = bits == null ? 24 : bits;
  const n = U.ipv4ToInt(ip);
  if (n == null) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return U.intToIpv4((n & mask) >>> 0) + '/' + bits;
};

/* 掩码位 → 点分十进制：24 → 255.255.255.0；非法/缺省回退 24 */
U.maskBitsToDotted = (bits) => {
  let n = parseInt(bits, 10);
  if (!Number.isFinite(n) || n < 0 || n > 32) n = 24;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return [(mask >>> 24) & 255, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join('.');
};

/* 掩码位 → 反掩码（通配掩码，点分）：24 → 0.0.0.255；非法/缺省回退 24 位 */
U.maskBitsToWildcard = (bits) => {
  let n = parseInt(bits, 10);
  if (!Number.isFinite(n) || n < 0 || n > 32) n = 24;
  const w = n === 0 ? 0xffffffff : (~(~0 << (32 - n))) >>> 0;
  return [(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255].join('.');
};

/* 掩码位 → CIDR 前缀：24 → '/24'；非法/缺省回退 24 位 */
U.maskBitsToCidr = (bits) => {
  let n = parseInt(bits, 10);
  if (!Number.isFinite(n) || n < 0 || n > 32) n = 24;
  return '/' + n;
};

/* CIDR 网段 → 点分掩码：192.168.1.0/24 → 255.255.255.0；非法回退 24 位 */
U.cidrMask = (cidr) => {
  const m = /^\d{1,3}(?:\.\d{1,3}){3}\/(\d{1,2})$/.exec(String(cidr || '').trim());
  return m ? U.maskBitsToDotted(parseInt(m[1], 10)) : '255.255.255.0';
};

/* ---------- IP 子网计算器 ---------- */
/* 掩码文本 → 掩码位：支持 '/24'、整数、点分掩码（255.255.255.192）、反掩码（0.0.0.63）。
 * 按「连续 1 前缀」识别正掩码，按「连续 0 前缀」识别反掩码；混合型（如 0.1.0.0）非法返回 null。 */
U.maskTextToBits = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\/?(\d{1,2})$/.test(s)) {
    const b = parseInt(s.replace(/^\//, ''), 10);
    return (b >= 0 && b <= 32) ? b : null;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some(x => x > 255)) return null;
  const n = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const ones = (c) => { let k = 0; while (c) { c &= c - 1; k++; } return k; };
  const prefixMask = (bits) => (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0);
  const onesN = ones(n);
  if ((((n & prefixMask(onesN)) >>> 0) === n) || onesN === 0) return onesN; // 正掩码（前缀连续 1；& 结果转回无符号再比较）
  const wc = (~n) >>> 0;
  const onesW = ones(wc);
  if ((((wc & prefixMask(onesW)) >>> 0) === wc)) return onesW; // 反掩码（wc 为前缀连续 1，前缀位 = ones(wc)）
  return null;
};

/* 「IP[/掩码| 空格 掩码]」输入解析 → {ip, bits}；bits 可能为 null（未给掩码），整体非法返回 null */
U.parseIpMaskText = (text) => {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const m = /^([0-9.]+)(?:[\s/]+(\S+))?$/.exec(s);
  if (!m) return null;
  if (U.ipv4ToInt(m[1]) == null) return null;
  let bits = null;
  if (m[2] != null && String(m[2]).trim()) {
    bits = U.maskTextToBits(m[2]);
    if (bits == null) return null;
  }
  return { ip: m[1], bits };
};

/* 子网计算：返回 {ip, bits, network, broadcast, mask, wildcard, first, last, total, usable, kind}；
 * kind = 'network'|'broadcast'|'host'；/31 按 RFC 3021 两个可用地址；/32 视为单主机。非法返回 null。 */
U.subnetCalc = (ip, bits) => {
  let b = (typeof bits === 'string' || bits == null) ? U.maskTextToBits(bits == null ? '' : bits) : parseInt(bits, 10);
  if (!Number.isFinite(b)) b = 24; // 缺省 /24
  const n = U.ipv4ToInt(ip);
  if (n == null || b < 0 || b > 32) return null;
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  const net = (n & mask) >>> 0;
  const bc = (net | ((~mask) >>> 0)) >>> 0;
  const total = b === 0 ? 4294967296 : Math.pow(2, 32 - b);
  let first, last, usable;
  if (b >= 32) { first = net; last = net; usable = 1; }
  else if (b === 31) { first = net; last = bc; usable = 2; }
  else { first = net + 1; last = bc - 1; usable = total - 2; }
  return {
    ip: U.intToIpv4(n), bits: b,
    network: U.intToIpv4(net), broadcast: U.intToIpv4(bc),
    mask: U.maskBitsToDotted(b), wildcard: U.maskBitsToWildcard(b),
    first: U.intToIpv4(first), last: U.intToIpv4(last),
    total, usable,
    kind: b >= 31 ? 'host' : (n === net ? 'network' : (n === bc ? 'broadcast' : 'host'))
  };
};

/* ---------- 拓扑快速搜索（Ctrl+F，画布定位） ----------
 * 设备匹配：名称 / 类型标签 / 管理地址 / 备注 / 型号 / 软件版本 / VLAN 编号与 IP；
 * 连线匹配：两端接口 / 两端 IP / 备注。名称命中优先，其次其他设备字段，最后连线。
 * 返回 [{kind:'node'|'link', id, title, sub}]，最多 limit 条（默认 20）。 */
U.searchTopology = (nodes, links, query, limit) => {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return [];
  limit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const has = (s) => String(s == null ? '' : s).toLowerCase().indexOf(q) >= 0;
  const nameHits = [], nodeHits = [];
  for (const n of nodes || []) {
    if (!n) continue;
    const t = U.getType(n.type);
    if (has(n.name)) {
      nameHits.push({ kind: 'node', id: n.id, title: n.name, sub: (t && t.label) || '' });
      continue;
    }
    const mg = U.nodeMgmts(n).find(ip => has(ip));
    const vlan = (n.vlans || []).find(v => has(v.id) || has(v.ip));
    if (mg) nodeHits.push({ kind: 'node', id: n.id, title: n.name, sub: '管理地址 ' + mg });
    else if (vlan) nodeHits.push({ kind: 'node', id: n.id, title: n.name, sub: 'VLAN ' + vlan.id + ' ' + vlan.ip });
    else if (has(n.note)) nodeHits.push({ kind: 'node', id: n.id, title: n.name, sub: '备注' });
    else if (has(n.model)) nodeHits.push({ kind: 'node', id: n.id, title: n.name, sub: '型号 ' + n.model });
    else if (has(n.osver)) nodeHits.push({ kind: 'node', id: n.id, title: n.name, sub: '版本 ' + n.osver });
    else if (t && has(t.label)) nodeHits.push({ kind: 'node', id: n.id, title: n.name, sub: '类型 ' + t.label });
  }
  const byId = new Map((nodes || []).map(n => [n.id, n]));
  const linkHits = [];
  for (const l of links || []) {
    if (!l) continue;
    const na = byId.get(l.a), nb = byId.get(l.b);
    if (!na || !nb) continue;
    let field = null;
    if (has(l.aIf) || has(l.bIf)) field = '接口';
    else if (has(l.aIp)) field = 'IP ' + l.aIp;
    else if (has(l.bIp)) field = 'IP ' + l.bIp;
    else if (has(l.note)) field = '备注';
    if (!field) continue;
    linkHits.push({ kind: 'link', id: l.id, title: na.name + ' ⇄ ' + nb.name, sub: field === '接口' ? ('接口 ' + (has(l.aIf) ? l.aIf : l.bIf)) : field });
  }
  return nameHits.concat(nodeHits).slice(0, limit).concat(linkHits).slice(0, limit);
};

/* 解析 VLAN 表达式为编号列表：支持单个（10）、逗号/分号（10,20;30）、
 * 空格（10 20）、范围（10-20、10 to 20）。返回升序去重的数字数组。 */
U.parseVlans = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return [];
  const out = new Set();
  const norm = s.replace(/\s*to\s*/gi, '-').replace(/\s*-\s*/g, '-');
  for (const seg of norm.split(/[,，;；\s]+/).filter(Boolean)) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(seg);
    if (!m) continue;
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    if (a < 1 || a > 4094 || b < 1 || b > 4094) continue;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
};
/* 子网分组配色（按组序号循环取色） */
U.SUBNET_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#84cc16', '#ec4899', '#06b6d4', '#a3e635'];
/* 按接口 IP 网段（优先）/ 管理 IP 网段（兜底）把设备归组，返回可绘制区域 */
U.subnetGroups = (nodes, links, names) => {
  names = names || {};
  const linkIps = new Map(); // nodeId -> [ip...]
  for (const l of links || []) {
    if (!linkIps.has(l.a)) linkIps.set(l.a, []);
    if (!linkIps.has(l.b)) linkIps.set(l.b, []);
    if (l.aIp) linkIps.get(l.a).push(l.aIp);
    if (l.bIp) linkIps.get(l.b).push(l.bIp);
  }
  const primaryOf = (n) => {
    // 优先接口 IP：出现次数最多的网段；其次管理 IP 网段
    const ips = linkIps.get(n.id) || [];
    const cnt = new Map();
    for (const ip of ips) { const s = U.subnetOf(ip); if (s) cnt.set(s, (cnt.get(s) || 0) + 1); }
    let best = null, bestC = 0;
    for (const [s, c] of cnt) {
      if (c > bestC || (c === bestC && (best == null || s < best))) { best = s; bestC = c; }
    }
    if (best) return best;
    const m0 = U.nodeMgmts(n)[0];
    return m0 ? U.subnetOf(m0) : null;
  };
  const groups = new Map();
  for (const n of nodes) {
    const s = primaryOf(n);
    if (!s) continue;
    if (!groups.has(s)) groups.set(s, { key: s, nodeIds: [] });
    groups.get(s).nodeIds.push(n.id);
  }
  const pad = 26;
  const out = [...groups.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((g, i) => {
      const rects = g.nodeIds.map(id => nodes.find(n => n.id === id)).filter(Boolean);
      const x0 = Math.min(...rects.map(r => r.x)) - pad;
      const y0 = Math.min(...rects.map(r => r.y)) - pad;
      const x1 = Math.max(...rects.map(r => r.x + r.w)) + pad;
      const y1 = Math.max(...rects.map(r => r.y + r.h)) + pad;
      const custom = names[g.key];
      const n = g.nodeIds.length;
      return {
        key: g.key,
        cidr: g.key,
        name: custom ? custom + '（' + g.key + '·' + n + '台）' : g.key + ' · ' + n + '台',
        color: U.SUBNET_COLORS[i % U.SUBNET_COLORS.length],
        nodeIds: g.nodeIds,
        x: x0, y: y0, w: x1 - x0, h: y1 - y0
      };
    });
  return out;
};

/* ---------- 设备配置生成（模板驱动，支持自定义厂家风格） ---------- */
/* 内置模板：huawei / cisco；占位符（模板中未提供的占位符原样保留）：
   设备级（设备头/无接口行/接口行可用）：
     {name}    设备名称
     {mgmt}    管理地址（无则显示 —）
     {type}    设备类型中文名（如 路由器）
     {comment} 注释符（如 # / !）
   接口级（接口块/接入端口行可用）：
     {iface}    本端接口名（如 GE0/0/1）
     {ip}       本端接口 IP
     {mask}     子网掩码，点分形式（255.255.255.0）
     {maskCidr} 子网掩码，CIDR 形式（/24）
     {wildcard} 子网掩码的反掩码/通配掩码（0.0.0.255，Cisco ACL/OSPF 常用）
     {peer}     对端设备名
     {peerIf}   对端接口名（如 GE1/0/1）
     {peerSuffix} 对端接口前缀（:GE1/0/1，无对端接口则为空，兼容旧模板）
     {bw}       链路带宽（如 1G）
     {vlan}     自动分配的 VLAN 号
   路由级（路由行可用）：
     {subnet}   远端网段 CIDR（如 192.168.1.0/24）
     {net}      远端网段地址（无前缀，如 192.168.1.0）
     {mask}     远端网段点分掩码（255.255.255.0）
     {maskCidr} 远端网段 CIDR（/24）
     {wildcard} 远端网段反掩码（0.0.0.255）
     {nextHop}  下一跳 IP（对端接口 IP） */
U.CONFIG_TEMPLATES = {
  huawei: {
    key: 'huawei', label: '华为', builtin: true, comment: '#',
    deviceHeader: '{comment} {name}  管理: {mgmt}  [{type}]',
    noIface: '{comment} （无接口配置）',
    interface: [
      'interface {iface}',
      ' ip address {ip} {mask}',
      ' description -> {peer}{peerSuffix}'
    ],
    switchAccess: [
      ' port link-type access',
      ' port default vlan {vlan}'
    ],
    vlanTrunk: [
      ' port link-type trunk',
      ' port trunk allow-pass vlan {vlanList}'
    ],
    vlanHybrid: [
      ' port link-type hybrid',
      ' port hybrid tagged vlan {vlanList}'
    ],
    svi: [
      'interface vlan {vid}',
      ' ip address {ip} {mask}'
    ],
    route: 'ip route-static {net} {mask} {nextHop}',
    vlanLine: 'vlan {vlan}'
  },
  h3c: {
    key: 'h3c', label: 'H3C（华三）', builtin: true, comment: '#',
    deviceHeader: '{comment} {name}  管理: {mgmt}  [{type}]',
    noIface: '{comment} （无接口配置）',
    interface: [
      'interface {iface}',
      ' ip address {ip} {mask}',
      ' description -> {peer}{peerSuffix}'
    ],
    switchAccess: [
      ' port link-type access',
      ' port default vlan {vlan}'
    ],
    vlanTrunk: [
      ' port link-type trunk',
      ' port trunk permit vlan {vlanList}'
    ],
    vlanHybrid: [
      ' port link-type hybrid',
      ' port hybrid vlan {vlanList} tagged'
    ],
    svi: [
      'interface Vlan-interface{vid}',
      ' ip address {ip} {mask}'
    ],
    route: 'ip route-static {net} {mask} {nextHop}',
    vlanLine: 'vlan {vlan}'
  },
  ruijie: {
    key: 'ruijie', label: '锐捷', builtin: true, comment: '!',
    deviceHeader: '{comment} {name}  管理: {mgmt}  [{type}]',
    noIface: '{comment} （无接口配置）',
    interface: [
      'interface {iface}',
      ' ip address {ip} {mask}',
      ' description -> {peer}{peerSuffix}',
      ' no shutdown'
    ],
    switchAccess: [
      ' switchport mode access',
      ' switchport access vlan {vlan}'
    ],
    vlanTrunk: [
      ' switchport mode trunk',
      ' switchport trunk allowed vlan {vlanCsv}'
    ],
    vlanHybrid: [
      ' switchport mode hybrid',
      ' switchport hybrid vlan {vlanCsv} tagged'
    ],
    svi: [
      'interface vlan {vid}',
      ' ip address {ip} {mask}',
      ' no shutdown'
    ],
    route: 'ip route {net} {mask} {nextHop}',
    vlanLine: 'vlan {vlan}'
  },
  cisco: {
    key: 'cisco', label: '思科', builtin: true, comment: '!',
    deviceHeader: '{comment} {name}  管理: {mgmt}  [{type}]',
    noIface: '{comment} （无接口配置）',
    interface: [
      'interface {iface}',
      ' ip address {ip} {mask}',
      ' description -> {peer}{peerSuffix}',
      ' no shutdown'
    ],
    switchAccess: [
      ' switchport mode access',
      ' switchport access vlan {vlan}'
    ],
    vlanTrunk: [
      ' switchport mode trunk',
      ' switchport trunk allowed vlan {vlanCsv}'
    ],
    // 思科无原生 hybrid，近似为 trunk（可手动调整）
    vlanHybrid: [
      ' switchport mode trunk',
      ' switchport trunk allowed vlan {vlanCsv}'
    ],
    svi: [
      'interface vlan {vid}',
      ' ip address {ip} {mask}',
      ' no shutdown'
    ],
    route: 'ip route {net} {mask} {nextHop}',
    vlanLine: 'vlan {vlan}'
  }
};
U.cfgTemplates = () => Object.assign({}, U.CONFIG_TEMPLATES, U.customCfgTemplates || {});
U.getCfgTemplate = (key) => U.cfgTemplates()[key] || U.cfgTemplates().huawei;
U.saveCustomCfgTemplates = () => {
  try { localStorage.setItem('nettopo.cfgTemplates', JSON.stringify(U.customCfgTemplates || {})); } catch (e) {}
};
/* 自定义配置模板键白名单重建：丢弃 __proto__/constructor/prototype 等危险键，
 * 防 Object.assign 合并时原型污染（CWE-1321）。localStorage 与本机/工程文件数据均走此清洗。 */
function cleanCfgTemplates(raw) {
  const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
  const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!SAFE_KEY.test(k) || DANGEROUS.has(k)) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    out[k] = v;
  }
  return out;
}
U.loadCustomCfgTemplates = () => {
  try { U.customCfgTemplates = cleanCfgTemplates(JSON.parse(localStorage.getItem('nettopo.cfgTemplates') || '{}')); }
  catch (e) { U.customCfgTemplates = {}; }
};
/** 合并工程文件携带的自定义配置模板（白名单过滤；工程覆盖本机同名；返回新增/覆盖数量） */
U.mergeCustomCfgTemplates = (raw) => {
  const fromProj = cleanCfgTemplates(raw);
  const merged = Object.assign({}, U.customCfgTemplates || {});
  for (const [k, v] of Object.entries(fromProj)) merged[k] = v;
  U.customCfgTemplates = merged;
  U.saveCustomCfgTemplates();
  return Object.keys(fromProj).length;
};
U.generateConfigs = (nodes, links, vendor, opts) => {
  vendor = vendor || 'huawei';
  opts = opts || {};
  const baseTpl = typeof vendor === 'object' ? vendor : U.getCfgTemplate(vendor);
  if (!baseTpl) return '';
  // only: 只生成这些设备的配置（Set<id>，空集合则不生成任何设备）；nodes 仍传全量，用于对端名称解析
  const only = opts.only instanceof Set ? opts.only : null;
  const targets = only ? nodes.filter(n => only.has(n.id)) : nodes;
  // 设备级图标：内置 key 或图片 dataURL
  const tplOf = (n) => {
    if (typeof vendor === 'object') return baseTpl; // 直接传模板对象时统一使用
    if (n && typeof n.vendor === 'string' && n.vendor) {
      const t = U.cfgTemplates()[n.vendor];
      if (t) return t;
    }
    return baseTpl;
  };
  const byId = new Map(nodes.map(n => [n.id, n]));
  const fill = (s, map) => String(s).replace(/\{(\w+)\}/g, (m, k) => map[k] != null ? map[k] : m);
  // 直连子网 / 邻居子网（用于静态路由）
  const linkOf = new Map();
  for (const n of nodes) linkOf.set(n.id, []);
  for (const l of links) { linkOf.get(l.a).push(l); linkOf.get(l.b).push(l); }
  const out = [];
  // 已知非路由设备类型不生成静态路由（与注释语义一致；自定义类型保留推导能力）
  const NON_ROUTE_TYPES = new Set(['switch', 'server', 'pc', 'other']);
  for (const n of targets) {
    const tpl = tplOf(n);
    if (!tpl) continue;
    const sec = [];
    sec.push(fill(tpl.deviceHeader, { comment: tpl.comment, name: n.name || '', mgmt: U.nodeMgmts(n).join(', ') || '—', type: U.getType(n.type).label }));
    const intfs = [];
    for (const l of links) {
      let ifn, ip, peerId, peerIf, bw, l2, vlan, vlanMode, maskBits;
      if (l.a === n.id) { ifn = l.aIf; ip = l.aIp; peerId = l.b; peerIf = l.bIf; bw = l.bw; l2 = !!l.aL2; vlan = String(l.aVlan || '').trim(); vlanMode = l.aVlanMode || 'access'; maskBits = l.aMask; }
      else if (l.b === n.id) { ifn = l.bIf; ip = l.bIp; peerId = l.a; peerIf = l.aIf; bw = l.bw; l2 = !!l.bL2; vlan = String(l.bVlan || '').trim(); vlanMode = l.bVlanMode || 'access'; maskBits = l.bMask; }
      else continue;
      if (!ifn) continue;
      const peer = byId.get(peerId);
      // 掩码位：按链路配置生成（缺省 24），二层接口不使用
      const bits = l2 ? 0 : (parseInt(maskBits, 10) > 0 && parseInt(maskBits, 10) <= 32 ? parseInt(maskBits, 10) : 24);
      intfs.push({ ifn, ip, peer: peer ? peer.name : '?', peerIf, bw, l2, vlan, vlanMode, maskBits: bits, subnet: U.subnetOf(ip, bits) });
    }
    const vlanDefs = new Set(); // 需要生成 vlan 定义的编号（显式 L2 VLAN + 自动接入 VLAN + SVI）
    const addVlanDefs = (expr) => { for (const vn of U.parseVlans(expr)) vlanDefs.add(vn); };
    if (!intfs.length) {
      sec.push(fill(tpl.noIface, { comment: tpl.comment, name: n.name || '', mgmt: U.nodeMgmts(n).join(', ') || '—', type: U.getType(n.type).label }));
    } else {
      for (const it of intfs) {
        sec.push('');
        // VLAN 只来自接口显式配置（连线弹窗勾选二层并填写 VLAN）；不做自动分配
        const effVlan = it.vlan;
        // 展开接口上的 VLAN 表达式（支持 10、10,20、10-20、10 to 20）
        const vlanNums = U.parseVlans(effVlan);
        const vlanSingle = vlanNums.length ? String(vlanNums[0]) : effVlan;
        const map = {
          iface: it.ifn, ip: it.ip || '未配置', mask: U.maskBitsToDotted(it.maskBits), maskCidr: U.maskBitsToCidr(it.maskBits), wildcard: U.maskBitsToWildcard(it.maskBits), peer: it.peer,
          peerIf: it.peerIf || '', peerSuffix: it.peerIf ? ':' + it.peerIf : '',
          bw: U.formatBw(it.bw) || '', vlan: vlanSingle,
          vlanList: vlanNums.join(' '), vlanCsv: vlanNums.join(','),
          comment: tpl.comment, name: n.name || '', mgmt: U.nodeMgmts(n).join(', ') || '—', type: U.getType(n.type).label
        };
        // 二层接口：不配置 IP 地址；三层接口照常配置
        const ifaceLines = (tpl.interface || []).filter(ln => !(it.l2 && /ip\s+address/i.test(ln)));
        for (const line of ifaceLines) sec.push(fill(line, map));
        // 二层接口 VLAN 配置（按模式：access / trunk / hybrid，仅显式配置）；与 VLAN 定义区一致，受 opts.vlan 开关控制
        if (opts.vlan !== false && it.l2 && effVlan) {
          addVlanDefs(effVlan); // 展开的每个 VLAN 编号都生成 vlan 定义
          const vlanTpl = it.vlanMode === 'trunk' ? tpl.vlanTrunk : (it.vlanMode === 'hybrid' ? tpl.vlanHybrid : tpl.switchAccess || tpl.vlanTrunk);
          for (const line of (vlanTpl || [])) sec.push(fill(line, map));
        }
      }
    }
    // 三层 VLAN 接口（SVI）：interface vlan + ip address（受 opts.vlan 开关控制，与 VLAN 定义一致）
    if (opts.vlan !== false && Array.isArray(n.vlans) && n.vlans.length) {
      for (const v of n.vlans) {
        const vid = String(v.id || '').trim(), vip = String(v.ip || '').trim();
        if (!vid || !vip) continue;
        addVlanDefs(vid); // 设备配置（三层 VLAN 接口）的 VLAN 编号也生成 vlan 定义
        sec.push('');
        const sviMaskD = U.maskBitsToDotted(v.mask); // 设备 VLAN 接口可带掩码位，缺省 24
        for (const line of (tpl.svi || ['interface vlan {vid}', ' ip address {ip} {mask}'])) {
          sec.push(fill(line, { vid, ip: vip, mask: sviMaskD, maskCidr: U.maskBitsToCidr(v.mask), wildcard: U.maskBitsToWildcard(v.mask), comment: tpl.comment, name: n.name || '', mgmt: U.nodeMgmts(n).join(', ') || '—', type: U.getType(n.type).label }));
        }
      }
    }
    // VLAN 定义
    if (opts.vlan !== false && tpl.vlanLine && vlanDefs.size) {
      for (const v of [...vlanDefs].sort((a, b) => String(a).localeCompare(String(b), 'zh', { numeric: true }))) {
        sec.push('', fill(tpl.vlanLine, { vlan: v, comment: tpl.comment }));
      }
    }
    // 静态路由（路由器/防火墙/云）：经直连邻居到达其直连网段
    if (opts.routes && tpl.route && !NON_ROUTE_TYPES.has(n.type)) {
      const mine = new Set(intfs.filter(i => i.subnet).map(i => i.subnet));
      const routes = [];
      for (const l of linkOf.get(n.id) || []) {
        const otherId = l.a === n.id ? l.b : l.a;
        const other = byId.get(otherId);
        const peerIp = l.a === n.id ? l.bIp : l.aIp; // 下一跳 = 对端接口 IP
        if (!other || !peerIp) continue;
        for (const ol of linkOf.get(otherId) || []) {
          let oBits = (ol.a === otherId ? ol.aMask : ol.bMask);
          oBits = parseInt(oBits, 10) > 0 && parseInt(oBits, 10) <= 32 ? parseInt(oBits, 10) : 24;
          const oIp = ol.a === otherId ? ol.aIp : ol.bIp;
          const oSub = U.subnetOf(oIp, oBits);
          if (oSub && !mine.has(oSub)) {
            const netInt = U.ipv4ToInt(oSub.split('/')[0]);
            const oBits2 = parseInt((oSub.match(/\/(\d+)$/) || ['', '24'])[1], 10) || 24;
            const ROUTE_FILL = {
              subnet: oSub,
              net: netInt == null ? oSub.split('/')[0] : U.intToIpv4(netInt),
              mask: U.cidrMask(oSub),
              maskCidr: U.maskBitsToCidr(oBits2),
              wildcard: U.maskBitsToWildcard(oBits2),
              nextHop: peerIp,
              comment: tpl.comment
            };
            routes.push(fill(tpl.route, ROUTE_FILL));
          }
        }
      }
      const uniq = [...new Set(routes)];
      if (uniq.length) { sec.push('', tpl.comment + ' 静态路由（自动推导）'); for (const r of uniq) sec.push(r); }
    }
    out.push(sec.join('\n'));
  }
  return out.join('\n\n');
};

/* ---------- 生成前冲突检查 ---------- */
/* 检查项：
 *  error 设备名重复 / 接口 IP 重复 / 链路两端网段矛盾（三层对三层不在同网段）/ 无效 VLAN 表达式
 *  warn  管理地址重复 / 同网段地址掩码不一致 / 链路两端掩码或 VLAN 不一致 / 一端二层一端三层（正常桥接场景，仅提示） /
 *        接口重复使用 / 管理地址与接口 IP 相同
 * 返回 { ok, issues: [{level:'error'|'warn', device, msg}] } */
U.checkConfigs = (nodes, links) => {
  nodes = nodes || [];
  links = links || [];
  const issues = [];
  const add = (level, device, msg) => issues.push({ level, device, msg });
  const byId = new Map(nodes.map(n => [n.id, n]));
  const devName = (id) => { const n = byId.get(id); return n ? (String(n.name || '').trim() || String(n.id)) : String(id); };

  // 1. 设备名重复
  const nameCnt = new Map();
  for (const n of nodes) {
    const k = String(n.name || '').trim();
    if (k) nameCnt.set(k, (nameCnt.get(k) || 0) + 1);
  }
  for (const [k, c] of nameCnt) {
    if (c > 1) add('error', k, '设备名「' + k + '」重复（' + c + ' 台），生成的 hostname 会相互冲突');
  }

  // 2. 管理地址重复 / 与接口 IP 相同
  const mgmtSeen = new Map(); // ip -> [设备名]
  const ifaceIps = new Map(); // ip -> [{device, iface, link}]
  const regIfaceIp = (device, iface, ip, link) => {
    if (!U.ipv4ToInt(ip)) return;
    if (!ifaceIps.has(ip)) ifaceIps.set(ip, []);
    ifaceIps.get(ip).push({ device, iface, link });
  };
  for (const n of nodes) {
    for (const ip of U.nodeMgmts(n)) {
      if (!U.ipv4ToInt(ip)) continue;
      if (!mgmtSeen.has(ip)) mgmtSeen.set(ip, []);
      mgmtSeen.get(ip).push(devName(n.id));
    }
    for (const v of (Array.isArray(n.vlans) ? n.vlans : [])) {
      regIfaceIp(devName(n.id), 'VLAN' + String(v.id || ''), v.ip);
    }
  }
  for (const [ip, names] of mgmtSeen) {
    if (names.length > 1) add('warn', names[0], '管理地址 ' + ip + ' 被多台设备同时使用：' + names.join('、'));
  }
  // 3. 接口 IP 重复
  for (const l of links) {
    if (l.aIp) regIfaceIp(devName(l.a), l.aIf || '', l.aIp, l);
    if (l.bIp) regIfaceIp(devName(l.b), l.bIf || '', l.bIp, l);
  }
  for (const [ip, owners] of ifaceIps) {
    if (owners.length > 1) {
      // 同一链路两端填写相同 IP（终端直连等场景）：提示确认，不按错误处理
      const sameLink = owners.length === 2 && owners[0].link != null && owners[0].link === owners[1].link;
      const msg = 'IP ' + ip + ' 被多个接口使用：' + owners.map(o => o.device + (o.iface ? '/' + o.iface : '')).join('、');
      if (sameLink) add('warn', owners[0].device, msg + '（同一链路两端，请确认是否为终端直连场景）');
      else add('error', owners[0].device, msg);
    }
  }
  for (const [ip, names] of mgmtSeen) {
    if (ifaceIps.has(ip)) add('warn', names[0], '管理地址 ' + ip + ' 同时被用作接口 IP（' + ifaceIps.get(ip).map(o => o.device + (o.iface ? '/' + o.iface : '')).join('、') + '）');
  }

  // 4. 链路两端一致性 + 网段/掩码 + VLAN 有效性
  const ifaceUse = new Map(); // device|iface -> 次数
  const useIface = (device, iface) => {
    if (!iface) return;
    const k = device + '|' + iface;
    ifaceUse.set(k, (ifaceUse.get(k) || 0) + 1);
  };
  for (const l of links) {
    useIface(devName(l.a), l.aIf);
    useIface(devName(l.b), l.bIf);
    const aName = devName(l.a), bName = devName(l.b);
    const l2a = !!l.aL2, l2b = !!l.bL2;
    if (l2a !== l2b) {
      // 一端二层（交换机二层口接入）一端三层（路由器/防火墙三层口）属正常桥接场景，非矛盾：仅提示并存档为警告
      add('warn', aName, '链路 ' + aName + '(' + (l.aIf || '?') + ') ⇄ ' + bName + '(' + (l.bIf || '?') + ') 两端分别为二层/三层接口（正常桥接场景；生成配置时二层端不配 IP、三层端配 IP）');
    }
    if (!l2a && l.aIp && l.bIp) {
      const aBits = parseInt(l.aMask, 10) > 0 && parseInt(l.aMask, 10) <= 32 ? parseInt(l.aMask, 10) : 24;
      const bBits = parseInt(l.bMask, 10) > 0 && parseInt(l.bMask, 10) <= 32 ? parseInt(l.bMask, 10) : 24;
      const sa = U.subnetOf(l.aIp, aBits), sb = U.subnetOf(l.bIp, bBits);
      if (sa !== sb) add('error', aName, '链路 ' + aName + '(' + (l.aIf || '?') + ') ⇄ ' + bName + '(' + (l.bIf || '?') + ') 两端不在同一网段（' + sa + ' vs ' + sb + '）');
      else if (aBits !== bBits) add('warn', aName, '链路 ' + aName + '(' + (l.aIf || '?') + ') ⇄ ' + bName + '(' + (l.bIf || '?') + ') 两端掩码位不一致（/' + aBits + ' vs /' + bBits + '）');
    }
    for (const side of ['a', 'b']) {
      const vlan = String(l[side + 'Vlan'] || '').trim();
      if (l[side + 'L2'] && vlan && !U.parseVlans(vlan).length) {
        add('warn', side === 'a' ? aName : bName, '二层接口 VLAN「' + vlan + '」无效（需为 1-4094 的数字或范围）');
      }
      if (l[side + 'L2'] && l[side + 'VlanMode'] === 'access' && /[-,;，；\s]/.test(vlan)) {
        const first = U.parseVlans(vlan)[0];
        add('warn', side === 'a' ? aName : bName, 'access 模式 VLAN「' + vlan + '」含多个编号，生成时只取第一个' + (first ? '（' + first + '）' : ''));
      }
    }
    if (l2a && l2b && String(l.aVlan || '').trim() && String(l.bVlan || '').trim() && String(l.aVlan).trim() !== String(l.bVlan).trim()) {
      add('warn', aName, '二层链路 ' + aName + ' ⇄ ' + bName + ' 两端 VLAN 不一致（' + l.aVlan + ' vs ' + l.bVlan + '）');
    }
  }
  for (const [k, c] of ifaceUse) {
    if (c > 1) {
      const sep = k.indexOf('|');
      add('warn', k.slice(0, sep), '接口 ' + k.slice(sep + 1) + ' 被 ' + c + ' 条链路同时使用（同一接口只能接一条链路）');
    }
  }

  // 5. 同网段地址掩码不一致
  const netMask = new Map(); // 网络地址 -> Set(位数)
  const regNet = (ip, bits) => {
    const n = U.ipv4ToInt(ip);
    if (n == null) return;
    bits = parseInt(bits, 10);
    if (!(bits > 0 && bits <= 32)) bits = 24;
    const net = U.intToIpv4((n & ((~0 << (32 - bits)) >>> 0)) >>> 0);
    if (!netMask.has(net)) netMask.set(net, new Set());
    netMask.get(net).add(bits);
  };
  for (const n of nodes) {
    for (const v of (Array.isArray(n.vlans) ? n.vlans : [])) {
      if (v.ip) regNet(v.ip, v.mask);
    }
  }
  for (const l of links) {
    if (!l.aL2 && l.aIp) regNet(l.aIp, l.aMask);
    if (!l.bL2 && l.bIp) regNet(l.bIp, l.bMask);
  }
  for (const [net, bitsSet] of netMask) {
    if (bitsSet.size > 1) {
      const first = (nodes[0] && nodes[0].name) || '';
      add('warn', first, '网段 ' + net + ' 上存在不同掩码位：/' + [...bitsSet].sort((x, y) => x - y).join('、/'));
    }
  }

  // 6. SVI（三层 VLAN 接口）无对应二层端口
  for (const n of nodes) {
    for (const v of (Array.isArray(n.vlans) ? n.vlans : [])) {
      const vid = String(v.id || '').trim();
      if (!vid) continue;
      const used = links.some(l =>
        (l.a === n.id && !!l.aL2 && U.parseVlans(l.aVlan).includes(parseInt(vid, 10))) ||
        (l.b === n.id && !!l.bL2 && U.parseVlans(l.bVlan).includes(parseInt(vid, 10))));
      if (!used && v.ip) add('warn', devName(n.id), '三层 VLAN 接口 VLAN' + vid + ' 在本设备上没有任何二层端口放通该 VLAN');
    }
  }

  return { ok: issues.every(i => i.level !== 'error'), issues };
};

/* ---------- 拓扑对比（工程 diff） ---------- */
U.diffProjects = (a, b) => {
  const keyOf = (n) => n.name || '';
  const linkKey = (l, byName) => {
    const an = byName.get(l.a) || '', bn = byName.get(l.b) || '';
    const k = [an, bn].sort().join('|');
    const ifs = [l.aIf || '', l.aIp || '', l.bIf || '', l.bIp || '', String(l.bw || '')].join('/');
    return k + '#' + ifs;
  };
  const byNameA = new Map(a.nodes.map(n => [n.id, n.name]));
  const byNameB = new Map(b.nodes.map(n => [n.id, n.name]));
  const nameA = new Map(a.nodes.map(n => [n.name, n]));
  const nameB = new Map(b.nodes.map(n => [n.name, n]));
  const addedNodes = [], removedNodes = [], changedNodes = [];
  for (const n of a.nodes) {
    const m = nameB.get(n.name);
    if (!m) removedNodes.push(n.name);
    else if (U.nodeMgmts(n).join('|') !== U.nodeMgmts(m).join('|') || n.type !== m.type || (n.note || '') !== (m.note || '')) changedNodes.push({ name: n.name, from: { mgmt: U.nodeMgmts(n).join(', '), type: n.type, note: n.note }, to: { mgmt: U.nodeMgmts(m).join(', '), type: m.type, note: m.note } });
  }
  for (const n of b.nodes) if (!nameA.has(n.name)) addedNodes.push(n.name);
  const linkSetA = new Set(a.links.map(l => linkKey(l, byNameA)));
  const linkSetB = new Set(b.links.map(l => linkKey(l, byNameB)));
  const addedLinks = [], removedLinks = [];
  const keyToText = (k) => { const [pair, rest] = k.split('#'); const [x, y] = pair.split('|'); const [aIf, aIp, bIf, bIp, bw] = rest.split('/'); return x + ' ⇄ ' + y + (aIf ? ' ' + aIf + ' ' + aIp + ' / ' + bIf + ' ' + bIp : '') + (bw ? ' ' + bw : ''); };
  for (const k of linkSetB) if (!linkSetA.has(k)) addedLinks.push(keyToText(k));
  for (const k of linkSetA) if (!linkSetB.has(k)) removedLinks.push(keyToText(k));
  return { addedNodes, removedNodes, changedNodes, addedLinks, removedLinks };
};

/* ---------- LLDP/CDP 邻居表解析（纯函数，Node 测试可调用） ----------
 * 支持：思科 show cdp neighbors 表格 / show cdp neighbors detail 块、
 * 华为 display lldp neighbor(-brief) 与 H3C display lldp neighbor-information 等键值块、
 * 以及中英文表头的 LLDP 简表。自动尝试三种格式并取命中最多者。
 * 返回 { ok, format, entries:[{localIf, peer, peerIf}], lines } */
const NB_IFACE_CLEAN = (s) => String(s || '').replace(/\s+/g, '');
const nbIsIface = (s) => {
  const t = NB_IFACE_CLEAN(s);
  return /^[A-Za-z][A-Za-z0-9.\/:\-]{0,31}$/.test(t) && /\d/.test(t);
};
const nbFirstToken = (v) => String(v == null ? '' : v).trim().split(/[,\s，、（(]/)[0].slice(0, 64);
const nbIsPeerName = (s) => {
  const t = String(s || '').trim();
  if (!t || t.length > 64) return false;
  if (/^\d+$/.test(t)) return false;                      // 纯数字多为过期时间/序号列
  if (/^[0-9a-fA-F]{2}([-:][0-9a-fA-F]{2}){5}$/.test(t)) return false; // 纯 MAC（ChassisId）
  return /[A-Za-z]/.test(t) || /[\u4e00-\u9fff]/.test(t);
};

U.parseNeighbors = (text) => {
  const clean = String(text == null ? '' : text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')            // 去 ANSI 转义
    .replace(/\u001b[()][0-9A-B]/g, '')
    .slice(0, 200 * 1024);                                  // 误粘贴超大文本兜底
  const lines = clean.replace(/\r\n?/g, '\n').split('\n').slice(0, 5000);

  const mk = (localIf, peer, peerIf) => ({ localIf: NB_IFACE_CLEAN(localIf), peer: String(peer || '').trim(), peerIf: peerIf ? NB_IFACE_CLEAN(peerIf) : '' });

  /* A. 思科 CDP 表格：Device ID / Local Intrfce / Holdtme / Capability / Platform / Port ID */
  const parseCdpTable = () => {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/Device\s+ID\s+.*Local\s+Intrf/i.test(lines[i])) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j];
        if (!ln.trim()) break;
        if (/Device\s+ID\s+.*Local\s+Intrf/i.test(ln)) continue; // 换页重复表头
        let cells = ln.trim().split(/\s{2,}/);
        if (cells.length < 3 && j + 1 < lines.length) {
          // 超长 Device ID 换行（独占一行，下一行才是接口/保持时间列）：拼接一次续行（防误并后续行）
          const nc = lines[j + 1].trim().split(/\s{2,}/);
          if (nc.length && cells.length + nc.length >= 3) { cells = cells.concat(nc); j++; }
        }
        if (cells.length < 3) break;
        const holdIdx = cells.findIndex((c, x) => x > 0 && /^\d+$/.test(c));
        if (holdIdx < 2) break; // 列结构异常：本表结束
        const peer = cells[0].trim();
        const localIf = cells.slice(1, holdIdx).join(' ').trim();
        const peerIf = cells[cells.length - 1].trim();
        if (!nbIsPeerName(peer) || !nbIsIface(localIf) || !nbIsIface(peerIf)) continue;
        out.push(mk(localIf, peer, peerIf));
        if (out.length >= 2000) return out;
      }
      if (out.length) break;
    }
    return out;
  };

  /* B. LLDP 简表（含中英文表头）：按表头单元格定位 本地接口 / 对端设备 / 对端接口 列 */
  const parseLldpTable = () => {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i];
      // 思科标准表头（Device ID / Local Intf / Hold-time / Capability / Port ID）不含 neighbor 字样，
      // 放宽为「local + (port|接口列) + (neighbor|device id)」组合识别
      if (!/local|本地/i.test(h) || !/(intf|port|interface|接口|端口)/i.test(h) || !/(neighbor|对端|邻居|device\s*id)/i.test(h)) continue;
      if (!/\s{2,}/.test(h)) continue;
      const headCells = h.trim().split(/\s{2,}/);
      const idxLocal = headCells.findIndex(c => /local|本地/i.test(c));
      const idxPeer = headCells.findIndex(c => (/(neighbor|对端|邻居)/i.test(c) || /device\s*id/i.test(c)) && !/(intf|port|interface|接口|端口)/i.test(c));
      const idxPeerIf = headCells.findIndex(c => /(intf|port|interface|接口|端口)/i.test(c) && !/local|本地/i.test(c));
      if (idxLocal < 0 || idxPeer < 0) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j];
        if (!ln.trim() || /Local\s*Intf|Device\s+ID/i.test(ln)) { if (out.length) break; continue; }
        const cells = ln.trim().split(/\s{2,}/);
        if (cells.length <= Math.max(idxPeer, idxPeerIf)) { if (out.length) break; continue; }
        const peer = nbFirstToken(cells[idxPeer]);
        if (!nbIsPeerName(peer)) { if (out.length) break; continue; }
        const localIf = cells[idxLocal] || '';
        const peerIf = idxPeerIf >= 0 ? cells[idxPeerIf] : '';
        if (!nbIsIface(localIf)) { if (out.length) break; continue; }
        out.push(mk(localIf, peer, peerIf));
        if (out.length >= 2000) return out;
      }
      if (out.length) break;
    }
    return out;
  };

  /* C. 键值块（华为/H3C display lldp neighbor、思科 show cdp neighbors detail、H3C verbose）
   * 记录起始三种形态：Local Intf : GE0/0/1（或 Local Interface / 本地接口）、
   * 「GigabitEthernet0/0/1 has 1 neighbor(s):」（华为/H3C verbose 段头）、
   * 「LLDP neighbor-information of port 1[GigabitEthernet1/0/1]:」（H3C verbose 段头，接口在方括号内） */
  const parseBlocks = () => {
    const out = [];
    const REC_START = /^\s*(?:(?:Local\s*Intf(?:\s*ace)?|Local\s*Interface|本地接口)\s*[:：]|[A-Za-z][A-Za-z0-9.\-/]*\d[A-Za-z0-9.\-/]*\s+has\s+\d+\s+neighbors?\s*[(:：])/i;
    const REC_HAS = /^\s*([A-Za-z][A-Za-z0-9.\-/]*\d[A-Za-z0-9.\-/]*)\s+has\s+\d+\s+neighbors?/i;
    const REC_H3C = /^\s*LLDP\s+neighbor-information\s+of\s+port\s*\d*\s*\[([^\]]+)\]/i;
    const DEV_START = /^\s*Device\s*ID\s*[:：]/i;
    const KV = /^\s*([^:：]{1,48}?)\s*[:：]\s*(.+?)\s*$/;
    let cur = null;
    let segLocal = ''; // 「has N neighbor(s)」/H3C 段头所在端口：段内多个 Device ID 共用
    const flush = () => {
      if (cur && cur.localIf && cur.peer && nbIsIface(cur.localIf) && nbIsPeerName(cur.peer) && out.length < 2000) {
        out.push(mk(cur.localIf, cur.peer, cur.peerIf));
      }
      cur = null;
    };
    for (const ln of lines) {
      const h3m = REC_H3C.exec(ln);
      if (REC_START.test(ln) || h3m) {
        flush();
        const hm = REC_HAS.exec(ln);
        segLocal = hm ? NB_IFACE_CLEAN(hm[1]) : (h3m ? NB_IFACE_CLEAN(h3m[1]) : '');
        cur = hm ? { localIf: hm[1], peer: '', peerIf: '' }
                 : { localIf: h3m ? h3m[1] : nbFirstToken(ln.replace(/^[^:：]*[:：]/, '')), peer: '', peerIf: '' };
        continue;
      }
      if (DEV_START.test(ln)) {
        const v = nbFirstToken(ln.replace(/^[^:：]*[:：]/, ''));
        if (cur && cur.localIf && !cur.peer) { cur.peer = v; continue; } // 华为块内的对端 Device ID 行
        // 段头（has N neighbors / H3C verbose）下第 2 个及以后的邻居：继承本段 localIf（此前被静默丢弃）；
        // CDP detail 等无段头场景 segLocal 为空，localIf 由各块自身的 Interface 行回填，不受影响
        flush(); cur = { localIf: segLocal, peer: v, peerIf: '' };
        continue;
      }
      if (!cur) continue;
      const m = KV.exec(ln);
      if (!m) continue;
      const k = m[1].replace(/\s+/g, ' ').toLowerCase();
      const v = m[2].trim();
      if (!cur.peer && /^(?:neighbor\s*(?:s?'\s*)?(?:device|system\s*name)|system\s*name|sysname|对端设备|邻居系统名)/.test(k)) cur.peer = nbFirstToken(v);
      else if (!cur.peerIf && /^(?:neighbors?'\s*port\s*id|neighbor\s*port\s*id|port\s*id(?:\s*\(outgoing\s*port\))?|neighbor\s*intf(?:\s*ace)?|outgoing\s*port|对端接口)/.test(k)) cur.peerIf = nbFirstToken(v);
      else if (!cur.localIf && /^interface\s*[:：]?/.test(k)) { // CDP detail 的 Interface 行
        // 思科 detail 的 Interface 与 Port ID (outgoing port) 同行：
        // 「Interface: Gi0/1,  Port ID (outgoing port): Gi0/24」——逗号后是对端接口，需二次提取
        const pm = /[,，]\s*port\s*id(?:\s*\(outgoing\s*port\))?\s*[:：]\s*(.+)$/i.exec(v);
        if (pm) {
          cur.localIf = nbFirstToken(v.slice(0, pm.index));
          if (!cur.peerIf) cur.peerIf = nbFirstToken(pm[1]);
        } else {
          cur.localIf = nbFirstToken(v);
        }
      }
    }
    flush();
    return out;
  };

  const cdpT = parseCdpTable(), lldpT = parseLldpTable(), blocks = parseBlocks();
  const cands = [
    { format: 'cdp-table', entries: cdpT },
    { format: 'lldp-table', entries: lldpT },
    { format: 'key-value', entries: blocks }
  ].sort((a, b) => b.entries.length - a.entries.length);
  const best = cands[0];
  if (!best.entries.length) {
    return { ok: false, format: '', entries: [], lines: lines.length,
      error: '未识别到邻居表：支持思科 show cdp neighbors、华为/H3C display lldp neighbor 等输出' };
  }
  // 同一本地接口多条记录（如聚合口/重复粘贴）按首条去重
  const seen = new Set();
  const entries = best.entries.filter(e => {
    const k = e.localIf + '→' + e.peer;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ok: true, format: best.format, entries, lines: lines.length };
};

/** 邻居表解析结果合并进图（原地修改 nodes/links；返回 {addedNodes, addedLinks, updatedLinks, skipped}）。
 *  - 对端设备按名称匹配：已存在则复用，不存在则新建（类型按名称推断，位置摆在本端设备右侧）
 *  - 已有链路（同设备对、任一端接口名匹配）回填空缺的接口名；两接口齐备但不匹配则跳过 */
U.applyNeighbors = (nodes, links, localId, entries, opts) => {
  opts = opts || {};
  const local = (nodes || []).find(n => n.id === localId);
  if (!local) return { ok: false, error: '本端设备不存在' };
  const byName = new Map((nodes || []).map(n => [String(n.name || '').trim(), n]));
  let addedNodes = 0, addedLinks = 0, updatedLinks = 0, skipped = 0;
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || !e.localIf || !e.peer) { skipped++; continue; }
    const peerName = String(e.peer).trim();
    let peer = byName.get(peerName);
    if (peer && peer.id === local.id) { skipped++; continue; } // 自环
    if (!peer) {
      const yOff = (addedNodes % 8) * 70 - 140;
      peer = {
        id: U.uid('n'), name: peerName, type: U.typeOf(peerName),
        x: (Number(local.x) || 0) + 260, y: (Number(local.y) || 0) + yOff,
        w: U.nodeWidthForName(peerName), h: U.NODE_H, note: '', mgmt: ''
      };
      nodes.push(peer);
      byName.set(peerName, peer);
      addedNodes++;
    }
    const la = (e.localIf || '').trim(), lb = (e.peerIf || '').trim();
    // 匹配已有链路：同设备对，且（接口齐备并一致）或（对端接口未识别时按本端接口匹配）
    const found = (links || []).find(l => {
      const ab = l.a === local.id && l.b === peer.id;
      const ba = l.a === peer.id && l.b === local.id;
      if (!ab && !ba) return false;
      const lIf = ab ? (l.aIf || '') : (l.bIf || '');
      const pIf = ab ? (l.bIf || '') : (l.aIf || '');
      if (!lb) return !lIf || lIf === la;
      if (lIf && pIf) return lIf === la && pIf === lb;
      return !lIf || lIf === la;
    });
    if (found) {
      const ab = found.a === local.id && found.b === peer.id;
      let changed = false;
      const fill = (slot, val) => { if (!found[slot] && val) { found[slot] = val; changed = true; } };
      if (ab) { fill('aIf', la); fill('bIf', lb); }
      else { fill('bIf', la); fill('aIf', lb); }
      if (changed) updatedLinks++; else skipped++;
      continue;
    }
    if (!lb && !opts.allowMissingPeerIf) { skipped++; continue; }
    links.push({
      id: U.uid('l'), a: local.id, b: peer.id,
      aIf: la, aIp: '', bIf: lb, bIp: '', bw: '',
      note: String(opts.note || ''), agg: ''
    });
    addedLinks++;
  }
  return { ok: true, addedNodes, addedLinks, updatedLinks, skipped };
};

/* ---------- 接口总表（全部链路两端接口集中编辑用；纯函数，Node 测试可调用） ----------
 * 每条链路的 a/b 两端各一行（接口名为空的行不生成），按设备名（中文序）+ 接口名排序。 */
U.buildIfTableRows = (nodes, links) => {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map(n => [n.id, n]));
  const rows = [];
  for (const l of (Array.isArray(links) ? links : [])) {
    const na = byId.get(l.a), nb = byId.get(l.b);
    for (const side of ['a', 'b']) {
      const ifn = String(l[side + 'If'] || '').trim();
      if (!ifn) continue;
      const self = side === 'a' ? na : nb;
      const peer = side === 'a' ? nb : na;
      rows.push({
        key: l.id + '|' + side,
        linkId: l.id, side,
        nodeId: self ? self.id : '', nodeName: self ? self.name : '?',
        ifn,
        ip: String(l[side + 'Ip'] || ''),
        mask: parseInt(l[side + 'Mask'], 10) > 0 && parseInt(l[side + 'Mask'], 10) <= 32 ? parseInt(l[side + 'Mask'], 10) : 24,
        l2: !!l[side + 'L2'],
        vlan: String(l[side + 'Vlan'] || ''),
        vlanMode: l[side + 'VlanMode'] || '',
        agg: String(l.agg || ''),
        peerName: peer ? peer.name : '?', peerIf: String(side === 'a' ? (l.bIf || '') : (l.aIf || '')).trim(),
        note: String(l.note || ''),
        bw: String(l.bw || '')
      });
    }
  }
  rows.sort((x, y) => x.nodeName.localeCompare(y.nodeName, 'zh') || x.ifn.localeCompare(y.ifn, 'zh', { numeric: true }));
  return rows;
};

/* ---------- 设备批量重命名 ---------- */
U.renameNodes = (nodes, opts) => {
  opts = opts || {};
  const prefix = opts.prefix || '', suffix = opts.suffix || '';
  const mode = opts.mode || 'keep'; // keep | number
  const start = opts.start != null ? Number(opts.start) : 1;
  const pad = opts.pad || 0;
  const sep = opts.sep || '';
  const sorted = [...nodes].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  sorted.forEach((n, i) => {
    const base = mode === 'number' ? '' : (n.name || '').trim();
    const num = mode === 'number' ? String(start + i).padStart(pad, '0') : '';
    n.name = (prefix + (base || num) + (num && base ? sep : '') + suffix).trim() || n.name;
  });
};

/* ---------- IP 规划清单（设备/接口/网段） ---------- */
U.ipPlan = (nodes, links) => {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const rows = [];
  const subnetMap = new Map(); // 网段 -> Set(设备名)
  const addSubnet = (ip, devName) => {
    const s = U.subnetOf(ip);
    if (!s) return;
    if (!subnetMap.has(s)) subnetMap.set(s, new Set());
    subnetMap.get(s).add(devName);
  };
  const typeLabel = (id) => { const nd = byId.get(id); return nd ? U.getType(nd.type).label : ''; };
  // 按设备聚合：同一台设备的“管理地址 + 全部接口”连续排列，便于 Excel 合并设备名列
  const sorted = [...nodes].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  for (const n of sorted) {
    const mgmts = U.nodeMgmts(n);
    mgmts.forEach((ip, mi) => {
      rows.push({ 设备: n.name, 类型: typeLabel(n.id), 接口: mi === 0 ? '管理' : '管理' + (mi + 1), IP: ip, 对端设备: '', 对端接口: '', 对端IP: '', 带宽: '', 网段: U.subnetOf(ip) || '', 备注: n.note || '' });
      addSubnet(ip, n.name);
    });
    for (const l of links) {
      const other = l.a === n.id ? byId.get(l.b) : (l.b === n.id ? byId.get(l.a) : null);
      if (!other) continue;
      const myIf = l.a === n.id ? l.aIf : l.bIf;
      const myIp = l.a === n.id ? l.aIp : l.bIp;
      const otIf = l.a === n.id ? l.bIf : l.aIf;
      const otIp = l.a === n.id ? l.bIp : l.aIp; // 对端接口 IP
      if (myIp) {
        rows.push({ 设备: n.name, 类型: typeLabel(n.id), 接口: myIf || '', IP: myIp, 对端设备: other.name, 对端接口: otIf || '', 对端IP: otIp || '', 带宽: U.formatBw(l.bw), 网段: U.subnetOf(myIp) || '', 备注: l.note || '' });
        addSubnet(myIp, n.name);
      }
    }
  }
  const subnets = [...subnetMap.entries()]
    .map(([cidr, names]) => ({ cidr, devices: [...names].sort((a, b) => a.localeCompare(b, 'zh')) }))
    .sort((a, b) => (a.cidr < b.cidr ? -1 : a.cidr > b.cidr ? 1 : 0));
  return { rows, subnets };
};

/* ---------- 网段分析（网段视角的 IP 总览；纯函数，Node 测试可调用） ----------
 * 地址来源：链路两端接口 IP（各按其掩码位，缺省 /24；二层接口无 IP 不参与）、
 * 设备三层 VLAN 接口（n.vlans：{id, ip, mask?}）、设备管理地址（无掩码信息，按 /24 归组）。
 * 按 CIDR 精确分组，每组：成员设备/链路、已用 IP（去重）/可用容量、VLAN、来源构成；
 * 异常 flags：overlap 与其他网段区间相交（不同掩码规划冲突）、netbc 误用网段/广播地址（/30 及以下）、
 * overcap 已用 IP 数超过可用容量。返回 { rows, stats }，rows 按网段地址数值升序。 */
U.buildSubnetTable = (nodes, links) => {
  nodes = Array.isArray(nodes) ? nodes : [];
  links = Array.isArray(links) ? links : [];
  const groups = new Map(); // cidr -> 组
  const bitsOf = (v) => {
    const b = parseInt(v, 10);
    return Number.isFinite(b) && b >= 0 && b <= 32 ? b : 24;
  };
  const add = (rawIp, bits, ent, vlans) => {
    const ip = String(rawIp || '').trim();
    const b = bitsOf(bits);
    const cidr = U.subnetOf(ip, b);
    if (!cidr) return null;
    let g = groups.get(cidr);
    if (!g) {
      const calc = U.subnetCalc(ip, b);
      g = {
        cidr, bits: b, netInt: U.ipv4ToInt(calc.network), bcInt: U.ipv4ToInt(calc.broadcast),
        mask: calc.mask, usable: calc.usable,
        entries: [], nodeIds: new Set(), linkIds: new Set(), vlanIds: new Set(),
        ipSet: new Set(), srcIf: 0, srcSvi: 0, srcMgmt: 0
      };
      groups.set(cidr, g);
    }
    g.entries.push(Object.assign({ ip }, ent));
    g.ipSet.add(U.ipv4ToInt(ip));
    if (ent.nodeId) g.nodeIds.add(ent.nodeId);
    if (ent.linkId) g.linkIds.add(ent.linkId);
    if (ent.source === 'svi') g.srcSvi++;
    else if (ent.source === 'mgmt') g.srcMgmt++;
    else g.srcIf++;
    for (const v of vlans || []) g.vlanIds.add(v);
    return g;
  };

  for (const l of links) {
    if (!l) continue;
    for (const side of ['a', 'b']) {
      const ip = String(l[side + 'Ip'] || '').trim();
      if (!ip) continue;
      add(ip, l[side + 'Mask'], {
        source: 'if', nodeId: l[side],
        ifn: String(l[side + 'If'] || '').trim() || '?', linkId: l.id
      }, U.parseVlans(l[side + 'Vlan']));
    }
  }
  for (const n of nodes) {
    if (!n) continue;
    for (const v of (Array.isArray(n.vlans) ? n.vlans : [])) {
      if (!v || !v.ip) continue;
      add(v.ip, v.mask, { source: 'svi', nodeId: n.id, ifn: 'VLAN' + (v.id || '?'), linkId: '' }, U.parseVlans(v.id));
    }
    for (const ip of U.nodeMgmts(n)) {
      add(ip, 24, { source: 'mgmt', nodeId: n.id, ifn: '管理', linkId: '' }, []);
    }
  }

  const rows = [...groups.values()].map((g) => {
    const flags = [];
    if (g.ipSet.size > g.usable) flags.push('overcap');
    if (g.bits <= 30) {
      for (const e of g.entries) {
        const t = U.ipv4ToInt(e.ip);
        if (t === g.netInt || t === g.bcInt) { flags.push('netbc'); break; }
      }
    }
    return {
      cidr: g.cidr, bits: g.bits, mask: g.mask,
      netInt: g.netInt, bcInt: g.bcInt, usable: g.usable,
      used: g.ipSet.size, util: g.usable > 0 ? g.ipSet.size / g.usable : 0,
      vlanIds: [...g.vlanIds].sort((x, y) => x - y),
      nodeIds: [...g.nodeIds], linkIds: [...g.linkIds],
      srcIf: g.srcIf, srcSvi: g.srcSvi, srcMgmt: g.srcMgmt,
      entries: g.entries, flags, overlaps: []
    };
  });
  rows.sort((x, y) => x.netInt - y.netInt || y.bits - x.bits);

  // 网段重叠：已按网段地址升序，右侧网段起点不超过左侧广播地址即区间相交（相同 CIDR 已合并为一组）
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].netInt > rows[i].bcInt) break;
      rows[i].overlaps.push(rows[j].cidr);
      rows[j].overlaps.push(rows[i].cidr);
      if (!rows[i].flags.includes('overlap')) rows[i].flags.push('overlap');
      if (!rows[j].flags.includes('overlap')) rows[j].flags.push('overlap');
    }
  }

  const stats = {
    subnetCount: rows.length,
    ipCount: rows.reduce((s, r) => s + r.entries.length, 0),
    overlap: rows.filter(r => r.flags.includes('overlap')).length,
    netbc: rows.filter(r => r.flags.includes('netbc')).length,
    overcap: rows.filter(r => r.flags.includes('overcap')).length
  };
  return { rows, stats };
};

/* Excel 设备名合并区间：同一台设备的连续行合并（数据行从第 1 行起，设备名列 = 0） */
U.deviceMergeRanges = (rows) => {
  const merges = [];
  let excelRow = 1;
  let idx = 0;
  while (idx < rows.length) {
    const name = rows[idx].设备;
    let j = idx;
    while (j < rows.length && rows[j].设备 === name) j++;
    if (j - idx > 1) merges.push({ s: { r: excelRow, c: 0 }, e: { r: excelRow + (j - idx) - 1, c: 0 } });
    excelRow += (j - idx);
    idx = j;
  }
  return merges;
};

/* ---------- IP 批量改段 ---------- */
U.cidrInfo = (cidr) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
  if (!m) return null;
  const p = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (p.some(v => v > 255) || prefix < 0 || prefix > 32) return null;
  const ip = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { ip, mask, prefix, base: (ip & mask) >>> 0 };
};
/* 把 ip 从 oldCidr 段改到 newCidr 段（保留主机位）；不在段内返回原值 */
U.renumberIp = (ip, oldCidr, newCidr) => {
  const a = U.cidrInfo(oldCidr), b = U.cidrInfo(newCidr);
  const n = U.ipv4ToInt(ip);
  if (!a || !b || n == null) return ip;
  if (((n & a.mask) >>> 0) !== a.base) return ip; // 不在原网段
  const host = (n & (~a.mask >>> 0)) >>> 0;
  // 新网段主机位不足时保留可用部分
  const newHost = (host & (~b.mask >>> 0)) >>> 0;
  return U.intToIpv4((b.base | newHost) >>> 0);
};

/* ---------- 多选对齐 / 分布 ---------- */
U.alignNodes = (nodes, mode) => {
  if (!nodes || nodes.length < 2) return;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs.map((x, i) => x + nodes[i].w));
  const minY = Math.min(...ys), maxY = Math.max(...ys.map((y, i) => y + nodes[i].h));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (mode === 'left') nodes.forEach(n => { n.x = minX; });
  else if (mode === 'right') nodes.forEach(n => { n.x = maxX - n.w; });
  else if (mode === 'hcenter') nodes.forEach(n => { n.x = cx - n.w / 2; });
  else if (mode === 'top') nodes.forEach(n => { n.y = minY; });
  else if (mode === 'bottom') nodes.forEach(n => { n.y = maxY - n.h; });
  else if (mode === 'vcenter') nodes.forEach(n => { n.y = cy - n.h / 2; });
  else if (mode === 'hdist' || mode === 'vdist') {
    const sorted = [...nodes].sort((a, b) => mode === 'hdist' ? a.x - b.x : a.y - b.y);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const dims = sorted.map(n => mode === 'hdist' ? n.w : n.h);
    const firstEdge = mode === 'hdist' ? first.x : first.y;
    const lastEdge = mode === 'hdist' ? last.x + last.w : last.y + last.h;
    const gaps = sorted.length - 1;
    const gap = (lastEdge - firstEdge - dims.reduce((s, w) => s + w, 0)) / gaps;
    let cur = firstEdge;
    for (let i = 0; i < sorted.length; i++) {
      if (mode === 'hdist') sorted[i].x = cur; else sorted[i].y = cur;
      cur += dims[i] + gap;
    }
  }
};

/* ---------- 拓扑设计报告（自包含 HTML） ---------- */
U.buildReportHtml = (nodes, links) => {
  const { rows, subnets } = U.ipPlan(nodes, links);
  const esc = U.escHtml;
  const bwMap = new Map();
  for (const l of links) { const n = U.normalizeBw(l.bw); if (n) bwMap.set(n, (bwMap.get(n) || 0) + 1); }
  const bwRows = [...bwMap.entries()].sort((a, b) => b[0] - a[0])
    .map(([n, c]) => `<tr><td>${esc(U.formatBw(n))}</td><td>${c}</td></tr>`).join('');
  // IP 规划表：设备名列按设备合并（rowspan）
  const ipRows = [];
  let i = 0;
  while (i < rows.length) {
    const name = rows[i].设备;
    let j = i;
    while (j < rows.length && rows[j].设备 === name) j++;
    const span = j - i;
    for (let k = i; k < j; k++) {
      const r = rows[k];
      ipRows.push(`<tr>${k === i ? `<td rowspan="${span}"><b>${esc(name)}</b></td>` : ''}
        <td>${esc(r.类型)}</td><td>${esc(r.接口)}</td><td>${esc(r.IP)}</td>
        <td>${esc(r.对端设备)}</td><td>${esc(r.对端接口)}</td><td>${esc(r.对端IP)}</td><td>${esc(r.带宽)}</td><td>${esc(r.网段)}</td><td>${esc(r.备注)}</td></tr>`);
    }
    i = j;
  }
  const linkRows = links.map(l => {
    const a = nodes.find(n => n.id === l.a), b = nodes.find(n => n.id === l.b);
    return `<tr><td>${esc(a ? a.name : '?')}</td><td>${esc(l.aIf || '')}</td><td>${esc(l.aIp || '')}</td>
      <td>${esc(b ? b.name : '?')}</td><td>${esc(l.bIf || '')}</td><td>${esc(l.bIp || '')}</td>
      <td>${esc(l.bw ? U.formatBw(l.bw) : '')}</td><td>${esc(l.note || '')}</td></tr>`;
  }).join('');
  const devRows = nodes.map(n => {
    const t = U.getType(n.type);
    const cnt = links.filter(l => l.a === n.id || l.b === n.id).length;
    return `<tr><td><b>${esc(n.name)}</b></td><td>${esc(t.label)}</td><td>${esc(U.nodeMgmts(n).join(', '))}</td><td>${cnt}</td><td>${esc(n.note || '')}</td></tr>`;
  }).join('');
  const subRows = subnets.map(s => `<tr><td><b>${esc(s.cidr)}</b></td><td>${s.devices.length}</td><td>${esc(s.devices.join('、'))}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>网络拓扑设计报告</title>
<style>
body{font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#1e293b;margin:32px auto;max-width:980px;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-left:4px solid #4f46e5;padding-left:8px}
.meta{color:#64748b;font-size:12px;margin-bottom:20px}
table{border-collapse:collapse;width:100%;margin:6px 0 10px;font-size:12.5px}
th,td{border:1px solid #dbe2ec;padding:5px 8px;text-align:left;vertical-align:top}
th{background:#f1f5f9;font-weight:600}tr:nth-child(even) td{background:#f8fafc}
.stats{display:flex;gap:24px;flex-wrap:wrap;margin:14px 0}
.stat{background:#f1f5f9;border-radius:10px;padding:10px 18px;text-align:center}
.stat b{display:block;font-size:20px;color:#4f46e5}
pre{background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:10px;font:12px/1.55 Consolas,monospace;overflow:auto;white-space:pre}
</style></head><body>
<h1>网络拓扑设计报告</h1>
<div class="meta">生成时间：${esc(new Date().toLocaleString('zh-CN'))} · 设备 ${nodes.length} 台 · 连线 ${links.length} 条 · 网段 ${subnets.length} 个</div>
<div class="stats">
  <div class="stat"><b>${nodes.length}</b>设备</div>
  <div class="stat"><b>${links.length}</b>链路</div>
  <div class="stat"><b>${subnets.length}</b>网段</div>
  <div class="stat"><b>${rows.length}</b>接口/IP</div>
</div>
<h2>设备清单</h2>
<table><tr><th>设备名</th><th>类型</th><th>管理地址</th><th>接口数</th><th>备注</th></tr>${devRows}</table>
<h2>IP 规划</h2>
<table><tr><th>设备名</th><th>类型</th><th>接口</th><th>IP</th><th>对端设备</th><th>对端接口</th><th>对端IP</th><th>带宽</th><th>网段</th><th>备注</th></tr>${ipRows}</table>
<h2>子网统计</h2>
<table><tr><th>网段</th><th>设备数</th><th>设备</th></tr>${subRows}</table>
<h2>链路明细</h2>
<table><tr><th>A设备</th><th>A接口</th><th>A IP</th><th>B设备</th><th>B接口</th><th>B IP</th><th>带宽</th><th>备注</th></tr>${linkRows}</table>
${bwRows ? `<h2>带宽汇总</h2><table><tr><th>带宽</th><th>链路数</th></tr>${bwRows}</table>` : ''}
</body></html>`;
};

/* ---------- 最短路径（BFS，无向） ---------- */
U.shortestPath = (nodes, links, fromId, toId) => {
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, []);
  const linkOf = new Map(); // "a|b" -> link
  for (const l of links) {
    // 悬空链路引用（手工编辑的工程数据可能出现）跳过：adj.get(undefined).push 会直接抛错
    if (!adj.has(l.a) || !adj.has(l.b)) continue;
    adj.get(l.a).push(l.b); adj.get(l.b).push(l.a);
    const k1 = l.a + '|' + l.b, k2 = l.b + '|' + l.a;
    if (!linkOf.has(k1)) linkOf.set(k1, l.id);
    if (!linkOf.has(k2)) linkOf.set(k2, l.id);
  }
  if (!adj.has(fromId) || !adj.has(toId)) return null;
  if (fromId === toId) return { nodeIds: [fromId], linkIds: [] };
  const prev = new Map(); // node -> {node, link}
  const seen = new Set([fromId]);
  const q = [fromId];
  while (q.length) {
    const u = q.shift();
    if (u === toId) break;
    for (const v of adj.get(u) || []) {
      if (seen.has(v)) continue;
      seen.add(v);
      prev.set(v, { node: u, link: linkOf.get(u + '|' + v) });
      q.push(v);
    }
  }
  if (!prev.has(toId)) return null; // 不可达
  const nodeIds = [];
  const linkIds = [];
  let cur = toId;
  while (cur !== fromId) {
    nodeIds.unshift(cur);
    const p = prev.get(cur);
    linkIds.unshift(p.link);
    cur = p.node;
  }
  nodeIds.unshift(fromId);
  return { nodeIds, linkIds };
};

/* ---------- 最宽路径（Dijkstra 最大瓶颈带宽） ----------
 * 链路聚合：同一对设备间「同名聚合组」（l.agg 非空且相同）的多条链路合并为一条逻辑链路，
 * 容量 = 成员带宽之和；成员被标记故障时不计入容量（全部成员故障则该聚合链路不可用）。
 * 未标记聚合的平行链路仍按独立链路参与计算（旧行为不变）。 */
U.bestPath = (nodes, links, fromId, toId, opts) => {
  opts = opts || {};
  const exclude = opts.exclude || null; // 故障链路 id 集合（Set）
  const edges = [];
  const edgeOf = new Map(); // pair|agg 组 -> {cap, lids}
  for (const l of links) {
    if (exclude && exclude.has(l.id)) continue; // 故障链路（或聚合故障成员）不参与
    const agg = String(l.agg || '').trim();
    const cap = U.normalizeBw(l.bw) || 1; // 未设置带宽视为最低
    if (agg) {
      const pk = l.a < l.b ? l.a + '|' + l.b : l.b + '|' + l.a;
      const ek = pk + '#' + agg;
      let e = edgeOf.get(ek);
      if (!e) { e = { a: l.a, b: l.b, cap: 0, lids: [] }; edgeOf.set(ek, e); }
      e.cap += cap;
      e.lids.push(l.id);
    } else {
      edges.push({ a: l.a, b: l.b, cap, lids: [l.id] });
    }
  }
  for (const e of edgeOf.values()) edges.push(e);
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.a).push({ to: e.b, cap: e.cap, lids: e.lids });
    adj.get(e.b).push({ to: e.a, cap: e.cap, lids: e.lids });
  }
  if (!adj.has(fromId) || !adj.has(toId)) return null;
  if (fromId === toId) return { nodeIds: [fromId], linkIds: [], bottleneck: Infinity };
  const best = new Map([[fromId, Infinity]]);
  const prev = new Map();
  const done = new Set();
  for (;;) {
    let u = null, ub = -1;
    for (const [id, b] of best) if (!done.has(id) && b > ub) { ub = b; u = id; }
    if (u == null) break;
    done.add(u);
    if (u === toId) break;
    for (const e of adj.get(u) || []) {
      if (done.has(e.to)) continue;
      const nb = Math.min(ub, e.cap);
      if (nb > (best.get(e.to) || 0)) {
        best.set(e.to, nb);
        prev.set(e.to, { node: u, lids: e.lids });
      }
    }
  }
  if (!prev.has(toId)) return null;
  const nodeIds = [];
  const linkIds = [];
  let cur = toId;
  while (cur !== fromId) {
    nodeIds.unshift(cur);
    const p = prev.get(cur);
    linkIds.unshift(...p.lids);
    cur = p.node;
  }
  nodeIds.unshift(fromId);
  return { nodeIds, linkIds, bottleneck: best.get(toId) };
};

/* ---------- 连线交叉计数（直线边，用于评估布局质量） ---------- */
U.countCrossings = (nodes, links) => {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const segs = [];
  for (const l of links) {
    const a = byId.get(l.a), b = byId.get(l.b);
    if (!a || !b) continue;
    segs.push({ x1: a.x + a.w / 2, y1: a.y + a.h / 2, x2: b.x + b.w / 2, y2: b.y + b.h / 2 });
  }
  const cross = (s, x, y, x2, y2) => (x - s.x1) * (y2 - s.y2) - (y - s.y1) * (x2 - s.x2);
  let c = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i], q = segs[j];
      const d1 = cross(q, p.x1, p.y1, p.x2, p.y2);
      const d2 = cross(q, p.x2, p.y2, p.x1, p.y1);
      const d3 = cross(p, q.x1, q.y1, q.x2, q.y2);
      const d4 = cross(p, q.x2, q.y2, q.x1, q.y1);
      if (d1 * d2 < 0 && d3 * d4 < 0) c++;
    }
  }
  return c;
};

/* ================= 单点故障 / 故障影响分析（纯图算法，无向连通性） =================
 *  - 单点设备（割点）：该设备故障后，原本与它连通的设备被拆分成多个区域
 *  - 关键链路（割边 / 无冗余链路）：该链路故障后两端失联；同一对设备间的平行链路
 *    （含链路聚合成员）视为互为冗余，单条成员故障不构成关键链路
 * opts.exclude：已标记故障的链路 id 集合（Set），分析时视为已断开
 */

/* 连通分量：返回节点 id 分组列表（每个节点恰好归属一组） */
U.graphComponents = (nodes, links, opts) => {
  opts = opts || {};
  const exclude = opts.exclude || null;
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const l of (links || [])) {
    if (exclude && exclude.has(l.id)) continue;
    if (!adj.has(l.a) || !adj.has(l.b) || l.a === l.b) continue;
    adj.get(l.a).push(l.b);
    adj.get(l.b).push(l.a);
  }
  const seen = new Set();
  const comps = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const comp = [];
    const q = [n.id];
    seen.add(n.id);
    while (q.length) {
      const u = q.pop();
      comp.push(u);
      for (const v of adj.get(u) || []) {
        if (seen.has(v)) continue;
        seen.add(v);
        q.push(v);
      }
    }
    comps.push(comp);
  }
  return comps;
};

/* 割点 + 割边（Tarjan，迭代 DFS 防大图递归栈溢出；平行链路折叠为一组）
 * 返回 { points: [nodeId…], bridges: [{ linkId, a, b }…] }（顺序按输入确定，不去重排序） */
U.spofAnalysis = (nodes, links, opts) => {
  opts = opts || {};
  const exclude = opts.exclude || null;
  const ids = new Set(nodes.map(n => n.id));
  const pairKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const groups = new Map(); // pairKey -> { a, b, lids[] }：同一对设备的全部有效链路
  for (const l of (links || [])) {
    if (exclude && exclude.has(l.id)) continue;
    if (!ids.has(l.a) || !ids.has(l.b) || l.a === l.b) continue;
    const k = pairKey(l.a, l.b);
    let g = groups.get(k);
    if (!g) { g = { a: l.a, b: l.b, lids: [] }; groups.set(k, g); }
    g.lids.push(l.id);
  }
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const g of groups.values()) {
    adj.get(g.a).push({ to: g.b, g });
    adj.get(g.b).push({ to: g.a, g });
  }
  const disc = new Map(), low = new Map();
  const isPoint = new Set();
  const bridges = [];
  let timer = 0;
  for (const root of ids) {
    if (disc.has(root)) continue;
    let rootChildren = 0;
    disc.set(root, timer); low.set(root, timer); timer++;
    // 帧结构 [节点, 进入边所属链路组, 邻接下标]：进入边组用于识别来边（其全部平行链路一并跳过）
    const stack = [[root, null, 0]];
    while (stack.length) {
      const fr = stack[stack.length - 1];
      const u = fr[0], via = fr[1];
      const list = adj.get(u) || [];
      if (fr[2] < list.length) {
        const e = list[fr[2]++];
        if (e.g === via) continue; // 来边不算回边（平行链路已折叠，天然整组跳过）
        if (!disc.has(e.to)) {
          if (u === root) rootChildren++;
          disc.set(e.to, timer); low.set(e.to, timer); timer++;
          stack.push([e.to, e.g, 0]);
        } else if (disc.get(e.to) < low.get(u)) {
          low.set(u, disc.get(e.to)); // 回边更新
        }
      } else {
        stack.pop();
        if (!stack.length) continue;
        const parent = stack[stack.length - 1][0];
        if (low.get(u) < low.get(parent)) low.set(parent, low.get(u));
        if (parent !== root && low.get(u) >= disc.get(parent)) isPoint.add(parent);
        if (low.get(u) > disc.get(parent) && via.lids.length === 1) {
          bridges.push({ linkId: via.lids[0], a: via.a, b: via.b });
        }
      }
    }
    if (rootChildren >= 2) isPoint.add(root);
  }
  return { points: [...isPoint], bridges };
};

/* 单设备 / 单链路故障影响分析
 * kind='node'：{ kind, id, isSPOF, groups: [{ nodeIds, size }], isolatedCount, survivorCount }
 *   先取该设备故障前所在的连通区域，删除该设备后区域重新分组：
 *   最大区域视为「存续主网络」，其余为失联区域；最大区域并列时无主网络
 *   可言（survivorCount=0），全部区域计为失联；isSPOF = 存在失联区域
 * kind='link'：{ kind, id, a, b, redundant, reroute, isolated, isolatedCount }
 *   redundant=true：断开后两端仍连通，reroute 为最短绕行路径（{ nodeIds, linkIds }，无则 null）
 *   redundant=false：两端失联，isolated 为两侧中较少的一侧（受影响设备） */
U.failureImpact = (nodes, links, kind, id, opts) => {
  opts = opts || {};
  const exclude = opts.exclude || null;
  const ids = new Set(nodes.map(n => n.id));
  const keep = (l) => !!l && ids.has(l.a) && ids.has(l.b) && l.a !== l.b && !(exclude && exclude.has(l.id));

  /* nodeIds 子图的连通分量（忽略 dropLinkId 这条链路） */
  const compsOf = (nodeIds, dropLinkId) => {
    const set = new Set(nodeIds);
    const adj = new Map(nodeIds.map(x => [x, []]));
    for (const l of (links || [])) {
      if (l.id === dropLinkId || !keep(l) || !set.has(l.a) || !set.has(l.b)) continue;
      adj.get(l.a).push(l.b);
      adj.get(l.b).push(l.a);
    }
    const seen = new Set();
    const comps = [];
    for (const s of nodeIds) {
      if (seen.has(s)) continue;
      const comp = [];
      const q = [s];
      seen.add(s);
      while (q.length) {
        const u = q.pop();
        comp.push(u);
        for (const v of adj.get(u) || []) {
          if (!seen.has(v)) { seen.add(v); q.push(v); }
        }
      }
      comps.push(comp);
    }
    return comps;
  };

  if (kind === 'node') {
    if (!ids.has(id)) return { kind, id, isSPOF: false, groups: [], isolatedCount: 0, survivorCount: 0 };
    const comp = compsOf(nodes.map(n => n.id)).find(c => c.includes(id)) || [id];
    const rest = comp.filter(x => x !== id);
    if (!rest.length) return { kind, id, isSPOF: false, groups: [], isolatedCount: 0, survivorCount: 0 };
    const comps = compsOf(rest).slice().sort((x, y) => y.length - x.length);
    // 最大区域视为「存续主网络」，其余为失联区域；最大区域并列时无主网络可言，全部计为失联
    const tie = comps.length > 1 && comps[0].length === comps[1].length;
    const groups = (tie ? comps : comps.slice(1)).map(c => ({ nodeIds: c, size: c.length }));
    return {
      kind, id,
      isSPOF: groups.length > 0,
      groups,
      isolatedCount: groups.reduce((s, g) => s + g.size, 0),
      survivorCount: tie ? 0 : comps[0].length
    };
  }

  const l = (links || []).find(x => x.id === id);
  if (!l || !ids.has(l.a) || !ids.has(l.b)) {
    return { kind, id, a: '', b: '', redundant: null, reroute: null, isolated: [], isolatedCount: 0 };
  }
  const comps = compsOf(nodes.map(n => n.id), l.id);
  const ca = comps.find(c => c.includes(l.a));
  const cb = comps.find(c => c.includes(l.b));
  if (ca && cb && ca !== cb) {
    const isolated = ca.length <= cb.length ? ca : cb;
    return { kind, id, a: l.a, b: l.b, redundant: false, reroute: null, isolated, isolatedCount: isolated.length };
  }
  // 两端仍连通：存在冗余路径，给出最短绕行（排除该链路与故障链路）
  const reroute = U.shortestPath(nodes, (links || []).filter(x => keep(x) && x.id !== l.id), l.a, l.b);
  return { kind, id, a: l.a, b: l.b, redundant: true, reroute, isolated: [], isolatedCount: 0 };
};

/* ---------- 节点默认尺寸 ---------- */
U.NODE_W = 160;
U.NODE_H = 56;
U.NODE_H_MGMT = 72; // 含管理地址的节点高度

/* 节点全部管理地址（主地址 n.mgmt + 附加 n.mgmts，去重保序） */
U.nodeMgmts = (n) => {
  const arr = [];
  const push = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (s && !arr.includes(s)) arr.push(s);
  };
  if (n) { push(n.mgmt); for (const m of (Array.isArray(n.mgmts) ? n.mgmts : [])) push(m); }
  return arr;
};
/* 把文本（逗号/分号/换行分隔）拆成管理地址列表 */
U.splitMgmts = (v) => String(v == null ? '' : v).split(/[,，;；\n\r]+/).map(s => s.trim()).filter(Boolean);
/* 设置设备管理地址列表：第一个为主地址 n.mgmt，其余放入 n.mgmts */
U.setNodeMgmts = (n, arr) => {
  const list = (Array.isArray(arr) ? arr : []).map(s => String(s == null ? '' : s).trim()).filter(Boolean);
  const uniq = [];
  for (const s of list) if (!uniq.includes(s)) uniq.push(s);
  n.mgmt = uniq[0] || '';
  n.mgmts = uniq.slice(1);
  return uniq;
};

/* 节点高度：无管理地址 56；每多一个管理口加高 16px（最多 3 行显示） */
U.nodeHeightFor = (n) => {
  const c = U.nodeMgmts(n).length;
  return c ? U.NODE_H + Math.min(c, 3) * 16 : U.NODE_H;
};

/* 文本宽度估算（CJK ≈ 字号，ASCII ≈ 0.56×字号） */
U.measureText = (text, size) => {
  let w = 0;
  for (const ch of String(text == null ? '' : text)) {
    w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.56;
  }
  return w;
};

/* 按设备名称自适应节点宽度（图标区 60px + 边距，含截断余量） */
U.nodeWidthForName = (name) => {
  const w = 60 + U.measureText(name, 13.5) + 22;
  return Math.round(U.clamp(w, U.NODE_W, 320));
};

/* Web 地址规范化：无协议自动补 http://；非 http(s) 协议（javascript:/file: 等）返回 null */
U.normalizeWebUrl = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // scheme:// 但非 http(s)（file://、ftp:// 等）拒绝
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return null;
  // 无 // 形式的危险协议（javascript:/data:/vbscript: 等）拒绝
  if (/^(?:javascript|data|file|vbscript|about):/i.test(s)) return null;
  // 其余视为 主机[:端口][/路径]（如 example.com:8080、10.0.0.1:8080），补 http://
  return 'http://' + s;
};

/* 子网自定义名称安全化：仅保留 CIDR 键 + 字符串值，防 __proto__ 键经原型链混淆子网名（渲染为文本，防混淆） */
U.sanitizeSubnetNames = (o) => {
  const out = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o)) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(k)) continue;
    if (typeof v !== 'string' || v.length > 64) continue;
    out[k] = v;
  }
  return out;
};

/* ---------- 结构克隆（撤销栈用） ---------- */
U.clone = (o) => {
  if (typeof structuredClone === 'function') return structuredClone(o);
  return JSON.parse(JSON.stringify(o));
};

global.TopoUtil = U;
})(typeof globalThis !== 'undefined' ? globalThis : this);
