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
    this.nodeEls = new Map();
    this.linkEls = new Map();
    this.sel = { kind: null, id: null };
    this.allowDrag = true;   // 由 app 根据模式控制
    this._drag = null;
    this._panning = false;

    this._buildDefs();
    this.world = el('g', { id: 'world' }, this.svg);
    // 网格
    const grid = el('g', { id: 'gridLayer' }, this.world);
    el('rect', { x: -100000, y: -100000, width: 200000, height: 200000, fill: 'url(#gridP)' }, grid);

    this.linkLayer = el('g', { id: 'linkLayer' }, this.world);
    this.nodeLayer = el('g', { id: 'nodeLayer' }, this.world);

    this._bind();
    this.applyView();
  }



  /* ---------- 视口 ---------- */
  applyView() {
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
    this.pan = pan; this.zoom = zoom;
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

  setData(nodes, links) {
    this.nodes = nodes;
    this.links = links;
    this.nodeEls.clear();
    this.linkEls.clear();
    this.nodeLayer.innerHTML = '';
    this.linkLayer.innerHTML = '';
    this.sel = { kind: null, id: null };
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
    this.update();
  }

  /* ---------- 节点构建 ---------- */
  _buildNode(n) {
    const t = U.getType(n.type);
    const g = el('g', { class: 'node', 'data-id': n.id, transform: `translate(${n.x} ${n.y})` }, this.nodeLayer);
    const body = el('g', { class: 'body' }, g);
    el('rect', { class: 'shape', x: 0, y: 0, width: n.w, height: n.h, rx: 12, fill: `url(#g-${n.type})` }, body);
    // 图标区：自定义类型用上传图片，否则用内置图标
    el('rect', { class: 'icon-chip', x: 6, y: 6, width: 44, height: n.h - 12, rx: 8 }, body);
    const ic = el('g', { transform: `translate(${6 + (44 - 26) / 2} ${(n.h - 26) / 2})` }, body);
    if (t.img) {
      const cid = 'clip-' + n.id;
      const cp = el('clipPath', { id: cid }, body);
      el('rect', { x: 0, y: 0, width: 44, height: n.h - 12, rx: 8 }, cp);
      const img = el('image', {
        href: t.img, x: 6, y: 6, width: 44, height: n.h - 12,
        preserveAspectRatio: 'xMidYMid slice',
        'clip-path': `url(#${cid})`
      }, body);
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', t.img);
      el('rect', { x: 6, y: 6, width: 44, height: n.h - 12, rx: 8, fill: 'none', stroke: 'rgba(255,255,255,.35)', 'stroke-width': 1 }, body);
    } else {
      ic.setAttribute('color', '#ffffff');
      const sv = el('svg', { viewBox: '0 0 24 24', width: 26, height: 26 }, ic);
      sv.innerHTML = U.ICONS[t.key] || U.ICONS.other;
    }
    // 名称 / 类型 / 管理地址（有管理地址时节点加高）
    const hasMgmt = !!(n.mgmt || '').trim();
    if (hasMgmt) {
      el('text', { class: 'nm', x: 60, y: n.h / 2 - 12, 'text-anchor': 'start' }, body).textContent = this._fitName(n.name, n.w);
      el('text', { class: 'tp', x: 60, y: n.h / 2 + 4, 'text-anchor': 'start' }, body).textContent = t.label;
      const mg = el('text', { class: 'mgmt', x: 60, y: n.h / 2 + 19, 'text-anchor': 'start' }, body);
      mg.textContent = '管理: ' + (n.mgmt || '');
    } else {
      el('text', { class: 'nm', x: 60, y: n.h / 2 - 3, 'text-anchor': 'start' }, body).textContent = this._fitName(n.name, n.w);
      el('text', { class: 'tp', x: 60, y: n.h / 2 + 15, 'text-anchor': 'start' }, body).textContent = t.label;
    }
    // 标题提示
    el('title', {}, g).textContent = `${n.name}（${t.label}）`;
    this.nodeEls.set(n.id, g);
  }

  _fitName(name, nodeW) {
    const avail = (nodeW || 160) - 78;
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
    for (const n of this.nodes) {
      const g = this.nodeEls.get(n.id);
      if (g) g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    }
    const geom = U.linkGeom(this.nodes, this.links);
    // 标注：三行合一，先收集位置与尺寸，防碰撞（标注互不重叠、不压节点）后渲染
    const SIZE = 11;
    const labelBoxes = [];
    const labelData = [];
    for (const l of this.links) {
      const q = geom[l.id];
      if (!q) continue;
      const lines = U.labelLines(l);
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
      ln.setAttribute('x1', q.x1); ln.setAttribute('y1', q.y1);
      ln.setAttribute('x2', q.x2); ln.setAttribute('y2', q.y2);
      hit.setAttribute('x1', q.x1); hit.setAttribute('y1', q.y1);
      hit.setAttribute('x2', q.x2); hit.setAttribute('y2', q.y2);
      const box = labelBoxes[bi];
      const ld = labelData[bi];
      bi++;
      const lab = g.querySelector('.lab');
      if (!box || !ld || !lab) { lab && lab.setAttribute('display', 'none'); continue; }
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
  select(kind, id) {
    if (this.sel.kind === kind && this.sel.id === id) return;
    const prev = this.sel;
    if (prev.kind === 'node') {
      const g = this.nodeEls.get(prev.id);
      if (g) g.classList.remove('selected');
    } else if (prev.kind === 'link') {
      const g = this.linkEls.get(prev.id);
      if (g) g.classList.remove('selected');
    }
    this.sel = { kind, id };
    if (kind === 'node') {
      const g = this.nodeEls.get(id);
      if (g) g.classList.add('selected');
    } else if (kind === 'link') {
      const g = this.linkEls.get(id);
      if (g) g.classList.add('selected');
    }
  }

  clearSelect() { this.select(null, null); }

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
      const target = e.target.closest ? e.target.closest('.node, .link') : null;
      if (target) {
        const kind = target.classList.contains('node') ? 'node' : 'link';
        const id = target.getAttribute('data-id');
        if (this.cb.onDown && this.cb.onDown(e, kind, id) === false) return;
        if (kind === 'node' && this.allowDrag) {
          this._startDrag(e, id);
        } else if (kind === 'link') {
          // 连线仅选中，不拖拽不平移
        } else {
          this._startPan(e);
        }
      } else {
        if (this.cb.onDown && this.cb.onDown(e, 'bg', null) === false) return;
        this._startPan(e);
      }
    });

    svg.addEventListener('dblclick', (e) => {
      const target = e.target.closest ? e.target.closest('.node, .link') : null;
      if (!target) return;
      const kind = target.classList.contains('node') ? 'node' : 'link';
      this.cb.onDbl && this.cb.onDbl(kind, target.getAttribute('data-id'));
    });

    svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const target = e.target.closest ? e.target.closest('.node, .link') : null;
      const kind = target ? (target.classList.contains('node') ? 'node' : 'link') : 'bg';
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
    const n = this.nodes.find(x => x.id === id);
    if (!n) return;
    const w = this.toWorld(e.clientX, e.clientY);
    this._drag = { id, dx: w.x - n.x, dy: w.y - n.y, moved: false, ox: n.x, oy: n.y };
    try { this.svg.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件无活动指针时忽略 */ }
    const move = (ev) => {
      if (!this._drag || this._drag.id !== id) return;
      const w2 = this.toWorld(ev.clientX, ev.clientY);
      const n2 = this.nodes.find(x => x.id === id);
      n2.x = w2.x - this._drag.dx;
      n2.y = w2.y - this._drag.dy;
      if (Math.abs(n2.x - this._drag.ox) > 2 || Math.abs(n2.y - this._drag.oy) > 2) this._drag.moved = true;
      this.update();
      this.cb.onDrag && this.cb.onDrag(id, n2.x, n2.y);
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
