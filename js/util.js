/* ============================================================
 * NetTopo util.js —— 通用工具（纯函数为主，可被 Node 测试）
 * ============================================================ */
(function (global) {
'use strict';

const U = {};

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
U.seedCounters = (nodes, links) => {
  const scan = (prefix) => {
    let max = 0;
    for (const list of [nodes, links]) {
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
  scan('n'); scan('l');
};

/* ---------- 字符串 ---------- */
U.escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

U.escXml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '');

U.truncate = (s, n) => {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  if (s.length <= n) return s;
  // 尽量按字符截断
  const cut = s.slice(0, n - 1);
  return cut + '…';
};

U.clamp = (v, a, b) => Math.max(a, Math.min(b, v));

U.fmtDate = (d) => {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
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
    const re = new RegExp(`(?:^|\\n|\\r)[^\\n\\r]*${d === '\t' ? '\\t' : d === ';' ? '\\;' : ','}`, 'g');
    const m = first.match(re);
    if (m && m.length > bestScore) { bestScore = m.length; best = d; }
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

/* ---------- CSV 构建（Excel 兼容：带 BOM + 引号转义） ---------- */
U.buildCSV = (rows, opts) => {
  opts = opts || {};
  const delim = opts.delim || ',';
  const esc = (v) => {
    v = v == null ? '' : String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
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
U.linkGeom = (nodes, links) => {
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
      out[l.id] = {
        x1, y1, x2, y2,
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
          text: (l.bw || '').trim() ? U.truncate(l.bw, 16) : '',
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
  if (/路由|rt|router/.test(s)) return 'router';
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
  } catch (e) { U.customTypes = []; U.typeOverrides = {}; }
};
U.saveCustomTypes = () => {
  try { localStorage.setItem(U.CUSTOM_KEY, JSON.stringify(U.customTypes)); } catch (e) { /* 超限时忽略 */ }
};
U.saveTypeOverrides = () => {
  try { localStorage.setItem(U.OVERRIDE_KEY, JSON.stringify(U.typeOverrides)); } catch (e) { /* 超限时忽略 */ }
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
  const key = 'ct' + (U.customTypes.length + 1);
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
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 3.5 3.5L16 13l4 4"/></svg>'
};
U.ICONS = I;

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
  for (let iter = 0; iter < 200; iter++) {
    let moved = false;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        if (push(labels[i], labels[j], false)) moved = true;
      }
    }
    // 标注避开节点：把节点当作固定矩形，仅推开标注
    for (const lb of labels) {
      for (const ob of obstacles) {
        if (push(lb, ob, true)) moved = true;
      }
    }
    if (!moved) break;
  }
  return labels;
};

/* 标注三行文本（接口IP / 对端接口IP / 带宽） */
U.labelLines = (l) => [
  [l.aIf, l.aIp].filter(Boolean).join('  '),
  [l.bIf, l.bIp].filter(Boolean).join('  '),
  l.bw ? '带宽: ' + l.bw : ''
].filter(Boolean);

/* ---------- 节点默认尺寸 ---------- */
U.NODE_W = 160;
U.NODE_H = 56;
U.NODE_H_MGMT = 72; // 含管理地址的节点高度

/* 节点高度：有管理地址时加高一行 */
U.nodeHeightFor = (n) => ((n.mgmt || '').trim()) ? U.NODE_H_MGMT : U.NODE_H;

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

/* ---------- 结构克隆（撤销栈用） ---------- */
U.clone = (o) => {
  if (typeof structuredClone === 'function') return structuredClone(o);
  return JSON.parse(JSON.stringify(o));
};

global.TopoUtil = U;
})(typeof globalThis !== 'undefined' ? globalThis : this);
