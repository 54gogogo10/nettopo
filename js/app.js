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
  blank: false,   // 用户主动新建空白画布（无表格也能直接画）
  showLabels: localStorage.getItem('nettopo.showLabels') !== '0',   // 链路标注显示开关
  showSubnets: localStorage.getItem('nettopo.showSubnets') === '1', // 子网分组显示开关
  subnetNames: {},  // 子网 -> 自定义名称（子网分组命名）
  downLinks: new Set(),  // 故障链路 id 集合（模拟断链，路径分析绕行）
  autoBackup: { on: localStorage.getItem('nettopo.autoBackup') === '1', minutes: Number(localStorage.getItem('nettopo.autoBackupMin') || 10), keep: Math.min(200, Math.max(1, Number(localStorage.getItem('nettopo.autoBackupKeep') || 30) || 30)) },
  texts: []  // 画布文本框（自定义字体样式）
};
let layoutCancel = false;

U.loadCustomTypes(); // 恢复自定义设备类型
U.loadCustomCfgTemplates(); // 恢复自定义配置模板

const renderer = new TopoRender($('#svg'), {
  onDown(e, kind, id) {
    hideTooltip();
    if (state.mode === 'link' || state.mode === 'place') {
      e.preventDefault();
      handleModeClick(e, kind, id);
      return false;
    }
    if (kind !== 'bg') select(kind, id, { center: false, multi: e.ctrlKey || e.metaKey, extend: e.shiftKey });
    // 记录拖拽前的状态，拖动结束时用于撤销（避免撤销栈记录“当前态”）
    state._dragPre = kind === 'node' ? snapshot() : null;
    return true;
  },
  onBoxSelect(ids) {
    if (!ids.length) { select(null, null); return; }
    state.sel = { kind: 'node', id: ids[ids.length - 1] };
    renderSelCard();
    refreshPanel();
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
  onGroupRename(key, cur) {
    openModal({
      title: '子网分组命名',
      sub: '留空则恢复为网段名',
      fields: [{ name: 'name', label: '分组名称', value: state.subnetNames[key] || '', ph: '例如：核心区' }],
      submit: '确定',
      onSubmit: (v) => {
        if (!String(v.name).trim()) delete state.subnetNames[key];
        else state.subnetNames[key] = String(v.name).trim();
        renderer.setSubnetView(state.showSubnets, state.subnetNames);
        saveGraph();
      }
    });
  },
  onView(z) {
    $('#zVal').textContent = Math.round(z * 100) + '%';
    // 视图平移/缩放也持久化（节流）
    clearTimeout(saveGraph._t);
    saveGraph._t = setTimeout(saveGraph, 500);
  }
});
// 显示开关初始状态
renderer.showLabels = state.showLabels;
renderer.showSubnets = state.showSubnets;
renderer.subnetNames = state.subnetNames;
setupAutoBackup(); // 自动备份（若有配置）

/* ================= 选中 ================= */
function select(kind, id, opts) {
  opts = opts || {};
  state.sel = { kind, id };
  renderer.select(kind, id, opts);
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
function snapshot() {
  return {
    nodes: U.clone(state.nodes), links: U.clone(state.links), texts: U.clone(state.texts),
    downLinks: [...state.downLinks], subnetNames: Object.assign({}, state.subnetNames)
  };
}
function restore(s) {
  state.nodes = s.nodes; state.links = s.links; state.texts = s.texts || [];
  state.sel = { kind: null, id: null };
  if (Array.isArray(s.downLinks)) { state.downLinks = new Set(s.downLinks); renderer.setDownLinks(state.downLinks); }
  if (s.subnetNames && typeof s.subnetNames === 'object') { state.subnetNames = s.subnetNames; renderer.subnetNames = s.subnetNames; }
  renderer.setSubnetView(state.showSubnets, state.subnetNames);
  renderer.setData(state.nodes, state.links, state.texts);
  refreshAll();
  updateLegend();
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

async function loadGraph(graph, msg) {
  if (state.nodes.length && !(await confirmBox('导入将替换当前拓扑，是否继续？'))) return;
  layoutCancel = true;
  setMode('normal');
  state.nodes = graph.nodes;
  state.links = graph.links;
  state.texts = [];
  state.sel = { kind: null, id: null };
  state.undoStack = []; // 初始状态无需撤销
  state.redoStack = [];
  state.blank = false; // 已导入/载入内容，回到常规模式
  updateUndoBtns();
  renderer.setData(state.nodes, state.links, state.texts);
  refreshAll();
  if (msg) toast(msg);
  saveGraph();
  // 带坐标的表格/工程直接还原布局，不带坐标才自动布局
  const hasPos = graph.nodes.some(n => n.x || n.y);
  if (hasPos) renderer.fit();
  else autoLayout();
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


/* ================= 布局预设 ================= */
function viewCenter() {
  const r = $('#svg').getBoundingClientRect();
  return renderer.toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

function applyLayoutPreset(kind) {
  if (!state.nodes.length) { toast('画布为空，请先添加设备'); return; }
  pushUndo();
  const c = viewCenter();
  if (kind === 'ring') Layout.ringLayout(state.nodes, { cx: c.x, cy: c.y });
  else if (kind === 'grid') Layout.gridLayout(state.nodes, { cx: c.x, cy: c.y });
  else if (kind === 'layer') Layout.layerLayout(state.nodes, { cx: c.x, cy: c.y });
  else if (kind === 'tier') Layout.tierLayout(state.nodes, { cx: c.x, cy: c.y });
  else if (kind === 'topo') Layout.layerTopoLayout(state.nodes, state.links, { cx: c.x, cy: c.y });
  renderer.setData(state.nodes, state.links, state.texts);
  refreshAll();
  renderer.fit();
  saveGraph();
  toast(kind === 'ring' ? '已应用环形布局' : kind === 'grid' ? '已应用网格布局' : kind === 'tier' ? '已应用三层架构布局（核心-汇聚-接入）' : kind === 'topo' ? '已应用拓扑分层布局（最少交叉）' : '已应用分层布局（按类型）');
}

/* ================= 路径分析 ================= */
function openPathAnalysis() {
  if (state.nodes.length < 2) { toast('至少需要两台设备才能分析路径'); return; }
  openModal({
    title: '路径分析',
    fields: [
      { name: 'from', label: '起点设备', type: 'select', options: state.nodes.map(n => [n.id, n.name]) },
      { name: 'to', label: '终点设备', type: 'select', options: state.nodes.map(n => [n.id, n.name]) }
    ],
    sub: state.downLinks.size ? `选择起点与终点（已排除 ${state.downLinks.size} 条故障链路）` : '选择起点与终点，高亮显示最短路径（BFS）',
    submit: '分析',
    onSubmit: (v) => {
      if (!v.from || !v.to) { toast('请选择起点与终点'); return; }
      const path = U.bestPath(state.nodes, state.links, v.from, v.to, { exclude: state.downLinks.size ? state.downLinks : null });
      if (!path) { toast(state.downLinks.size ? '两台设备之间不可达（可能因故障链路导致）' : '两台设备之间不可达'); return; }
      renderer.highlightPath(path.nodeIds, path.linkIds);
      const names = path.nodeIds.map(id => { const n = state.nodes.find(x => x.id === id); return n ? n.name : id; });
      const ifText = path.linkIds.map((lid, i) => {
        const l = state.links.find(x => x.id === lid);
        if (!l) return '';
        const dir = (l.a === path.nodeIds[i] && l.b === path.nodeIds[i + 1]) || (l.a === path.nodeIds[i + 1] && l.b === path.nodeIds[i]);
        return dir ? `（${l.aIf || '—'} / ${l.bIf || '—'}）` : '';
      });
      const steps = names.map((nm, i) => (i ? ifText[i - 1] + nm : nm)).join(' → ');
      const bottleneck = Number.isFinite(path.bottleneck) ? U.formatBw(path.bottleneck) : '';
      showPathResult(names.length - 1, steps, bottleneck);
    }
  });
}

function showPathResult(hops, steps, bottleneck) {
  const faultNote = state.downLinks.size ? `<div class="m-sub">已排除 ${state.downLinks.size} 条故障链路（红色虚线）</div>` : '';
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:520px">
      <h3>路径分析结果</h3>
      <div class="m-sub">共 ${hops} 跳${bottleneck ? `，瓶颈带宽 <b>${bottleneck}</b>（按带宽优选）` : '（未设置带宽，按跳数优先）'}；路径已在画布中高亮为金色</div>
      ${faultNote}
      <div class="path-steps">${U.escHtml(steps)}</div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="clear">清除高亮</button>
        <button type="button" class="tb primary" data-act="close">关闭</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => { ov.remove(); };
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) { renderer.clearPath(); close(); } });
  ov.querySelector('[data-act=clear]').onclick = () => { renderer.clearPath(); close(); };
  ov.querySelector('[data-act=close]').onclick = () => close();
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); renderer.clearPath(); close(); } });
}

/* ================= 设备模板库 ================= */
const DEVICE_TEMPLATES = [
  { label: '路由器（华为 AR）', type: 'router', name: 'AR-核心路由器', mgmt: '10.255.0.1' },
  { label: '路由器（思科 ISR）', type: 'router', name: 'ISR-边界路由器', mgmt: '10.255.0.1' },
  { label: '核心交换机', type: 'switch', name: '核心交换机', mgmt: '10.255.0.2' },
  { label: '接入交换机', type: 'switch', name: '接入交换机', mgmt: '10.255.0.3' },
  { label: '防火墙', type: 'firewall', name: '防火墙', mgmt: '10.255.0.254' },
  { label: '服务器', type: 'server', name: '服务器', mgmt: '' },
  { label: '终端 PC', type: 'pc', name: '办公PC', mgmt: '' },
  { label: '云 / 外网', type: 'cloud', name: '互联网出口', mgmt: '' }
];

function openTemplatePicker() {
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:560px">
      <h3>从模板添加设备</h3>
      <div class="m-sub">点击模板即在画布中心添加（重名自动加序号），可随后双击编辑</div>
      <div class="tpl-grid">
        ${DEVICE_TEMPLATES.map((t, i) => `
          <button type="button" class="tb tpl" data-i="${i}">
            <i class="ic" data-ic="node"></i>
            <span><b>${U.escHtml(t.label)}</b><small>${U.escHtml(t.mgmt ? '管理 ' + t.mgmt : t.type)}</small></span>
          </button>`).join('')}
      </div>
      <div class="m-actions"><button type="button" class="tb" data-act="close">关闭</button></div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=close]').onclick = close;
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  ov.querySelectorAll('.tpl').forEach(btn => {
    btn.onclick = () => { const t = DEVICE_TEMPLATES[+btn.dataset.i]; close(); addTemplateDevice(t); };
  });
}

function addTemplateDevice(t) {
  const c = viewCenter();
  let name = t.name;
  let k = 2;
  while (state.nodes.some(n => n.name === name)) name = `${t.name}-${k++}`;
  pushUndo();
  const node = {
    id: U.uid('n'), name, type: t.type, note: '',
    x: c.x - U.nodeWidthForName(name) / 2, y: c.y - U.NODE_H / 2,
    w: U.nodeWidthForName(name), h: U.NODE_H, mgmt: t.mgmt
  };
  node.h = U.nodeHeightFor(node);
  node.y = c.y - node.h / 2;
  state.nodes.push(node);
  renderer.setData(state.nodes, state.links, state.texts);
  refreshAll();
  saveGraph();
  select('node', node.id, { center: true });
  toast(`已添加「${name}」，双击可编辑`);
}

/* ================= 设备配置生成（自定义厂家风格） ================= */
function cfgVendorOptions() {
  const tpls = U.cfgTemplates();
  const builtin = [], custom = [];
  for (const k in tpls) {
    const t = tpls[k];
    (t.builtin ? builtin : custom).push(`<option value="${k}">${U.escHtml(t.label)}${t.builtin ? '' : '（自定义）'}</option>`);
  }
  return builtin.join('') + (custom.length ? '<optgroup label="自定义厂家">' + custom.join('') + '</optgroup>' : '');
}
function openConfigGen() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  const root = $('#modalRoot');
  const hasSel = renderer.selIds.size > 0;
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:700px">
      <h3>生成设备配置</h3>
      <div class="m-sub">按拓扑接口/IP 生成配置片段；可选 <b>静态路由</b>（自动推导）与 <b>VLAN</b>（交换机接入端口）</div>
      <div class="m-row">
        <label>厂家风格</label>
        <select id="cfgVendor">${cfgVendorOptions()}</select>
        <label style="margin-left:16px">范围</label>
        <select id="cfgScope">
          <option value="all">全部设备</option>
          ${hasSel ? '<option value="sel">仅选中设备（' + renderer.selIds.size + ' 台）</option>' : ''}
        </select>
        <label style="margin-left:16px;display:flex;align-items:center;gap:5px"><input id="cfgRoutes" type="checkbox" checked/> 静态路由</label>
        <label style="display:flex;align-items:center;gap:5px"><input id="cfgVlan" type="checkbox" checked/> VLAN</label>
        <button type="button" class="tb" id="cfgTplMgr" style="margin-left:auto">管理模板…</button>
      </div>
      <textarea id="cfgOut" class="cfg-box" readonly spellcheck="false"></textarea>
      <div class="m-actions">
        <button type="button" class="tb" data-act="copy">复制配置</button>
        <button type="button" class="tb" data-act="dl">下载 .txt</button>
        <button type="button" class="tb primary" data-act="close">关闭</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  const gen = () => {
    const vendor = ov.querySelector('#cfgVendor').value;
    const scope = ov.querySelector('#cfgScope').value;
    const selIds = renderer.selIds;
    const nodes = scope === 'sel' && selIds.size ? state.nodes.filter(n => selIds.has(n.id)) : state.nodes;
    ov.querySelector('#cfgOut').value = U.generateConfigs(nodes, state.links, vendor, {
      routes: ov.querySelector('#cfgRoutes').checked,
      vlan: ov.querySelector('#cfgVlan').checked
    });
  };
  ov.querySelector('#cfgVendor').addEventListener('change', gen);
  ov.querySelector('#cfgScope').addEventListener('change', gen);
  ov.querySelector('#cfgRoutes').addEventListener('change', gen);
  ov.querySelector('#cfgVlan').addEventListener('change', gen);
  ov.querySelector('#cfgTplMgr').onclick = () => openConfigTemplateManager(() => {
    ov.querySelector('#cfgVendor').innerHTML = cfgVendorOptions();
    gen();
  });
  gen();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=close]').onclick = close;
  ov.querySelector('[data-act=copy]').onclick = () => {
    const txt = ov.querySelector('#cfgOut').value;
    const done = () => toast('配置已复制到剪贴板');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
    } else fallbackCopy(txt, done);
  };
  ov.querySelector('[data-act=dl]').onclick = () => {
    U.download(`设备配置_${U.fmtDate()}.txt`, new Blob([ov.querySelector('#cfgOut').value], { type: 'text/plain;charset=utf-8' }));
    toast('已下载设备配置文本');
  };
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

/* 配置模板管理：内置模板只读，自定义模板可增删改（占位符 {name}{mgmt}{type}{iface}{ip}{peer}{peerIf}{vlan}{subnet}{nextHop}） */
function openConfigTemplateManager(done) {
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:720px">
      <h3>配置模板管理</h3>
      <div class="m-sub" style="line-height:1.7">占位符（模板里直接写，生成时替换）：
        设备级 <b>{name}</b> 设备名 · <b>{mgmt}</b> 管理地址 · <b>{type}</b> 类型 · <b>{comment}</b> 注释符
        接口级 <b>{iface}</b> 本端接口 · <b>{ip}</b> 接口 IP · <b>{mask}</b> 掩码 · <b>{peer}</b> 对端设备 · <b>{peerIf}</b> 对端接口 · <b>{bw}</b> 带宽 · <b>{vlan}</b> VLAN 号
        路由级 <b>{subnet}</b> 远端网段 · <b>{nextHop}</b> 下一跳</div>
      <div id="tplList" style="max-height:46vh;overflow:auto"></div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="add">新增模板</button>
        <button type="button" class="tb primary" data-act="close">关闭</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => { ov.remove(); done && done(); };
  const render = () => {
    const list = ov.querySelector('#tplList');
    const tpls = U.cfgTemplates();
    list.innerHTML = Object.keys(tpls).map(k => {
      const t = tpls[k];
      return `<div class="tpl-item" data-k="${k}">
        <div class="tpl-head"><b>${U.escHtml(t.label)}</b>${t.builtin ? '<span class="tpl-badge">内置</span>' : '<span class="tpl-badge custom">自定义</span>'}</div>
        <div class="tpl-actions">
          <button type="button" class="tb" data-act="edit">编辑</button>
          ${t.builtin ? '' : '<button type="button" class="tb danger" data-act="del">删除</button>'}
        </div>
      </div>`;
    }).join('');
    list.querySelectorAll('.tpl-item').forEach(item => {
      const k = item.dataset.k;
      item.querySelector('[data-act=edit]').onclick = () => editCfgTemplate(k);
      const del = item.querySelector('[data-act=del]');
      if (del) del.onclick = () => {
        confirmBox('删除自定义模板「' + (U.cfgTemplates()[k] || {}).label + '」？').then(ok => {
          if (!ok) return;
          delete (U.customCfgTemplates || {})[k];
          U.saveCustomCfgTemplates();
          render();
        });
      };
    });
  };
  const editCfgTemplate = (k) => {
    const t = U.cfgTemplates()[k];
    if (!t) return;
    const edit = document.createElement('div');
    edit.className = 'overlay';
    edit.innerHTML = `
      <div class="modal" role="dialog" style="width:680px">
        <h3>${t.builtin ? '查看模板' : '编辑模板'}：${U.escHtml(t.label)}</h3>
        <div class="m-row"><label>名称</label><input id="tplLabel" type="text" value="${U.escHtml(t.label)}" ${t.builtin ? 'disabled' : ''}/></div>
        <div class="m-row"><label>注释符</label><input id="tplComment" type="text" value="${U.escHtml(t.comment || '')}" style="width:70px" ${t.builtin ? 'disabled' : ''}/></div>
        <div class="m-sub" style="line-height:1.6">可用占位符：<b>{name}</b>设备名 <b>{mgmt}</b>管理 <b>{type}</b>类型 <b>{comment}</b>注释符 <b>{iface}</b>接口 <b>{ip}</b>IP <b>{mask}</b>掩码 <b>{peer}</b>对端设备 <b>{peerIf}</b>对端接口 <b>{bw}</b>带宽 <b>{vlan}</b>VLAN <b>{subnet}</b>网段 <b>{nextHop}</b>下一跳</div>
        <div class="m-row" style="align-items:flex-start"><label>设备头</label><textarea id="tplHeader" style="height:54px">${U.escHtml(t.deviceHeader || '')}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>接口块<br/><small>每行一条</small></label><textarea id="tplIface" style="height:110px">${U.escHtml((t.interface || []).join('\n'))}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>接入端口<br/><small>VLAN</small></label><textarea id="tplAccess" style="height:54px">${U.escHtml((t.switchAccess || []).join('\n'))}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>路由行<br/><small>可选</small></label><input id="tplRoute" type="text" value="${U.escHtml(t.route || '')}" style="flex:1"/></div>
        <div class="m-actions">
          <button type="button" class="tb" data-act="cancel">取消</button>
          <button type="button" class="tb primary" data-act="save">${t.builtin ? '关闭' : '保存'}</button>
        </div>
      </div>`;
    root.appendChild(edit);
    edit.tabIndex = -1; edit.focus();
    const c2 = () => edit.remove();
    edit.addEventListener('pointerdown', (e) => { if (e.target === edit) c2(); });
    edit.querySelector('[data-act=cancel]').onclick = c2;
    edit.querySelector('[data-act=save]').onclick = () => {
      if (t.builtin) { c2(); return; }
      const label = edit.querySelector('#tplLabel').value.trim();
      if (!label) { toast('模板名称不能为空'); return; }
      U.customCfgTemplates = U.customCfgTemplates || {};
      U.customCfgTemplates[k] = {
        key: k, label,
        comment: edit.querySelector('#tplComment').value.trim() || '#',
        deviceHeader: edit.querySelector('#tplHeader').value,
        noIface: U.cfgTemplates().huawei.noIface,
        interface: edit.querySelector('#tplIface').value.split('\n').map(s => s.trim()).filter(Boolean),
        switchAccess: edit.querySelector('#tplAccess').value.split('\n').map(s => s.trim()).filter(Boolean),
        vlanLine: U.cfgTemplates().huawei.vlanLine,
        route: edit.querySelector('#tplRoute').value.trim() || null
      };
      U.saveCustomCfgTemplates();
      c2(); render();
    };
    edit.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); c2(); } });
  };
  ov.querySelector('[data-act=add]').onclick = () => {
    let k = 'custom' + (Date.now() % 100000);
    while ((U.cfgTemplates())[k]) k = 'custom' + (Date.now() % 100000);
    U.customCfgTemplates = U.customCfgTemplates || {};
    U.customCfgTemplates[k] = {
      key: k, label: '自定义厂家',
      comment: '#',
      deviceHeader: '{comment} {name}  管理: {mgmt}  [{type}]',
      noIface: '{comment} （无接口配置）',
      interface: ['interface {iface}', ' ip address {ip} 255.255.255.0', ' description -> {peer}{peerIf}'],
      switchAccess: [],
      vlanLine: '',
      route: null
    };
    U.saveCustomCfgTemplates();
    render();
    editCfgTemplate(k);
  };
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=close]').onclick = close;
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  render();
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择复制'); }
  ta.remove();
}

/* ================= IP 规划清单 ================= */
function openIpPlan() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  const { rows, subnets } = U.ipPlan(state.nodes, state.links);
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:560px">
      <h3>IP 规划清单</h3>
      <div class="m-sub">已按设备分组（${rows.length} 行，子网 ${subnets.length} 个）；Excel 中「设备名」列按设备合并单元格</div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="copy">复制清单</button>
        <button type="button" class="tb" data-act="csv">导出 CSV</button>
        <button type="button" class="tb" data-act="xlsx">导出 Excel</button>
        <button type="button" class="tb primary" data-act="close">关闭</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  const text = () => {
    const head = Object.keys(rows[0] || {});
    const lines = [head.join('\t')].concat(rows.map(r => head.map(k => r[k] == null ? '' : String(r[k])).join('\t')));
    lines.push('');
    lines.push('== 子网统计 ==');
    lines.push('网段\t设备数\t设备');
    for (const s of subnets) lines.push(s.cidr + '\t' + s.devices.length + '\t' + s.devices.join(', '));
    return lines.join('\n');
  };
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=close]').onclick = close;
  ov.querySelector('[data-act=copy]').onclick = () => {
    const done = () => toast('IP 规划清单已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text()).then(done).catch(() => fallbackCopy(text(), done));
    else fallbackCopy(text(), done);
  };
  ov.querySelector('[data-act=csv]').onclick = () => {
    const head = Object.keys(rows[0] || {});
    const arr = [head].concat(rows.map(r => head.map(k => r[k] == null ? '' : String(r[k]))));
    arr.push([]); arr.push(['== 子网统计 ==']);
    arr.push(['网段', '设备数', '设备']);
    for (const s of subnets) arr.push([s.cidr, s.devices.length, s.devices.join(', ')]);
    U.download(`IP规划_${U.fmtDate()}.csv`, new Blob([U.buildCSV(arr)], { type: 'text/csv;charset=utf-8' }));
    toast('已导出 IP 规划 CSV');
  };
  ov.querySelector('[data-act=xlsx]').onclick = () => {
    if (!window.XLSX) { toast('未加载 Excel 解析库（需联网），请改用 CSV 导出'); return; }
    const wb = window.XLSX.utils.book_new();
    const ws = window.XLSX.utils.json_to_sheet(rows);
    // 设备名列合并：同一台设备的连续行合并成一个单元格（第 0 行表头，数据从第 1 行起，设备名列=0）
    const merges = U.deviceMergeRanges(rows);
    if (merges.length) ws['!merges'] = merges;
    // 列宽自适应
    const keys = Object.keys(rows[0] || {});
    ws['!cols'] = keys.map(k => ({ wch: Math.min(30, Math.max(8, ...rows.map(r => String(r[k] == null ? '' : r[k]).length)) + 2) }));
    window.XLSX.utils.book_append_sheet(wb, ws, 'IP规划');
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(subnets.map(s => ({ 网段: s.cidr, 设备数: s.devices.length, 设备: s.devices.join(', ') }))), '子网统计');
    const buf = window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    U.download(`IP规划_${U.fmtDate()}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    toast('已导出 IP 规划 Excel（设备名已按设备合并单元格）');
  };
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

/* ================= IP 批量改段 ================= */
function openIpRenumber() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  // 收集拓扑中的网段（接口 IP + 管理 IP）
  const subSet = new Map(); // cidr -> 数量
  const count = (ip) => { const s = U.subnetOf(ip); if (s) subSet.set(s, (subSet.get(s) || 0) + 1); };
  for (const l of state.links) { if (l.aIp) count(l.aIp); if (l.bIp) count(l.bIp); }
  for (const n of state.nodes) { for (const m of U.nodeMgmts(n)) count(m); }
  const options = [...subSet.keys()].sort();
  if (!options.length) { toast('拓扑中未发现 IP，无法改段'); return; }
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:520px">
      <h3>IP 批量改段</h3>
      <div class="m-sub">把某个网段整体改到新网段，自动保留主机位（如 192.168.1.5 → 172.20.1.5）</div>
      <div class="m-row">
        <label>原网段</label>
        <select id="rnOld">${options.map(s => `<option value="${s}">${s}（${subSet.get(s)} 个 IP）</option>`).join('')}</select>
      </div>
      <div class="m-row">
        <label>新网段</label>
        <input id="rnNew" type="text" placeholder="例如 172.20.1.0/24" style="width:200px"/>
      </div>
      <div class="m-row"><label style="display:flex;align-items:center;gap:6px"><input id="rnMgmt" type="checkbox" checked/> 同步更新网段内的管理地址</label></div>
      <div class="m-sub" id="rnPreview"></div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="cancel">取消</button>
        <button type="button" class="tb primary" data-act="apply">应用改段</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  const preview = () => {
    const oldC = ov.querySelector('#rnOld').value;
    const newC = ov.querySelector('#rnNew').value.trim();
    const info = U.cidrInfo(newC);
    let ifCnt = 0, mgmtCnt = 0, devs = new Set();
    for (const l of state.links) {
      if (l.aIp && U.renumberIp(l.aIp, oldC, newC) !== l.aIp) { ifCnt++; devs.add(l.a); }
      if (l.bIp && U.renumberIp(l.bIp, oldC, newC) !== l.bIp) { ifCnt++; devs.add(l.b); }
    }
    if (ov.querySelector('#rnMgmt').checked) {
      for (const n of state.nodes) { for (const m of U.nodeMgmts(n)) { if (U.renumberIp(m, oldC, newC) !== m) { mgmtCnt++; devs.add(n.id); } } }
    }
    const ok = info ? (info.prefix >= U.cidrInfo(oldC).prefix ? '' : '（注意：新网段主机位更少，超出部分会被截断）') : '（新网段格式无效）';
    ov.querySelector('#rnPreview').textContent = `将更新 ${ifCnt} 个接口 IP、${mgmtCnt} 个管理地址，涉及 ${devs.size} 台设备${ok}`;
  };
  ov.querySelector('#rnOld').addEventListener('change', preview);
  ov.querySelector('#rnNew').addEventListener('input', preview);
  ov.querySelector('#rnMgmt').addEventListener('change', preview);
  preview();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=cancel]').onclick = close;
  ov.querySelector('[data-act=apply]').onclick = () => {
    const oldC = ov.querySelector('#rnOld').value;
    const newC = ov.querySelector('#rnNew').value.trim();
    if (!U.cidrInfo(newC)) { toast('新网段格式无效，应为 CIDR 如 172.20.1.0/24'); return; }
    const incMgmt = ov.querySelector('#rnMgmt').checked;
    let changed = 0;
    pushUndo();
    for (const l of state.links) {
      if (l.aIp && U.renumberIp(l.aIp, oldC, newC) !== l.aIp) { l.aIp = U.renumberIp(l.aIp, oldC, newC); changed++; }
      if (l.bIp && U.renumberIp(l.bIp, oldC, newC) !== l.bIp) { l.bIp = U.renumberIp(l.bIp, oldC, newC); changed++; }
    }
    if (incMgmt) {
      for (const n of state.nodes) {
        const list = U.nodeMgmts(n).map(m => U.renumberIp(m, oldC, newC));
        const before = U.nodeMgmts(n).join('|');
        U.setNodeMgmts(n, list);
        if (U.nodeMgmts(n).join('|') !== before) changed++;
      }
    }
    close();
    renderer.setData(state.nodes, state.links, state.texts);
    refreshAll();
    saveGraph();
    toast(changed ? `已改段：${oldC} → ${newC}，共更新 ${changed} 个 IP` : '没有 IP 位于该网段，未做修改');
  };
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

/* ================= 拓扑设计报告导出 ================= */
function exportReport() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  const html = U.buildReportHtml(state.nodes, state.links, { includeConfig: true });
  U.download(`拓扑设计报告_${U.fmtDate()}.html`, new Blob([html], { type: 'text/html;charset=utf-8' }));
  toast('已导出拓扑设计报告（HTML，含设备/IP/子网/链路/配置）');
}

/* ================= 多选对齐 / 分布 ================= */
function openAlign() {
  const ids = renderer.selectedNodes();
  if (ids.length < 2) { toast('请先多选至少两台设备（Ctrl 点选 / Shift 框选）'); return; }
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  const acts = [
    ['left', '左对齐'], ['hcenter', '水平居中'], ['right', '右对齐'],
    ['top', '顶部对齐'], ['vcenter', '垂直居中'], ['bottom', '底部对齐'],
    ['hdist', '水平等距'], ['vdist', '垂直等距']
  ];
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:520px">
      <h3>对齐 / 分布（已选 ${ids.length} 台设备）</h3>
      <div class="m-sub">按当前相对位置对齐或等距分布，Ctrl+Z 可撤销</div>
      <div class="align-grid">
        ${acts.map(([k, lb]) => `<button type="button" class="tb" data-k="${k}">${lb}</button>`).join('')}
      </div>
      <div class="m-actions"><button type="button" class="tb" data-act="close">关闭</button></div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=close]').onclick = close;
  ov.querySelectorAll('.align-grid .tb').forEach(btn => {
    btn.onclick = () => {
      const nodes = state.nodes.filter(n => ids.has(n.id));
      pushUndo();
      U.alignNodes(nodes, btn.dataset.k);
      renderer.setData(state.nodes, state.links, state.texts);
      refreshAll(); saveGraph();
      toast('已执行「' + btn.textContent + '」');
      close();
    };
  });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

/* ================= 工程对比（diff） ================= */
function openProjectDiff() {
  if (!state.nodes.length) { toast('请先打开或导入一个拓扑作为对比基准'); return; }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.nettopo,.json';
  inp.onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const { buffer } = await U.readFile(f);
      const data = JSON.parse(U.decodeBytes(buffer));
      if (!data || data.app !== 'NetTopo' || !Array.isArray(data.nodes)) { toast('对比文件不是有效的 .nettopo 工程'); return; }
      const d = U.diffProjects({ nodes: state.nodes, links: state.links }, { nodes: data.nodes, links: data.links || [] });
      const row = (items) => items.length ? items.map(x => `<div class="tt-r">· ${U.escHtml(x)}</div>`).join('') : '<div class="tt-r" style="color:var(--muted)">无</div>';
      const chg = d.changedNodes.length ? d.changedNodes.map(c => `<div class="tt-r">· ${U.escHtml(c.name)}：${U.escHtml(c.from.mgmt || '-')} → ${U.escHtml(c.to.mgmt || '-')}</div>`).join('') : '<div class="tt-r" style="color:var(--muted)">无</div>';
      const root = $('#modalRoot');
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = `
        <div class="modal" role="dialog" style="width:560px">
          <h3>工程对比结果</h3>
          <div class="m-sub">当前工程 vs ${U.escHtml(f.name)}（${data.nodes.length} 设备 / ${(data.links||[]).length} 链路）</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;max-height:48vh;overflow:auto">
            <div><b style="color:var(--danger)">新增设备 ${d.addedNodes.length}</b>${row(d.addedNodes)}</div>
            <div><b style="color:var(--danger)">删除设备 ${d.removedNodes.length}</b>${row(d.removedNodes)}</div>
            <div><b>变更设备 ${d.changedNodes.length}</b>${chg}</div>
            <div><b style="color:var(--accent)">新增链路 ${d.addedLinks.length}</b>${row(d.addedLinks)}</div>
            <div><b style="color:var(--accent)">删除链路 ${d.removedLinks.length}</b>${row(d.removedLinks)}</div>
          </div>
          <div class="m-actions"><button type="button" class="tb primary" data-act="close">关闭</button></div>
        </div>`;
      root.appendChild(ov);
      ov.tabIndex = -1; ov.focus();
      const close = () => ov.remove();
      ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
      ov.querySelector('[data-act=close]').onclick = close;
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    } catch (err) { toast('对比文件解析失败：' + err.message); }
    e.target.value = '';
  };
  inp.click();
}

/* ================= 批量重命名 ================= */
function openRename() {
  const ids = renderer.selectedNodes();
  const nodes = ids.size ? state.nodes.filter(n => ids.has(n.id)) : state.nodes;
  if (!nodes.length) { toast('画布为空，请先添加设备'); return; }
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:520px">
      <h3>批量重命名（${nodes.length} 台设备）</h3>
      <div class="m-sub">${ids.size ? '对选中的设备' : '对全部设备'}统一加前缀/后缀，或按序号重命名；Ctrl+Z 可撤销</div>
      <div class="m-row"><label>方式</label>
        <select id="rnMode">
          <option value="keep">保留原名 + 前缀/后缀</option>
          <option value="number">按序号重命名</option>
        </select>
      </div>
      <div class="m-row"><label>前缀</label><input id="rnPrefix" type="text" placeholder="例如 接入-"/></div>
      <div class="m-row"><label>后缀</label><input id="rnSuffix" type="text" placeholder="例如 -主"/></div>
      <div class="m-row" id="rnNumRow" style="display:none">
        <label>起始序号</label><input id="rnStart" type="number" value="1" style="width:90px"/>
        <label>位数</label><input id="rnPad" type="number" value="2" style="width:70px"/>
      </div>
      <div class="m-sub" id="rnPrev"></div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="cancel">取消</button>
        <button type="button" class="tb primary" data-act="apply">应用</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  const prev = () => {
    const mode = ov.querySelector('#rnMode').value;
    const p = ov.querySelector('#rnPrefix').value, s = ov.querySelector('#rnSuffix').value;
    const start = Number(ov.querySelector('#rnStart').value || 1), pad = Number(ov.querySelector('#rnPad').value || 0);
    ov.querySelector('#rnNumRow').style.display = mode === 'number' ? '' : 'none';
    const sample = [...nodes].sort((a, b) => a.name.localeCompare(b.name, 'zh')).slice(0, 4);
    const names = [];
    sample.forEach((n, i) => {
      if (mode === 'number') names.push(p + String(start + i).padStart(pad, '0') + s);
      else names.push(p + n.name + s);
    });
    ov.querySelector('#rnPrev').textContent = '示例：' + names.join('、') + (nodes.length > 4 ? ' …' : '');
  };
  ['rnMode','rnPrefix','rnSuffix','rnStart','rnPad'].forEach(id2 => ov.querySelector('#'+id2).addEventListener('input', prev));
  ov.querySelector('#rnMode').addEventListener('change', prev);
  prev();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=cancel]').onclick = close;
  ov.querySelector('[data-act=apply]').onclick = () => {
    const mode = ov.querySelector('#rnMode').value;
    const prefix = ov.querySelector('#rnPrefix').value.trim();
    const suffix = ov.querySelector('#rnSuffix').value.trim();
    const start = Number(ov.querySelector('#rnStart').value || 1);
    const pad = Number(ov.querySelector('#rnPad').value || 0);
    pushUndo();
    U.renameNodes(nodes, { mode, prefix, suffix, start, pad });
    // 名称变化 → 宽度自适应（保持中心不变）
    for (const n of nodes) {
      const nw = U.nodeWidthForName(n.name);
      const dw = nw - n.w;
      if (dw) { n.w = nw; n.x -= dw / 2; }
    }
    close();
    renderer.setData(state.nodes, state.links, state.texts);
    refreshAll(); saveGraph();
    toast('已重命名 ' + nodes.length + ' 台设备');
  };
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

/* ================= 自动备份工程 ================= */
function openAutoBackup() {
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:460px">
      <h3>自动备份工程</h3>
      <div class="m-sub">按固定间隔自动备份工程（内容有变化时才备份，避免重复）${window.topoBackup ? '，备份保存在本机备份库，可在「备份管理」中浏览/恢复' : ''}</div>
      <div class="m-row"><label style="display:flex;align-items:center;gap:6px"><input id="abOn" type="checkbox" ${state.autoBackup.on ? 'checked' : ''}/> 启用自动备份</label></div>
      <div class="m-row"><label>间隔（分钟）</label><input id="abMin" type="number" min="1" max="120" value="${state.autoBackup.minutes}" style="width:90px"/></div>
      <div class="m-row"><label>保留最近份数</label><input id="abKeep" type="number" min="1" max="200" value="${Math.min(200, Math.max(1, state.autoBackup.keep))}" style="width:90px"/></div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="cancel">取消</button>
        <button type="button" class="tb primary" data-act="save">保存</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=cancel]').onclick = close;
  ov.querySelector('[data-act=save]').onclick = () => {
    state.autoBackup.on = ov.querySelector('#abOn').checked;
    state.autoBackup.minutes = Math.min(120, Math.max(1, Number(ov.querySelector('#abMin').value || 10)));
    state.autoBackup.keep = Math.min(200, Math.max(1, Number(ov.querySelector('#abKeep').value || 30) || 30));
    localStorage.setItem('nettopo.autoBackup', state.autoBackup.on ? '1' : '0');
    localStorage.setItem('nettopo.autoBackupMin', String(state.autoBackup.minutes));
    localStorage.setItem('nettopo.autoBackupKeep', String(state.autoBackup.keep));
    close();
    setupAutoBackup();
    toast(state.autoBackup.on ? '已启用自动备份（每 ' + state.autoBackup.minutes + ' 分钟，保留最近 ' + state.autoBackup.keep + ' 份）' : '已关闭自动备份');
  };
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}
function setupAutoBackup() {
  if (setupAutoBackup._timer) { clearInterval(setupAutoBackup._timer); setupAutoBackup._timer = null; }
  if (!state.autoBackup.on) return;
  setupAutoBackup._last = '';
  setupAutoBackup._timer = setInterval(() => {
    if (!state.nodes.length) return;
    const data = buildProjectData();
    const hash = JSON.stringify([state.nodes, state.links, state.texts, state.downLinks ? [...state.downLinks] : []]);
    if (hash === setupAutoBackup._last) return;
    setupAutoBackup._last = hash;
    if (window.topoBackup) {
      // 桌面版：写入本机备份库（备份管理可浏览/恢复）
      window.topoBackup.save({ content: JSON.stringify(data, null, 2), label: 'auto', keep: state.autoBackup.keep }).then((res) => {
        if (res && res.ok) toast('已自动备份工程（' + res.name + '，共 ' + res.count + ' 份）');
        else toast('自动备份失败：' + ((res && res.error) || '未知错误'));
      }).catch(() => {});
    } else {
      // 浏览器版：无本地文件能力，回退为下载
      U.download(`自动备份_${U.fmtDate()}.nettopo`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
      toast('已自动备份工程（' + U.fmtDate() + '）');
    }
  }, state.autoBackup.minutes * 60000);
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
  const buf = TopoVsdx.buildVSDX({ nodes: state.nodes, links: state.links, texts: state.texts }, { showLabels: state.showLabels });
  U.download(`网络拓扑图_${U.fmtDate()}.vsdx`,
    new Blob([buf], { type: 'application/vnd.ms-visio' }));
  toast('已导出 Visio 文件（.vsdx，Visio 2013+ 可直接打开编辑）');
}

function exportPdf() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  const svg = TopoPdf.buildSvgImage({ nodes: state.nodes, links: state.links, texts: state.texts }, { showLabels: state.showLabels });
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

/* ================= 导出图片（PNG / SVG / 剪贴板） ================= */
function renderTopologyPng(cb) {
  const svg = TopoPdf.buildSvgImage({ nodes: state.nodes, links: state.links, texts: state.texts }, { showLabels: state.showLabels });
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
    URL.revokeObjectURL(url);
    canvas.toBlob(cb, 'image/png');
  };
  img.onerror = () => { URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}

function exportImage(kind) {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  if (kind === 'svg') {
    const svg = TopoPdf.buildSvgImage({ nodes: state.nodes, links: state.links, texts: state.texts }, { showLabels: state.showLabels });
    U.download(`网络拓扑图_${U.fmtDate()}.svg`, new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    toast('已导出 SVG 矢量图');
    return;
  }
  renderTopologyPng((b) => {
    if (!b) { toast('PNG 导出失败'); return; }
    U.download(`网络拓扑图_${U.fmtDate()}.png`, b);
    toast('已导出 PNG 高清图片（2 倍像素）');
  });
}

function copyImageToClipboard() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  if (!navigator.clipboard || !window.ClipboardItem || !navigator.clipboard.write) {
    toast('当前环境不支持剪贴板图片，请用「导出图片」');
    return;
  }
  renderTopologyPng((blob) => {
    if (!blob) { toast('生成图片失败'); return; }
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      .then(() => toast('已复制拓扑图片到剪贴板，可直接粘贴'))
      .catch(() => toast('复制失败：浏览器未授予剪贴板权限，请用「导出图片」'));
  });
}

function openImageExport() {
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:420px">
      <h3>导出图片</h3>
      <div class="m-sub">图例、设备样式与画布一致；PNG 为 2 倍像素高清图，SVG 可无限缩放</div>
      <div class="img-export-actions">
        <button type="button" class="tb big" data-act="png"><i class="ic" data-ic="image"></i><span>PNG 高清图片</span></button>
        <button type="button" class="tb big" data-act="svg"><i class="ic" data-ic="image"></i><span>SVG 矢量图</span></button>
      </div>
      <div class="m-actions"><button type="button" class="tb" data-act="cancel">取消</button></div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=cancel]').addEventListener('click', close);
  ov.querySelector('[data-act=png]').addEventListener('click', () => { close(); exportImage('png'); });
  ov.querySelector('[data-act=svg]').addEventListener('click', () => { close(); exportImage('svg'); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

/* ================= 工程文件（.nettopo 保存/打开） ================= */
/** 构建工程数据对象（保存工程 / 自动备份 / 立即备份共用） */
function buildProjectData() {
  return {
    app: 'NetTopo',
    version: 1,
    savedAt: new Date().toISOString(),
    nodes: state.nodes,
    links: state.links,
    texts: state.texts,
    pan: renderer.pan,
    zoom: renderer.zoom,
    customTypes: U.customTypes,
    typeOverrides: U.typeOverrides,
    showLabels: state.showLabels,
    showSubnets: state.showSubnets,
    subnetNames: state.subnetNames,
    downLinks: [...state.downLinks]
  };
}

function saveProject() {
  const data = buildProjectData();
  U.download(`网络拓扑工程_${U.fmtDate()}.nettopo`,
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
  toast('已保存工程文件（.nettopo，含位置与自定义类型）');
}

/** 解析并应用工程数据（打开工程 / 恢复备份共用） */
function applyProjectData(data) {
  if (!data || data.app !== 'NetTopo' || !Array.isArray(data.nodes)) {
    toast('工程文件格式不正确'); return false;
  }
  if (Array.isArray(data.customTypes) || (data.typeOverrides && typeof data.typeOverrides === 'object')) {
    // 清洗非法颜色/图片，防止恶意工程注入 HTML/SVG
    const cleaned = U.sanitizeTypeData(data.typeOverrides, data.customTypes);
    if (Array.isArray(data.customTypes)) { U.customTypes = cleaned.customTypes; U.saveCustomTypes(); }
    if (data.typeOverrides && typeof data.typeOverrides === 'object') { U.typeOverrides = cleaned.overrides; U.saveTypeOverrides(); }
  }
  const cleaned = U.sanitizeGraph(data.nodes, data.links, data.texts);
  state.nodes = cleaned.nodes;
  state.links = cleaned.links;
  state.texts = cleaned.texts;
  state.sel = { kind: null, id: null };
  state.undoStack = [];
  state.redoStack = [];
  if (typeof data.showLabels === 'boolean') state.showLabels = data.showLabels;
  if (typeof data.showSubnets === 'boolean') state.showSubnets = data.showSubnets;
  if (data.subnetNames && typeof data.subnetNames === 'object') state.subnetNames = data.subnetNames;
  state.downLinks = new Set(Array.isArray(data.downLinks) ? data.downLinks : []);
  renderer.showLabels = state.showLabels;
  renderer.showSubnets = state.showSubnets;
  renderer.subnetNames = state.subnetNames;
  renderer.setDownLinks(state.downLinks);
  U.seedCounters(state.nodes, state.links, state.texts);
  updateUndoBtns();
  renderer.setData(state.nodes, state.links, state.texts);
  if (data.pan && data.zoom) renderer.setView(data.pan, data.zoom);
  else renderer.fit();
  refreshAll();
  saveGraph();
  return true;
}

async function loadProject(file) {
  const { buffer } = await U.readFile(file);
  let data;
  try {
    data = JSON.parse(U.decodeBytes(buffer));
  } catch (e) {
    toast('工程文件解析失败：不是有效的 .nettopo 文件'); return;
  }
  if (!data || data.app !== 'NetTopo' || !Array.isArray(data.nodes)) {
    toast('工程文件格式不正确'); return;
  }
  if (state.nodes.length && !(await confirmBox('打开工程将替换当前拓扑，是否继续？'))) return;
  if (applyProjectData(data)) toast(`已打开工程：${state.nodes.length} 台设备、${state.links.length} 条链路`);
}

/* ================= 备份管理（桌面版本地备份库） ================= */
const BACKUP_ICON_HTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="8.5" width="17" height="10" rx="1.8"/><path d="M3.5 8.5v-3h17v3M9 12h6"/></svg>';

function fmtBackupTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtBackupSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/** 立即备份当前工程（桌面版写入备份库，浏览器版回退为下载） */
function backupNow() {
  if (!state.nodes.length) { toast('画布为空，无需备份'); return; }
  const data = buildProjectData();
  if (window.topoBackup) {
    window.topoBackup.save({ content: JSON.stringify(data, null, 2), label: 'manual', keep: state.autoBackup.keep }).then((res) => {
      if (res && res.ok) toast('已备份工程（' + res.name + '，共 ' + res.count + ' 份）');
      else toast('备份失败：' + ((res && res.error) || '未知错误'));
    }).catch(() => toast('备份失败'));
  } else {
    U.download(`网络拓扑备份_${U.fmtDate()}.nettopo`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
    toast('浏览器版不支持备份库，已下载备份文件');
  }
}

/** 备份管理弹窗：浏览 / 恢复 / 删除 / 立即备份 / 清空 */
function openBackupManager() {
  if (!window.topoBackup) {
    openModal({
      title: '备份管理',
      sub: '备份管理为桌面版专属功能：自动/手动备份集中保存在本机备份库，可浏览、恢复与清理。浏览器版仍可通过下载保存备份文件。',
      submit: '知道了',
      onSubmit: () => {}
    });
    return;
  }
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:620px">
      <h3>备份管理</h3>
      <div class="m-sub" id="bkSub">正在读取备份列表…</div>
      <div class="v-list" id="bkList" style="max-height:52vh"></div>
      <div class="m-actions">
        <button type="button" class="tb danger" data-act="clear">清空全部</button>
        <span style="flex:1"></span>
        <button type="button" class="tb" data-act="folder"><i class="ic" data-ic="folder"></i>打开备份文件夹</button>
        <button type="button" class="tb" data-act="now"><i class="ic" data-ic="save"></i>立即备份</button>
        <button type="button" class="tb" data-act="close">关闭</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  const listEl = ov.querySelector('#bkList');
  const subEl = ov.querySelector('#bkSub');
  const busy = new Set(); // 防止重复点击

  async function refreshList() {
    let res;
    try { res = await window.topoBackup.list(); } catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
    if (!ov.isConnected) return;
    if (!res || !res.ok) { subEl.textContent = (res && res.error) || '读取备份列表失败'; listEl.innerHTML = ''; return; }
    const items = res.items || [];
    subEl.textContent = `共 ${items.length} 份备份 · 保留最近 ${Math.min(200, Math.max(1, state.autoBackup.keep || 30))} 份 · 内容有变化的自动备份按间隔写入`;
    if (!items.length) {
      listEl.innerHTML = '<div class="vrow ok"><span class="v-ic">✓</span><span class="v-msg">暂无备份，点击「立即备份」创建第一份。</span></div>';
      return;
    }
    listEl.innerHTML = items.map((it) => `
      <div class="vrow" data-name="${U.escHtml(it.name)}">
        <span class="v-ic" style="background:var(--accent)">${BACKUP_ICON_HTML}</span>
        <span class="v-msg">
          <b style="color:var(--text)">${U.escHtml(it.name)}</b><br>
          <span style="color:var(--muted)">${fmtBackupTime(it.time)} · ${fmtBackupSize(it.size)}</span>
        </span>
        <button type="button" class="tb" data-act="restore" title="恢复该备份（替换当前拓扑）">恢复</button>
        <button type="button" class="tb icon danger" data-act="del" title="删除该备份">
          <i class="ic" data-ic="trash"></i>
        </button>
      </div>`).join('');
    U.fillIcons();
  }

  listEl.addEventListener('click', async (e) => {
    const row = e.target.closest('.vrow');
    const btn = e.target.closest('button[data-act]');
    if (!row || !btn) return;
    const name = row.dataset.name;
    const act = btn.dataset.act;
    if (busy.has(name + act)) return;
    if (act === 'del') {
      if (!(await confirmBox(`删除备份「${name}」？此操作不可撤销。`))) return;
      busy.add(name + act);
      let res;
      try { res = await window.topoBackup.remove(name); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
      busy.delete(name + act);
      if (res && res.ok) toast('已删除备份');
      else toast('删除失败：' + ((res && res.error) || '未知错误'));
      refreshList();
    } else if (act === 'restore') {
      if (state.nodes.length && !(await confirmBox(`恢复备份「${name}」将替换当前拓扑，是否继续？`))) return;
      busy.add(name + act);
      let res;
      try { res = await window.topoBackup.read(name); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
      busy.delete(name + act);
      if (!res || !res.ok) { toast('恢复失败：' + ((res && res.error) || '未知错误')); return; }
      let data;
      try { data = JSON.parse(res.content); } catch (e) { toast('备份内容解析失败'); return; }
      if (!data || data.app !== 'NetTopo' || !Array.isArray(data.nodes)) { toast('备份文件格式不正确'); return; }
      close();
      if (applyProjectData(data)) toast(`已恢复备份：${state.nodes.length} 台设备、${state.links.length} 条链路`);
    }
  });

  ov.querySelector('[data-act=close]').onclick = close;
  ov.querySelector('[data-act=folder]').onclick = () => {
    window.topoBackup.openFolder().then((res) => { if (res && !res.ok) toast('打开文件夹失败：' + (res.error || '')); }).catch(() => {});
  };
  ov.querySelector('[data-act=now]').onclick = async () => {
    if (!state.nodes.length) { toast('画布为空，无需备份'); return; }
    const data = buildProjectData();
    let res;
    try { res = await window.topoBackup.save({ content: JSON.stringify(data, null, 2), label: 'manual', keep: state.autoBackup.keep }); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    if (res && res.ok) toast('已备份工程（' + res.name + '）');
    else toast('备份失败：' + ((res && res.error) || '未知错误'));
    refreshList();
  };
  ov.querySelector('[data-act=clear]').onclick = async () => {
    if (!(await confirmBox('清空全部备份？此操作不可撤销。'))) return;
    let res;
    try { res = await window.topoBackup.removeAll(); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    if (res && res.ok) toast('已清空 ' + (res.removed || 0) + ' 份备份');
    else toast('清空失败：' + ((res && res.error) || '未知错误'));
    refreshList();
  };

  refreshList();
}

/* ================= 拓扑校验报告 ================= */
function runValidation() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  const issues = M.validateTopology(state.nodes, state.links);
  const errs = issues.filter(i => i.level === 'error').length;
  const warns = issues.filter(i => i.level === 'warning').length;
  const infos = issues.filter(i => i.level === 'info').length;
  const cls = { error: 'err', warning: 'warn', info: 'info' };
  const icon = { error: '✕', warning: '!', info: 'i' };
  const rows = issues.length ? issues.map((it, idx) => `
    <div class="vrow ${cls[it.level]}" data-idx="${idx}">
      <span class="v-ic">${icon[it.level]}</span>
      <span class="v-msg">${U.escHtml(it.msg)}</span>
      <button type="button" class="tb icon" data-act="locate" title="定位到画布">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/></svg>
      </button>
    </div>`).join('') : '<div class="vrow ok"><span class="v-ic">✓</span><span class="v-msg">未发现问题，拓扑健康。</span></div>';
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:600px">
      <h3>拓扑校验报告</h3>
      <div class="m-sub">${errs} 个错误 · ${warns} 个警告 · ${infos} 条提示</div>
      <div class="v-list">${rows}</div>
      <div class="m-actions"><button type="button" class="tb" data-act="close">关闭</button></div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=close]').addEventListener('click', close);
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  ov.querySelectorAll('[data-act=locate]').forEach(btn => {
    btn.addEventListener('click', () => {
      const it = issues[+btn.closest('.vrow').dataset.idx];
      close();
      locateIssue(it);
    });
  });
}

function locateIssue(issue) {
  const nid = (issue.nodeIds || []).find(id => state.nodes.some(n => n.id === id));
  const lid = (issue.linkIds || []).find(id => state.links.some(l => l.id === id));
  if (nid) select('node', nid, { center: true });
  else if (lid) select('link', lid, { center: true });
  else toast(issue.msg);
}

/* ================= 新建 ================= */
async function newGraph() {
  if (state.nodes.length && !(await confirmBox('新建将清空当前拓扑，是否继续？'))) return;
  layoutCancel = true;
  setMode('normal');
  state.nodes = [];
  state.links = [];
  state.texts = []; // 空白画布不保留旧文本框
  state.sel = { kind: null, id: null };
  state.undoStack = [];
  state.redoStack = [];
  state.blank = true; // 空白画布：无表格也可直接添加设备/连线
  updateUndoBtns();
  renderer.setData(state.nodes, state.links, state.texts);
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
      { name: 'mgmts', label: '管理地址', type: 'mgmts', value: [] },
      { name: 'web', label: '管理Web页URL', ph: '例如 http://10.255.0.1（可选）' },
      { name: 'note', label: '备注', type: 'textarea' }
    ],
    submit: '创建',
    onSubmit: (v) => {
      pushUndo(); // 变更前快照
      const ms = Array.isArray(v.mgmts) ? v.mgmts : [];
      const node = {
        id: U.uid('n'), name: v.name.trim(),
        type: v.type || U.typeOf(v.name),
        x: wx - U.nodeWidthForName(v.name) / 2, y: wy - U.NODE_H / 2,
        w: U.nodeWidthForName(v.name), h: U.NODE_H,
        note: v.note.trim(), mgmt: ms[0] || '', mgmts: ms.slice(1), web: v.web.trim()
      };
      node.h = U.nodeHeightFor(node);
      node.y = wy - node.h / 2;
      state.nodes.push(node);
      renderer.setData(state.nodes, state.links, state.texts);
      refreshAll();
      select('node', node.id, { center: true });
    }
  });
}

const TEXT_FONTS = ['Microsoft YaHei', 'SimSun', 'SimHei', 'DengXian', 'KaiTi', 'Arial', 'Consolas', 'Georgia', 'Times New Roman'];

/* ================= 文本框（自定义字体样式） ================= */
function addTextAt(wx, wy) {
  const t = {
    id: U.uid('t'),
    x: wx, y: wy,
    w: 220, h: 56,
    text: '双击编辑文字',
    font: 'Microsoft YaHei', size: 16, color: '#1e293b',
    bold: false, italic: false, align: 'left', bg: ''
  };
  pushUndo();
  state.texts.push(t);
  renderer.setData(state.nodes, state.links, state.texts);
  refreshAll(); saveGraph();
  select('text', t.id);
  editText(t.id);
}
function editText(id) {
  const t = state.texts.find(x => x.id === id);
  if (!t) return;
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:540px">
      <h3>编辑文本框</h3>
      <div class="m-sub">支持多行文字与字体样式；保存后自动按内容调整框大小，Ctrl+Z 可撤销</div>
      <div class="m-row" style="align-items:flex-start"><label>内容</label><textarea id="txText" style="height:90px">${U.escHtml(t.text || '')}</textarea></div>
      <div class="m-row"><label>字体</label><select id="txFont">${TEXT_FONTS.map(f => `<option value="${f}" ${t.font === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
        <label style="margin-left:16px">字号</label><input id="txSize" type="number" min="10" max="72" value="${t.size || 16}" style="width:70px"/></div>
      <div class="m-row"><label>颜色</label><input id="txColor" type="color" value="${t.color || '#1e293b'}"/>
        <label style="margin-left:16px;display:flex;align-items:center;gap:5px"><input id="txBold" type="checkbox" ${t.bold ? 'checked' : ''}/> 粗体</label>
        <label style="display:flex;align-items:center;gap:5px"><input id="txItalic" type="checkbox" ${t.italic ? 'checked' : ''}/> 斜体</label></div>
      <div class="m-row"><label>对齐</label>
        <select id="txAlign"><option value="left" ${t.align === 'left' ? 'selected' : ''}>左对齐</option><option value="center" ${t.align === 'center' ? 'selected' : ''}>居中</option><option value="right" ${t.align === 'right' ? 'selected' : ''}>右对齐</option></select>
        <label style="margin-left:16px;display:flex;align-items:center;gap:5px"><input id="txBgOn" type="checkbox" ${t.bg ? 'checked' : ''}/> 背景色</label>
        <input id="txBg" type="color" value="${t.bg || '#ffffff'}" ${t.bg ? '' : 'disabled'}/></div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="cancel">取消</button>
        <button type="button" class="tb primary" data-act="save">保存</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.querySelector('#txBgOn').addEventListener('change', (e) => { ov.querySelector('#txBg').disabled = !e.target.checked; });
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=cancel]').onclick = close;
  ov.querySelector('[data-act=save]').onclick = () => {
    const text = ov.querySelector('#txText').value;
    if (!text.trim()) { toast('内容不能为空'); return; }
    pushUndo();
    t.text = text;
    t.font = ov.querySelector('#txFont').value;
    t.size = Math.max(10, Number(ov.querySelector('#txSize').value || 16));
    t.color = ov.querySelector('#txColor').value;
    t.bold = ov.querySelector('#txBold').checked;
    t.italic = ov.querySelector('#txItalic').checked;
    t.align = ov.querySelector('#txAlign').value;
    t.bg = ov.querySelector('#txBgOn').checked ? ov.querySelector('#txBg').value : '';
    const lines = text.split('\n');
    const maxLine = lines.reduce((a, b) => a.length > b.length ? a : b, '');
    t.w = Math.max(120, U.measureText(maxLine, t.size) + 24);
    t.h = Math.max(40, lines.length * t.size * 1.25 + 16);
    close();
    renderer.setData(state.nodes, state.links, state.texts);
    refreshAll(); saveGraph();
    select('text', t.id);
  };
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}
function deleteText(id) {
  const t = state.texts.find(x => x.id === id);
  if (!t) return;
  pushUndo();
  state.texts = state.texts.filter(x => x.id !== id);
  renderer.setData(state.nodes, state.links, state.texts);
  refreshAll(); saveGraph();
  select(null, null);
  toast('已删除文本框');
}

function editNode(id) {
  const n = state.nodes.find(n => n.id === id);
  if (!n) return;
  openModal({
    title: '编辑设备',
    fields: [
      { name: 'name', label: '设备名称', required: true, value: n.name },
      { name: 'type', label: '设备类型', type: 'select', options: U.typeList().map(t => [t.key, t.label]), value: n.type },
      { name: 'mgmts', label: '管理地址', type: 'mgmts', value: U.nodeMgmts(n) },
      { name: 'web', label: '管理Web页URL', value: n.web || '', ph: '例如 http://10.255.0.1（可选）' },
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
      U.setNodeMgmts(n, v.mgmts);
      const nh = U.nodeHeightFor(n);
      if (nh !== n.h) { const dh = nh - n.h; n.h = nh; n.y -= dh / 2; }
      n.type = v.type;
      n.web = v.web.trim();
      n.note = v.note.trim();
      renderer.setData(state.nodes, state.links, state.texts);
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
  renderer.setData(state.nodes, state.links, state.texts);
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
      { name: 'bw', label: '带宽 (Mbps)', ph: '例如 1000（百兆=100 / 千兆=1000 / 万兆=10000）' },
      { name: 'note', label: '备注', type: 'textarea' }
    ],
    submit: '创建',
    onSubmit: (v) => {
      pushUndo(); // 变更前快照
      state.links.push({
        id: U.uid('l'), a: aId, b: bId,
        aIf: v.aIf.trim(), aIp: v.aIp.trim(),
        bIf: v.bIf.trim(), bIp: v.bIp.trim(),
        bw: U.normalizeBw(v.bw), note: v.note.trim()
      });
      renderer.setData(state.nodes, state.links, state.texts);
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
      { name: 'bw', label: '带宽 (Mbps)', value: U.normalizeBw(l.bw), ph: '例如 1000（百兆=100 / 千兆=1000 / 万兆=10000）' },
      { name: 'note', label: '备注', type: 'textarea', value: l.note }
    ],
    submit: '保存',
    onSubmit: (v) => {
      pushUndo(); // 变更前快照
      l.aIf = v.aIf.trim(); l.aIp = v.aIp.trim();
      l.bIf = v.bIf.trim(); l.bIp = v.bIp.trim();
      l.bw = U.normalizeBw(v.bw); l.note = v.note.trim();
      renderer.setData(state.nodes, state.links, state.texts);
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
  renderer.setData(state.nodes, state.links, state.texts);
  refreshAll();
  select(null, null);
}

function deleteSelection() {
  const { kind, id } = state.sel;
  if (kind === 'node' && renderer.selIds.size > 1) {
    deleteNodes(renderer.selectedNodes());
    return;
  }
  if (kind === 'link' && renderer.selLinkIds.size > 1) {
    deleteLinks(renderer.selectedLinks());
    return;
  }
  if (!id) return;
  if (kind === 'node') deleteNode(id);
  else if (kind === 'link') deleteLink(id);
  else if (kind === 'text') deleteText(id);
}

function deleteNodes(ids) {
  const set = new Set(ids);
  const names = state.nodes.filter(n => set.has(n.id)).map(n => n.name);
  const removedLinks = state.links.filter(l => set.has(l.a) || set.has(l.b)).length;
  pushUndo();
  state.links = state.links.filter(l => !set.has(l.a) && !set.has(l.b));
  state.nodes = state.nodes.filter(n => !set.has(n.id));
  renderer.setData(state.nodes, state.links, state.texts);
  refreshAll();
  select(null, null);
  toast(`已删除 ${names.length} 台设备及 ${removedLinks} 条连线`);
}

function batchEditNodes() {
  const ids = renderer.selectedNodes();
  if (!ids.length) return;
  openModal({
    title: `批量编辑（${ids.length} 台设备）`,
    sub: '留空的字段保持原值不变',
    fields: [
      { name: 'type', label: '设备类型', type: 'select', options: [['', '（保持不变）']].concat(U.typeList().map(t => [t.key, t.label])) },
      { name: 'mgmts', label: '管理地址', type: 'mgmts', value: [] },
      { name: 'web', label: '管理Web页URL', ph: '留空不修改' },
      { name: 'note', label: '备注', type: 'textarea', ph: '留空不修改' }
    ],
    submit: '应用',
    onSubmit: (v) => {
      pushUndo();
      const ms = Array.isArray(v.mgmts) ? v.mgmts : [];
      for (const id of ids) {
        const n = state.nodes.find(x => x.id === id);
        if (!n) continue;
        if (v.type) n.type = v.type;
        if (ms.length) U.setNodeMgmts(n, ms);
        if (String(v.web).trim()) n.web = String(v.web).trim();
        if (String(v.note).trim()) n.note = String(v.note).trim();
        const nh = U.nodeHeightFor(n);
        if (nh !== n.h) { const dh = nh - n.h; n.h = nh; n.y -= dh / 2; }
      }
      renderer.setData(state.nodes, state.links, state.texts);
      refreshAll();
      // 保留多选，便于继续操作
      renderer.selIds = new Set(ids);
      renderer.sel = { kind: 'node', id: ids[ids.length - 1] };
      renderer._syncSelClass();
      state.sel = { kind: 'node', id: ids[ids.length - 1] };
      renderSelCard();
      toast(`已批量更新 ${ids.length} 台设备`);
    }
  });
}

function deleteLinks(ids) {
  const set = new Set(ids);
  const removed = state.links.filter(l => set.has(l.id));
  pushUndo();
  state.links = state.links.filter(l => !set.has(l.id));
  renderer.setData(state.nodes, state.links, state.texts);
  refreshAll();
  select(null, null);
  toast(`已删除 ${removed.length} 条连线`);
}

function batchEditLinks() {
  const ids = renderer.selectedLinks();
  if (!ids.length) return;
  openModal({
    title: `批量编辑连线（${ids.length} 条）`,
    sub: '留空的字段保持原值不变',
    fields: [
      { name: 'bw', label: '带宽 (Mbps)', ph: '留空不修改，例如 1000 / 10000' },
      { name: 'note', label: '备注', type: 'textarea', ph: '留空不修改' }
    ],
    submit: '应用',
    onSubmit: (v) => {
      pushUndo();
      for (const id of ids) {
        const l = state.links.find(x => x.id === id);
        if (!l) continue;
        if (String(v.bw).trim()) l.bw = U.normalizeBw(v.bw);
        if (String(v.note).trim()) l.note = String(v.note).trim();
      }
      renderer.setData(state.nodes, state.links, state.texts);
      refreshAll();
      // 保留多选
      renderer.selLinkIds = new Set(ids);
      renderer.sel = { kind: 'link', id: ids[ids.length - 1] };
      renderer._syncSelClass();
      state.sel = { kind: 'link', id: ids[ids.length - 1] };
      renderSelCard();
      toast(`已批量更新 ${ids.length} 条连线`);
    }
  });
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
  const dEdit = $('#btnDropEdit');
  if (dEdit) dEdit.classList.toggle('mode-on', mode === 'link' || mode === 'place');
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

/* ================= 显示开关 ================= */
function toggleLabels() {
  state.showLabels = !state.showLabels;
  renderer.setShowLabels(state.showLabels);
  localStorage.setItem('nettopo.showLabels', state.showLabels ? '1' : '0');
  saveGraph();
  toast(state.showLabels ? '已显示链路标注' : '已隐藏链路标注');
}
function toggleSubnets() {
  state.showSubnets = !state.showSubnets;
  renderer.setSubnetView(state.showSubnets, state.subnetNames);
  localStorage.setItem('nettopo.showSubnets', state.showSubnets ? '1' : '0');
  saveGraph();
  updateLegend();
  toast(state.showSubnets ? '已显示子网分组' : '已隐藏子网分组');
}

/* ================= 链路故障模拟 ================= */
function toggleLinkDown(id) {
  if (state.downLinks.has(id)) state.downLinks.delete(id); else state.downLinks.add(id);
  renderer.setDownLinks(state.downLinks);
  saveGraph();
  updateLegend();
  const down = state.downLinks.has(id);
  toast(down ? '已标记链路故障（红色虚线，路径分析将绕行）' : '已恢复链路');
}
function clearDownLinks() {
  if (!state.downLinks.size) { toast('当前没有故障标记'); return; }
  state.downLinks.clear();
  renderer.setDownLinks(state.downLinks);
  saveGraph();
  updateLegend();
  toast('已清除全部故障标记');
}
function clearPathHl() {
  if (!renderer.pathHl) { toast('当前没有路径高亮'); return; }
  renderer.clearPath();
  toast('已清除路径高亮');
}

/* ================= 弹窗 ================= */

/* ================= 工具栏下拉菜单 ================= */
function openDrop(anchor, items) {
  const drop = $('#drop');
  drop._anchor = anchor;
  drop.innerHTML = items.map(it => {
    if (it.sep) return '<div class="d-sep"></div>';
    const active = it.active ? ' mode-on' : '';
    return `<button class="ci${it.danger ? ' danger' : ''}${active}" data-k="${it.key || ''}"><i class="ic" data-ic="${it.ic}"></i>${U.escHtml(it.label)}</button>`;
  }).join('');
  U.fillIcons();
  drop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const mw = drop.offsetWidth, mh = drop.offsetHeight;
  drop.style.left = Math.max(4, Math.min(r.left, innerWidth - mw - 4)) + 'px';
  drop.style.top = (r.bottom + 4) + 'px';
  if (r.bottom + 4 + mh > innerHeight - 4) drop.style.top = Math.max(4, r.top - mh - 4) + 'px';
  let bi = 0;
  for (const it of items) {
    if (it.sep || it.head) continue;
    const b = drop.querySelectorAll('.ci')[bi++];
    b.onclick = () => { closeDrop(); it.act && it.act(); };
  }
  anchor.classList.add('mode-on');
}
function closeDrop() {
  const drop = $('#drop');
  if (!drop.classList.contains('hidden')) {
    drop.classList.add('hidden');
    if (drop._anchor) drop._anchor.classList.remove('mode-on');
    drop._anchor = null;
  }
}

function openModal(opts) {
  closeDrop();
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
    } else if (f.type === 'mgmts') {
      const vals = Array.isArray(f.value) ? f.value : [];
      const rows = (vals.length ? vals : ['']).map(v =>
        `<div class="mgmt-row"><input type="text" value="${U.escHtml(v)}" placeholder="例如 10.255.0.1（第一个为默认）"/><button type="button" class="tb icon mgmt-del" title="删除该管理口">✕</button></div>`).join('');
      ctrl = `<div class="mgmt-list" data-field="${f.name}">${rows}<button type="button" class="tb mgmt-add" title="再增加一个管理口">＋ 增加管理口</button></div>`;
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
  try { window.focus(); } catch (e) {} // 确保窗口有键盘焦点（原生 confirm/对话框后可能失焦）

  const close = () => ov.remove();
  const form = ov.querySelector('form');
  // 管理口列表：增加 / 删除行
  U.$$('.mgmt-list', form).forEach(list => {
    const addRow = () => {
      const d = document.createElement('div');
      d.className = 'mgmt-row';
      d.innerHTML = '<input type="text" placeholder="例如 10.255.0.1（第一个为默认）"/><button type="button" class="tb icon mgmt-del" title="删除该管理口">✕</button>';
      d.querySelector('.mgmt-del').onclick = () => d.remove();
      list.insertBefore(d, list.querySelector('.mgmt-add'));
      d.querySelector('input').focus();
    };
    list.querySelector('.mgmt-add').onclick = addRow;
    list.querySelectorAll('.mgmt-del').forEach(b => { b.onclick = () => b.closest('.mgmt-row').remove(); });
  });
  const grab = () => {
    const o = {};
    fields.forEach(f => {
      if (f.type === 'mgmts') {
        const list = form.querySelector('.mgmt-list[data-field="' + f.name + '"]');
        o[f.name] = list ? [...list.querySelectorAll('.mgmt-row input')].map(i => i.value.trim()).filter(Boolean) : [];
        return;
      }
      const el2 = form.elements[f.name];
      if (el2) o[f.name] = el2.value;
    });
    return o;
  };
  const submit = () => {
    const v = grab();
    for (const f of fields) {
      if (f.required && f.type !== 'mgmts' && !String(v[f.name]).trim()) {
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
  // 弹窗动画（rise .2s）完成后再聚焦，避免个别环境下动画期间聚焦被重置
  if (first) setTimeout(() => { if (document.body.contains(ov)) first.focus(); }, 250);
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

/* ================= 应用内确认框（替代原生 confirm，避免 Electron 原生对话框后的焦点问题） ================= */
function confirmBox(message) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal" role="dialog" style="width:380px">
        <h3>请确认</h3>
        <div class="m-sub">${U.escHtml(message)}</div>
        <div class="m-actions">
          <button type="button" class="tb" data-act="no">取消</button>
          <button type="button" class="tb primary" data-act="yes">确定</button>
        </div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = (val) => { ov.remove(); resolve(val); };
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(false); });
    ov.querySelector('[data-act=no]').onclick = () => close(false);
    ov.querySelector('[data-act=yes]').onclick = () => close(true);
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } });
  });
}

/* ================= 右键菜单 ================= */
function openCtx(e, kind, id) {
  closeDrop();
  const menu = $('#ctx');
  let items = [];
  if (kind === 'node') {
    const n = state.nodes.find(x => x.id === id);
    items = [
      { ic: 'edit', label: '编辑设备…', act: () => editNode(id) },
      { ic: 'locate', label: '定位到视图', act: () => { select('node', id); centerOn('node', id); } },
      { ic: 'terminal', label: 'Web Shell（SSH/Telnet）…', act: () => openWebShell(id) },
      { ic: 'web', label: '打开设备管理页面', act: () => openDeviceWeb(id) },
      { sep: true },
      { ic: 'trash', label: '删除设备及连线', danger: true, act: () => deleteNode(id) }
    ];
    if (n) items.unshift({ head: `${n.name}（${U.getType(n.type).label}）` });
  } else if (kind === 'link') {
    const l = state.links.find(x => x.id === id);
    const na = l ? state.nodes.find(n => n.id === l.a) : null;
    const nb = l ? state.nodes.find(n => n.id === l.b) : null;
    const isDown = state.downLinks.has(id);
    items = [
      { ic: 'edit', label: '编辑连线…', act: () => editLink(id) },
      { ic: isDown ? 'undo' : 'shield', label: isDown ? '恢复链路（解除故障）' : '标记链路故障（模拟断链）', act: () => toggleLinkDown(id) },
      { sep: true },
      { ic: 'trash', label: '删除连线', danger: true, act: () => deleteLink(id) }
    ];
    if (na && nb) items.unshift({ head: `${na.name} ⇄ ${nb.name}${isDown ? '（故障）' : ''}` });
  } else if (kind === 'text') {
    const t = state.texts.find(x => x.id === id);
    items = [
      { ic: 'edit', label: '编辑文本框…', act: () => editText(id) },
      { sep: true },
      { ic: 'trash', label: '删除文本框', danger: true, act: () => deleteText(id) }
    ];
    if (t) items.unshift({ head: (t.text || '').split('\n')[0].slice(0, 20) || '文本框' });
  } else {
    items = [
      { ic: 'node', label: '在此添加设备', act: () => { const w = renderer.toWorld(e.clientX, e.clientY); setMode('normal'); addNodeAt(w.x, w.y); } },
      { ic: 'edit', label: '在此添加文本框', act: () => { const w = renderer.toWorld(e.clientX, e.clientY); setMode('normal'); addTextAt(w.x, w.y); } },
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
      ${U.nodeMgmts(n).length ? `<div class="tt-r">管理地址：${U.escHtml(U.nodeMgmts(n).join('、'))}</div>` : ''}
      ${n.web ? `<div class="tt-r">管理Web页：${U.escHtml(n.web)}</div>` : ''}
      ${n.note ? `<div class="tt-r">备注：${U.escHtml(n.note)}</div>` : ''}`;
    posTooltip(e, html);
  } else if (kind === 'link') {
    const l = state.links.find(x => x.id === id);
    if (!l) return;
    const na = state.nodes.find(n => n.id === l.a), nb = state.nodes.find(n => n.id === l.b);
    const row = (ifn, ip) => `<div class="tt-r">${U.escHtml(ifn || '—')} ${U.escHtml(ip || '')}</div>`;
    const html = `<div class="tt-t">${U.escHtml(na ? na.name : '?')} ⇄ ${U.escHtml(nb ? nb.name : '?')}</div>
      ${row(l.aIf, l.aIp)}${row(l.bIf, l.bIp)}
      ${l.bw ? `<div class="tt-r">带宽：${U.escHtml(U.formatBw(l.bw))}</div>` : ''}
      ${l.note ? `<div class="tt-r">备注：${U.escHtml(l.note)}</div>` : ''}
      ${state.downLinks.has(l.id) ? '<div class="tt-r" style="color:var(--danger)">故障：已标记断链（路径分析将绕行）</div>' : ''}`;
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
  if (kind === 'node' && renderer.selIds.size > 1) {
    const ids = renderer.selectedNodes();
    card.classList.remove('hidden');
    card.innerHTML = `
      <div class="sc-head"><span class="sc-type">多选</span><span class="sc-title">已选 ${ids.length} 台设备</span></div>
      <div class="sc-row">拖动任意一台可整体移动；Delete 删除选中</div>
      <div class="sc-actions">
        <button class="tb" data-act="batch">批量编辑</button>
        <button class="tb danger" data-act="del">删除</button>
        <button class="tb" data-act="clear">取消选择</button>
      </div>`;
    card.querySelector('[data-act=batch]').onclick = () => batchEditNodes();
    card.querySelector('[data-act=del]').onclick = () => deleteSelection();
    card.querySelector('[data-act=clear]').onclick = () => select(null, null);
    return;
  }
  if (kind === 'link' && renderer.selLinkIds.size > 1) {
    const ids = renderer.selectedLinks();
    card.classList.remove('hidden');
    card.innerHTML = `
      <div class="sc-head"><span class="sc-type">多选</span><span class="sc-title">已选 ${ids.length} 条连线</span></div>
      <div class="sc-row">Ctrl+点选切换；Delete 删除选中</div>
      <div class="sc-actions">
        <button class="tb" data-act="batch">批量编辑</button>
        <button class="tb" data-act="fault">${ids.every(id2 => state.downLinks.has(id2)) ? '批量恢复' : '批量标记故障'}</button>
        <button class="tb danger" data-act="del">删除</button>
        <button class="tb" data-act="clear">取消选择</button>
      </div>`;
    card.querySelector('[data-act=batch]').onclick = () => batchEditLinks();
    card.querySelector('[data-act=fault]').onclick = () => {
      const down = !ids.every(id2 => state.downLinks.has(id2));
      for (const id2 of ids) { if (down) state.downLinks.add(id2); else state.downLinks.delete(id2); }
      renderer.setDownLinks(state.downLinks);
      saveGraph();
      updateLegend();
      toast(down ? '已批量标记 ' + ids.length + ' 条链路故障（红色虚线，路径分析绕行）' : '已批量恢复 ' + ids.length + ' 条链路');
      renderSelCard();
    };
    card.querySelector('[data-act=del]').onclick = () => deleteSelection();
    card.querySelector('[data-act=clear]').onclick = () => select(null, null);
    return;
  }
  if (kind === 'text') {
    const t = state.texts.find(x => x.id === id);
    if (!t) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const first = (t.text || '').split('\n')[0] || '';
    card.innerHTML = `
      <div class="sc-head"><span class="sc-type" style="background:var(--accent)">文本框</span><span class="sc-title">${U.escHtml(first.slice(0, 18))}</span></div>
      <div class="sc-row">${U.escHtml(t.font)} · ${t.size}px${t.bold ? ' · 粗体' : ''}${t.italic ? ' · 斜体' : ''}${t.bg ? ' · 有背景' : ''}</div>
      <div class="sc-actions">
        <button class="tb" data-act="edit">编辑</button>
        <button class="tb danger" data-act="del">删除</button>
        <button class="tb" data-act="clear">取消选择</button>
      </div>`;
    card.querySelector('[data-act=edit]').onclick = () => editText(id);
    card.querySelector('[data-act=del]').onclick = () => deleteText(id);
    card.querySelector('[data-act=clear]').onclick = () => select(null, null);
    return;
  }
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
      ${U.nodeMgmts(n).length ? `<div class="sc-row">管理地址：<b>${U.escHtml(U.nodeMgmts(n).join('、'))}</b></div>` : ''}
      ${n.web ? `<div class="sc-row">管理Web页：<b>${U.escHtml(n.web)}</b></div>` : ''}
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
      ${l.bw ? `<div class="sc-row">带宽：<b>${U.escHtml(U.formatBw(l.bw))}</b></div>` : ''}
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
      .filter(n => !q || String(n.name || '').toLowerCase().includes(q) || String(n.note || '').toLowerCase().includes(q))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
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
        ${l.bw ? `<span class="ifc">${U.escHtml(U.formatBw(l.bw))}</span>` : ''}
      </div>`).join('');
  }
  $$('.pitem', wrap).forEach(it => {
    it.addEventListener('click', () => {
      const kind = it.getAttribute('data-kind'), id = it.getAttribute('data-id');
      select(kind, id, { center: true });
    });
    // 右键：在面板项上直接打开与画布一致的编辑菜单（设备/连线）
    it.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const kind = it.getAttribute('data-kind'), id = it.getAttribute('data-id');
      select(kind, id);
      openCtx(e, kind, id);
    });
    // 双击：直接编辑设备 / 连线
    it.addEventListener('dblclick', () => {
      const kind = it.getAttribute('data-kind'), id = it.getAttribute('data-id');
      if (kind === 'node') editNode(id);
      else if (kind === 'link') editLink(id);
    });
  });
}

function updateLegend() {
  const typeHtml = U.typeList().map(t => {
    const c = U.getType(t.key);
    return `<span class="lg" title="${U.escHtml(t.label)}"><i style="background:${c.c1}"></i>${U.escHtml(t.label)}</span>`;
  }).join('');
  // 带宽图例：颜色标识带宽大小（图上不显示带宽文字）
  const bwSet = new Map();
  for (const l of state.links) { const n = U.normalizeBw(l.bw); if (n && !bwSet.has(n)) bwSet.set(n, U.bwColor(n)); }
  const bwHtml = bwSet.size ? [...bwSet.entries()].sort((a, b) => b[0] - a[0])
    .map(([n, c]) => `<span class="lg bw" title="带宽 ${U.formatBw(n)}"><i style="background:${c}"></i>${U.formatBw(n)}</span>`).join('') : '';
  // 故障图例
  const faultHtml = state.downLinks.size
    ? `<span class="lg fault" title="已标记故障的链路（模拟断链）"><i></i>故障 ${state.downLinks.size}</span>` : '';
  // 子网分组图例（显示子网分组时展示配色）
  let subnetHtml = '';
  if (state.showSubnets) {
    const groups = U.subnetGroups(state.nodes, state.links, state.subnetNames);
    subnetHtml = groups.map(g =>
      `<span class="lg subnet" title="${U.escHtml(g.cidr)}"><i style="border-color:${g.color};color:${g.color}"></i>${U.escHtml(g.name)}</span>`
    ).join('');
  }
  const parts = [typeHtml, bwHtml, faultHtml, subnetHtml].filter(Boolean);
  $('#legend').innerHTML = parts.map((p, i) => i ? '<span class="lg-sep"></span>' + p : p).join('');
}

/* ================= 持久化（刷新自动恢复） ================= */
const GRAPH_KEY = 'nettopo.graph';

function saveGraph() {
  try {
    localStorage.setItem(GRAPH_KEY, JSON.stringify({
      nodes: state.nodes,
      links: state.links,
      texts: state.texts,
      pan: renderer.pan,
      zoom: renderer.zoom,
      showLabels: state.showLabels,
      showSubnets: state.showSubnets,
      subnetNames: state.subnetNames,
      downLinks: [...state.downLinks],
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
    const cleaned = U.sanitizeGraph(d.nodes, d.links, d.texts);
    state.nodes = cleaned.nodes;
    state.links = cleaned.links;
    state.texts = cleaned.texts;
    U.seedCounters(state.nodes, state.links, state.texts); // 避免新 ID 与恢复节点/文本框冲突
    state.sel = { kind: null, id: null };
    state.undoStack = []; // 初始状态无需撤销
    state.redoStack = [];
    if (typeof d.showLabels === 'boolean') state.showLabels = d.showLabels;
    if (typeof d.showSubnets === 'boolean') state.showSubnets = d.showSubnets;
    if (d.subnetNames && typeof d.subnetNames === 'object') state.subnetNames = d.subnetNames;
    state.downLinks = new Set(Array.isArray(d.downLinks) ? d.downLinks : []);
    renderer.showLabels = state.showLabels;
    renderer.showSubnets = state.showSubnets;
    renderer.subnetNames = state.subnetNames;
    renderer.setDownLinks(state.downLinks);
    renderer.setData(state.nodes, state.links, state.texts);
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
    renderer.setData(state.nodes, state.links, state.texts);
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
        confirmBox(`删除类型「${U.customTypes.find(t => t.key === key).label}」？`).then(ok => {
          if (!ok) return;
          U.removeCustomType(key);
          for (const n of state.nodes) {
            if (n.type === key) { n.type = 'other'; }
          }
          afterChange();
        });
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
  modal.style.width = '700px';
  ov.querySelector('form').innerHTML = `
  <div class="help-body">
    <h4>① 快速开始</h4>
    <p>三种方式进入：<b>「文件 ▾ 导入表格…」</b>选择连线关系表（自动生成拓扑）、<b>「文件 ▾ 载入示例拓扑」</b>体验内置数据、<b>「文件 ▾ 新建空白画布」</b>直接手动画。导入后自动布局；拖拽调整位置、双击编辑、右键更多操作，<kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd> 撤销重做。</p>
    <h4>② 表格格式（导入）</h4>
    <table>
      <tr><th>中文表头</th><th>英文表头</th><th>说明</th></tr>
      <tr><td>源设备 / 设备A / 设备1</td><td>source / device_a</td><td>必填</td></tr>
      <tr><td>源接口 / 接口A</td><td>source_interface</td><td>可选</td></tr>
      <tr><td>源IP / IP地址A</td><td>source_ip</td><td>可选</td></tr>
      <tr><td>目标设备 / 设备B / 设备2</td><td>target / device_b</td><td>必填</td></tr>
      <tr><td>目标接口 / 接口B</td><td>target_interface</td><td>可选</td></tr>
      <tr><td>目标IP / IP地址B</td><td>target_ip</td><td>可选</td></tr>
      <tr><td>带宽 / 备注 / 管理地址</td><td>bandwidth / note / mgmt</td><td>可选</td></tr>
    </table>
    <p>无表头按「设备A, 设备B, 接口A, IP A, 接口B, IP B, 带宽, 备注」顺序识别；自动识别 UTF-8 / GBK 编码，兼容 .csv / .txt / .xlsx / .xls。</p>
    <h4>③ 画布操作</h4>
    <p>滚轮缩放（以光标为中心）、拖拽空白或中键平移；<b>Ctrl 点选</b>多选、<b>Shift 拖拽框选</b>；<kbd>Delete</kbd> 删除选中；多选后可整体拖动、批量编辑、对齐/分布。</p>
    <h4>④ 工具栏菜单</h4>
    <p><b>文件</b>：新建 / 导入表格 / 示例 / 保存工程(.nettopo) / 打开工程 / 对比工程 / 自动备份 / 备份管理。</p>
    <p><b>编辑</b>：添加设备 / 连线 / 文本框、从模板添加设备、对齐分布、批量重命名、IP 批量改段、类型管理、删除选中。</p>
    <p><b>布局</b>：力导向 / 环形 / 分层（按类型）/ 三层架构 / 拓扑分层（最少交叉）/ 网格布局、适应视图、路径分析、拓扑校验。</p>
    <p><b>显示</b>：链路标注、子网分组、清除故障标记、清除路径高亮。</p>
    <p><b>导出</b>：CSV / Excel / PDF / 图片(PNG/SVG) / 复制图片 / Visio / 设计报告 / 生成设备配置 / IP 规划清单。</p>
    <h4>⑤ 设备与连线</h4>
    <p><b>设备</b>可配置多个管理口地址（编辑设备点「＋ 增加管理口」，第一个为默认）、管理 Web 页 URL、备注；「编辑 ▾ 类型管理」可自定义类型并上传设备图片。</p>
    <p><b>连线</b>可配置接口 / IP / 带宽 / 备注；带宽以 Mbps 数值保存，图上用颜色标识（100M 灰 / 1G 蓝 / 10G 紫 / 40G 橙 / 100G 红）；右键连线可<b>标记故障</b>（模拟断链，路径分析自动绕行）。</p>
    <h4>⑥ 路径分析 / 拓扑校验</h4>
    <p><b>路径分析</b>：选两台设备按带宽优选最宽路径并高亮（显示瓶颈带宽），故障链路自动绕行。<b>拓扑校验</b>：一键检查重复 IP / 接口 / 管理地址、孤立设备、环路、平行链路、跨网段等，报告内可点击定位。</p>
    <h4>⑦ Web Shell（桌面版）</h4>
    <p>右键设备「Web Shell（SSH/Telnet）…」连接管理口（多管理口可下拉选择）；在<b>独立窗口</b>以<b>多标签</b>管理多台设备，主界面不锁定。终端支持：选中即复制、Ctrl+Shift+C/V 复制粘贴、右键菜单、字号调节（A−/A+ 或 Ctrl+-/Ctrl+=）、底部<b>快捷按钮条</b>（右键或「＋」新建，内容支持 \n 回车、\t 制表、\p 暂停 1 秒）。SSH 主机密钥以 SHA256 指纹展示。</p>
    <h4>⑧ 设备管理 Web 页（桌面版）</h4>
    <p>设备编辑中配置「管理Web页URL」，右键设备「打开设备管理页面」在<b>独立窗口</b>以<b>多标签</b>打开；支持地址栏 / 后退 / 前进 / 刷新；HTTPS 自签名 / 无效证书会弹出<b>安全告警</b>，手动确认后可继续访问并记住该站点。</p>
    <h4>⑨ 保存 / 导出</h4>
    <p><b>工程文件 .nettopo</b>：保存 / 打开含位置、视图、自定义类型、多管理口的完整工程；<b>CSV / Excel</b>：把修改后的拓扑保存回连线关系表（多管理口逗号分隔，可再导入）；<b>PDF</b>：矢量高清交付；<b>PNG / SVG</b>：图片导出与复制到剪贴板；<b>Visio</b>：.vsdx 原生格式可在 Visio 继续编辑；<b>设计报告</b>：自包含 HTML（设备 / IP / 子网 / 链路 / 配置）；<b>IP 规划清单</b>：Excel 导出含对端接口 IP；<b>生成设备配置</b>：华为 / 思科及自定义模板（{name} {mgmt} {iface} {ip} {peer} {vlan}…）。</p>
    <h4>快捷键</h4>
    <table>
      <tr><td>滚轮</td><td>缩放</td></tr>
      <tr><td>拖拽空白 / 中键</td><td>平移</td></tr>
      <tr><td>Ctrl+Z / Ctrl+Y</td><td>撤销 / 重做</td></tr>
      <tr><td>Delete / Backspace</td><td>删除选中</td></tr>
      <tr><td>L / F</td><td>自动布局 / 适应视图</td></tr>
      <tr><td>+ / -</td><td>放大 / 缩小</td></tr>
      <tr><td>Ctrl+S</td><td>保存工程</td></tr>
      <tr><td>Ctrl+K</td><td>聚焦搜索</td></tr>
      <tr><td>Ctrl+E</td><td>打开导出菜单</td></tr>
      <tr><td>Ctrl+Shift+L</td><td>切换链路标注</td></tr>
    </table>
    <h4>说明</h4>
    <p>浏览器版可编辑与导出；<b>Web Shell、设备管理 Web 页与备份管理为桌面版专属</b>（需 Electron 环境）。数据保存在本机，建议用「保存工程」备份。更多信息见右上角「关于」。</p>
  </div>`;
}

function openAbout() {
  openModal({
    title: '关于',
    submit: '关闭',
    onSubmit: () => {},
    fields: []
  });
  const ov = $('#modalRoot').lastElementChild;
  const modal = ov.querySelector('.modal');
  modal.style.width = '480px';
  ov.querySelector('form').innerHTML = `
  <div class="about-body">
    <div class="about-logo">
      <svg viewBox="0 0 32 32" width="52" height="52"><rect width="32" height="32" rx="7" fill="#4f46e5"/><circle cx="16" cy="16" r="4.5" fill="#fff"/><circle cx="8" cy="8" r="2.6" fill="#a5b4fc"/><circle cx="24" cy="8" r="2.6" fill="#a5b4fc"/><circle cx="8" cy="24" r="2.6" fill="#a5b4fc"/><circle cx="24" cy="24" r="2.6" fill="#a5b4fc"/><path d="M8 8h6.2M24 8h-6.2M8 24h6.2M24 24h-6.2M16 11.5v4.5M13 20l3-4 3 4" stroke="#a5b4fc" stroke-width="1.6" fill="none"/></svg>
    </div>
    <div class="about-title">NetTopo · 网络拓扑设计器</div>
    <div class="about-row"><b>版本</b><span>${U.APP_VERSION}</span></div>
    <div class="about-row"><b>用途</b><span>网络拓扑可视化设计、管理与导出工具</span></div>
    <div class="about-row"><b>运行环境</b><span>Windows 桌面版（Electron）/ 现代浏览器</span></div>
    <div class="about-row"><b>版权</b><span>© 2026 NetTopo 项目，保留所有权利</span></div>
    <div class="about-row"><b>许可</b><span>MIT License</span></div>
    <div class="about-row"><b>项目主页</b><span class="about-url">https://github.com/54gogogo10/nettopo</span></div>
    <div class="about-actions">
      <button type="button" class="tb" id="aboutCopy">复制链接</button>
      <button type="button" class="tb primary" id="aboutOpen">在浏览器打开</button>
    </div>
    <div class="about-license">本软件基于 MIT 许可证发布：允许自由使用、复制、修改、合并、出版发行、再许可和/或销售副本，但需保留上述版权声明与许可声明。本软件按“现状”提供，不作任何明示或暗示的担保。</div>
    <div class="about-note">数据仅保存在本机；Web Shell 与设备管理 Web 页为桌面版功能。</div>
  </div>`;
  const ABOUT_URL = 'https://github.com/54gogogo10/nettopo';
  const aboutCopy = ov.querySelector('#aboutCopy');
  if (aboutCopy) aboutCopy.onclick = () => {
    if (window.topoShell && window.topoShell.copyText) window.topoShell.copyText(ABOUT_URL);
    toast('已复制项目地址：' + ABOUT_URL);
  };
  const aboutOpen = ov.querySelector('#aboutOpen');
  if (aboutOpen) aboutOpen.onclick = () => {
    if (window.topoShell && window.topoShell.openExternal) window.topoShell.openExternal(ABOUT_URL);
    else window.open(ABOUT_URL, '_blank');
  };
}


/* ================= 事件接线 ================= */
function wire() {
  U.fillIcons();

  // ---- 工具栏下拉菜单（文件 / 编辑 / 布局 / 导出） ----
  const loadSample = () => {
    loadGraph(M.textToGraph(M.SAMPLE_CSV), '已载入示例拓扑：9 台设备、10 条链路'); // 是否覆盖由 loadGraph 内确认框处理
  };
  const togglePlace = () => setMode(state.mode === 'place' ? 'normal' : 'place');
  const toggleLink = () => setMode(state.mode === 'link' ? 'normal' : 'link');

  $('#btnDropFile').onclick = (e) => openDrop(e.currentTarget, [
    { ic: 'fileplus', label: '新建空白画布', act: newGraph },
    { ic: 'upload', label: '导入表格…', act: () => $('#fileInput').click() },
    { ic: 'wand', label: '载入示例拓扑', act: loadSample },
    { sep: true },
    { ic: 'save', label: '保存工程…', act: saveProject },
    { ic: 'folder', label: '打开工程…', act: () => $('#projInput').click() },
    { ic: 'git', label: '对比工程…', act: openProjectDiff },
    { ic: 'clock', label: '自动备份工程…', act: openAutoBackup },
    { ic: 'archive', label: '备份管理…', act: openBackupManager }
  ]);
  $('#btnDropEdit').onclick = (e) => openDrop(e.currentTarget, [
    { ic: 'node', label: '添加设备', active: state.mode === 'place', act: togglePlace },
    { ic: 'link', label: '添加连线', active: state.mode === 'link', act: toggleLink },
    { ic: 'edit', label: '添加文本框', act: () => { const c = viewCenter(); addTextAt(c.x, c.y); } },
    { ic: 'fileplus', label: '从模板添加设备…', act: openTemplatePicker },
    { sep: true },
    { ic: 'edit', label: '对齐 / 分布选中…', act: openAlign },
    { ic: 'edit', label: '批量重命名…', act: openRename },
    { ic: 'edit', label: 'IP 批量改段…', act: openIpRenumber },
    { sep: true },
    { ic: 'tag', label: '类型管理…', act: openTypeManager },
    { ic: 'trash', label: '删除选中', danger: true, act: () => deleteSelection() }
  ]);
  $('#btnDropLayout').onclick = (e) => openDrop(e.currentTarget, [
    { ic: 'layout', label: '自动布局（力导向）(L)', act: () => autoLayout() },
    { ic: 'layout', label: '环形布局', act: () => applyLayoutPreset('ring') },
    { ic: 'layout', label: '分层布局（按类型）', act: () => applyLayoutPreset('layer') },
    { ic: 'layout', label: '三层架构布局（核心-汇聚-接入）', act: () => applyLayoutPreset('tier') },
    { ic: 'layout', label: '拓扑分层布局（最少交叉）', act: () => applyLayoutPreset('topo') },
    { ic: 'layout', label: '网格布局', act: () => applyLayoutPreset('grid') },
    { sep: true },
    { ic: 'fit', label: '适应视图 (F)', act: () => renderer.fit() },
    { ic: 'locate', label: '路径分析…', act: openPathAnalysis },
    { sep: true },
    { ic: 'shield', label: '拓扑校验', act: runValidation }
  ]);
  $('#btnDropView').onclick = (e) => openDrop(e.currentTarget, [
    { ic: 'eye', label: '链路标注', active: state.showLabels, act: toggleLabels },
    { ic: 'layers', label: '子网分组', active: state.showSubnets, act: toggleSubnets },
    { sep: true },
    { ic: 'undo', label: state.downLinks.size ? '清除故障标记（' + state.downLinks.size + '）' : '清除故障标记', act: clearDownLinks },
    { ic: 'close', label: '清除路径高亮', active: !!renderer.pathHl, act: clearPathHl }
  ]);
  $('#btnDropExport').onclick = (e) => openDrop(e.currentTarget, [
    { ic: 'csv', label: '导出 CSV 表格', act: exportCSV },
    { ic: 'xlsx', label: '导出 Excel 表格', act: exportXlsx },
    { ic: 'pdf', label: '导出 PDF', act: exportPdf },
    { ic: 'image', label: '导出图片（PNG / SVG）', act: openImageExport },
    { ic: 'copy', label: '复制图片到剪贴板', act: copyImageToClipboard },
    { ic: 'visio', label: '导出 Visio', act: exportVisio },
    { sep: true },
    { ic: 'list', label: '导出设计报告（HTML）', act: exportReport },
    { ic: 'code', label: '生成设备配置…', act: openConfigGen },
    { ic: 'list', label: '导出 IP 规划清单…', act: openIpPlan }
  ]);

  $('#btnEmptyImport').onclick = () => $('#fileInput').click();
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleImport(f).catch(err => toast('读取文件失败：' + err.message));
    e.target.value = '';
  });
  $('#btnEmptySample').onclick = loadSample;
  $('#projInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) loadProject(f).catch(err => toast('打开工程失败：' + err.message));
    e.target.value = '';
  });
  $('#btnEmptyNew').onclick = () => {
    newGraph();
    setMode('place'); // 直接进入放置模式，点击画布即可添加第一台设备
    setHint('放置模式：点击画布空白处放置设备；Esc 或右键取消');
  };

  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnTheme').onclick = toggleTheme;
  $('#btnHelp').onclick = openHelp;
  $('#btnAbout').onclick = openAbout;

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
    const drop = $('#drop');
    if (!drop.classList.contains('hidden')) {
      const anchor = drop._anchor;
      const inDrop = e.target.closest && e.target.closest('#drop');
      const inAnchor = anchor && e.target.closest && e.target.closest('#' + anchor.id);
      if (!inDrop && !inAnchor) closeDrop();
    }
  }, true);

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
      closeDrop();
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#searchInput').focus(); $('#searchInput').select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); $('#btnDropExport').click(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); toggleLabels(); return; }
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

/* ================= 设备管理 Web 页（独立窗口多标签，不锁定主界面） ================= */
function openDeviceWeb(id) {
  const n = state.nodes.find(x => x.id === id);
  if (!n) return;
  if (!window.topoWeb) { toast('打开设备管理页面需要桌面版 NetTopo（Electron）环境'); return; }
  const url = String(n.web || '').trim();
  if (!url) { toast(`设备「${n.name}」未设置管理 Web 页 URL，请在编辑设备中添加`); return; }
  if (!/^https?:\/\//i.test(url)) { toast('管理 Web 页 URL 必须以 http:// 或 https:// 开头'); return; }
  window.topoWeb.open(url, n.name).then((res) => {
    if (res && res.ok) toast(`已在「设备管理页」窗口打开 ${n.name} 的管理页面（多标签，不锁定主界面）`);
    else toast((res && res.error) || '无法打开管理页面');
  }).catch(() => toast('无法打开管理页面'));
}

/* ================= Web Shell（SSH / Telnet 连接设备管理口，独立窗口多标签） ================= */
function openWebShell(id) {
  const n = state.nodes.find(x => x.id === id);
  if (!n) return;
  if (!window.topoShell) { toast('Web Shell 需要桌面版 NetTopo（Electron）环境'); return; }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('topoShellCfg') || 'null'); } catch (e) { saved = null; }
  saved = saved || {};
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal ws-dialog" role="dialog" style="width:440px">
      <h3>Web Shell — ${U.escHtml(n.name)}</h3>
      <div class="m-sub">通过 SSH 或 Telnet 连接设备的管理口地址${U.nodeMgmts(n).length ? ` <b class="ws-mgmt">${U.escHtml(U.nodeMgmts(n)[0])}</b>${U.nodeMgmts(n).length > 1 ? `（共 ${U.nodeMgmts(n).length} 个，可下拉选择）` : ''}` : '（该设备未设置管理地址，请手动填写）'}。连接后将在独立的「Web Shell」窗口以标签页显示，主界面可继续操作。</div>
      <div class="frow">
        <label>连接协议</label>
        <select id="wsProto">
          <option value="ssh"${(saved.protocol || 'ssh') === 'ssh' ? ' selected' : ''}>SSH（默认端口 22）</option>
          <option value="telnet"${saved.protocol === 'telnet' ? ' selected' : ''}>Telnet（默认端口 23）</option>
        </select>
      </div>
      <div class="frow">
        <label>主机 / 管理口</label>
        ${U.nodeMgmts(n).length > 1
          ? `<select id="wsHost">${U.nodeMgmts(n).map(m => `<option value="${U.escHtml(m)}">${U.escHtml(m)}</option>`).join('')}</select>`
          : `<input id="wsHost" type="text" placeholder="例如 10.255.0.1" value="${U.escHtml(n.mgmt || '')}" autocomplete="off"/>`}
      </div>
      <div class="frow"><div class="frow-inline">
        <div class="frow"><label>端口</label><input id="wsPort" type="number" min="1" max="65535" value="${U.escHtml(saved.port || '')}"/></div>
        <div class="frow"><label>用户名</label><input id="wsUser" type="text" placeholder="admin" value="${U.escHtml(saved.username || 'admin')}" autocomplete="off"/></div>
      </div></div>
      <div class="frow">
        <label>密码</label>
        <input id="wsPass" type="password" placeholder="SSH 密码；Telnet 通常可留空" autocomplete="new-password"/>
      </div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="cancel">取消</button>
        <button type="button" class="tb primary" data-act="connect">连接</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('[data-act=cancel]').onclick = close;
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  const protoEl = ov.querySelector('#wsProto');
  const portEl = ov.querySelector('#wsPort');
  const autoPort = () => protoEl.value === 'telnet' ? '23' : '22';
  protoEl.addEventListener('change', () => {
    const cur = portEl.value.trim();
    const otherDefault = autoPort() === '23' ? '22' : '23';
    if (!cur || cur === otherDefault) portEl.value = autoPort();
  });
  if (!portEl.value.trim()) portEl.value = autoPort();
  const doConnect = async () => {
    const cfg = {
      protocol: protoEl.value,
      host: ov.querySelector('#wsHost').value.trim(),
      port: ov.querySelector('#wsPort').value.trim(),
      username: ov.querySelector('#wsUser').value.trim(),
      password: ov.querySelector('#wsPass').value,
      title: n.name
    };
    try { cfg.expectFp = localStorage.getItem('topoShellFp:' + cfg.host) || ''; } catch (e) { cfg.expectFp = ''; }
    if (!cfg.host) { toast('请填写主机地址（管理口 IP）'); return; }
    try { localStorage.setItem('topoShellCfg', JSON.stringify({ protocol: cfg.protocol, port: cfg.port, username: cfg.username })); } catch (e) {}
    const btn = ov.querySelector('[data-act=connect]');
    btn.disabled = true; btn.textContent = '连接中…';
    let res;
    try { res = await window.topoShell.connect(cfg); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    if (!res || !res.ok) {
      btn.disabled = false; btn.textContent = '连接';
      toast((res && res.error) || '无法发起连接');
      return;
    }
    close();
    toast(`已连接 ${cfg.host}，请在「Web Shell」窗口查看（可继续操作拓扑）`);
  };
  ov.querySelector('[data-act=connect]').onclick = doConnect;
  for (const sel of ['#wsHost', '#wsPort', '#wsUser', '#wsPass']) {
    ov.querySelector(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doConnect(); } });
  }
  // 弹窗动画完成后聚焦主机输入框（避免动画期间焦点被重置）
  setTimeout(() => { if (document.body.contains(ov)) ov.querySelector('#wsHost').focus(); }, 250);
}

/* ================= 启动 ================= */
// 版本号统一取自 U.APP_VERSION（唯一来源），并同步到界面显示
console.log('[NetTopo] 版本 ' + U.APP_VERSION);
$('#statVer').textContent = U.APP_VERSION;
document.title = 'NetTopo · 网络拓扑设计器 ' + U.APP_VERSION;
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
