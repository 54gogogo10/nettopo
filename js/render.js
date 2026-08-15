/* ============================================================
 * NetTopo render.js —— SVG 渲染与交互（缩放/平移/拖拽/选中/命中）
 * ============================================================ */
(function (global) {
'use strict';
const U = global.TopoUtil;

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};

class Renderer {
  constructor(svg, cb) {
    this.svg = svg;
    this.cb = cb || {};
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.nodes = [];
    this.links = [];
    this.texts = [];            // 画布文本框（自定义字体样式）
    this.nodeEls = new Map();
    this.linkEls = new Map();
    this.textEls = new Map();
    this.sel = { kind: null, id: null };
    this.selIds = new Set(); // 多选（仅节点）
    this.selLinkIds = new Set(); // 多选（连线）
    this.allowDrag = true;   // 由 app 根据模式控制
    this._drag = null;
    this._panning = false;
    this.showLabels = true;      // 链路标注显示开关
    this.showSubnets = false;    // 子网分组显示开关
    this.subnetNames = {};       // 子网 -> 自定义名称
    this.downLinks = new Set();  // 故障链路 id 集合（模拟断链）

    this._buildDefs();
    this.world = el('g', { id: 'world' }, this.svg);
    // 网格
    const grid = el('g', { id: 'gridLayer' }, this.world);
    el('rect', { x: -100000, y: -100000, width: 200000, height: 200000, fill: 'url(#gridP)' }, grid);

    this.groupLayer = el('g', { id: 'groupLayer' }, this.world);
    this.linkLayer = el('g', { id: 'linkLayer' }, this.world);
    this.nodeLayer = el('g', { id: 'nodeLayer' }, this.world);
    this.textLayer = el('g', { id: 'textLayer' }, this.world);

    this._bind();
    this.applyView();
  }



  /* ---------- 视口 ---------- */
  applyView() {
    // 平移范围钳制，避免把画布拖丢后找不到图
    this.pan.x = Math.max(-200000, Math.min(200000, this.pan.x));
    this.pan.y = Math.max(-200000, Math.min(200000, this.pan.y));
    const { x, y } = this.pan;
    this.world.setAttribute('transform', `translate(${x} ${y}) scale(${this.zoom})`);
    if (this.cb.onView) this.cb.onView(this.zoom);
  }

  toWorld(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.pan.x) / this.zoom,
      y: (clientY - r.top - this.pan.y) / this.zoom
    };
  }

  setView(pan, zoom) {
    this.pan = pan;
    this.zoom = U.clamp(zoom, 0.12, 4); // 与 zoomBy 同一缩放范围（工程文件/本地存储可能含异常 zoom）
    this.applyView();
    this.update();
  }

  zoomBy(factor, cx, cy) {
    const r = this.svg.getBoundingClientRect();
    const px = (cx != null ? cx : r.width / 2) - r.left;
    const py = (cy != null ? cy : r.height / 2) - r.top;
    const nz = U.clamp(this.zoom * factor, 0.12, 4);
    const k = nz / this.zoom;
    this.pan.x = px - (px - this.pan.x) * k;
    this.pan.y = py - (py - this.pan.y) * k;
    this.zoom = nz;
    this.applyView();
    this.update();
  }

  fit() {
    const b = this.bbox();
    const r = this.svg.getBoundingClientRect();
    if (!b) { this.setView({ x: 0, y: 0 }, 1); return; }
    const m = 90;
    const w = Math.max(b.w + m * 2, 200);
    const h = Math.max(b.h + m * 2, 200);
    const z = U.clamp(Math.min(r.width / w, r.height / h), 0.12, 1.4);
    this.setView({
      x: r.width / 2 - (b.x + b.w / 2) * z,
      y: r.height / 2 - (b.y + b.h / 2) * z
    }, z);
  }

  bbox() {
    if (!this.nodes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* ---------- 数据 ---------- */
  /* ---------- defs（内置 + 自定义类型渐变） ---------- */
  _buildDefs() {
    const defs = U.$('#defs', this.svg);
    if (!defs) return;
    defs.innerHTML = '';
    const types = U.TYPE_ORDER.map(k => [k, U.getType(k)])
      .concat(U.customTypes.map(t => [t.key, U.getType(t.key)]));
    for (const [k, c] of types) {
      const g = el('linearGradient', { id: 'g-' + k, x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
      el('stop', { offset: 0, 'stop-color': c.c1 }, g);
      el('stop', { offset: 1, 'stop-color': c.c2 }, g);
    }
    const p = el('pattern', { id: 'gridP', width: 26, height: 26, patternUnits: 'userSpaceOnUse' }, defs);
    el('circle', { cx: 1.4, cy: 1.4, r: 1.25, class: 'grid-dot' }, p);
  }

  setData(nodes, links, texts) {
    this.nodes = nodes;
    this.links = links;
    this.texts = texts || [];
    this.nodeEls.clear();
    this.linkEls.clear();
    this.textEls.clear();
    this.nodeLayer.innerHTML = '';
    this.linkLayer.innerHTML = '';
    this.textLayer.innerHTML = '';
    this.sel = { kind: null, id: null };
    this.selIds = new Set();
    this.selLinkIds = new Set();
    this._buildDefs(); // 同步自定义类型的渐变
    // 平行链路分组（标注垂直错开）
    this._pairIdx = new Map();
    const pc = new Map();
    for (const l of links) {
      const k = l.a < l.b ? l.a + '|' + l.b : l.b + '|' + l.a;
      this._pairIdx.set(l.id, pc.get(k) || 0);
      pc.set(k, (pc.get(k) || 0) + 1);
    }
    for (const n of nodes) this._buildNode(n);
    for (const l of links) this._buildLink(l);
    for (const t of this.texts) this._buildText(t);
    this.update();
  }

  /* ---------- 文本框构建 ---------- */
  _buildText(t) {
    const g = el('g', { class: 'ann', 'data-id': t.id }, this.textLayer);
    if (t.bg) el('rect', { class: 'ann-bg', x: 0, y: 0, width: t.w || 160, height: t.h || 40, rx: 8, fill: t.bg }, g);
    const lines = String(t.text || '').split('\n');
    const anchor = t.align === 'center' ? 'middle' : (t.align === 'right' ? 'end' : 'start');
    const tx = t.align === 'center' ? (t.w || 160) / 2 : (t.align === 'right' ? (t.w || 160) : 8);
    const txt = el('text', {
      class: 'ann-text', x: tx, y: (t.size || 16) + 6,
      'font-family': t.font || 'Microsoft YaHei', 'font-size': t.size || 16,
      fill: t.color || '#1e293b',
      'font-weight': t.bold ? '700' : '400',
      'font-style': t.italic ? 'italic' : 'normal',
      'text-anchor': anchor
    }, g);
    lines.forEach((ln, i) => {
      const ts = el('tspan', { x: tx, dy: i ? (t.size || 16) * 1.25 : 0 }, txt);
      ts.textContent = ln;
    });
    this.textEls.set(t.id, g);
  }

  /* ---------- 显示开关 ---------- */
  setShowLabels(v) {
    this.showLabels = !!v;
    this.update();
  }
  setSubnetView(show, names) {
    this.showSubnets = !!show;
    if (names) this.subnetNames = names;
    this.update();
  }
  setDownLinks(set) {
    this.downLinks = set || new Set();
    this.update();
  }

  /* ---------- 子网分组 ---------- */
  _buildGroups() {
    this.groupLayer.innerHTML = '';
    if (!this.showSubnets) return;
    const groups = U.subnetGroups(this.nodes, this.links, this.subnetNames);
    for (const g of groups) {
      const grp = el('g', { class: 'subnet', transform: `translate(${g.x} ${g.y})`, 'data-key': g.key }, this.groupLayer);
      el('rect', { class: 'subnet-box', x: 0, y: 0, width: g.w, height: g.h, rx: 16, fill: g.color }, grp).style.opacity = '0.08';
      // 边框与标题按屏幕等效尺寸绘制（除以 zoom），缩放时保持可读
      const z = 1 / this.zoom;
      el('rect', { class: 'subnet-box', x: 0.5, y: 0.5, width: g.w - 1, height: g.h - 1, rx: 16, fill: 'none', stroke: g.color, 'stroke-width': 1.6 / this.zoom, 'stroke-dasharray': `${9 / this.zoom} ${5 / this.zoom}` }, grp);
      const ttG = el('g', { transform: `translate(16 26) scale(${z})` }, grp);
      const tt = el('text', { class: 'subnet-title', x: 0, y: 0, 'data-key': g.key }, ttG);
      tt.textContent = g.name;
      tt.style.fill = g.color;
      el('title', {}, grp).textContent = g.cidr + ' · ' + g.nodeIds.length + ' 台设备';
      tt.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.cb.onGroupRename) this.cb.onGroupRename(g.key, g.name);
      });
    }
  }

  /* ---------- 节点构建 ---------- */
  _buildNode(n) {
    const t = U.getType(n.type);
    const g = el('g', { class: 'node', 'data-id': n.id, transform: `translate(${n.x} ${n.y})` }, this.nodeLayer);
    const body = el('g', { class: 'body' }, g);
    el('rect', { class: 'shape', x: 0, y: 0, width: n.w, height: n.h, rx: 12, fill: `url(#g-${n.type})` }, body);
    // 图标区：设备级自定义图标（n.icon：内置 key 或图片 dataURL）> 类型上传图片 > 内置图标
    // 图标区恒为正方形圆角方框；上传图片直接缩放拉伸填满整个方框（不裁切、不按比例留白）
    const iconKey = (n.icon && U.NODE_ICON_KEYS && U.NODE_ICON_KEYS.includes(n.icon)) ? n.icon : null;
    const iconImg = n.icon && !iconKey ? n.icon : (t.img || '');
    const nh = Number(n.h) > 0 ? Number(n.h) : U.NODE_H; // 兜底：旧工程可能缺 h
    const isz = Math.max(24, Math.min(44, nh - 12)); // 方框边长（正方形）
    const dispW = isz, dispH = isz;
    const ix = 6, iy = Math.max(0, (nh - dispH) / 2);
    el('rect', { class: 'icon-chip', x: ix, y: iy, width: dispW, height: dispH, rx: 8, fill: 'rgba(255,255,255,.14)' }, body);
    const tx = ix + dispW + 8; // 文字起点
    if (iconImg) {
      const cid = 'clip-' + n.id;
      const cp = el('clipPath', { id: cid }, body);
      // 裁剪区原点必须与图片一致（ix, iy），否则图片右下角被裁掉、内容偏左上
      el('rect', { x: ix, y: iy, width: dispW, height: dispH, rx: 8 }, cp);
      const img = el('image', {
        href: iconImg, x: ix, y: iy, width: dispW, height: dispH,
        preserveAspectRatio: 'none', // 直接拉伸缩放填满方框
        'clip-path': `url(#${cid})`
      }, body);
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', iconImg);
      el('rect', { x: ix, y: iy, width: dispW, height: dispH, rx: 8, fill: 'none', stroke: 'rgba(255,255,255,.35)', 'stroke-width': 1 }, body);
    } else {
      const ic = el('g', { transform: `translate(${ix + (dispH - 26) / 2} ${iy + (dispH - 26) / 2})` }, body);
      ic.setAttribute('color', '#ffffff');
      const sv = el('svg', { viewBox: '0 0 24 24', width: 26, height: 26 }, ic);
      sv.innerHTML = U.ICONS[iconKey || t.key] || U.ICONS.other;
    }
    // 名称 / 类型 / 管理地址（有管理地址时节点加高，多个地址分行显示）
    const mgmts = U.nodeMgmts(n);
    const hasMgmt = mgmts.length > 0;
    if (hasMgmt) {
      const lines = Math.min(mgmts.length, 3);
      const shown = mgmts.slice(0, lines);
      if (mgmts.length > lines) shown[lines - 1] = '+' + (mgmts.length - lines + 1) + ' 个';
      const y0 = n.h / 2 - 12 - (lines - 1) * 8;
      el('text', { class: 'nm', x: tx, y: y0, 'text-anchor': 'start' }, body).textContent = this._fitName(n.name, n.w, tx);
      el('text', { class: 'tp', x: tx, y: y0 + 16, 'text-anchor': 'start' }, body).textContent = t.label;
      shown.forEach((ip, i) => {
        const mg = el('text', { class: 'mgmt', x: tx, y: y0 + 32 + i * 14, 'text-anchor': 'start' }, body);
        mg.textContent = '管理: ' + ip;
      });
    } else {
      el('text', { class: 'nm', x: tx, y: n.h / 2 - 3, 'text-anchor': 'start' }, body).textContent = this._fitName(n.name, n.w, tx);
      el('text', { class: 'tp', x: tx, y: n.h / 2 + 15, 'text-anchor': 'start' }, body).textContent = t.label;
    }
    // 标题提示
    el('title', {}, g).textContent = `${n.name}（${t.label}）`;
    this.nodeEls.set(n.id, g);
  }

  _fitName(name, nodeW, tx) {
    const start = Number(tx) > 0 ? Number(tx) : 60;
    const avail = (nodeW || 160) - start - 18;
    const size = 13.5;
    const text = String(name);
    if (U.measureText(text, size) <= avail) return text;
    let out = '';
    let w = U.measureText(text, size);
    for (const ch of text) {
      if (w <= avail - 8) break;
      w -= /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.56;
      out += ch;
    }
    return out + '…';
  }

  /* ---------- 连线构建 ---------- */
  _buildLink(l) {
    const g = el('g', { class: 'link', 'data-id': l.id }, this.linkLayer);
    el('line', { class: 'ln', x1: 0, y1: 0, x2: 0, y2: 0 }, g);
    el('line', { class: 'hit', x1: 0, y1: 0, x2: 0, y2: 0 }, g);
    // 标注组：三行（A端接口IP / B端接口IP / 带宽），防碰撞后定位
    const lab = el('g', { class: 'lab' }, g);
    for (let i = 0; i < 3; i++) {
      el('text', { class: 'lb', y: 0 }, lab);
    }
    el('title', {}, g).textContent = '链路';
    this.linkEls.set(l.id, g);
  }

  /* ---------- 全量位置更新 ---------- */
  update() {
    this._buildGroups();
    for (const n of this.nodes) {
      const g = this.nodeEls.get(n.id);
      if (g) g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    }
    const tz = 1 / this.zoom;
    for (const t of this.texts) {
      const g = this.textEls.get(t.id);
      if (g) g.setAttribute('transform', `translate(${t.x} ${t.y}) scale(${tz})`);
    }
    const geom = U.linkGeom(this.nodes, this.links);
    // 标注：三行合一，先收集位置与尺寸，防碰撞（标注互不重叠、不压节点）后渲染
    const SIZE = 11;
    const labelBoxes = [];
    const labelData = [];
    for (const l of this.links) {
      const q = geom[l.id];
      if (!q) continue;
      const lines = this.showLabels ? U.labelLines(l) : [];
      if (!lines.length) { labelBoxes.push(null); labelData.push(null); continue; }
      const mx = (q.x1 + q.x2) / 2, my = (q.y1 + q.y2) / 2;
      const dx = q.x2 - q.x1, dy = q.y2 - q.y1;
      const len = Math.hypot(dx, dy) || 1;
      const pairOff = (this._pairIdx.get(l.id) || 0) * 50;
      const cx = mx + dx / len * 10;
      const cy = my + dy / len * 10 - 30 - pairOff;
      const maxLine = lines.reduce((a, b) => a.length > b.length ? a : b, '');
      // 框尺寸按屏幕等效（标注以 1/zoom 放大显示，世界坐标尺寸需除以 zoom）
      labelBoxes.push({
        x: cx, y: cy,
        w: (U.measureText(maxLine, SIZE) + 12) / this.zoom,
        h: (lines.length * SIZE * 1.25 + 4) / this.zoom
      });
      labelData.push({ lines, cx, cy });
    }
    U.resolveLabelCollisions(labelBoxes.filter(Boolean), {
      pad: 8 / this.zoom, // 屏幕等效 8px 间距（标注以 1/zoom 放大显示）
      obstacles: this.nodes.map(n => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
    });
    let bi = 0;
    const z = 1 / this.zoom;
    for (const l of this.links) {
      const g = this.linkEls.get(l.id);
      if (!g) continue;
      const q = geom[l.id];
      if (!q) continue;
      const ln = g.querySelector('.ln'), hit = g.querySelector('.hit');
      g.classList.toggle('down', this.downLinks.has(l.id));
      g.style.setProperty('--bw-c', U.bwColor(l.bw)); // 带宽颜色（图上不显示带宽文字）
      ln.setAttribute('x1', q.x1); ln.setAttribute('y1', q.y1);
      ln.setAttribute('x2', q.x2); ln.setAttribute('y2', q.y2);
      hit.setAttribute('x1', q.x1); hit.setAttribute('y1', q.y1);
      hit.setAttribute('x2', q.x2); hit.setAttribute('y2', q.y2);
      const box = labelBoxes[bi];
      const ld = labelData[bi];
      bi++;
      const lab = g.querySelector('.lab');
      if (!this.showLabels || !box || !ld || !lab) { lab && lab.setAttribute('display', 'none'); continue; }
      lab.setAttribute('display', '');
      lab.setAttribute('transform', `translate(${box.x} ${box.y}) scale(${z})`);
      const texts = lab.querySelectorAll('text');
      ld.lines.forEach((ln2, i) => {
        const t = texts[i];
        if (!t) return;
        t.setAttribute('display', '');
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('y', (ld.lines.length / 2 - i - 0.5) * SIZE * 1.25);
        if (t.textContent !== ln2) t.textContent = ln2;
      });
      for (let i = ld.lines.length; i < 3; i++) texts[i] && texts[i].setAttribute('display', 'none');
    }
  }

  /* 更新 pdf/vsdx 风格三行标注不再需要 _setLabel，删除 */
  /* ---------- 选中 ---------- */
  _syncSelClass() {
    for (const [nid, g] of this.nodeEls) g.classList.toggle('selected', this.selIds.has(nid));
    for (const [lid, g] of this.linkEls) g.classList.toggle('selected', this.selLinkIds.has(lid));
    for (const [tid, g] of this.textEls) g.classList.toggle('selected', this.sel.kind === 'text' && this.sel.id === tid);
  }

  select(kind, id, opts) {
    opts = opts || {};
    if (kind === 'text') {
      this.selIds.clear();
      this.selLinkIds.clear();
      this.sel = { kind: 'text', id };
      this._syncSelClass();
      return this.sel;
    }
    if (kind === 'node') {
      this.selLinkIds.clear();
      if (opts.multi) { // Ctrl/Cmd 点选：切换
        if (this.selIds.has(id)) this.selIds.delete(id);
        else this.selIds.add(id);
        this.sel = { kind: 'node', id: this.selIds.size ? id : null };
      } else if (opts.extend) { // Shift 点选：追加
        this.selIds.add(id);
        this.sel = { kind: 'node', id };
      } else {
        // 普通点击：若该节点已在多选中，保留多选（便于整体拖动）；否则单选
        if (!this.selIds.has(id)) this.selIds = new Set([id]);
        this.sel = { kind: 'node', id };
      }
      this._syncSelClass();
      return this.sel;
    }
    if (kind === 'link') {
      this.selIds.clear();
      if (opts.multi) { // Ctrl 点选：切换
        if (this.selLinkIds.has(id)) this.selLinkIds.delete(id);
        else this.selLinkIds.add(id);
        this.sel = { kind: 'link', id: this.selLinkIds.size ? id : null };
      } else if (opts.extend) {
        this.selLinkIds.add(id);
        this.sel = { kind: 'link', id };
      } else {
        this.selLinkIds = new Set([id]);
        this.sel = { kind: 'link', id };
      }
      this._syncSelClass();
      return this.sel;
    }
    // 取消选择：清空全部
    this.selIds.clear();
    this.selLinkIds.clear();
    this._syncSelClass();
    if (this.sel.kind === 'node') {
      const g = this.nodeEls.get(this.sel.id);
      if (g) g.classList.remove('selected');
    } else if (this.sel.kind === 'link') {
      const g = this.linkEls.get(this.sel.id);
      if (g) g.classList.remove('selected');
    }
    this.sel = { kind: null, id: null };
    return this.sel;
  }

  clearSelect() { this.select(null, null); }

  selectedNodes() { return [...this.selIds]; }

  selectedLinks() { return [...this.selLinkIds]; }

  /* ---------- 路径高亮 ---------- */
  highlightPath(nodeIds, linkIds) {
    this.clearPath();
    this.pathHl = { nodeIds: nodeIds || [], linkIds: linkIds || [] };
    for (const id of nodeIds || []) { const g = this.nodeEls.get(id); if (g) g.classList.add('path-hl'); }
    for (const id of linkIds || []) { const g = this.linkEls.get(id); if (g) g.classList.add('path-hl'); }
  }

  clearPath() {
    this.pathHl = null;
    for (const g of this.nodeEls.values()) g.classList.remove('path-hl');
    for (const g of this.linkEls.values()) g.classList.remove('path-hl');
  }

  flash(kind, id) {
    const map = kind === 'node' ? this.nodeEls : this.linkEls;
    const g = map.get(id);
    if (!g) return;
    if (kind === 'node') {
      // 定位脉冲：金色扩散圆环
      const n = this.nodes.find(x => x.id === id);
      if (!n) return;
      const r = el('rect', {
        class: 'ping', x: 0, y: 0, width: n.w, height: n.h, rx: 12,
        fill: 'none', stroke: '#fbbf24', 'stroke-width': 3.5
      }, g);
      setTimeout(() => r.remove(), 1000);
    } else {
      g.classList.add('hover');
      setTimeout(() => g.classList.remove('hover'), 900);
    }
  }

  /* ---------- 事件绑定 ---------- */
  _bind() {
    const svg = this.svg;

    svg.addEventListener('pointerdown', (e) => {
      if (this.cb.onBgDown) this.cb.onBgDown(); // 点击画布时先隐藏悬停提示
      if (e.button === 1) { e.preventDefault(); this._startPan(e); return; }
      const target = e.target.closest ? e.target.closest('.node, .link, .ann') : null;
      if (target) {
        const kind = target.classList.contains('node') ? 'node' : (target.classList.contains('ann') ? 'text' : 'link');
        const id = target.getAttribute('data-id');
        if (this.cb.onDown && this.cb.onDown(e, kind, id) === false) return;
        if (kind === 'node' && this.allowDrag) {
          this._startDrag(e, id);
        } else if (kind === 'text' && this.allowDrag) {
          this._startTextDrag(e, id);
        } else if (kind === 'link') {
          // 连线仅选中，不拖拽不平移
        } else {
          this._startPan(e);
        }
      } else {
        if (this.cb.onDown && this.cb.onDown(e, 'bg', null) === false) return;
        if (e.shiftKey) { this._startBoxSelect(e); }
        else this._startPan(e);
      }
    });

    svg.addEventListener('dblclick', (e) => {
      const target = e.target.closest ? e.target.closest('.node, .link, .ann') : null;
      if (!target) return;
      const kind = target.classList.contains('node') ? 'node' : (target.classList.contains('ann') ? 'text' : 'link');
      this.cb.onDbl && this.cb.onDbl(kind, target.getAttribute('data-id'));
    });

    svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const target = e.target.closest ? e.target.closest('.node, .link, .ann') : null;
      const kind = target ? (target.classList.contains('node') ? 'node' : (target.classList.contains('ann') ? 'text' : 'link')) : 'bg';
      const id = target ? target.getAttribute('data-id') : null;
      this.cb.onCtx && this.cb.onCtx(e, kind, id);
    });

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0016);
      this.zoomBy(f, e.clientX, e.clientY);
    }, { passive: false });

    // hover 提示
    svg.addEventListener('pointerover', (e) => {
      const target = e.target.closest ? e.target.closest('.node, .link') : null;
      if (!target) return;
      const kind = target.classList.contains('node') ? 'node' : 'link';
      this.cb.onHover && this.cb.onHover(e, kind, target.getAttribute('data-id'));
    });
    svg.addEventListener('pointerout', (e) => {
      const target = e.target.closest ? e.target.closest('.node, .link') : null;
      if (!target) return;
      const kind = target.classList.contains('node') ? 'node' : 'link';
      this.cb.onHoverOut && this.cb.onHoverOut(e, kind, target.getAttribute('data-id'));
    });
  }

  _startDrag(e, id) {
    const ids = this.selIds.has(id) && this.selIds.size > 1 ? [...this.selIds] : [id];
    const orig = {};
    for (const i of ids) {
      const nn = this.nodes.find(x => x.id === i);
      if (nn) orig[i] = { x: nn.x, y: nn.y };
    }
    const first = this.nodes.find(x => x.id === id);
    if (!first) return;
    const w = this.toWorld(e.clientX, e.clientY);
    this._drag = { ids, dx: w.x - first.x, dy: w.y - first.y, moved: false, orig };
    try { this.svg.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无活动指针时忽略 */ }
    const move = (ev) => {
      if (!this._drag) return;
      const w2 = this.toWorld(ev.clientX, ev.clientY);
      for (const i of this._drag.ids) {
        const nn = this.nodes.find(x => x.id === i);
        if (!nn) continue;
        const o = this._drag.orig[i];
        nn.x = w2.x - this._drag.dx + (o.x - this._drag.orig[this._drag.ids[0]].x);
        nn.y = w2.y - this._drag.dy + (o.y - this._drag.orig[this._drag.ids[0]].y);
      }
      const f0 = this.nodes.find(x => x.id === id);
      if (f0 && (Math.abs(f0.x - this._drag.orig[id].x) > 2 || Math.abs(f0.y - this._drag.orig[id].y) > 2)) this._drag.moved = true;
      this.update();
      this.cb.onDrag && this.cb.onDrag(id, f0 && f0.x, f0 && f0.y);
    };
    const up = (ev) => {
      svgElRemove(this.svg, 'pointermove', move);
      svgElRemove(this.svg, 'pointerup', up);
      const d = this._drag;
      this._drag = null;
      if (d && d.moved) this.cb.onDragEnd && this.cb.onDragEnd(id, true);
    };
    svgElAdd(this.svg, 'pointermove', move);
    svgElAdd(this.svg, 'pointerup', up);
  }

  _startTextDrag(e, id) {
    const t = this.texts.find(x => x.id === id);
    if (!t) return;
    const orig = { x: t.x, y: t.y };
    const w = this.toWorld(e.clientX, e.clientY);
    this._drag = { ids: [id], dx: w.x - t.x, dy: w.y - t.y, moved: false, orig: { [id]: orig } };
    try { this.svg.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无活动指针时忽略 */ }
    const move = (ev) => {
      if (!this._drag) return;
      const w2 = this.toWorld(ev.clientX, ev.clientY);
      t.x = w2.x - this._drag.dx;
      t.y = w2.y - this._drag.dy;
      if (Math.abs(t.x - orig.x) > 2 || Math.abs(t.y - orig.y) > 2) this._drag.moved = true;
      this.update();
    };
    const up = (ev) => {
      svgElRemove(this.svg, 'pointermove', move);
      svgElRemove(this.svg, 'pointerup', up);
      const d = this._drag;
      this._drag = null;
      if (d && d.moved) this.cb.onDragEnd && this.cb.onDragEnd(id, true);
    };
    svgElAdd(this.svg, 'pointermove', move);
    svgElAdd(this.svg, 'pointerup', up);
  }

  /* ---------- Shift 拖拽框选 ---------- */
  _startBoxSelect(e) {
    const w0 = this.toWorld(e.clientX, e.clientY);
    if (!this._boxRect) {
      this._boxRect = el('rect', { class: 'box-sel', x: 0, y: 0, width: 0, height: 0 }, this.world);
    }
    const move = (ev) => {
      const w1 = this.toWorld(ev.clientX, ev.clientY);
      const x = Math.min(w0.x, w1.x), y = Math.min(w0.y, w1.y);
      this._boxRect.setAttribute('x', x);
      this._boxRect.setAttribute('y', y);
      this._boxRect.setAttribute('width', Math.abs(w1.x - w0.x));
      this._boxRect.setAttribute('height', Math.abs(w1.y - w0.y));
    };
    const up = (ev) => {
      svgElRemove(this.svg, 'pointermove', move);
      svgElRemove(this.svg, 'pointerup', up);
      if (this._boxRect) { this._boxRect.remove(); this._boxRect = null; }
      const w1 = this.toWorld(ev.clientX, ev.clientY);
      const x0 = Math.min(w0.x, w1.x), y0 = Math.min(w0.y, w1.y);
      const x1 = Math.max(w0.x, w1.x), y1 = Math.max(w0.y, w1.y);
      if (Math.hypot(w1.x - w0.x, w1.y - w0.y) < 4) { this.cb.onBgClick && this.cb.onBgClick(w1, ev); return; }
      const ids = this.nodes
        .filter(n => n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0)
        .map(n => n.id);
      if (!ids.length) { this.select(null, null); this.cb.onBoxSelect && this.cb.onBoxSelect([]); return; }
      this.selIds = new Set(ids);
      this.sel = { kind: 'node', id: ids[ids.length - 1] };
      this._syncSelClass();
      this.cb.onBoxSelect && this.cb.onBoxSelect(ids);
    };
    svgElAdd(this.svg, 'pointermove', move);
    svgElAdd(this.svg, 'pointerup', up);
  }

  _startPan(e) {
    this._panning = true;
    this.svg.classList.add('panning');
    const sx = e.clientX, sy = e.clientY;
    const ox = this.pan.x, oy = this.pan.y;
    const move = (ev) => {
      this.pan.x = ox + (ev.clientX - sx);
      this.pan.y = oy + (ev.clientY - sy);
      this.applyView();
    };
    const up = (ev) => {
      svgElRemove(this.svg, 'pointermove', move);
      svgElRemove(this.svg, 'pointerup', up);
      this.svg.classList.remove('panning');
      const moved = Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4;
      this._panning = false;
      if (!moved) this.cb.onBgClick && this.cb.onBgClick(this.toWorld(ev.clientX, ev.clientY), ev);
    };
    svgElAdd(this.svg, 'pointermove', move);
    svgElAdd(this.svg, 'pointerup', up);
  }
}

function svgElAdd(svg, name, fn) { svg.addEventListener(name, fn); }
function svgElRemove(svg, name, fn) { svg.removeEventListener(name, fn); }

global.TopoRender = Renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
