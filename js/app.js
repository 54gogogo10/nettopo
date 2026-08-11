/* ============================================================
 * NetTopo app.js —— 应用主逻辑
 * ============================================================ */
(function () {
'use strict';
const U = TopoUtil, M = TopoModel, Layout = TopoLayout;
const $ = U.$, $$ = U.$$;

/* ================= 状态 ================= */
const state = {
  nodes: [],
  links: [],
  sel: { kind: null, id: null },
  mode: 'normal',      // normal | link | place
  linkPick: null,      // 连线模式下已选中的源节点
  undoStack: [],
  redoStack: [],
  theme: localStorage.getItem('nettopo.theme') || 'light',
  search: '',
  tab: 'nodes',
  blank: false   // 用户主动新建空白画布（无表格也能直接画）
};
let layoutCancel = false;

U.loadCustomTypes(); // 恢复自定义设备类型

const renderer = new TopoRender($('#svg'), {
  onDown(e, kind, id) {
    hideTooltip();
    if (state.mode === 'link' || state.mode === 'place') {
      e.preventDefault();
      handleModeClick(e, kind, id);
      return false;
    }
    if (kind !== 'bg') select(kind, id, { center: false });
    // 记录拖拽前的状态，拖动结束时用于撤销（避免撤销栈记录“当前态”）
    state._dragPre = kind === 'node' ? snapshot() : null;
    return true;
  },
  onDbl(kind, id) { kind === 'node' ? editNode(id) : editLink(id); },
  onCtx(e, kind, id) { openCtx(e, kind, id); },
  onDrag() {},
  onDragEnd(id, moved) {
    if (moved && state._dragPre) pushUndo(state._dragPre); // 拖拽前快照
    state._dragPre = null;
    refreshPanel();
  },
  onBgClick() { if (state.mode === 'normal') select(null, null); },
  onHover(e, kind, id) { showTooltip(e, kind, id); },
  onHoverOut() { hideTooltip(); },
  onView(z) {
    $('#zVal').textContent = Math.round(z * 100) + '%';
    // 视图平移/缩放也持久化（节流）
    clearTimeout(saveGraph._t);
    saveGraph._t = setTimeout(saveGraph, 500);
  }
});

/* ================= 选中 ================= */
function select(kind, id, opts) {
  opts = opts || {};
  state.sel = { kind, id };
  renderer.select(kind, id);
  renderSelCard();
  if (opts.center && id) {
    centerOn(kind, id);
  }
  refreshPanel();
}

function centerOn(kind, id) {
  let x = 0, y = 0;
  if (kind === 'node') {
    const n = state.nodes.find(n => n.id === id);
    if (!n) return;
    x = n.x + n.w / 2; y = n.y + n.h / 2;
  } else {
    const l = state.links.find(l => l.id === id);
    if (!l) return;
    const na = state.nodes.find(n => n.id === l.a), nb = state.nodes.find(n => n.id === l.b);
    if (!na || !nb) return;
    x = (na.x + nb.x) / 2; y = (na.y + nb.y) / 2;
  }
  const r = $('#svg').getBoundingClientRect();
  renderer.setView({ x: r.width / 2 - x * renderer.zoom, y: r.height / 2 - y * renderer.zoom }, renderer.zoom);
  renderer.flash(kind, id);
}

/* ================= 撤销 / 重做 ================= */
function snapshot() { return { nodes: U.clone(state.nodes), links: U.clone(state.links) }; }
function restore(s) {
  state.nodes = s.nodes; state.links = s.links;
  state.sel = { kind: null, id: null };
  renderer.setData(state.nodes, state.links);
  refreshAll();
  renderSelCard(); // 隐藏可能残留的选中卡
}
function pushUndo(pre) {
  // 快照入栈：pre 为拖拽开始前捕获的状态；其余操作在变更前调用本函数
  state.undoStack.push(pre || snapshot());
  if (state.undoStack.length > 60) state.undoStack.shift();
  state.redoStack = [];
  updateUndoBtns();
  saveGraph(); // 任何修改都持久化
}
function undo() {
  const s = state.undoStack.pop();
  if (!s) return;
  state.redoStack.push(snapshot());
  restore(s);
  updateUndoBtns();
}
function redo() {
  const s = state.redoStack.pop();
  if (!s) return;
  state.undoStack.push(snapshot());
  restore(s);
  updateUndoBtns();
}
function updateUndoBtns() {
  $('#btnUndo').disabled = !state.undoStack.length;
  $('#btnRedo').disabled = !state.redoStack.length;
}

/* ================= 导入 ================= */
async function handleImport(file) {
  const { name, buffer } = await U.readFile(file);
  const ext = (name.split('.').pop() || '').toLowerCase();
  let graph = null;
  if (ext === 'xlsx' || ext === 'xls') {
    if (!window.XLSX) { toast('未加载 Excel 解析库（需联网），请改用 CSV 文件'); return; }
    graph = M.xlsxToGraph(buffer);
  } else {
    graph = M.textToGraph(U.decodeBytes(buffer));
  }
  if (!graph.nodes.length) {
    toast('未识别到有效的连线数据：请确认表头包含「源设备 / 目标设备」列');
    return;
  }
  loadGraph(graph, `已导入 ${graph.nodes.length} 台设备、${graph.links.length} 条链路`);
}

function loadGraph(graph, msg) {
  if (state.nodes.length && !confirm('导入将替换当前拓扑，是否继续？')) return;
  layoutCancel = true;
  setMode('normal');
  state.nodes = graph.nodes;
  state.links = graph.links;
  state.sel = { kind: null, id: null };
  state.undoStack = []; // 初始状态无需撤销
  state.redoStack = [];
  state.blank = false; // 已导入/载入内容，回到常规模式
  updateUndoBtns();
  renderer.setData(state.nodes, state.links);
  refreshAll();
  if (msg) toast(msg);
  saveGraph();
  autoLayout();
}

/* ================= 自动布局 ================= */
function autoLayout() {
  if (!state.nodes.length) return;
  layoutCancel = false;
  // 先给节点一个圆环初始位（layout 内部处理）
  const pts = {};
  const n = state.nodes.length;
  const cx = renderer.bbox() ? renderer.bbox().x + renderer.bbox().w / 2 : 0;
  const cy = renderer.bbox() ? renderer.bbox().y + renderer.bbox().h / 2 : 0;
  const R = Math.max(280, Math.sqrt(n) * 150);
  state.nodes.forEach((nd, i) => {
    const ang = (i / n) * Math.PI * 2;
    pts[nd.id] = { x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R };
  });
  Layout.runLayout(state.nodes, state.links, () => renderer.update(), {
    cancel: () => layoutCancel || state.mode !== 'normal'
  }).then(() => {
    if (!layoutCancel) renderer.fit();
    renderer.update();
    saveGraph(); // 布局后的位置也持久化
  });
}

/* ================= 导出 ================= */
function exportCSV() {
  const rows = M.graphToTableRows(state.nodes, state.links);
  U.download(`网络拓扑表_${U.fmtDate()}.csv`,
    new Blob([U.buildCSV(rows)], { type: 'text/csv;charset=utf-8' }));
  toast('已导出 CSV 连线表');
}

function exportXlsx() {
  if (!window.XLSX) { toast('未加载 Excel 解析库（需联网），请改用 CSV 导出'); return; }
  const rows = M.graphToTableRows(state.nodes, state.links);
  const ws = window.XLSX.utils.aoa_to_sheet(rows);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, '连线关系');
  const buf = window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  U.download(`网络拓扑表_${U.fmtDate()}.xlsx`,
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  toast('已导出 Excel 连线表');
}

function exportVisio() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  const buf = TopoVsdx.buildVSDX({ nodes: state.nodes, links: state.links }, {});
  U.download(`网络拓扑图_${U.fmtDate()}.vsdx`,
    new Blob([buf], { type: 'application/vnd.ms-visio' }));
  toast('已导出 Visio 文件（.vsdx，Visio 2013+ 可直接打开编辑）');
}

function exportPdf() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  const svg = TopoPdf.buildSvgImage({ nodes: state.nodes, links: state.links }, {});
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL('image/jpeg', 0.92);
    // dataURL → 二进制
    const bin = atob(jpeg.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pdf = TopoPdf.buildImagePDF(bytes, canvas.width, canvas.height, {});
    U.download(`网络拓扑图_${U.fmtDate()}.pdf`,
      new Blob([pdf], { type: 'application/pdf' }));
    URL.revokeObjectURL(url);
    toast('已导出 PDF 文件');
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('PDF 渲染失败'); };
  img.src = url;
}

/* ================= 新建 ================= */
function newGraph() {
  if (state.nodes.length && !confirm('新建将清空当前拓扑，是否继续？')) return;
  layoutCancel = true;
  setMode('normal');
  state.nodes = [];
  state.links = [];
  state.sel = { kind: null, id: null };
  state.undoStack = [];
  state.redoStack = [];
  state.blank = true; // 空白画布：无表格也可直接添加设备/连线
  updateUndoBtns();
  renderer.setData(state.nodes, state.links);
  refreshAll();
  saveGraph();
  toast('已新建空白画布：点击「添加设备」或右键画布添加设备');
}

/* ================= 设备 / 连线 增删改 ================= */
function addNodeAt(wx, wy) {
  openModal({
    title: '添加设备',
    fields: [
      { name: 'name', label: '设备名称', required: true, ph: '例如：核心交换机SW1' },
      { name: 'type', label: '设备类型', type: 'select', options: U.typeList().map(t => [t.key, t.label]) },
      { name: 'mgmt', label: '管理地址', ph: '例如：10.255.0.1（可选）' },
      { name: 'note', label: '备注', type: 'textarea' }
    ],
    submit: '创建',
    onSubmit: (v) => {
      pushUndo(); // 变更前快照
      const node = {
        id: U.uid('n'), name: v.name.trim(),
        type: v.type || U.typeOf(v.name),
        x: wx - U.nodeWidthForName(v.name) / 2, y: wy - U.NODE_H / 2,
        w: U.nodeWidthForName(v.name), h: U.NODE_H,
        note: v.note.trim(), mgmt: v.mgmt.trim()
      };
      node.h = U.nodeHeightFor(node);
      node.y = wy - node.h / 2;
      state.nodes.push(node);
      renderer.setData(state.nodes, state.links);
      refreshAll();
      select('node', node.id, { center: true });
    }
  });
}

function editNode(id) {
  const n = state.nodes.find(n => n.id === id);
  if (!n) return;
  openModal({
    title: '编辑设备',
    fields: [
      { name: 'name', label: '设备名称', required: true, value: n.name },
      { name: 'type', label: '设备类型', type: 'select', options: U.typeList().map(t => [t.key, t.label]), value: n.type },
      { name: 'mgmt', label: '管理地址', value: n.mgmt || '', ph: '例如：10.255.0.1（可选）' },
      { name: 'note', label: '备注', type: 'textarea', value: n.note }
    ],
    submit: '保存',
    onSubmit: (v) => {
      pushUndo(); // 变更前快照
      n.name = v.name.trim() || n.name;
      // 名称变化 → 宽度自适应，保持中心不变
      const nw = U.nodeWidthForName(n.name);
      const dw = nw - n.w;
      if (dw) { n.w = nw; n.x -= dw / 2; }
      // 管理地址变化 → 高度自适应（保持中心不变）
      n.mgmt = v.mgmt.trim();
      const nh = U.nodeHeightFor(n);
      if (nh !== n.h) { const dh = nh - n.h; n.h = nh; n.y -= dh / 2; }
      n.type = v.type;
      n.note = v.note.trim();
      renderer.setData(state.nodes, state.links);
      refreshAll();
      select('node', n.id);
    }
  });
}

function deleteNode(id) {
  const n = state.nodes.find(n => n.id === id);
  if (!n) return;
  pushUndo(); // 变更前快照
  const removed = state.links.filter(l => l.a === id || l.b === id);
  state.links = state.links.filter(l => l.a !== id && l.b !== id);
  state.nodes = state.nodes.filter(x => x.id !== id);
  renderer.setData(state.nodes, state.links);
  refreshAll();
  select(null, null);
  toast(`已删除 ${n.name} 及其 ${removed.length} 条连线`);
}

function addLinkBetween(aId, bId) {
  const a = state.nodes.find(n => n.id === aId);
  const b = state.nodes.find(n => n.id === bId);
  if (!a || !b) return;
  openModal({
    title: '添加连线',
    sub: `${a.name} ⇄ ${b.name}`,
    fields: [
      { name: 'aIf', label: `${a.name} 接口`, ph: '例如 GE0/0/1' },
      { name: 'aIp', label: `${a.name} IP`, ph: '例如 10.0.0.1' },
      { name: 'bIf', label: `${b.name} 接口`, ph: '例如 GE1/0/1' },
      { name: 'bIp', label: `${b.name} IP`, ph: '例如 10.0.0.2' },
      { name: 'bw', label: '带宽', ph: '例如 千兆 / 10Gbps' },
      { name: 'note', label: '备注', type: 'textarea' }
    ],
    submit: '创建',
    onSubmit: (v) => {
      pushUndo(); // 变更前快照
      state.links.push({
        id: U.uid('l'), a: aId, b: bId,
        aIf: v.aIf.trim(), aIp: v.aIp.trim(),
        bIf: v.bIf.trim(), bIp: v.bIp.trim(),
        bw: v.bw.trim(), note: v.note.trim()
      });
      renderer.setData(state.nodes, state.links);
      refreshAll();
      select('link', state.links[state.links.length - 1].id);
    }
  });
}

function editLink(id) {
  const l = state.links.find(l => l.id === id);
  if (!l) return;
  const a = state.nodes.find(n => n.id === l.a);
  const b = state.nodes.find(n => n.id === l.b);
  if (!a || !b) return;
  openModal({
    title: '编辑连线',
    sub: `${a.name} ⇄ ${b.name}`,
    fields: [
      { name: 'aIf', label: `${a.name} 接口`, value: l.aIf },
      { name: 'aIp', label: `${a.name} IP`, value: l.aIp },
      { name: 'bIf', label: `${b.name} 接口`, value: l.bIf },
      { name: 'bIp', label: `${b.name} IP`, value: l.bIp },
      { name: 'bw', label: '带宽', value: l.bw },
      { name: 'note', label: '备注', type: 'textarea', value: l.note }
    ],
    submit: '保存',
    onSubmit: (v) => {
      pushUndo(); // 变更前快照
      l.aIf = v.aIf.trim(); l.aIp = v.aIp.trim();
      l.bIf = v.bIf.trim(); l.bIp = v.bIp.trim();
      l.bw = v.bw.trim(); l.note = v.note.trim();
      renderer.setData(state.nodes, state.links);
      refreshAll();
      select('link', l.id);
    }
  });
}

function deleteLink(id) {
  const l = state.links.find(l => l.id === id);
  if (!l) return;
  pushUndo(); // 变更前快照
  state.links = state.links.filter(x => x.id !== id);
  renderer.setData(state.nodes, state.links);
  refreshAll();
  select(null, null);
}

function deleteSelection() {
  const { kind, id } = state.sel;
  if (!id) return;
  if (kind === 'node') deleteNode(id);
  else if (kind === 'link') deleteLink(id);
}

/* ================= 模式（添加连线 / 添加设备） ================= */
function setMode(mode, silent) {
  const prev = state.mode;
  state.mode = mode;
  state.linkPick = null;
  $('#hintBar').classList.toggle('hidden', mode === 'normal');
  // 没有表格时进入放置/连线模式，直接收起空态遮罩，允许在空白画布上操作
  if (mode !== 'normal' && !state.nodes.length) {
    state.blank = true;
    $('#empty').classList.add('hidden');
  }
  renderer.allowDrag = mode === 'normal';
  // 工具栏按钮高亮显示模式状态
  $('#btnAddLink').classList.toggle('mode-on', mode === 'link');
  $('#btnAddNode').classList.toggle('mode-on', mode === 'place');
  if (mode === 'link') {
    setHint('连线模式：依次点击两台设备；Esc 或右键取消');
  } else if (mode === 'place') {
    setHint('放置模式：点击画布空白处放置设备；Esc 或右键取消');
  } else {
    select(null, null);
    if (!silent && prev !== 'normal') toast(`已退出${prev === 'link' ? '连线' : '放置'}模式`);
  }
}

function setHint(msg) {
  const t0 = Date.now();
  const DUR = 3;
  const render = () => {
    const left = DUR - Math.floor((Date.now() - t0) / 1000);
    $('#hintBar').innerHTML = `<span class="hb-txt">${U.escHtml(msg)}</span><span class="hb-ct">${Math.max(left, 0)}s</span><button class="hb-x" type="button" title="退出当前模式">✕</button>`;
    if (left <= 0) { $('#hintBar').classList.add('hidden'); return; }
    setHint._t = setTimeout(render, 500);
  };
  clearTimeout(setHint._t);
  $('#hintBar').classList.remove('hidden');
  render();
}

function handleModeClick(e, kind, id) {
  if (kind === 'bg') {
    if (state.mode === 'place') {
      const w = renderer.toWorld(e.clientX, e.clientY);
      setMode('normal');
      addNodeAt(w.x, w.y);
    } else if (state.mode === 'link') {
      if (state.linkPick) {
        // 取消已选源节点，保持连线模式
        state.linkPick = null;
        renderer.clearSelect();
        setHint('连线模式：依次点击两台设备；Esc 或右键取消');
      } else {
        // 未选择任何节点时，点击空白退出连线模式
        setMode('normal');
      }
    }
    return;
  }
  if (kind !== 'node') return;
  if (state.mode === 'link') {
    if (!state.linkPick) {
      state.linkPick = id;
      renderer.flash('node', id);
      $('#hintBar').textContent = '再点击目标设备（Esc 取消）';
    } else {
      const a = state.linkPick, b = id;
      if (a === b) { toast('不能连接到自身'); return; }
      setMode('normal');
      addLinkBetween(a, b);
    }
  }
}

/* ================= 弹窗 ================= */
function openModal(opts) {
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  const fields = opts.fields || [];
  const rowsHtml = fields.map((f, i) => {
    const req = f.required ? ' <span class="req">*</span>' : '';
    let ctrl = '';
    if (f.type === 'select') {
      ctrl = `<select name="${f.name}">${f.options.map(([v, lb]) =>
        `<option value="${v}" ${String(f.value) === String(v) ? 'selected' : ''}>${U.escHtml(lb)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      ctrl = `<textarea name="${f.name}" placeholder="${U.escHtml(f.ph || '')}">${U.escHtml(f.value || '')}</textarea>`;
    } else {
      ctrl = `<input name="${f.name}" type="text" value="${U.escHtml(f.value || '')}" placeholder="${U.escHtml(f.ph || '')}"/>`;
    }
    return `<div class="frow"><label>${U.escHtml(f.label)}${req}</label>${ctrl}</div>`;
  }).join('');

  ov.innerHTML = `
    <div class="modal" role="dialog">
      <h3>${U.escHtml(opts.title)}</h3>
      ${opts.sub ? `<div class="m-sub">${U.escHtml(opts.sub)}</div>` : ''}
      <form>${rowsHtml}
        <div class="m-actions">
          <button type="button" class="tb" data-act="cancel">取消</button>
          <button type="submit" class="tb primary">${U.escHtml(opts.submit || '确定')}</button>
        </div>
      </form>
    </div>`;
  root.appendChild(ov);

  const close = () => ov.remove();
  const form = ov.querySelector('form');
  const grab = (v) => {
    const o = {};
    fields.forEach(f => { const el2 = form.elements[f.name]; if (el2) o[f.name] = el2.value; });
    return o;
  };
  const submit = () => {
    const v = grab();
    for (const f of fields) {
      if (f.required && !String(v[f.name]).trim()) {
        const el2 = form.elements[f.name];
        el2.focus(); el2.style.borderColor = 'var(--danger)';
        return;
      }
    }
    close();
    opts.onSubmit && opts.onSubmit(v);
  };

  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=cancel]').addEventListener('click', close);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  const first = form.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 30);
}

function toast(msg) {
  let t = $('#toastTmp');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastTmp';
    t.style.cssText = 'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:90;background:var(--tooltip-bg);color:var(--tooltip-tx);padding:9px 18px;border-radius:10px;font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.3);transition:opacity .3s;max-width:70vw';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = '0'; }, 2600);
}

/* ================= 右键菜单 ================= */
function openCtx(e, kind, id) {
  const menu = $('#ctx');
  let items = [];
  if (kind === 'node') {
    const n = state.nodes.find(x => x.id === id);
    items = [
      { ic: 'edit', label: '编辑设备…', act: () => editNode(id) },
      { ic: 'locate', label: '定位到视图', act: () => { select('node', id); centerOn('node', id); } },
      { sep: true },
      { ic: 'trash', label: '删除设备及连线', danger: true, act: () => deleteNode(id) }
    ];
    if (n) items.unshift({ head: `${n.name}（${U.getType(n.type).label}）` });
  } else if (kind === 'link') {
    const l = state.links.find(x => x.id === id);
    const na = l ? state.nodes.find(n => n.id === l.a) : null;
    const nb = l ? state.nodes.find(n => n.id === l.b) : null;
    items = [
      { ic: 'edit', label: '编辑连线…', act: () => editLink(id) },
      { sep: true },
      { ic: 'trash', label: '删除连线', danger: true, act: () => deleteLink(id) }
    ];
    if (na && nb) items.unshift({ head: `${na.name} ⇄ ${nb.name}` });
  } else {
    items = [
      { ic: 'node', label: '在此添加设备', act: () => { const w = renderer.toWorld(e.clientX, e.clientY); setMode('normal'); addNodeAt(w.x, w.y); } },
      { ic: 'link', label: '添加连线…', act: () => setMode('link') },
      { sep: true },
      { ic: 'layout', label: '自动布局', act: () => autoLayout() },
      { ic: 'fit', label: '适应视图', act: () => renderer.fit() },
      { sep: true },
      { ic: 'upload', label: '导入表格…', act: () => $('#fileInput').click() }
    ];
  }
  menu.innerHTML = items.map(it => {
    if (it.sep) return '<div style="height:1px;background:var(--border);margin:4px 8px"></div>';
    if (it.head) return `<div style="padding:5px 10px 3px;font-size:10.5px;color:var(--muted);font-weight:600">${U.escHtml(it.head)}</div>`;
    return `<button class="ci ${it.danger ? 'danger' : ''}"><i class="ic" data-ic="${it.ic}"></i>${U.escHtml(it.label)}</button>`;
  }).join('');
  U.fillIcons();
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(e.clientX, innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(e.clientY, innerHeight - mh - 8) + 'px';
  // 按钮与 items 一一绑定（items 含 head/分隔符占位项，不能用索引对应）
  const btns = menu.querySelectorAll('.ci');
  let bi = 0;
  for (const it of items) {
    if (it.sep || it.head) continue;
    btns[bi].addEventListener('click', () => { closeCtx(); it.act && it.act(); });
    bi++;
  }
}
function closeCtx() { $('#ctx').classList.add('hidden'); }

/* ================= 悬停提示 ================= */
let tooltipTimer = null;
function showTooltip(e, kind, id) {
  clearTimeout(tooltipTimer);
  if (kind === 'node') {
    const n = state.nodes.find(x => x.id === id);
    if (!n) return;
    const t = U.getType(n.type);
    const links = state.links.filter(l => l.a === id || l.b === id);
    const html = `<div class="tt-t">${U.escHtml(n.name)}</div>
      <div class="tt-r">类型：${U.escHtml(t.label)} · 连线 ${links.length} 条</div>
      ${n.mgmt ? `<div class="tt-r">管理地址：${U.escHtml(n.mgmt)}</div>` : ''}
      ${n.note ? `<div class="tt-r">备注：${U.escHtml(n.note)}</div>` : ''}`;
    posTooltip(e, html);
  } else if (kind === 'link') {
    const l = state.links.find(x => x.id === id);
    if (!l) return;
    const na = state.nodes.find(n => n.id === l.a), nb = state.nodes.find(n => n.id === l.b);
    const row = (ifn, ip) => `<div class="tt-r">${U.escHtml(ifn || '—')} ${U.escHtml(ip || '')}</div>`;
    const html = `<div class="tt-t">${U.escHtml(na ? na.name : '?')} ⇄ ${U.escHtml(nb ? nb.name : '?')}</div>
      ${row(l.aIf, l.aIp)}${row(l.bIf, l.bIp)}
      ${l.bw ? `<div class="tt-r">带宽：${U.escHtml(l.bw)}</div>` : ''}
      ${l.note ? `<div class="tt-r">备注：${U.escHtml(l.note)}</div>` : ''}`;
    posTooltip(e, html);
  }
}
function posTooltip(e, html) {
  const t = $('#tooltip');
  t.innerHTML = html;
  t.classList.remove('hidden');
  const r = t.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 10;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 10;
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}
function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(() => $('#tooltip').classList.add('hidden'), 120);
}

/* ================= 选中详情卡片 ================= */
function renderSelCard() {
  const card = $('#selCard');
  const { kind, id } = state.sel;
  if (!id) { card.classList.add('hidden'); return; }
  let html = '';
  if (kind === 'node') {
    const n = state.nodes.find(x => x.id === id);
    if (!n) { card.classList.add('hidden'); return; }
    const t = U.getType(n.type);
    const cnt = state.links.filter(l => l.a === id || l.b === id).length;
    html = `<div class="sc-head"><span class="sc-type" style="background:${t.c1}">${U.escHtml(t.label)}</span>
      <span class="sc-title">${U.escHtml(n.name)}</span></div>
      <div class="sc-row">接口数量：<b>${cnt}</b> 条连线</div>
      ${n.mgmt ? `<div class="sc-row">管理地址：<b>${U.escHtml(n.mgmt)}</b></div>` : ''}
      ${n.note ? `<div class="sc-row">备注：<b>${U.escHtml(n.note)}</b></div>` : ''}
      <div class="sc-actions">
        <button class="tb" data-act="edit">编辑</button>
        <button class="tb" data-act="locate">定位</button>
        <button class="tb danger" data-act="del">删除</button>
      </div>`;
  } else {
    const l = state.links.find(x => x.id === id);
    if (!l) { card.classList.add('hidden'); return; }
    const na = state.nodes.find(n => n.id === l.a), nb = state.nodes.find(n => n.id === l.b);
    const row = (nm, ifn, ip) => `<div class="sc-row">${U.escHtml(nm)} <b>${U.escHtml(ifn || '—')}</b> ${U.escHtml(ip || '')}</div>`;
    html = `<div class="sc-head"><span class="sc-type" style="background:#64748b">连线</span>
      <span class="sc-title">${U.escHtml(na ? na.name : '?')} ⇄ ${U.escHtml(nb ? nb.name : '?')}</span></div>
      ${row(na ? na.name : '', l.aIf, l.aIp)}
      ${row(nb ? nb.name : '', l.bIf, l.bIp)}
      ${l.bw ? `<div class="sc-row">带宽：<b>${U.escHtml(l.bw)}</b></div>` : ''}
      ${l.note ? `<div class="sc-row">备注：<b>${U.escHtml(l.note)}</b></div>` : ''}
      <div class="sc-actions">
        <button class="tb" data-act="edit">编辑</button>
        <button class="tb danger" data-act="del">删除</button>
      </div>`;
  }
  card.innerHTML = html;
  card.classList.remove('hidden');
  card.querySelector('[data-act=edit]').onclick = () => kind === 'node' ? editNode(id) : editLink(id);
  const loc = card.querySelector('[data-act=locate]');
  if (loc) loc.onclick = () => centerOn('node', id);
  card.querySelector('[data-act=del]').onclick = () => deleteSelection();
}

/* ================= 面板 ================= */
function refreshAll() {
  updateStats();
  refreshPanel();
  updateLegend();
  $('#empty').classList.toggle('hidden', state.blank || state.nodes.length > 0);
  $('#zoomCtl').classList.toggle('hidden', state.nodes.length === 0);
}

function updateStats() {
  $('#statGraph').innerHTML = `设备 <b>${state.nodes.length}</b> · 连线 <b>${state.links.length}</b>`;
  $('#cntNodes').textContent = state.nodes.length;
  $('#cntLinks').textContent = state.links.length;
}

function refreshPanel() {
  const wrap = $('#listWrap');
  const q = state.search.trim().toLowerCase();
  if (state.tab === 'nodes') {
    const list = state.nodes
      .filter(n => !q || n.name.toLowerCase().includes(q) || n.note.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    if (!list.length) {
      wrap.innerHTML = `<div class="list-empty">${state.nodes.length ? '无匹配设备' : '暂无设备，可新建空白画布或添加设备'}</div>`;
      return;
    }
    wrap.innerHTML = list.map(n => {
      const t = U.getType(n.type);
      const cnt = state.links.filter(l => l.a === n.id || l.b === n.id).length;
      return `<div class="pitem ${state.sel.kind === 'node' && state.sel.id === n.id ? 'sel' : ''}" data-kind="node" data-id="${n.id}">
        <span class="dot" style="background:${t.c1}"></span>
        <span class="nm">${U.escHtml(n.name)}<span class="sub">${U.escHtml(t.label)}${n.note ? ' · ' + U.escHtml(n.note) : ''}</span></span>
        <span class="cnt2">${cnt} 线</span>
      </div>`;
    }).join('');
  } else {
    const list = state.links
      .map(l => {
        const a = state.nodes.find(n => n.id === l.a), b = state.nodes.find(n => n.id === l.b);
        return { l, a, b };
      })
      .filter(({ l, a, b }) => {
        if (!q) return true;
        return [a && a.name, b && b.name, l.aIf, l.bIf, l.aIp, l.bIp].some(v => v && v.toLowerCase().includes(q));
      });
    if (!list.length) {
      wrap.innerHTML = `<div class="list-empty">${state.links.length ? '无匹配连线' : '暂无连线'}</div>`;
      return;
    }
    wrap.innerHTML = list.map(({ l, a, b }) => `
      <div class="pitem ${state.sel.kind === 'link' && state.sel.id === l.id ? 'sel' : ''}" data-kind="link" data-id="${l.id}">
        <span class="dot" style="background:#64748b"></span>
        <span class="nm">${U.escHtml(a ? a.name : '?')} ⇄ ${U.escHtml(b ? b.name : '?')}
          <span class="sub">${U.escHtml(l.aIf || '')} ${U.escHtml(l.aIp || '')} ⇄ ${U.escHtml(l.bIf || '')} ${U.escHtml(l.bIp || '')}</span>
        </span>
        ${l.bw ? `<span class="ifc">${U.escHtml(l.bw)}</span>` : ''}
      </div>`).join('');
  }
  $$('.pitem', wrap).forEach(it => {
    it.addEventListener('click', () => {
      const kind = it.getAttribute('data-kind'), id = it.getAttribute('data-id');
      select(kind, id, { center: true });
    });
  });
}

function updateLegend() {
  $('#legend').innerHTML = U.typeList().map(t => {
    const c = U.getType(t.key);
    return `<span class="lg" title="${U.escHtml(t.label)}"><i style="background:${c.c1}"></i>${U.escHtml(t.label)}</span>`;
  }).join('');
}

/* ================= 持久化（刷新自动恢复） ================= */
const GRAPH_KEY = 'nettopo.graph';

function saveGraph() {
  try {
    localStorage.setItem(GRAPH_KEY, JSON.stringify({
      nodes: state.nodes,
      links: state.links,
      pan: renderer.pan,
      zoom: renderer.zoom,
      ts: Date.now()
    }));
  } catch (e) { /* 存储超限时忽略 */ }
}

function restoreGraph() {
  try {
    const raw = localStorage.getItem(GRAPH_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d.nodes || !d.nodes.length) return false;
    state.nodes = d.nodes;
    state.links = d.links;
    U.seedCounters(state.nodes, state.links); // 避免新 ID 与恢复节点冲突
    state.sel = { kind: null, id: null };
    state.undoStack = []; // 初始状态无需撤销
    state.redoStack = [];
    renderer.setData(state.nodes, state.links);
    if (d.pan && d.zoom) renderer.setView(d.pan, d.zoom);
    else renderer.fit();
    updateUndoBtns();
    refreshAll();
    return true;
  } catch (e) { return false; }
}

/* ================= 主题 ================= */
function togglePanel() {
  document.body.classList.toggle('panel-off');
  const off = document.body.classList.contains('panel-off');
  $('#btnPanel').title = off ? '展开面板' : '收起面板';
  if (!off) renderer.fit(); // 面板展开后画布宽度变化，重新适应视图
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  $('#btnTheme').innerHTML = `<i class="ic" data-ic="${state.theme === 'dark' ? 'sun' : 'moon'}"></i>`;
  U.fillIcons();
  renderer.update();
}
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('nettopo.theme', state.theme);
  applyTheme();
}

/* ================= 设备类型管理 ================= */
function openTypeManager() {
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" style="width:540px">
      <h3>设备类型管理</h3>
      <div class="m-sub">内置与自定义类型均可<b>修改颜色</b>、<b>上传设备图片</b>（拓扑中以图片显示）；数据保存在本机浏览器中</div>
      <div class="help-body">
        <h4>内置类型</h4>
        <div id="tmBuiltin"></div>
        <h4>自定义类型</h4>
        <div id="tmCustom"></div>
        <h4>添加自定义类型</h4>
        <div class="frow"><label>类型名称 <span class="req">*</span></label><input id="tmName" placeholder="例如：出口防火墙、核心存储…"/></div>
        <div class="frow"><label>设备图片（可选）</label>
          <input type="file" id="tmFile" accept="image/*"/>
          <div class="hint2">上传后自动压缩为 96×96，用于拓扑中的设备图标；也可在下方列表中为任意类型单独上传</div>
        </div>
        <div class="m-actions">
          <button class="tb" data-act="close">关闭</button>
          <button class="tb primary" id="tmAdd">添加类型</button>
        </div>
      </div>
    </div>`;
  root.appendChild(ov);

  const builtinEl = ov.querySelector('#tmBuiltin');
  const customEl = ov.querySelector('#tmCustom');
  // 行内图片上传：共享一个隐藏 file input
  const rowFile = document.createElement('input');
  rowFile.type = 'file';
  rowFile.accept = 'image/*';
  rowFile.style.display = 'none';
  ov.appendChild(rowFile);
  let rowFileKey = null;

  const afterChange = () => {
    renderer.setData(state.nodes, state.links);
    refreshAll();
    render();
  };

  const rowHtml = (t, isCustom) => {
    const c = U.getType(t.key);
    const thumb = c.img
      ? `<img class="tm-thumb" src="${c.img}" alt=""/>`
      : `<span class="dot" style="background:${c.c1};width:26px;height:26px;border-radius:7px"></span>`;
    return `
      <div class="tm-row" data-key="${t.key}">
        ${thumb}
        <span class="tm-label">${U.escHtml(t.label)}${isCustom ? '' : '<span class="tm-tag">内置</span>'}</span>
        <input type="color" class="tm-color" value="${c.c1}" title="修改颜色"/>
        <button class="tb" data-act="img" title="上传设备图片">图片</button>
        ${c.img ? '<button class="tb" data-act="clr-img" title="清除图片">清除图</button>' : ''}
        ${isCustom ? `<button class="tb danger" data-act="del" title="删除该类型（已使用该类型的设备将变为「其他」）">删除</button>` : ''}
      </div>`;
  };

  const render = () => {
    builtinEl.innerHTML = U.TYPE_ORDER.map(k => rowHtml({ key: k, label: U.TYPES[k].label }, false)).join('');
    customEl.innerHTML = U.customTypes.length
      ? U.customTypes.map(t => rowHtml(t, true)).join('')
      : '<div class="list-empty">尚未添加自定义类型</div>';
    $$('.tm-row', builtinEl).concat($$('.tm-row', customEl)).forEach(row => {
      const key = row.getAttribute('data-key');
      row.querySelector('[data-act=img]').addEventListener('click', () => {
        rowFileKey = key;
        rowFile.click();
      });
      const clr = row.querySelector('[data-act=clr-img]');
      if (clr) clr.addEventListener('click', () => {
        U.setTypeImage(key, '');
        afterChange();
      });
      row.querySelector('.tm-color').addEventListener('input', (e) => {
        U.setTypeColor(key, e.target.value);
        afterChange();
      });
      const del = row.querySelector('[data-act=del]');
      if (del) del.addEventListener('click', () => {
        if (!confirm(`删除类型「${U.customTypes.find(t => t.key === key).label}」？`)) return;
        U.removeCustomType(key);
        for (const n of state.nodes) {
          if (n.type === key) { n.type = 'other'; }
        }
        afterChange();
      });
    });
  };

  rowFile.addEventListener('change', async () => {
    const f = rowFile.files[0];
    rowFile.value = '';
    if (!f || !rowFileKey) return;
    try {
      const img = await U.imageToDataURL(f);
      U.setTypeImage(rowFileKey, img);
      toast(`已为类型设置图片`);
      afterChange();
    } catch (e) { toast('图片读取失败：' + e.message); }
  });

  ov.querySelector('#tmAdd').addEventListener('click', async () => {
    const name = ov.querySelector('#tmName').value.trim();
    if (!name) { toast('请输入类型名称'); return; }
    if (U.typeList().some(t => t.label === name)) { toast('该类型名称已存在'); return; }
    const file = ov.querySelector('#tmFile').files[0];
    let img = '';
    if (file) {
      try { img = await U.imageToDataURL(file); }
      catch (e) { toast('图片读取失败：' + e.message); return; }
    }
    U.addCustomType(name, img);
    afterChange();
    ov.querySelector('#tmName').value = '';
    ov.querySelector('#tmFile').value = '';
    toast(`已添加类型「${name}」`);
  });

  ov.querySelector('[data-act=close]').addEventListener('click', () => ov.remove());
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) ov.remove(); });
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); ov.remove(); }
  });
  render();
  setTimeout(() => ov.querySelector('#tmName').focus(), 30);
}

/* ================= 帮助 ================= */
function openHelp() {
  openModal({
    title: '使用帮助',
    submit: '知道了',
    onSubmit: () => {},
    fields: []
  });
  const ov = $('#modalRoot').lastElementChild;
  const modal = ov.querySelector('.modal');
  modal.style.width = '560px';
  ov.querySelector('form').innerHTML = `
  <div class="help-body">
    <h4>① 导入连线关系表</h4>
    <p>支持 <code>.csv / .txt / .xlsx / .xls</code> 文件（自动识别 UTF-8 / GBK 编码，兼容中英文表头）。</p>
    <table>
      <tr><th>中文表头</th><th>英文表头</th><th>说明</th></tr>
      <tr><td>源设备 / 设备A / 设备1</td><td>source / device_a</td><td>必填</td></tr>
      <tr><td>源接口 / 接口A</td><td>source_interface</td><td>可选</td></tr>
      <tr><td>源IP / IP地址A</td><td>source_ip</td><td>可选</td></tr>
      <tr><td>目标设备 / 设备B / 设备2</td><td>target / device_b</td><td>必填</td></tr>
      <tr><td>目标接口 / 接口B</td><td>target_interface</td><td>可选</td></tr>
      <tr><td>目标IP / IP地址B</td><td>target_ip</td><td>可选</td></tr>
      <tr><td>带宽 / 备注</td><td>bandwidth / note</td><td>可选</td></tr>
    </table>
    <p>无表头的表格按「设备A, 设备B, 接口A, IP A, 接口B, IP B」顺序识别。</p>
    <h4>② 自动生成拓扑</h4>
    <p>导入后自动执行力导向布局，接口名与 IP 标注在连线上；同一对设备的多条链路会自动平行展开。</p>
    <h4>③ 手动修改</h4>
    <p>拖拽设备调整位置；<b>双击</b>设备/连线编辑名称、接口、IP；工具栏可<b>添加设备 / 添加连线</b>；选中后按 <kbd>Delete</kbd> 删除，<kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd> 撤销重做；右键空白处可直接添加设备或导入导出。</p>
    <p><b>设备类型</b>：点工具栏「类型」可添加自定义设备类型并<b>上传设备图片</b>，拓扑中自动以图片显示；设备名称过长时节点宽度会自动加宽。</p>
    <h4>④ 保存 / 导出</h4>
    <p><b>导出CSV / 导出Excel</b>：把修改后的拓扑保存回连线关系表；<b>导出PDF</b>：矢量渲染为高清图片后生成 PDF，任何设备上打开效果一致，适合交付与打印；<b>导出Visio</b>：生成 .vsdx 文件（Visio 2013+ 可直接打开继续编辑）。</p>
    <h4>快捷键</h4>
    <p><kbd>滚轮</kbd> 缩放 · <kbd>拖拽空白</kbd> 平移 · <kbd>L</kbd> 自动布局 · <kbd>F</kbd> 适应视图 · <kbd>Delete</kbd> 删除选中</p>
  </div>`;
}

/* ================= 事件接线 ================= */
function wire() {
  U.fillIcons();

  $('#btnNew').onclick = newGraph;
  $('#btnImport').onclick = () => $('#fileInput').click();
  $('#btnEmptyImport').onclick = () => $('#fileInput').click();
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleImport(f).catch(err => toast('读取文件失败：' + err.message));
    e.target.value = '';
  });

  $('#btnSample').onclick = () => {
    if (state.nodes.length && !confirm('导入将替换当前拓扑，是否继续？')) return;
    loadGraph(M.textToGraph(M.SAMPLE_CSV), '已载入示例拓扑：9 台设备、10 条链路');
  };
  $('#btnEmptySample').onclick = () => $('#btnSample').click();
  $('#btnEmptyNew').onclick = () => {
    newGraph();
    setMode('place'); // 直接进入放置模式，点击画布即可添加第一台设备
    setHint('放置模式：点击画布空白处放置设备；Esc 或右键取消');
  };

  $('#btnAddNode').onclick = () => setMode(state.mode === 'place' ? 'normal' : 'place');
  $('#btnAddLink').onclick = () => setMode(state.mode === 'link' ? 'normal' : 'link');
  $('#btnTypes').onclick = openTypeManager;
  $('#btnDelete').onclick = () => deleteSelection();
  $('#btnLayout').onclick = () => autoLayout();
  $('#btnFit').onclick = () => renderer.fit();
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnCsv').onclick = exportCSV;
  $('#btnXlsx').onclick = exportXlsx;
  $('#btnPdf').onclick = exportPdf;
  $('#btnVisio').onclick = exportVisio;
  $('#btnTheme').onclick = toggleTheme;
  $('#btnHelp').onclick = openHelp;

  $('#zIn').onclick = () => renderer.zoomBy(1.25);
  $('#zOut').onclick = () => renderer.zoomBy(0.8);
  $('#zFit').onclick = () => renderer.fit();

  $('#btnPanel').onclick = () => togglePanel();
  $('#panelOpen').onclick = () => togglePanel();

  $$('.tab').forEach(t => t.addEventListener('click', () => {
    state.tab = t.getAttribute('data-tab');
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    refreshPanel();
  }));
  $('#searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    refreshPanel();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!$('#ctx').classList.contains('hidden') && !e.target.closest('#ctx')) closeCtx();
  });

  // hintBar：点击任意位置关闭（pointerdown + mousedown + click 三重兼容）
  const closeHint = (e) => { e.stopPropagation(); e.preventDefault(); setMode('normal'); };
  $('#hintBar').addEventListener('pointerdown', closeHint);
  $('#hintBar').addEventListener('mousedown', closeHint);
  $('#hintBar').addEventListener('click', closeHint);

  // 全局兜底（pointerdown + mousedown 双兼容）
  const exitOnBlank = (e) => {
    if (state.mode === 'normal') return;
    if (state.mode === 'place') return; // 放置模式点击空白 = 放置设备，不退出
    const t = e.target;
    const keep = t && t.closest && t.closest('.node, .link, .modal, #toolbar, #panel, #hintBar, #ctx, #empty, #selCard, #zoomCtl');
    if (!keep) setMode('normal');
  };
  document.addEventListener('pointerdown', exitOnBlank, true);
  document.addEventListener('mousedown', exitOnBlank, true);

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (state.mode !== 'normal') {
      // 模式中按任意键退出（Esc 或其他键均可）
      setMode('normal');
      return;
    }
    if (e.key === 'Escape') {
      closeCtx();
      select(null, null);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newGraph(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); return; }
    if (e.key.toLowerCase() === 'l') { autoLayout(); return; }
    if (e.key.toLowerCase() === 'f') { renderer.fit(); return; }
    if (e.key === '+' || e.key === '=') { renderer.zoomBy(1.25); return; }
    if (e.key === '-') { renderer.zoomBy(0.8); return; }
  });
}

/* ================= 诊断（帮助定位交互问题） ================= */
(function () {
  const div = document.createElement('div');
  div.id = 'diagBar';
  div.style.cssText = 'position:fixed;right:8px;bottom:30px;z-index:999;font:11px/1.6 monospace;background:rgba(15,23,42,.85);color:#e2e8f0;padding:6px 10px;border-radius:8px;max-width:340px;pointer-events:none;display:none';
  document.body.appendChild(div);
  const D = { mode: 'normal', ev: '-', evTarget: '-', t: 0 };
  for (const t of ['pointerdown', 'mousedown', 'click', 'keydown']) {
    document.addEventListener(t, (e) => {
      D.ev = t;
      D.evTarget = (e.target && (e.target.id || e.target.className && e.target.className.baseVal !== undefined ? e.target.className.baseVal : e.target.className) || e.target.tagName) || '-';
    }, true);
  }
  setInterval(() => {
    D.mode = state.mode;
    D.t = setHint._t ? 1 : 0;
    div.textContent = `模式:${D.mode} | 事件:${D.ev}@${D.evTarget} | 计时器:${D.t} | 显示倒计时请按 F2`;
  }, 400);
  // F2 切换诊断条显隐
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F2') { div.style.display = div.style.display === 'none' ? 'block' : 'none'; }
  });
})();

/* ================= 启动 ================= */
console.log('[NetTopo] 版本 v20260811c');
// 启动时强制隐藏悬浮层（避免上次会话残留的黑点/提示条）
$('#tooltip').classList.add('hidden');
$('#hintBar').classList.add('hidden');
applyTheme();
wire();
updateUndoBtns();
refreshAll();
setMode('normal');
restoreGraph(); // 恢复上次的拓扑（刷新不丢失）

// 自动化/调试钩子
if (typeof globalThis !== 'undefined') {
  globalThis.__topo = {
    _closeHint: () => setMode('normal'),
    state,
    renderer,
    loadSample: () => loadGraph(M.textToGraph(M.SAMPLE_CSV), '示例'),
    newGraph,
    autoLayout,
    exportCSV,
    exportXlsx,
    exportVisio,
    exportPdf
  };
}
})();
