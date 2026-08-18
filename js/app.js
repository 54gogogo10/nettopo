/* ============================================================
 * NetTopo app.js —— 应用主逻辑
 * ============================================================ */
(function () {
'use strict';
const U = TopoUtil, M = TopoModel, Layout = TopoLayout;
const $ = U.$, $$ = U.$$;

/* localStorage 安全读取：浏览器禁用存储（隐私模式/沙箱）时 getItem 会抛异常，
 * 顶层状态初始化不能因此中断整个应用 */
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };

/* ================= 状态 ================= */
const state = {
  nodes: [],
  links: [],
  sel: { kind: null, id: null },
  mode: 'normal',      // normal | link | place
  linkPick: null,      // 连线模式下已选中的源节点
  undoStack: [],
  redoStack: [],
  theme: lsGet('nettopo.theme', 'light'),
  search: '',
  tab: 'nodes',
  blank: false,   // 用户主动新建空白画布（无表格也能直接画）
  showLabels: lsGet('nettopo.showLabels', '1') !== '0',   // 链路标注显示开关
  showSubnets: lsGet('nettopo.showSubnets', '0') === '1', // 子网分组显示开关
  subnetNames: {},  // 子网 -> 自定义名称（子网分组命名）
  downLinks: new Set(),  // 故障链路 id 集合（模拟断链，路径分析绕行）
  autoBackup: { on: lsGet('nettopo.autoBackup', '0') === '1', minutes: Number(lsGet('nettopo.autoBackupMin', '10') || 10), keep: Math.min(200, Math.max(1, Number(lsGet('nettopo.autoBackupKeep', '30') || 30) || 30)) },
  texts: [],  // 画布文本框（自定义字体样式）
  monitorCfg: {},   // 设备后台监控配置：nodeId -> {hosts:[{host,protocol,port,username,password,commands,onConnect,readOnly,...}],intervalSec,cmdDelayMs,enabled}
  monitorStatus: {} // 设备后台监控运行状态：nodeId -> {state,text,since}（运行时态，不持久化）
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
  reconcileMonitors(); // 撤销/重做后对齐后台监控
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
  reconcileMonitors(); // 拓扑变更后对齐后台监控（停止已删除设备的监控、启动启用设备）
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
/* 厂家选项（数组格式，供 openModal 的 select 字段使用） */
function cfgVendorOptionList() {
  const tpls = U.cfgTemplates();
  const out = [];
  for (const k in tpls) out.push([k, tpls[k].label + (tpls[k].builtin ? '' : '（自定义）')]);
  return out;
}
function openConfigGen() {
  if (!state.nodes.length) { toast('画布为空，请先导入或添加设备'); return; }
  const root = $('#modalRoot');
  const selIds = renderer.selIds;
  // 默认选中：画布有选中则取画布选中设备，否则全部
  const selDev = new Set(selIds.size ? selIds : state.nodes.map(n => n.id));
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:700px">
      <h3>生成设备配置</h3>
      <div class="m-sub">按拓扑接口/IP 生成配置片段；可选 <b>静态路由</b>（自动推导）与 <b>VLAN</b>（连线/设备上显式配置的 VLAN 相关配置）；设备可在「编辑设备」中单独指定厂家（默认跟随此处全局选择）</div>
      <div class="m-row">
        <label>厂家风格</label>
        <select id="cfgVendor">${cfgVendorOptions()}</select>
        <button type="button" class="tb" id="cfgPick" title="勾选要生成配置的设备">选择设备</button>
        <span class="dp-count" id="cfgPickCnt" style="color:var(--muted);font-size:12px"></span>
        <label style="margin-left:16px;display:flex;align-items:center;gap:5px"><input id="cfgRoutes" type="checkbox" checked/> 静态路由</label>
        <label style="display:flex;align-items:center;gap:5px"><input id="cfgVlan" type="checkbox" checked/> VLAN</label>
        <button type="button" class="tb" id="cfgTplMgr" style="margin-left:auto">管理模板…</button>
      </div>
      <div id="cfgIssues" class="cfg-issues" style="display:none"></div>
      <textarea id="cfgOut" class="cfg-box" readonly spellcheck="false"></textarea>
      <div class="m-actions">
        <button type="button" class="tb" data-act="copy">复制配置</button>
        <button type="button" class="tb" data-act="dl">下载 .txt</button>
        <button type="button" class="tb" data-act="zip" title="全部选中设备各导出一个 .txt，按厂家分目录打包">下载 ZIP</button>
        <button type="button" class="tb primary" data-act="close">关闭</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  const total = state.nodes.length;
  const refreshCount = () => {
    const n = selDev.size;
    ov.querySelector('#cfgPickCnt').textContent = n === total ? `（全部 ${total} 台）` : `（${n} / ${total} 台）`;
  };
  const issuesEl = ov.querySelector('#cfgIssues');
  const renderIssues = () => {
    const r = U.checkConfigs(state.nodes, state.links);
    if (!r.issues.length) { issuesEl.style.display = 'none'; issuesEl.innerHTML = ''; return; }
    issuesEl.style.display = '';
    const errs = r.issues.filter(i => i.level === 'error');
    const warns = r.issues.filter(i => i.level === 'warn');
    issuesEl.innerHTML = '<div class="ci-head">生成前冲突检查：' + (errs.length ? '<b class="ci-err">' + errs.length + ' 处错误</b>' : '<b class="ci-ok">无错误</b>') + '，' + (warns.length ? '<b class="ci-warn">' + warns.length + ' 处警告</b>' : '无警告') + '</div>'
      + [...errs, ...warns].map(i => '<div class="ci-item ' + (i.level === 'error' ? 'ci-err' : 'ci-warn') + '">' + U.escHtml(i.device) + '：' + U.escHtml(i.msg) + '</div>').join('');
  };
  const gen = () => {
    renderIssues();
    const vendor = ov.querySelector('#cfgVendor').value;
    ov.querySelector('#cfgOut').value = selDev.size
      ? U.generateConfigs(state.nodes, state.links, vendor, {
          routes: ov.querySelector('#cfgRoutes').checked,
          vlan: ov.querySelector('#cfgVlan').checked,
          only: selDev
        })
      : '（未选择任何设备，请点击「选择设备」勾选）';
  };
  ov.querySelector('#cfgVendor').addEventListener('change', gen);
  ov.querySelector('#cfgRoutes').addEventListener('change', gen);
  ov.querySelector('#cfgVlan').addEventListener('change', gen);
  ov.querySelector('#cfgPick').onclick = () => openCfgDevicePicker(selDev, () => { refreshCount(); gen(); });
  ov.querySelector('#cfgTplMgr').onclick = () => openConfigTemplateManager(() => {
    ov.querySelector('#cfgVendor').innerHTML = cfgVendorOptions();
    gen();
  });
  refreshCount();
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
  ov.querySelector('[data-act=zip]').onclick = () => {
    const vendor = ov.querySelector('#cfgVendor').value;
    const tplOf = (n) => (n.vendor && U.cfgTemplates()[n.vendor]) ? n.vendor : vendor;
    const targets = selDev.size ? state.nodes.filter(n => selDev.has(n.id)) : state.nodes;
    const files = targets.map(n => {
      const v = tplOf(n);
      return { name: (v || 'huawei') + '/' + (n.name || n.id) + '.txt', content: U.generateConfigs(state.nodes, state.links, v, { routes: ov.querySelector('#cfgRoutes').checked, vlan: ov.querySelector('#cfgVlan').checked, only: new Set([n.id]) }) };
    });
    if (!files.length) { toast('没有可导出的设备'); return; }
    U.download(`设备配置_${U.fmtDate()}.zip`, new Blob([U.zipFiles(files)], { type: 'application/zip' }));
    toast('已下载配置 ZIP（' + files.length + ' 个设备，按厂家分目录）');
  };
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

/* 设备多选选择器：从 state.nodes 勾选子集（供配置生成/其它批量功能复用） */
function openCfgDevicePicker(selSet, onDone) {
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal" role="dialog" style="width:520px">
      <h3>选择设备</h3>
      <div class="m-sub">勾选要生成配置的设备，仅输出所选设备。</div>
      <div class="search" style="margin:2px 0 8px"><i class="ic" data-ic="search"></i><input id="dpSearch" type="text" placeholder="搜索设备 / 类型 / 管理地址…"/></div>
      <div class="dp-list" id="dpList"></div>
      <div class="m-row" style="margin-top:8px">
        <button type="button" class="tb" data-act="all">全选</button>
        <button type="button" class="tb" data-act="none">清空</button>
        <button type="button" class="tb" data-act="inv">反选</button>
        <span class="dp-count" style="margin-left:auto">已选 <b id="dpCount">0</b> 台</span>
      </div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="cancel">取消</button>
        <button type="button" class="tb primary" data-act="confirm">确定</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  const check = {}; // id -> bool（工作副本，取消时丢弃）
  for (const n of state.nodes) check[n.id] = selSet.has(n.id);
  const dpList = ov.querySelector('#dpList');
  const dpCount = ov.querySelector('#dpCount');
  const q = () => (ov.querySelector('#dpSearch').value || '').trim().toLowerCase();
  const updateCount = () => { dpCount.textContent = Object.values(check).filter(Boolean).length; };
  const render = () => {
    const list = state.nodes.filter(n => {
      if (q()) {
        const name = String(n.name).toLowerCase(), mgmt = String(n.mgmt || '').toLowerCase(), type = U.getType(n.type).label.toLowerCase();
        if (!(name.includes(q()) || mgmt.includes(q()) || type.includes(q()))) return false;
      }
      return true;
    });
    dpList.innerHTML = list.map(n => {
      const t = U.getType(n.type);
      return `<label class="dp-item"><input type="checkbox" data-id="${n.id}" ${check[n.id] ? 'checked' : ''}/><span class="nm">${U.escHtml(n.name)}<span class="sub">${U.escHtml(t.label)}${n.mgmt ? ' · ' + U.escHtml(n.mgmt) : ''}</span></span></label>`;
    }).join('');
    dpList.querySelectorAll('input[type=checkbox]').forEach(i => {
      i.addEventListener('change', () => { check[i.dataset.id] = i.checked; updateCount(); });
    });
    if (!list.length) dpList.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:14px 6px">无匹配设备</div>';
  };
  const setAll = (val) => { for (const n of state.nodes) check[n.id] = val; render(); updateCount(); };
  ov.querySelector('#dpSearch').addEventListener('input', render);
  ov.querySelector('[data-act=all]').onclick = () => setAll(true);
  ov.querySelector('[data-act=none]').onclick = () => setAll(false);
  ov.querySelector('[data-act=inv]').onclick = () => { for (const n of state.nodes) check[n.id] = !check[n.id]; render(); updateCount(); };
  ov.querySelector('[data-act=cancel]').onclick = close;
  ov.querySelector('[data-act=confirm]').onclick = () => {
    selSet.clear();
    for (const n of state.nodes) if (check[n.id]) selSet.add(n.id);
    close();
    onDone && onDone();
  };
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  render();
  updateCount();
  setTimeout(() => { if (document.body.contains(ov)) ov.querySelector('#dpSearch').focus(); }, 200);
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
        接口级 <b>{iface}</b> 本端接口 · <b>{ip}</b> 接口 IP · <b>{mask}</b> 掩码(255.255.255.0) · <b>{maskCidr}</b>(/24) · <b>{wildcard}</b>(0.0.0.255) · <b>{peer}</b> 对端设备 · <b>{peerIf}</b> 对端接口 · <b>{bw}</b> 带宽 · <b>{vlan}</b> VLAN · <b>{vlanList}</b>/<b>{vlanCsv}</b> VLAN列表 · <b>{vid}</b> SVI编号
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
        <div class="m-sub" style="line-height:1.6">可用占位符：<b>{name}</b>设备名 <b>{mgmt}</b>管理 <b>{type}</b>类型 <b>{comment}</b>注释符 <b>{iface}</b>接口 <b>{ip}</b>IP <b>{mask}</b>掩码(255.255.255.0) <b>{maskCidr}</b>/24 <b>{wildcard}</b>反掩码 <b>{peer}</b>对端设备 <b>{peerIf}</b>对端接口 <b>{bw}</b>带宽 <b>{vlan}</b>VLAN <b>{vid}</b>SVI编号 <b>{vlanList}</b>VLAN列表(空格) <b>{vlanCsv}</b>VLAN列表(逗号) <b>{net}</b>远端网段 <b>{subnet}</b>网段CIDR <b>{nextHop}</b>下一跳</div>
        <div class="m-row" style="align-items:flex-start"><label>设备头</label><textarea id="tplHeader" style="height:54px">${U.escHtml(t.deviceHeader || '')}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>无接口行<br/><small>无接口时显示</small></label><textarea id="tplNoIface" style="height:40px">${U.escHtml(t.noIface || '')}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>接口块<br/><small>每行一条，三层口</small></label><textarea id="tplIface" style="height:110px">${U.escHtml((t.interface || []).join('\n'))}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>接入端口<br/><small>access 模式</small></label><textarea id="tplAccess" style="height:48px">${U.escHtml((t.switchAccess || []).join('\n'))}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>Trunk 口<br/><small>trunk 模式</small></label><textarea id="tplTrunk" style="height:48px">${U.escHtml((t.vlanTrunk || []).join('\n'))}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>Hybrid 口<br/><small>hybrid 模式</small></label><textarea id="tplHybrid" style="height:48px">${U.escHtml((t.vlanHybrid || []).join('\n'))}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>三层VLAN接口<br/><small>SVI，每行一条</small></label><textarea id="tplSvi" style="height:66px">${U.escHtml((t.svi || []).join('\n'))}</textarea></div>
        <div class="m-row" style="align-items:flex-start"><label>VLAN定义行<br/><small>单个</small></label><input id="tplVlanLine" type="text" value="${U.escHtml(t.vlanLine || '')}" style="flex:1" placeholder="如 vlan {vlan}"/></div>
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
        noIface: edit.querySelector('#tplNoIface').value,
        interface: edit.querySelector('#tplIface').value.split('\n').map(s => s.trim()).filter(Boolean),
        switchAccess: edit.querySelector('#tplAccess').value.split('\n').map(s => s.trim()).filter(Boolean),
        vlanTrunk: edit.querySelector('#tplTrunk').value.split('\n').map(s => s.trim()).filter(Boolean),
        vlanHybrid: edit.querySelector('#tplHybrid').value.split('\n').map(s => s.trim()).filter(Boolean),
        svi: edit.querySelector('#tplSvi').value.split('\n').map(s => s.trim()).filter(Boolean),
        vlanLine: edit.querySelector('#tplVlanLine').value.trim(),
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
      vlanTrunk: [], vlanHybrid: [], svi: [], vlanLine: '',
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
    const safeRows = rows.map(r => { const o = {}; for (const k in r) o[k] = U.sanitizeCell(r[k]); return o; });
    const wb = window.XLSX.utils.book_new();
    const ws = window.XLSX.utils.json_to_sheet(safeRows);
    // 设备名列合并：同一台设备的连续行合并成一个单元格（第 0 行表头，数据从第 1 行起，设备名列=0）
    const merges = U.deviceMergeRanges(safeRows);
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
  const html = U.buildReportHtml(state.nodes, state.links);
  U.download(`拓扑设计报告_${U.fmtDate()}.html`, new Blob([html], { type: 'text/html;charset=utf-8' }));
  toast('已导出拓扑设计报告（HTML，含设备/IP/子网/链路）');
}

/* ================= 多选对齐 / 分布 ================= */
function openAlign() {
  const ids = new Set(renderer.selectedNodes()); // selectedNodes() 返回数组，这里转 Set 供 has() 判断
  if (ids.size < 2) { toast('请先多选至少两台设备（Ctrl 点选 / Shift 框选）'); return; }
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
      <h3>对齐 / 分布（已选 ${ids.size} 台设备）</h3>
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
  const ids = new Set(renderer.selectedNodes()); // selectedNodes() 返回数组，这里转 Set 供 size/has 判断
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
      <div class="m-row" style="align-items:flex-start"><label>${window.topoBackup ? '备份目录' : ''}</label>${window.topoBackup ? `<div style="flex:1;min-width:0"><div id="abDir" title="备份文件存储位置" style="font:11.5px/1.5 Consolas,monospace;color:var(--text);background:var(--panel2);border:1px solid var(--border);border-radius:7px;padding:5px 8px;word-break:break-all;white-space:normal">读取中…</div><div class="frow-inline" style="margin-top:6px;gap:6px;display:flex"><button type="button" class="tb" data-act="chooseDir">更改目录…</button><button type="button" class="tb" data-act="resetDir" style="display:none">恢复默认</button></div></div>` : ''}</div>
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

  // 备份目录：读取 / 更改 / 恢复默认
  const dirEl = ov.querySelector('#abDir');
  const resetBtn = ov.querySelector('[data-act=resetDir]');
  const renderDir = (dir, custom) => {
    if (!dirEl) return;
    dirEl.textContent = dir + (custom ? '（自定义）' : '（默认）');
    if (resetBtn) resetBtn.style.display = custom ? '' : 'none';
  };
  if (window.topoBackup && dirEl) {
    window.topoBackup.getDir().then((res) => {
      if (res && res.ok) renderDir(res.dir, res.custom);
      else if (dirEl) dirEl.textContent = '无法读取备份目录';
    }).catch(() => { if (dirEl) dirEl.textContent = '无法读取备份目录'; });
    const cBtn = ov.querySelector('[data-act=chooseDir]');
    if (cBtn) cBtn.onclick = async () => {
      try {
        const res = await window.topoBackup.chooseDir();
        if (res && res.ok) { renderDir(res.dir, true); toast('已更改备份目录'); }
        else if (!res || !res.canceled) toast((res && res.error) || '未能更改备份目录');
      } catch (e) { toast('更改备份目录失败'); }
    };
    if (resetBtn) resetBtn.onclick = async () => {
      try {
        const res = await window.topoBackup.resetDir();
        if (res && res.ok) { renderDir(res.dir, false); toast('已恢复默认备份目录'); }
        else toast((res && res.error) || '恢复默认失败');
      } catch (e) { toast('恢复默认失败'); }
    };
  }

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
  const rows = M.graphToTableRows(state.nodes, state.links).map(r => r.map(U.sanitizeCell));
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
  reconcileMonitors();
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
    (async () => { try { const dr = await window.topoBackup.getDir(); if (dr && dr.ok && subEl.isConnected) subEl.textContent += '\n目录：' + dr.dir + (dr.custom ? '（自定义）' : ''); } catch (e) {} })();
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
    title: '添加设备', width: 640,
    fields: [
      { name: 'name', label: '设备名称', required: true, ph: '例如：核心交换机SW1' },
      { name: 'type', label: '设备类型', type: 'select', options: U.typeList().map(t => [t.key, t.label]) },
      { name: 'vendor', label: '配置厂家', type: 'select', options: [['', '跟随全局（生成配置时选择）']].concat(cfgVendorOptionList()) },
      { name: 'icon', label: '设备图标', type: 'icon', value: '' },
      { name: 'mgmts', label: '管理地址', type: 'mgmts', value: [] },
      { name: 'web', label: '管理Web页URL', ph: '例如 http://10.255.0.1（可选）' },
      { name: 'hasVlanIf', label: '三层 VLAN 接口', type: 'checkbox', value: false, tip: '有 VLAN 接口（生成 interface vlan 及 IP 地址）', toggles: 'vlans' },
      { name: 'vlans', label: 'VLAN 接口列表（VLAN 编号 + IP 地址）', type: 'vlans', value: [] },
      { name: 'note', label: '备注', type: 'textarea' }
    ],
    submit: '创建',
    onSubmit: (v) => {
      pushUndo(); // 变更前快照
      const ms = Array.isArray(v.mgmts) ? v.mgmts : [];
      const node = {
        id: U.uid('n'), name: v.name.trim(),
        type: v.type || U.typeOf(v.name),
        vendor: v.vendor || '',
        icon: v.icon || '',
        x: wx - U.nodeWidthForName(v.name) / 2, y: wy - U.NODE_H / 2,
        w: U.nodeWidthForName(v.name), h: U.NODE_H,
        note: v.note.trim(), mgmt: ms[0] || '', mgmts: ms.slice(1), web: v.web.trim(),
        vlans: (v.hasVlanIf && Array.isArray(v.vlans)) ? v.vlans : []
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

const TEXT_FONTS = U.TEXT_FONTS;

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
    title: '编辑设备', width: 640,
    fields: [
      { name: 'name', label: '设备名称', required: true, value: n.name },
      { name: 'type', label: '设备类型', type: 'select', options: U.typeList().map(t => [t.key, t.label]), value: n.type },
      { name: 'vendor', label: '配置厂家', type: 'select', options: [['', '跟随全局（生成配置时选择）']].concat(cfgVendorOptionList()), value: n.vendor || '' },
      { name: 'icon', label: '设备图标', type: 'icon', value: n.icon || '' },
      { name: 'mgmts', label: '管理地址', type: 'mgmts', value: U.nodeMgmts(n) },
      { name: 'web', label: '管理Web页URL', value: n.web || '', ph: '例如 http://10.255.0.1（可选）' },
      { name: 'hasVlanIf', label: '三层 VLAN 接口', type: 'checkbox', value: !!(Array.isArray(n.vlans) && n.vlans.length), tip: '有 VLAN 接口（生成 interface vlan 及 IP 地址）', toggles: 'vlans' },
      { name: 'vlans', label: 'VLAN 接口列表（VLAN 编号 + IP 地址）', type: 'vlans', value: Array.isArray(n.vlans) ? n.vlans : [] },
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
      n.vendor = v.vendor || '';
      n.icon = v.icon || '';
      n.web = v.web.trim();
      n.note = v.note.trim();
      n.vlans = (v.hasVlanIf && Array.isArray(v.vlans)) ? v.vlans : [];
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
  stopMonitorForNode(id); // 删除设备时停止其后台监控
  delete state.monitorCfg[id]; saveMonitorCfg().catch(() => {});
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
  openLinkDialog(a, b, null);
}

function editLink(id) {
  const l = state.links.find(x => x.id === id);
  if (!l) return;
  const a = state.nodes.find(n => n.id === l.a);
  const b = state.nodes.find(n => n.id === l.b);
  if (!a || !b) return;
  openLinkDialog(a, b, l);
}

/** 连线配置弹窗：每端可配置接口名、是否二层接口、VLAN 与 VLAN 模式（access/trunk/hybrid） */
function openLinkDialog(a, b, l) {
  const rootNode = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  const vlanModeOpts = (v) => `<select class="lk-vlanmode">
    <option value="access"${v === 'access' ? ' selected' : ''}>access（仅一个 VLAN）</option>
    <option value="trunk"${v === 'trunk' ? ' selected' : ''}>trunk（透传）</option>
    <option value="hybrid"${v === 'hybrid' ? ' selected' : ''}>hybrid（混杂）</option>
  </select>`;
  const sideHtml = (nm, p) => `
    <div class="lk-side" data-side="${p}">
      <div class="lk-side-title">${U.escHtml(nm)}</div>
      <div class="frow-inline" style="display:flex;gap:8px">
        <div class="frow" style="flex:1.4;margin-bottom:0"><label>接口</label><input class="lk-if" type="text" placeholder="例如 GE0/0/1" value="${U.escHtml(l ? l[p + 'If'] : '')}"/></div>
        <div class="frow" style="flex:1.2;margin-bottom:0"><label>IP（三层）</label><input class="lk-ip" type="text" placeholder="二层无需填写" value="${U.escHtml(l ? l[p + 'Ip'] : '')}"/></div>
        <div class="frow" style="flex:0.55;margin-bottom:0"><label>掩码位</label><input class="lk-mask" type="number" min="0" max="32" placeholder="24" value="${U.escHtml(l ? (l[p + 'Mask'] || '') : '')}"/></div>
      </div>
      <div class="lk-row2">
        <label class="ck-field"><input class="lk-l2" type="checkbox"${l && l[p + 'L2'] ? ' checked' : ''}/><span>二层接口（不配置 IP）</span></label>
        <label class="ck-field"><input class="lk-hasvlan" type="checkbox"${l && l[p + 'Vlan'] ? ' checked' : ''}/><span>有 VLAN</span></label>
        <input class="lk-vlan" type="text" placeholder="VLAN 编号" value="${U.escHtml(l ? l[p + 'Vlan'] : '')}" style="width:92px"/>
        ${vlanModeOpts(l ? l[p + 'VlanMode'] : 'access')}
      </div>
    </div>`;
  ov.innerHTML = `
    <div class="modal lk-dialog" role="dialog" style="width:600px">
      <h3>${l ? '编辑连线' : '添加连线'}</h3>
      <div class="m-sub">${U.escHtml(a.name)} ⇄ ${U.escHtml(b.name)}。二层接口生成配置时不配置 IP 地址，并按所选 VLAN 模式生成 VLAN 配置；三层接口配置 IP 地址。</div>
      ${sideHtml(a.name, 'a')}
      ${sideHtml(b.name, 'b')}
      <div class="frow" style="margin-top:12px"><div class="frow-inline" style="display:flex;gap:8px">
        <div class="frow" style="flex:1;margin-bottom:0"><label>带宽 (Mbps)</label><input class="lk-bw" type="text" placeholder="例如 1000" value="${U.escHtml(l ? U.normalizeBw(l.bw) : '')}"/></div>
        <div class="frow" style="flex:2;margin-bottom:0"><label>备注</label><input class="lk-note" type="text" value="${U.escHtml(l ? l.note : '')}"/></div>
      </div></div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="cancel">取消</button>
        <button type="button" class="tb primary" data-act="save">${l ? '保存' : '创建'}</button>
      </div>
    </div>`;
  rootNode.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  // 联动：二层 → 禁用 IP；有 VLAN → 启用 VLAN 值与模式
  U.$$('.lk-side', ov).forEach(side => {
    const l2 = side.querySelector('.lk-l2');
    const ip = side.querySelector('.lk-ip');
    const mask = side.querySelector('.lk-mask');
    const hv = side.querySelector('.lk-hasvlan');
    const vlan = side.querySelector('.lk-vlan');
    const mode = side.querySelector('.lk-vlanmode');
    const apply = () => {
      ip.disabled = l2.checked;
      ip.style.opacity = l2.checked ? '0.45' : '';
      ip.placeholder = l2.checked ? '二层接口，不配置 IP' : '例如 10.0.0.1';
      mask.disabled = l2.checked;
      mask.style.opacity = l2.checked ? '0.45' : '';
      vlan.disabled = !hv.checked;
      mode.disabled = !hv.checked;
      vlan.style.opacity = hv.checked ? '' : '0.45';
      mode.style.opacity = hv.checked ? '' : '0.45';
      if (!hv.checked) vlan.value = '';
    };
    l2.addEventListener('change', apply);
    hv.addEventListener('change', apply);
    apply();
  });

  const save = () => {
    const side = (p) => {
      const s = ov.querySelector('[data-side="' + p + '"]');
      const ifn = s.querySelector('.lk-if').value.trim();
      const l2 = s.querySelector('.lk-l2').checked;
      const hv = s.querySelector('.lk-hasvlan').checked;
      const mask = parseInt(s.querySelector('.lk-mask').value, 10);
      return {
        ifn, ip: l2 ? '' : s.querySelector('.lk-ip').value.trim(),
        mask: l2 ? 24 : (Number.isFinite(mask) && mask >= 0 && mask <= 32 ? mask : 24),
        l2, vlan: hv ? s.querySelector('.lk-vlan').value.trim() : '',
        vlanMode: hv ? s.querySelector('.lk-vlanmode').value : ''
      };
    };
    const sa = side('a'), sb = side('b');
    if (!sa.ifn || !sb.ifn) { toast('两端接口名不能为空'); return; }
    pushUndo(); // 变更前快照
    const base = {
      aIf: sa.ifn, aIp: sa.ip, aL2: sa.l2, aVlan: sa.vlan, aVlanMode: sa.vlanMode, aMask: sa.mask,
      bIf: sb.ifn, bIp: sb.ip, bL2: sb.l2, bVlan: sb.vlan, bVlanMode: sb.vlanMode, bMask: sb.mask,
      bw: U.normalizeBw(ov.querySelector('.lk-bw').value),
      note: ov.querySelector('.lk-note').value.trim()
    };
    let id;
    if (l) {
      Object.assign(l, base);
      id = l.id;
    } else {
      id = U.uid('l');
      state.links.push(Object.assign({ id, a: a.id, b: b.id }, base));
    }
    close();
    renderer.setData(state.nodes, state.links, state.texts);
    refreshAll();
    select('link', id);
  };
  ov.querySelector('[data-act=cancel]').onclick = close;
  ov.querySelector('[data-act=save]').onclick = save;
  setTimeout(() => { if (document.body.contains(ov)) ov.querySelector('.lk-if').focus(); }, 250);
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
  pushUndo(); // 故障标记参与撤销（快照包含 downLinks）
  if (state.downLinks.has(id)) state.downLinks.delete(id); else state.downLinks.add(id);
  renderer.setDownLinks(state.downLinks);
  saveGraph();
  updateLegend();
  const down = state.downLinks.has(id);
  toast(down ? '已标记链路故障（红色虚线，路径分析将绕行）' : '已恢复链路');
}
function clearDownLinks() {
  if (!state.downLinks.size) { toast('当前没有故障标记'); return; }
  pushUndo(); // 故障标记参与撤销
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
    } else if (f.type === 'checkbox') {
      ctrl = `<label class="ck-field"><input name="${f.name}" type="checkbox"${f.value ? ' checked' : ''}/><span>${U.escHtml(f.tip || '')}</span></label>`;
    } else if (f.type === 'mgmts') {
      const vals = Array.isArray(f.value) ? f.value : [];
      const rows = (vals.length ? vals : ['']).map(v =>
        `<div class="mgmt-row"><input type="text" value="${U.escHtml(v)}" placeholder="例如 10.255.0.1（第一个为默认）"/><button type="button" class="tb icon mgmt-del" title="删除该管理口">✕</button></div>`).join('');
      ctrl = `<div class="mgmt-list" data-field="${f.name}">${rows}<button type="button" class="tb mgmt-add" title="再增加一个管理口">＋ 增加管理口</button></div>`;
    } else if (f.type === 'vlans') {
      const rows = Array.isArray(f.value) && f.value.length ? f.value : [{ id: '', ip: '' }];
      const vrows = rows.map(v =>
        `<div class="vlan-row"><input class="vlan-id" type="text" value="${U.escHtml(String(v.id || ''))}" placeholder="VLAN 编号 如 10"/><input class="vlan-ip" type="text" value="${U.escHtml(String(v.ip || ''))}" placeholder="IP 如 192.168.10.1"/><button type="button" class="tb icon vlan-del" title="删除该 VLAN 接口">✕</button></div>`).join('');
      ctrl = `<div class="vlan-ctrl" data-vlan-ctrl="${f.name}"><div class="vlan-list" data-field="${f.name}">${vrows}<button type="button" class="tb vlan-add" title="再增加一个 VLAN 接口">＋ 增加 VLAN 接口</button></div></div>`;
    } else if (f.type === 'icon') {
      const curKey = f.value && U.NODE_ICON_KEYS.includes(f.value) ? f.value : '';
      const curImg = f.value && !U.NODE_ICON_KEYS.includes(f.value) ? f.value : '';
      const optRows = [['', '跟随类型（使用设备类型默认图标）']]
        .concat((U.NODE_ICON_KEYS || []).map(k => [k, (U.NODE_ICON_LABELS[k] || k) + ' 图标']));
      ctrl = `<div class="icon-ctrl" data-icon-ctrl="${f.name}">
        <input type="hidden" name="${f.name}" value="${U.escHtml(curKey)}"/>
        <input type="hidden" name="${f.name}Data" value="${U.escHtml(curImg)}"/>
        <div class="icon-line">
          <select name="${f.name}Sel">${optRows.map(([v, lb]) => `<option value="${v}"${String(curKey) === String(v) && !curImg ? ' selected' : ''}>${U.escHtml(lb)}</option>`).join('')}<option value="__upload">＋ 上传图片…（按正方形裁切显示）</option></select>
          <button type="button" class="tb icon-clr" title="清除自定义图标">清除</button>
        </div>
        <div class="icon-prev-row">
          <span class="icon-prev" data-icon-prev>${curImg ? `<img src="${U.escHtml(curImg)}" alt=""/>` : (curKey ? `<span class="ic" data-ic="${curKey}"></span>` : '<span class="tip">跟随类型</span>')}</span>
          <span class="icon-prev-info">${curImg ? '已上传自定义图片（画布上按正方形显示）' : (curKey ? (U.NODE_ICON_LABELS[curKey] || curKey) + ' 图标' : '未设置：使用设备类型默认图标')}</span>
        </div>
      </div>`;
      setTimeout(() => U.fillIcons(), 0);
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
  // 弹窗宽度：JS 赋值（模板内联 style 在部分环境解析异常，改用属性赋值）
  if (opts.width) { const md = ov.querySelector('.modal'); if (md) md.style.width = String(opts.width) + 'px'; }
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
  // VLAN 接口列表（三层 SVI）：增加 / 删除行
  U.$$('.vlan-list', form).forEach(list => {
    const addRow = () => {
      const d = document.createElement('div');
      d.className = 'vlan-row';
      d.innerHTML = '<input class="vlan-id" type="text" placeholder="VLAN 编号 如 10"/><input class="vlan-ip" type="text" placeholder="IP 如 192.168.10.1"/><button type="button" class="tb icon vlan-del" title="删除该 VLAN 接口">✕</button>';
      d.querySelector('.vlan-del').onclick = () => d.remove();
      list.insertBefore(d, list.querySelector('.vlan-add'));
      d.querySelector('.vlan-id').focus();
    };
    list.querySelector('.vlan-add').onclick = addRow;
    list.querySelectorAll('.vlan-del').forEach(b => { b.onclick = () => b.closest('.vlan-row').remove(); });
  });
  // 图标字段：下拉列表选择 / 上传图片（正方形预览）/ 清除
  U.$$('.icon-ctrl', form).forEach(ctrl => {
    const keyEl = ctrl.querySelector('input[name="' + ctrl.dataset.iconCtrl + '"]');
    const dataEl = ctrl.querySelector('input[name="' + ctrl.dataset.iconCtrl + 'Data"]');
    const sel = ctrl.querySelector('select[name="' + ctrl.dataset.iconCtrl + 'Sel"]');
    const prev = ctrl.querySelector('[data-icon-prev]');
    const info = ctrl.querySelector('.icon-prev-info');
    const renderPrev = () => {
      const img = dataEl.value;
      const key = keyEl.value;
      if (img) { prev.innerHTML = `<img src="${U.escHtml(img)}" alt=""/>`; info.textContent = '已上传自定义图片（画布上按正方形显示）'; }
      else if (key) { prev.innerHTML = `<span class="ic" data-ic="${key}"></span>`; info.textContent = (U.NODE_ICON_LABELS[key] || key) + ' 图标'; }
      else { prev.innerHTML = '<span class="tip">跟随类型</span>'; info.textContent = '未设置：使用设备类型默认图标'; }
      U.fillIcons();
    };
    const pickFile = () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        if (f.size > 1024 * 1024) { toast('图片不能超过 1MB'); return; }
        const rd = new FileReader();
        rd.onload = () => {
          keyEl.value = '';
          dataEl.value = String(rd.result);
          renderPrev();
        };
        rd.readAsDataURL(f);
      };
      inp.click();
    };
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (v === '__upload') { pickFile(); sel.value = keyEl.value || ''; return; }
      keyEl.value = v;
      dataEl.value = '';
      renderPrev();
    });
    ctrl.querySelector('.icon-clr').onclick = () => { keyEl.value = ''; dataEl.value = ''; sel.value = ''; renderPrev(); };
    renderPrev();
  });
  // 复选框联动：勾选时显示关联的字段（如「有VLAN接口」→ VLAN 接口列表）
  fields.forEach(f => {
    if (f.type === 'checkbox' && f.toggles) {
      const cb = form.elements[f.name];
      const ctrl = form.querySelector('[data-vlan-ctrl="' + f.toggles + '"]') || form.querySelector('[data-field="' + f.toggles + '"]')?.closest('.frow');
      const apply = () => { if (ctrl) ctrl.style.display = cb.checked ? '' : 'none'; };
      cb.addEventListener('change', apply);
      apply();
    }
  });
  const grab = () => {
    const o = {};
    fields.forEach(f => {
      if (f.type === 'mgmts') {
        const list = form.querySelector('.mgmt-list[data-field="' + f.name + '"]');
        o[f.name] = list ? [...list.querySelectorAll('.mgmt-row input')].map(i => i.value.trim()).filter(Boolean) : [];
        return;
      }
      if (f.type === 'vlans') {
        const list = form.querySelector('.vlan-list[data-field="' + f.name + '"]');
        o[f.name] = list ? [...list.querySelectorAll('.vlan-row')].map(r => ({ id: r.querySelector('.vlan-id').value.trim(), ip: r.querySelector('.vlan-ip').value.trim() })).filter(v => v.id && v.ip) : [];
        return;
      }
      if (f.type === 'checkbox') {
        const el2 = form.elements[f.name];
        if (el2) o[f.name] = el2.checked;
        return;
      }
      if (f.type === 'icon') {
        const sel = form.elements[f.name];
        const dataEl = form.elements[f.name + 'Data'];
        const img = dataEl ? dataEl.value : '';
        o[f.name] = img || (sel ? sel.value : '');
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
      { ic: 'pulse', label: '设备监控（静默采集）…', act: () => openMonitorConfig(id) },
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
      ${n.note ? `<div class="tt-r">备注：${U.escHtml(n.note)}</div>` : ''}
      ${state.monitorStatus[id] ? `<div class="tt-r">后台监控：${U.escHtml(state.monitorStatus[id].text || state.monitorStatus[id].state)}</div>` : ''}`;
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
      pushUndo(); // 批量故障标记参与撤销
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
      ${state.monitorStatus[id] ? `<div class="sc-row">后台监控：<b>${U.escHtml(state.monitorStatus[id].text || state.monitorStatus[id].state)}</b></div>` : ''}
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
        ${monitorBadgeHtml(n.id)}
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
    // 先解密加载持久化的监控配置，再对齐主进程状态并自启动已启用的监控
    loadMonitorCfg().then((saved) => {
      if (saved && typeof saved === 'object' && Object.keys(saved).length) state.monitorCfg = saved;
      syncMonitorStatus();  // 对齐主进程监控运行状态
      reconcileMonitors(); // 自启动已启用的监控
    }).catch(() => { syncMonitorStatus(); reconcileMonitors(); });
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
    <p><b>工程文件 .nettopo</b>：保存 / 打开含位置、视图、自定义类型、多管理口的完整工程；<b>CSV / Excel</b>：把修改后的拓扑保存回连线关系表（多管理口逗号分隔，可再导入）；<b>PDF</b>：矢量高清交付；<b>PNG / SVG</b>：图片导出与复制到剪贴板；<b>Visio</b>：.vsdx 原生格式可在 Visio 继续编辑；<b>设计报告</b>：自包含 HTML（设备 / IP / 子网 / 链路 / 配置）；<b>IP 规划清单</b>：Excel 导出含对端接口 IP；<b>生成设备配置</b>：华为 / H3C / 思科 / 锐捷及自定义模板（{name} {mgmt} {iface} {ip} {peer} {vlan}…），生成前自动做<b>冲突检查</b>，可<b>下载 ZIP</b> 按厂家分目录打包；模板掩码变量支持点分 / CIDR / 反掩码三种：{mask}（255.255.255.0）、{maskCidr}（/24）、{wildcard}（0.0.0.255）；「编辑设备」中可为设备指定<b>厂家与自定义图标</b>。</p>
    <h4>⑩ 后台监控（桌面版）</h4>
    <p>右键设备「设备监控（静默采集）…」配置协议 / 管理口 / 账号 / 命令与循环间隔后，即可在后台静默通过 SSH/Telnet 定时采集命令输出，<b>全部输出连同时间戳写入本地日志（按天归档）</b>：<userData>/monitor-logs/设备名/日期/<设备名>_<管理口>.log，同一天内连接/重连只追加同一文件，不再重复生成。每个管理口可单独配置：<b>连接时执行命令</b>（每行一条可多条，每次连接成功仅执行一次、先于周期循环，适合登录后的会话初始化）、<b>在线探测</b>（TCP/ICMP，离线变红并弹通知）、<b>输出关键字告警</b>（正则匹配即告警，周期循环 / 连接时命令 / 仅读取模式的输出均可匹配；多条关键字同时命中时全部显示，<b>全部不再命中才解除</b>；告警事件携带具体匹配行）与<b>配置自动备份</b>（命令可多条、输出合并保存；连接方式可选<b>复用监控连接</b>或<b>独立连接</b>；首份备份显示「首次」而非「有变化」）。<b>仅读取模式</b>不执行周期命令，但连接时命令、在线探测、关键字告警、自动备份均可用；<b>仅探测模式</b>可不勾选仅读取、不填命令、只勾选「在线探测」，保持连接并仅做连通性探测。<b>监控中心…</b>（工具栏「监控」菜单或右键设备）聚合全部设备状态与统计，「事件时间线 / 配置备份」以<b>标签页</b>切换，<b>点击左侧设备名或管理地址可筛选时间线</b>，事件带设备徽标与类型标签，告警事件显示匹配到的具体内容；「监控日志…」支持<b>全局跨文件搜索</b>（一次搜全部设备 / 日期 / 文件，点击结果直接定位到对应行）。关闭主窗口时可<b>托盘常驻</b>（工具栏「监控」菜单或监控配置弹窗）让后台监控继续运行；正在监控的设备在<b>右侧设备列表显示绿色标记</b>（连接失败显示琥珀/红色）。断线自动重连，可在弹窗打开日志目录查看。</p>
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
  $('#btnDropMonitor').onclick = (e) => openDrop(e.currentTarget, [
    { ic: 'grid', label: '监控中心…', act: () => openMonitorCenter() },
    { ic: 'pulse', label: '设备监控（静默采集）…', act: () => {
      const selId = state.sel && state.sel.kind === 'node' ? state.sel.id : (renderer.selIds && renderer.selIds.size ? [...renderer.selIds][0] : '');
      if (selId) openMonitorConfig(selId); else toast('请先选中一台设备，或右键设备进入');
    } },
    { sep: true },
    { ic: 'doc', label: '监控日志…', act: () => {
      const selId = state.sel && state.sel.kind === 'node' ? state.sel.id : '';
      openMonitorLogs(selId || '');
    } },
    { ic: 'archive', label: '配置备份…', act: () => {
      const selId = state.sel && state.sel.kind === 'node' ? state.sel.id : '';
      openConfigBackups(selId || '');
    } },
    { sep: true },
    { ic: 'tray', label: '托盘常驻（关闭窗口后台继续监控）', act: async () => {
      if (!window.topoMonitor || !window.topoMonitor.setTray) { toast('托盘常驻需要桌面版 NetTopo'); return; }
      let cur = false;
      try { const s = await window.topoMonitor.getSettings(); cur = !!(s && s.tray); } catch (e) {}
      const r = await window.topoMonitor.setTray(!cur);
      toast(r && r.ok ? (r.enabled ? '已启用托盘常驻：关闭窗口后监控在后台继续，点击托盘图标恢复' : '已关闭托盘常驻') : '设置失败');
    } }
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

  // ---- 后台监控实时状态（侧栏标记；任务 key 为 deviceId@host，按设备聚合） ----
  if (window.topoMonitor && window.topoMonitor.onStatus) {
    window.topoMonitor.onStatus((info) => {
      if (!info || !info.key) return;
      const did = info.deviceId || deviceIdFromMonitorKey(info.key);
      const host = info.host || '';
      if (info.state === 'stopped') {
        const ms = state.monitorStatus[did];
        if (ms && ms.perHost) {
          delete ms.perHost[host];
          ms.state = aggregateMonitorState(ms.perHost);
          ms.text = aggregateMonitorText(ms.perHost);
          if (!ms.state || !Object.keys(ms.perHost).length) delete state.monitorStatus[did];
        } else delete state.monitorStatus[did];
      } else {
        if (!state.monitorStatus[did]) state.monitorStatus[did] = { state: null, text: '', perHost: {} };
        const oldHost = state.monitorStatus[did].perHost[host] || {};
        state.monitorStatus[did].perHost[host] = Object.assign({}, oldHost, { state: info.state, text: info.text || '', since: info.since, probeOk: info.probeOk, alert: info.alert, backup: info.backup });
        state.monitorStatus[did].state = aggregateMonitorState(state.monitorStatus[did].perHost);
        state.monitorStatus[did].text = aggregateMonitorText(state.monitorStatus[did].perHost);
      }
      refreshPanel();
      renderSelCard();
    });
  }
  // 探测/告警/备份状态（独立通道，合并进 perHost 明细）
  if (window.topoMonitor && window.topoMonitor.onProbe) {
    window.topoMonitor.onProbe((info) => {
      if (!info || !info.key) return;
      const did = info.deviceId || deviceIdFromMonitorKey(info.key);
      const host = info.host || '';
      const ms = state.monitorStatus[did];
      if (!ms || !ms.perHost || !ms.perHost[host]) return;
      ms.perHost[host].probeOk = info.ok;
      ms.perHost[host].probeLatency = info.latencyMs;
      ms.perHost[host].probeFailSince = info.failSince;
      ms.state = aggregateMonitorState(ms.perHost);
      ms.text = aggregateMonitorText(ms.perHost);
      refreshPanel();
      renderSelCard();
    });
  }
  if (window.topoMonitor && window.topoMonitor.onAlert) {
    window.topoMonitor.onAlert((info) => {
      if (!info || !info.key) return;
      const did = info.deviceId || deviceIdFromMonitorKey(info.key);
      const host = info.host || '';
      const ms = state.monitorStatus[did];
      if (!ms || !ms.perHost || !ms.perHost[host]) return;
      if (info.matched) ms.perHost[host].alert = info.pattern || true;
      else delete ms.perHost[host].alert;
      ms.state = aggregateMonitorState(ms.perHost);
      ms.text = aggregateMonitorText(ms.perHost);
      refreshPanel();
      renderSelCard();
    });
  }
  if (window.topoMonitor && window.topoMonitor.onBackup) {
    window.topoMonitor.onBackup((info) => {
      if (!info || !info.key) return;
      const did = info.deviceId || deviceIdFromMonitorKey(info.key);
      const host = info.host || '';
      const ms = state.monitorStatus[did];
      if (!ms || !ms.perHost || !ms.perHost[host]) return;
      if (info.ok) {
        ms.perHost[host].backup = { name: info.name, changed: !!info.changed, first: !!info.first, added: info.added, removed: info.removed, error: null };
      } else {
        ms.perHost[host].backup = { name: null, changed: false, error: info.error || '备份失败' };
      }
      refreshPanel();
      renderSelCard();
    });
  }
}

/* 诊断条（F2 调试）已移除：常驻 setInterval 与全局捕获监听不再随生产包发布；
 * 需要排查交互问题时可在控制台临时挂载等价监听 */

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

/* ================= 设备后台静默监控（Telnet / SSH 定时采集，桌面版） ================= */
const MON_CFG_KEY = 'nettopo.monitorCfg';
const SECRET_PREFIX = 'enc:';

/** 密码等机密字段经主进程 safeStorage（Windows DPAPI 等）加密后落盘；无桥/不可用时密码不持久化 */
function secureBridge() {
  return (window.topoSecure && window.topoSecure.encryptSecret && window.topoSecure.decryptSecret) ? window.topoSecure : null;
}
async function saveMonitorCfg() {
  try {
    const sec = secureBridge();
    const cfg = JSON.parse(JSON.stringify(state.monitorCfg)); // 深拷贝：不改写内存中的明文
    for (const k of Object.keys(cfg)) {
      const hosts = (cfg[k] && Array.isArray(cfg[k].hosts)) ? cfg[k].hosts : [];
      for (const h of hosts) {
        if (!h || typeof h !== 'object' || !h.password) { if (h && typeof h === 'object') h.password = ''; continue; }
        if (sec) {
          try {
            const r = await sec.encryptSecret(h.password);
            h.password = (r && r.ok && r.cipher) ? SECRET_PREFIX + r.cipher : ''; // 加密失败则密码不落盘
          } catch (e) { h.password = ''; }
        } else {
          h.password = ''; // 无加密能力（如浏览器版）：密码仅本次运行内存
        }
      }
    }
    localStorage.setItem(MON_CFG_KEY, JSON.stringify(cfg));
  } catch (e) { /* 存储超限忽略 */ }
}
async function loadMonitorCfg() {
  try {
    const raw = localStorage.getItem(MON_CFG_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    if (!obj || typeof obj !== 'object') return {};
    const sec = secureBridge();
    for (const k of Object.keys(obj)) {
      const hosts = (obj[k] && Array.isArray(obj[k].hosts)) ? obj[k].hosts : [];
      for (const h of hosts) {
        if (h && typeof h === 'object' && typeof h.password === 'string' && h.password.indexOf(SECRET_PREFIX) === 0) {
          if (sec) {
            try {
              const r = await sec.decryptSecret(h.password.slice(SECRET_PREFIX.length));
              h.password = (r && r.ok) ? r.text : '';
            } catch (e) { h.password = ''; }
          } else h.password = '';
        }
        // 旧版明文残留：下次保存时统一加密；本轮不落盘新明文
      }
    }
    return obj;
  } catch (e) { return {}; }
}

/** 返回 topoMonitor 桥；缺失（浏览器版）时提示并返回 null */
function monitorBridge() {
  if (window.topoMonitor && window.topoMonitor.start) return window.topoMonitor;
  toast('后台监控需要桌面版 NetTopo（Electron）环境');
  return null;
}

/** 侧栏监控状态标记 HTML（无状态返回空串） */
/** 监控任务 key：nodeId@host（同一设备多个管理口各一个任务） */
function monitorKey(nodeId, host) { return String(nodeId) + '@' + String(host); }

/** 从 hostKey 解析设备 id */
function deviceIdFromMonitorKey(key) {
  const i = String(key || '').lastIndexOf('@');
  return i > 0 ? key.slice(0, i) : String(key || '');
}

/** 聚合同一设备多个管理口的监控状态：任一错误→error；否则任一重连/连接中→对应态；全部监控中→monitoring */
function aggregateMonitorState(perHost) {
  const states = Object.values(perHost || {});
  if (!states.length) return null;
  if (states.some(s => s && s.alert)) return 'alert';
  if (states.some(s => s && s.probeOk === false)) return 'offline';
  if (states.some(s => s && s.state === 'error')) return 'error';
  if (states.some(s => s && s.state === 'reconnecting')) return 'reconnecting';
  if (states.some(s => s && s.state === 'connecting')) return 'connecting';
  if (states.every(s => s && s.state === 'monitoring')) return 'monitoring';
  return 'connecting';
}
/** 聚合文本：各管理口状态摘要 */
function aggregateMonitorText(perHost) {
  const arr = Object.entries(perHost || {});
  if (!arr.length) return '';
  return arr.map(([h, s]) => {
    let t = h + '：' + (s ? (s.text || s.state) : '未启动');
    if (s && s.alert) t += '【告警:' + s.alert + '】';
    else if (s && s.probeOk === false) t += '【探测离线】';
    if (s && s.backup && s.backup.error) t += '【备份失败】';
    else if (s && s.backup && s.backup.name) t += '【备份:' + (s.backup.first ? '首次' : (s.backup.changed ? '有变化' : '一致')) + '】';
    return t;
  }).join('；');
}

/** 命令字段统一为数组（兼容旧版单字符串配置） */
function normCmds(v, def) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/\r?\n/);
  const out = [];
  for (const c of arr) { const s = String(c == null ? '' : c).trim(); if (s) out.push(s); }
  return out.length ? out : (def || []);
}

/** 管理地址行：host + 各自连接方式（协议/端口/用户名/密码）+ 各自执行命令 + 仅读取开关 */
function monitorRow(host, saved) {
  saved = saved || {};
  return {
    host: String(host == null ? '' : host).trim(),
    protocol: saved.protocol || 'ssh',
    port: saved.port != null ? String(saved.port) : '',
    username: saved.username || 'admin',
    password: saved.password || '',
    commands: Array.isArray(saved.commands) ? saved.commands.slice() : [],
    onConnect: normCmds(saved.onConnect, []),
    readOnly: !!saved.readOnly,
    probeEnabled: !!saved.probeEnabled,
    probeType: saved.probeType === 'icmp' ? 'icmp' : 'tcp',
    probeIntervalSec: saved.probeIntervalSec != null ? saved.probeIntervalSec : 30,
    probePort: saved.probePort != null ? saved.probePort : '',
    alerts: Array.isArray(saved.alerts) ? saved.alerts.slice() : [],
    backupEnabled: !!saved.backupEnabled,
    backupCommand: normCmds(saved.backupCommand, ['display current-configuration']),
    backupMode: saved.backupMode === 'own' ? 'own' : 'session',
    backupIntervalSec: saved.backupIntervalSec != null ? saved.backupIntervalSec : 3600,
    backupWaitSec: saved.backupWaitSec != null ? saved.backupWaitSec : 3
  };
}

/** 规范化 hosts：兼容字符串数组（用共享连接方式/命令补全）与旧单 host，统一为行对象数组 */
function normalizeMonitorHosts(cfg) {
  cfg = cfg || {};
  const fill = (h) => {
    if (typeof h === 'string') return monitorRow(h, cfg);
    if (h && typeof h === 'object' && String(h.host || '').trim()) {
      return {
        host: String(h.host).trim(),
        protocol: h.protocol || 'ssh',
        port: h.port != null ? String(h.port) : '',
        username: h.username || 'admin',
        password: h.password || '',
        readOnly: !!h.readOnly,
        probeEnabled: !!h.probeEnabled,
        probeType: h.probeType === 'icmp' ? 'icmp' : 'tcp',
        probeIntervalSec: h.probeIntervalSec != null ? h.probeIntervalSec : 30,
        probePort: h.probePort != null ? h.probePort : '',
        alerts: Array.isArray(h.alerts) ? h.alerts.slice() : [],
        backupEnabled: !!h.backupEnabled,
        backupCommand: normCmds(h.backupCommand, ['display current-configuration']),
        backupMode: h.backupMode === 'own' ? 'own' : 'session',
        backupIntervalSec: h.backupIntervalSec != null ? h.backupIntervalSec : 3600,
        backupWaitSec: h.backupWaitSec != null ? h.backupWaitSec : 3,
        // 兼容旧配置：行内无 commands 时回退到设备级共享命令
        commands: Array.isArray(h.commands) ? h.commands.slice() : (Array.isArray(cfg.commands) ? cfg.commands.slice() : []),
        onConnect: normCmds(h.onConnect, cfg.onConnect ? normCmds(cfg.onConnect, []) : [])
      };
    }
    return null;
  };
  if (Array.isArray(cfg.hosts) && cfg.hosts.length) return cfg.hosts.map(fill).filter(Boolean);
  if (cfg.host && String(cfg.host).trim()) return [monitorRow(cfg.host, cfg)];
  return [];
}

/** 监控配置弹窗预填：已保存的 hosts 优先，否则用设备全部管理地址，否则留空一行 */
function monitorHostsForPrefill(saved, mgmts) {
  const rows = normalizeMonitorHosts(saved);
  if (rows.length) return rows;
  const all = (mgmts || []).map(h => String(h).trim()).filter(Boolean);
  return all.length ? all.map(h => monitorRow(h, saved)) : [monitorRow('', saved)];
}

function monitorBadgeHtml(nodeId) {
  const ms = state.monitorStatus[nodeId];
  if (!ms) return '';
  if (ms.state === 'alert') return '<span class="mon-badge alert" title="' + U.escHtml(ms.text || '输出匹配告警关键字') + '"></span>';
  if (ms.state === 'offline') return '<span class="mon-badge off" title="' + U.escHtml(ms.text || '设备探测离线') + '"></span>';
  if (ms.state === 'monitoring') return '<span class="mon-badge ok" title="' + U.escHtml(ms.text || '正在监控') + '"></span>';
  if (ms.state === 'connecting') return '<span class="mon-badge pending" title="' + U.escHtml(ms.text || '连接中') + '"></span>';
  if (ms.state === 'reconnecting') return '<span class="mon-badge pending" title="' + U.escHtml(ms.text || '重连中') + '"></span>';
  if (ms.state === 'error') return '<span class="mon-badge err" title="' + U.escHtml(ms.text || '监控异常') + '"></span>';
  return '';
}

/** 应用监控配置并同步主进程启停（每个管理地址独立连接方式：协议/端口/账号/密码） */
async function applyMonitor(id, cfg, enabled) {
  const node = state.nodes.find(n => n.id === id);
  const bridge = monitorBridge();
  if (enabled && !bridge) return;
  const hosts = normalizeMonitorHosts(cfg);
  try {
    if (enabled) {
      // 先校验后持久化：无效配置不落盘
      if (!hosts.length) { toast('请至少填写一个管理地址'); return false; }
      if (hosts.some(r => !r.readOnly && !(Array.isArray(r.commands) && r.commands.length) && !r.probeEnabled)) { toast('每个非「仅读取」的管理地址至少填写一条执行命令，或勾选「在线探测」仅探测'); return false; }
      const cleanCfg = {
        hosts,
        intervalSec: cfg.intervalSec,
        cmdDelayMs: cfg.cmdDelayMs
      };
      state.monitorCfg[id] = Object.assign({}, cleanCfg, { enabled: true });
      saveMonitorCfg().catch(() => {});
      const perHost = {};
      for (const r of hosts) perHost[r.host] = { state: 'connecting', text: '启动监控…', since: Date.now() };
      state.monitorStatus[id] = { state: 'connecting', text: aggregateMonitorText(perHost), perHost };
      refreshPanel();
      let allOk = true;
      for (const r of hosts) {
        // 复用 Web Shell 已信任的指纹（若此前通过 Web Shell 信任过该主机，则直接严格校验）
        let expectFp = '';
        try {
          const fp = localStorage.getItem('topoShellFp:' + r.host);
          if (fp && fp.indexOf('SHA256:') === 0) expectFp = fp;
        } catch (e) { expectFp = ''; }
        const res = await bridge.start(Object.assign(
          { key: monitorKey(id, r.host), deviceId: id, name: node ? node.name : '', expectFp, host: r.host },
          { protocol: r.protocol, port: r.port, username: r.username, password: r.password },
          { commands: r.readOnly ? [] : r.commands, readOnly: !!r.readOnly, onConnect: r.onConnect || [], intervalSec: cleanCfg.intervalSec, cmdDelayMs: cleanCfg.cmdDelayMs },
          { probe: { enabled: r.probeEnabled, type: r.probeType, intervalSec: r.probeIntervalSec, port: r.probePort || 0 } },
          { alerts: r.alerts },
          { backup: { enabled: r.backupEnabled, command: r.backupCommand, mode: r.backupMode, intervalSec: r.backupIntervalSec, waitMs: Math.round((r.backupWaitSec || 3) * 1000) } }
        ));
        if (!res || !res.ok) {
          perHost[r.host] = { state: 'error', text: (res && res.error) || '启动失败', since: Date.now() };
          allOk = false;
        }
      }
      state.monitorStatus[id] = { state: aggregateMonitorState(perHost) || 'connecting', text: aggregateMonitorText(perHost), perHost };
      refreshPanel();
      if (allOk) toast('已启动后台监控：' + (node ? node.name : id) + '（' + hosts.length + ' 个管理口）');
      else toast('部分管理口启动失败：' + (node ? node.name : id));
      return allOk;
    } else {
      // 停止：仅翻转启用位，不覆盖已保存的 hosts/密码（调用方可能传入脱敏后的配置）
      if (state.monitorCfg[id]) {
        state.monitorCfg[id].enabled = false;
        saveMonitorCfg().catch(() => {});
      } else {
        state.monitorCfg[id] = { hosts: [], enabled: false };
      }
      if (bridge) bridge.stop(id); // deviceId 作用域：停止该设备全部管理口任务
      delete state.monitorStatus[id];
      refreshPanel();
      toast('已停止后台监控');
      return true;
    }
  } catch (err) {
    toast('监控操作失败：' + String(err && err.message || err));
    return false;
  }
}

function stopMonitorForNode(id) {
  const bridge = monitorBridge();
  if (bridge) bridge.stop(id);
  delete state.monitorStatus[id];
}

/** 让启用了监控的设备与主进程运行状态对齐：期望集合 = deviceId@host，停止多余任务、启动缺失任务 */
async function reconcileMonitors() {
  const bridge = monitorBridge();
  if (!bridge) return;
  // 简单互斥：fire-and-forget 的多处调用（loadGraph/loadProject/restoreGraph）并发时防止重复 start
  if (reconcileMonitors._busy) return;
  reconcileMonitors._busy = true;
  try {
  const validIds = new Set(state.nodes.map(n => n.id));
  // 清理已不存在节点的配置
  let changed = false;
  for (const k of Object.keys(state.monitorCfg)) {
    if (!validIds.has(k)) { delete state.monitorCfg[k]; changed = true; }
  }
  if (changed) saveMonitorCfg().catch(() => {});
  // 期望任务集合：hostKey -> {cfg, row, node}
  const desired = new Map();
  for (const n of state.nodes) {
    const cfg = state.monitorCfg[n.id];
    if (!cfg || !cfg.enabled) continue;
    for (const r of normalizeMonitorHosts(cfg)) desired.set(monitorKey(n.id, r.host), { cfg, row: r, node: n });
  }
  // 当前主进程任务
  let current = [];
  try { const res = await bridge.status(); current = (res && res.ok && Array.isArray(res.items)) ? res.items : []; } catch (e) {}
  const currentByKey = new Map(current.map(it => [it.key, it]));
  // 停止不在期望集合中的任务
  for (const it of current) {
    if (!desired.has(it.key)) { try { await bridge.stop(it.key); } catch (e) {} }
  }
  // 启动缺失任务，并构造每设备聚合状态（每个地址用各自连接方式）
  const perDev = {};
  for (const [hk, { cfg, row, node }] of desired) {
    if (!perDev[node.id]) perDev[node.id] = {};
    const cur = currentByKey.get(hk);
    if (cur && (cur.state === 'monitoring' || cur.state === 'connecting' || cur.state === 'reconnecting')) {
      perDev[node.id][row.host] = { state: cur.state, text: cur.text, since: cur.since };
      continue;
    }
    perDev[node.id][row.host] = { state: 'connecting', text: '启动监控…', since: Date.now() };
    try {
      let expectFp = '';
      try { const fp = localStorage.getItem('topoShellFp:' + row.host); if (fp && fp.indexOf('SHA256:') === 0) expectFp = fp; } catch (e) {}
      const res = await bridge.start(Object.assign(
        { key: hk, deviceId: node.id, name: node.name, expectFp, host: row.host },
        { protocol: row.protocol, port: row.port, username: row.username, password: row.password },
        { commands: row.readOnly ? [] : (Array.isArray(row.commands) ? row.commands : []), readOnly: !!row.readOnly, onConnect: row.onConnect || [], intervalSec: cfg.intervalSec, cmdDelayMs: cfg.cmdDelayMs },
        { probe: { enabled: row.probeEnabled, type: row.probeType, intervalSec: row.probeIntervalSec, port: row.probePort || 0 } },
        { alerts: row.alerts },
        { backup: { enabled: row.backupEnabled, command: row.backupCommand, mode: row.backupMode, intervalSec: row.backupIntervalSec, waitMs: Math.round((row.backupWaitSec || 3) * 1000) } }
      ));
      if (!res || !res.ok) perDev[node.id][row.host] = { state: 'error', text: (res && res.error) || '启动失败', since: Date.now() };
    } catch (err) {
      perDev[node.id][row.host] = { state: 'error', text: String(err && err.message || err), since: Date.now() };
    }
  }
  for (const n of state.nodes) {
    if (perDev[n.id]) {
      state.monitorStatus[n.id] = { state: aggregateMonitorState(perDev[n.id]) || 'connecting', text: aggregateMonitorText(perDev[n.id]), perHost: perDev[n.id] };
    }
  }
  refreshPanel();
  } finally {
    reconcileMonitors._busy = false;
  }
}

/** 从主进程拉取当前运行状态并刷新侧栏（按设备聚合成 perHost 明细） */
async function syncMonitorStatus() {
  const bridge = monitorBridge();
  if (!bridge) return;
  try {
    const res = await bridge.status();
    const items = (res && res.ok && Array.isArray(res.items)) ? res.items : [];
    const perDev = {};
    for (const it of items) {
      const did = it.deviceId || deviceIdFromMonitorKey(it.key);
      const host = it.host || '';
      if (!perDev[did]) perDev[did] = {};
      perDev[did][host] = { state: it.state, text: it.text, since: it.since, probeOk: it.probeOk, alert: it.alert, backup: it.backup };
    }
    const next = {};
    for (const [did, perHost] of Object.entries(perDev)) {
      next[did] = { state: aggregateMonitorState(perHost) || 'connecting', text: aggregateMonitorText(perHost), perHost };
    }
    state.monitorStatus = next;
    refreshPanel();
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 监控配置弹窗 ---------------- */
function openMonitorConfig(id) {
  const n = state.nodes.find(x => x.id === id);
  if (!n) return;
  const bridge = monitorBridge();
  if (!bridge) return;
  const saved = state.monitorCfg[id] || {};
  const mgmts = U.nodeMgmts(n);
  const rootNode = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal ws-dialog mon-dialog" role="dialog" style="width:640px">
      <h3>设备后台监控 — ${U.escHtml(n.name)}</h3>
      <div class="m-sub">通过 Telnet 或 SSH 在后台静默连接设备，按循环周期定时执行命令，全部输出连同时间戳保存到本地日志（按日期自动归档）。每个管理地址可单独开启<b>连接时执行命令</b>（每次连接成功仅执行一次，先于周期循环，适用于登录后会话初始化命令）、<b>在线探测</b>（TCP/ICMP，离线告警）、<b>输出关键字告警</b>与<b>配置自动备份</b>（定时抓取配置并保留历史，可对比差异）。</div>
      <div class="frow">
        <label>管理地址与执行配置 <span style="color:var(--muted);font-weight:400">（每个地址可单独设置协议 / 端口 / 账号 / 密码 / 执行命令 / 连接时命令）</span></label>
        <div id="monHostList" class="mon-host-list"></div>
        <button type="button" class="tb mon-host-add" data-act="addHost">＋ 增加管理地址</button>
      </div>
      <div class="frow"><div class="frow-inline">
        <div class="frow"><label>循环间隔（秒，每轮命令之间）</label><input id="monInterval" type="number" min="1" value="${U.escHtml(saved.intervalSec != null ? saved.intervalSec : 300)}"/></div>
        <div class="frow"><label>命令间隔（秒，一轮内命令之间）</label><input id="monCmdDelay" type="number" min="0" step="0.1" value="${U.escHtml(saved.cmdDelayMs != null ? saved.cmdDelayMs / 1000 : 1)}"/></div>
      </div></div>
      <div class="frow" style="display:flex;align-items:center;gap:16px">
        <label style="display:flex;align-items:center;gap:6px;margin:0"><input id="monEnable" type="checkbox" style="width:auto"${saved.enabled ? ' checked' : ''}/>启用后台监控</label>
        <label style="display:flex;align-items:center;gap:6px;margin:0" title="设备离线 / 输出匹配告警关键字 / 备份失败时弹出系统通知"><input id="monNotify" type="checkbox" style="width:auto" checked/>离线/告警/备份失败时弹系统通知</label>
        <label style="display:flex;align-items:center;gap:6px;margin:0" title="关闭主窗口后应用最小化到系统托盘，后台监控继续运行"><input id="monTray" type="checkbox" style="width:auto"/>托盘常驻（关窗后后台继续监控）</label>
      </div>
      <div id="monStatus" class="m-sub" style="margin-top:4px"></div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="cancel">取消</button>
        <button type="button" class="tb" data-act="browse" style="display:${bridge.logsTree ? '' : 'none'}">日志浏览器…</button>
        <button type="button" class="tb" data-act="bk" style="display:${window.topoConfigBackup ? '' : 'none'}">配置备份…</button>
        <button type="button" class="tb" data-act="logs" style="display:${bridge.openLogs ? '' : 'none'}">打开日志目录</button>
        <button type="button" class="tb primary" data-act="save">保存</button>
      </div>
    </div>`;
  rootNode.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  // ---- 管理地址行列表（每行独立协议/端口/账号/密码） ----
  const listEl = ov.querySelector('#monHostList');
  const protoOpts = '<option value="ssh">SSH</option><option value="telnet">Telnet</option>';
  const rowHtml = (r) => `
    <div class="mon-host-row">
      <input class="mh-host" type="text" placeholder="管理地址" value="${U.escHtml(r.host)}" autocomplete="off"/>
      <select class="mh-proto">${protoOpts.replace('value="ssh"', 'value="ssh"' + (r.protocol === 'ssh' ? ' selected' : '')).replace('value="telnet"', 'value="telnet"' + (r.protocol === 'telnet' ? ' selected' : ''))}</select>
      <input class="mh-port" type="number" min="1" max="65535" placeholder="端口" value="${U.escHtml(r.port)}"/>
      <input class="mh-user" type="text" placeholder="用户名" value="${U.escHtml(r.username)}" autocomplete="off"/>
      <input class="mh-pass" type="password" placeholder="密码" value="${U.escHtml(r.password)}" autocomplete="new-password"/>
      <button type="button" class="tb mh-cmd-btn" title="设置该地址的执行命令">命令${Array.isArray(r.commands) && r.commands.length ? `（${r.commands.length}）` : ''}</button>
      <label class="mh-ro" title="仅读取模式：只记录设备主动输出的内容，不执行周期循环命令（连接时执行命令仍会执行一次，输出同样参与关键字告警匹配）"><input type="checkbox" class="mh-ro-cb"${r.readOnly ? ' checked' : ''}/>仅读取</label>
      <button type="button" class="tb icon mh-del" title="删除该管理地址">✕</button>
      <div class="mh-cmds-wrap" hidden><textarea class="mh-cmds" rows="3" placeholder="该地址的执行命令（每行一条）：&#10;display version&#10;display current-configuration">${U.escHtml(Array.isArray(r.commands) ? r.commands.join('\n') : '')}</textarea></div>
      <div class="mh-ext">
        <label class="mh-onc" title="连接时执行命令：每次连接成功（含自动重连）仅执行一次，先于周期循环命令发出；每行一条，依次执行">连接时
          <textarea class="mh-onc-ta" rows="2" placeholder="命令（每行一条，连接成功时依次执行）">${U.escHtml(Array.isArray(r.onConnect) ? r.onConnect.join('\n') : (r.onConnect || ''))}</textarea>
        </label>
        <label class="mh-pr" title="按间隔探测该地址连通性，失败时侧栏变红并弹通知（仅读取模式同样适用）"><input type="checkbox" class="mh-pr-cb"${r.probeEnabled ? ' checked' : ''}/>在线探测</label>
        <select class="mh-pr-type" title="探测方式"><option value="tcp"${r.probeType !== 'icmp' ? ' selected' : ''}>TCP</option><option value="icmp"${r.probeType === 'icmp' ? ' selected' : ''}>ICMP</option></select>
        <input class="mh-pr-int" type="number" min="5" max="3600" title="探测间隔（秒）" value="${U.escHtml(r.probeIntervalSec)}"/><span class="mh-unit">秒</span>
        <input class="mh-pr-port" type="number" min="1" max="65535" placeholder="端口(默认管理口)" title="探测目标端口，留空 = 管理端口" value="${U.escHtml(r.probePort)}"/>
        <button type="button" class="tb mh-alert-btn" title="输出匹配这些关键字时告警">告警${Array.isArray(r.alerts) && r.alerts.length ? '（' + r.alerts.length + '）' : ''}</button>
        <label class="mh-bk" title="定时抓取配置保存为备份，保留历史并可对比差异"><input type="checkbox" class="mh-bk-cb"${r.backupEnabled ? ' checked' : ''}/>自动备份</label>
        <select class="mh-bk-mode" title="备份连接方式：复用监控连接 = 在监控会话内执行备份命令；独立连接 = 每次备份单独建立连接，不干扰监控会话">
          <option value="session"${r.backupMode !== 'own' ? ' selected' : ''}>复用监控连接</option>
          <option value="own"${r.backupMode === 'own' ? ' selected' : ''}>独立连接</option>
        </select>
        <textarea class="mh-bk-ta" rows="2" placeholder="备份命令（每行一条，依次执行并合并保存）" title="抓取配置的命令，可多条">${U.escHtml(Array.isArray(r.backupCommand) ? r.backupCommand.join('\n') : (r.backupCommand || ''))}</textarea>
        <input class="mh-bk-int" type="number" min="1" max="1440" title="备份间隔（分钟）" value="${U.escHtml(Math.round((r.backupIntervalSec || 3600) / 60))}"/><span class="mh-unit">分钟</span>
        <div class="mh-alerts-wrap" hidden><textarea class="mh-alerts" rows="2" placeholder="每行一个正则表达式，输出匹配即告警；可写：error|down # 接口异常">${U.escHtml(Array.isArray(r.alerts) ? r.alerts.map(a => (a && typeof a === 'object' ? (a.pattern || '') + (a.note && a.note !== (a.pattern || '') ? ' # ' + a.note : '') : String(a))) .join('\n') : '')}</textarea></div>
      </div>
    </div>`;
  const autoPort = (proto) => proto === 'telnet' ? '23' : '22';
  const wireRow = (rowEl) => {
    const protoEl2 = rowEl.querySelector('.mh-proto');
    const portEl2 = rowEl.querySelector('.mh-port');
    protoEl2.addEventListener('change', () => {
      const cur = portEl2.value.trim();
      const otherDefault = autoPort(protoEl2.value) === '23' ? '22' : '23';
      if (!cur || cur === otherDefault) portEl2.value = autoPort(protoEl2.value);
    });
    const cmdBtn = rowEl.querySelector('.mh-cmd-btn');
    const cmdsWrap = rowEl.querySelector('.mh-cmds-wrap');
    cmdBtn.onclick = () => {
      const hidden = cmdsWrap.hasAttribute('hidden');
      cmdsWrap.toggleAttribute('hidden');
      cmdBtn.classList.toggle('on', hidden);
      if (hidden) cmdsWrap.querySelector('textarea').focus();
    };
    const roCb = rowEl.querySelector('.mh-ro-cb');
    // 仅读取禁用的控件：仅周期命令按钮（连接时命令、在线探测、自动备份在仅读取模式下仍可用）
    const extEls = [];
    const applyRo = () => {
      cmdBtn.disabled = roCb.checked;
      cmdBtn.style.opacity = roCb.checked ? '0.45' : '';
      if (roCb.checked) { cmdsWrap.setAttribute('hidden', ''); cmdBtn.classList.remove('on'); }
      for (const el of extEls) { el.disabled = roCb.checked; el.style.opacity = roCb.checked ? '0.45' : ''; }
    };
    roCb.addEventListener('change', applyRo);
    applyRo();
    const alertBtn = rowEl.querySelector('.mh-alert-btn');
    const alertsWrap = rowEl.querySelector('.mh-alerts-wrap');
    alertBtn.onclick = () => {
      const hidden = alertsWrap.hasAttribute('hidden');
      alertsWrap.toggleAttribute('hidden');
      alertBtn.classList.toggle('on', hidden);
      if (hidden) alertsWrap.querySelector('textarea').focus();
    };
    rowEl.querySelector('.mh-del').onclick = () => rowEl.remove();
    for (const inp of rowEl.querySelectorAll('input, select')) {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
    }
  };
  const addRow = (r) => {
    const d = document.createElement('div');
    d.innerHTML = rowHtml(r || { host: '', protocol: 'ssh', port: '', username: 'admin', password: '', commands: [] });
    const rowEl = d.firstElementChild;
    listEl.appendChild(rowEl);
    wireRow(rowEl);
    return rowEl;
  };
  const prefillRows = monitorHostsForPrefill(saved, mgmts);
  if (!prefillRows.length) prefillRows.push(monitorRow('', saved));
  for (const r of prefillRows) addRow(r);
  const addBtn = ov.querySelector('[data-act=addHost]');
  addBtn.onclick = () => { const el = addRow(); setTimeout(() => el.querySelector('.mh-host').focus(), 50); };

  const renderStatus = () => {
    const st = state.monitorStatus[id];
    ov.querySelector('#monStatus').textContent = st
      ? '当前状态：' + (st.text || st.state)
      : (saved.enabled ? '当前状态：已配置（未运行）' : '当前状态：未启用');
  };
  renderStatus();
  if (bridge.getSettings) {
    bridge.getSettings().then((r) => {
      if (r && r.ok && document.body.contains(ov)) {
        ov.querySelector('#monNotify').checked = !!r.notify;
        if (bridge.setTray) ov.querySelector('#monTray').checked = !!r.tray;
      }
    }).catch(() => {});
  }

  const doSave = async () => {
    const rows = [...listEl.querySelectorAll('.mon-host-row')].map(rowEl => {
      const alerts = rowEl.querySelector('.mh-alerts').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => {
        const i = s.indexOf('#');
        if (i > 0) return { pattern: s.slice(0, i).trim(), note: s.slice(i + 1).trim() };
        return { pattern: s, note: s };
      }).filter(a => a.pattern);
      return {
        host: rowEl.querySelector('.mh-host').value.trim(),
        protocol: rowEl.querySelector('.mh-proto').value,
        port: rowEl.querySelector('.mh-port').value.trim(),
        username: rowEl.querySelector('.mh-user').value.trim(),
        password: rowEl.querySelector('.mh-pass').value,
        readOnly: rowEl.querySelector('.mh-ro-cb').checked,
        commands: rowEl.querySelector('.mh-cmds').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
        onConnect: rowEl.querySelector('.mh-onc-ta').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
        probeEnabled: rowEl.querySelector('.mh-pr-cb').checked,
        probeType: rowEl.querySelector('.mh-pr-type').value,
        probeIntervalSec: Math.max(5, Math.min(3600, parseInt(rowEl.querySelector('.mh-pr-int').value, 10) || 30)),
        probePort: parseInt(rowEl.querySelector('.mh-pr-port').value, 10) > 0 ? parseInt(rowEl.querySelector('.mh-pr-port').value, 10) : '',
        alerts,
        backupEnabled: rowEl.querySelector('.mh-bk-cb').checked,
        backupCommand: (() => { const v = rowEl.querySelector('.mh-bk-ta').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean); return v.length ? v : ['display current-configuration']; })(),
        backupMode: rowEl.querySelector('.mh-bk-mode').value,
        backupIntervalSec: Math.max(1, Math.min(1440, parseInt(rowEl.querySelector('.mh-bk-int').value, 10) || 60)) * 60,
        backupWaitSec: 3
      };
    }).filter(r => r.host);
    if (!rows.length) { toast('请至少填写一个管理地址'); return; }
    if (rows.some(r => !r.readOnly && !r.commands.length && !r.probeEnabled)) { toast('每个非「仅读取」的管理地址至少填写一条执行命令，或勾选「在线探测」仅探测'); return; }
    const intervalSec = parseFloat(ov.querySelector('#monInterval').value);
    if (!Number.isFinite(intervalSec) || intervalSec < 1) { toast('循环间隔需 ≥ 1 秒'); return; }
    const cfg = {
      hosts: rows,
      intervalSec: Math.round(intervalSec),
      cmdDelayMs: Math.round((parseFloat(ov.querySelector('#monCmdDelay').value) || 0) * 1000)
    };
    const enabled = ov.querySelector('#monEnable').checked;
    const notify = ov.querySelector('#monNotify').checked;
    if (bridge.setSettings) { try { await bridge.setSettings(notify); } catch (e) {} }
    if (bridge.setTray) { try { await bridge.setTray(ov.querySelector('#monTray').checked); } catch (e) {} }
    close();
    await applyMonitor(id, cfg, enabled);
  };
  ov.querySelector('[data-act=cancel]').onclick = close;
  ov.querySelector('[data-act=save]').onclick = doSave;
  ov.querySelector('[data-act=logs]').onclick = async () => {
    try { await bridge.openLogs(id); }
    catch (e) { toast('无法打开日志目录'); }
  };
  ov.querySelector('[data-act=browse]').onclick = () => { close(); openMonitorLogs(id); };
  ov.querySelector('[data-act=bk]').onclick = () => { close(); openConfigBackups(id); };
  for (const sel of ['#monInterval', '#monCmdDelay']) {
    ov.querySelector(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
  }
  setTimeout(() => { if (document.body.contains(ov)) { const f = listEl.querySelector('.mh-host'); if (f) f.focus(); } }, 250);
}

/* ================= 监控中心总览（设备状态 + 告警历史 + 备份差异） ================= */
function openMonitorCenter() {
  const bridge = monitorBridge();
  if (!bridge || !bridge.overview) { toast('监控中心需要桌面版 NetTopo（Electron）环境'); return; }
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal mc-dialog" role="dialog" style="width:960px;height:82vh">
      <h3>监控中心</h3>
      <div class="m-sub">所有设备的监控状态、告警事件与配置备份差异一览（实时刷新）。</div>
      <div class="mc-stats">
        <div class="mc-stat"><b id="mcSTotal">0</b><span>监控任务</span></div>
        <div class="mc-stat s-ok"><b id="mcSOk">0</b><span>在线</span></div>
        <div class="mc-stat s-off"><b id="mcSOff">0</b><span>离线</span></div>
        <div class="mc-stat s-alert"><b id="mcSAlert">0</b><span>告警中</span></div>
        <div class="mc-stat"><b id="mcSBak">0</b><span>备份设备</span></div>
      </div>
      <div class="mc-main">
        <div class="mc-col">
          <div class="mc-h">设备监控状态</div>
          <div class="mc-jobs" id="mcJobs"></div>
        </div>
        <div class="mc-col">
          <div class="mc-tabs">
            <button type="button" class="mc-tab on" data-pane="events">事件时间线</button>
            <button type="button" class="mc-tab" data-pane="baks">配置备份</button>
            <span id="mcFilter" class="mc-filt" hidden></span>
          </div>
          <div class="mc-pane" data-pane="events">
            <div class="mc-events" id="mcEvents"></div>
          </div>
          <div class="mc-pane" data-pane="baks" hidden>
            <div class="mc-baks" id="mcBaks"></div>
          </div>
        </div>
      </div>
      <div class="m-actions">
        <button type="button" class="tb" data-act="refresh">刷新</button>
        <button type="button" class="tb primary" data-act="close">关闭</button>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  ov.querySelector('[data-act=close]').onclick = close;
  ov.querySelector('[data-act=refresh]').onclick = load;
  const jobsEl = ov.querySelector('#mcJobs');
  const evsEl = ov.querySelector('#mcEvents');
  const baksEl = ov.querySelector('#mcBaks');
  // 事件时间线 / 配置备份 标签切换
  ov.querySelectorAll('.mc-tab').forEach(tab => {
    tab.onclick = () => {
      ov.querySelectorAll('.mc-tab').forEach(t => t.classList.toggle('on', t === tab));
      ov.querySelectorAll('.mc-pane').forEach(p => { p.hidden = p.dataset.pane !== tab.dataset.pane; });
    };
  });

  const stateIcon = (s) => {
    if (s && s.alert) return '<span class="mc-dot alert"></span>';
    if (s && s.probeOk === false) return '<span class="mc-dot off"></span>';
    if (s && s.state === 'monitoring') return '<span class="mc-dot ok"></span>';
    if (s && (s.state === 'connecting' || s.state === 'reconnecting')) return '<span class="mc-dot pending"></span>';
    if (s && s.state === 'error') return '<span class="mc-dot err"></span>';
    return '<span class="mc-dot none"></span>';
  };
  const evIcon = (t) => ({
    offline: '🔴', recovery: '🟢', alert: '🟠', 'alert-clear': '⚪',
    backup: '📦', 'backup-change': '📦', 'backup-error': '❌'
  }[t] || '•');
  const evTypeLabel = {
    offline: '离线', recovery: '恢复', alert: '告警', 'alert-clear': '解除',
    backup: '备份', 'backup-change': '配置变化', 'backup-error': '备份失败'
  };
  // 事件时间线筛选：null = 全部；curDev = 设备；curHost = 具体管理地址
  let curDev = null, curHost = null, curDevName = '';
  const filterEl = ov.querySelector('#mcFilter');
  const setFilter = (devId, host, name) => {
    if (curDev === devId && curHost === (host || null)) { curDev = null; curHost = null; curDevName = ''; }
    else { curDev = devId; curHost = host || null; curDevName = name || devId || ''; }
    filterEl.hidden = !curDev;
    filterEl.textContent = curDev ? ('筛选：' + curDevName + (curHost ? '@' + curHost : '') + ' ✕') : '';
    load();
  };
  filterEl.onclick = () => { curDev = null; curHost = null; curDevName = ''; filterEl.hidden = true; filterEl.textContent = ''; load(); };

  async function load() {
    try {
      const r = await bridge.overview();
      if (!r || !r.ok) { jobsEl.innerHTML = '<div class="mc-empty">加载失败</div>'; return; }
      // 设备状态：按 job 展示（同一设备多地址合并为一行明细）
      const jobs = r.jobs || [];
      const byDev = new Map();
      for (const j of jobs) {
        if (!byDev.has(j.deviceId)) byDev.set(j.deviceId, []);
        byDev.get(j.deviceId).push(j);
      }
      jobsEl.innerHTML = byDev.size
        ? [...byDev.values()].map(arr => {
            const j = arr[0];
            const devSelCls = (curDev === j.deviceId && !curHost) ? ' sel' : '';
            const hosts = arr.map(h => {
              const icon = stateIcon(h);
              const bits = [];
              if (h.probeOk === false) bits.push('<b class="t-off">离线</b>');
              if (h.alert) bits.push('<b class="t-alert">告警:' + U.escHtml(h.alert) + '</b>');
              if (h.probeOk && h.probeLatency != null) bits.push(h.probeLatency + 'ms');
              if (h.backup && h.backup.error) bits.push('<b class="t-off">备份失败</b>');
              else if (h.backup && h.backup.name) bits.push(h.backup.first ? '首次备份' : (h.backup.changed ? '<b class="t-alert">备份有变化</b>' : '备份一致'));
              const selCls = (curDev === h.deviceId && curHost === h.host) ? ' sel' : '';
              return '<div class="mc-job' + selCls + '" data-dev="' + U.escHtml(h.deviceId) + '" data-name="' + U.escHtml(j.name || j.deviceId) + '" data-host="' + U.escHtml(h.host) + '" title="点击筛选该地址的事件">' + icon + ' <b>' + U.escHtml(h.host) + '</b> ' + (bits.length ? '<span class="mc-bits">' + bits.join(' · ') + '</span>' : '') + '</div>';
            }).join('');
            return '<div class="mc-dev"><div class="mc-dev-nm' + devSelCls + '" data-dev="' + U.escHtml(j.deviceId) + '" data-name="' + U.escHtml(j.name || j.deviceId) + '" title="点击筛选该设备的事件">' + U.escHtml(j.name || j.deviceId) + '</div>' + hosts + '</div>';
          }).join('')
        : '<div class="mc-empty">暂无监控任务（右键设备 → 设备监控 启动）</div>';
      // 设备名 / 管理地址可点击筛选事件时间线
      jobsEl.querySelectorAll('[data-dev]').forEach(el => {
        el.onclick = () => setFilter(el.dataset.dev, el.dataset.host || null, el.dataset.name || '');
      });
      // 事件时间线（按设备 / 地址筛选）
      const evs = (r.events || []).filter(e => (!curDev || e.deviceId === curDev) && (!curHost || (e.host === curHost && e.deviceId === curDev)));
      evsEl.innerHTML = evs.length
        ? evs.slice(0, 120).map(e => {
            const devTag = '<span class="mc-tag dev" data-dev="' + U.escHtml(e.deviceId || '') + '" data-name="' + U.escHtml(e.name || e.deviceId || '') + '"' + (e.host ? ' data-host="' + U.escHtml(e.host) + '"' : '') + ' title="点击筛选该设备的事件">' + U.escHtml(e.name || e.deviceId || '?') + '</span>';
            const typeTag = '<span class="mc-tag ' + U.escHtml(e.type || '') + '">' + U.escHtml(evTypeLabel[e.type] || e.type || '事件') + '</span>';
            return '<div class="mc-ev"><span class="mc-ev-ic">' + evIcon(e.type) + '</span><span class="mc-ev-t">' + U.escHtml(U.fmtDateTime(new Date(e.ts)).slice(11)) + '</span>' + devTag + typeTag + '<span class="mc-ev-d">' + U.escHtml(e.detail || '') + '</span></div>';
          }).join('')
        : '<div class="mc-empty">' + (curDev ? '该设备暂无事件' : '暂无事件') + '</div>';
      evsEl.querySelectorAll('.mc-tag.dev').forEach(el => {
        el.onclick = () => setFilter(el.dataset.dev, el.dataset.host || null, el.dataset.name || '');
      });
      // 备份
      const baks = r.backups || [];
      baksEl.innerHTML = baks.length
        ? baks.map(b => '<div class="mc-bak"><span class="mc-bak-nm">' + U.escHtml(b.device + '@' + b.host) + '</span><span class="mc-bak-sub">' + b.count + ' 份 · 最近 ' + U.escHtml(U.fmtDateTime(new Date(b.lastAt))) + '</span></div>').join('')
        : '<div class="mc-empty">暂无配置备份</div>';
      // 顶部统计（任务总数 / 在线 / 离线 / 告警中 / 备份设备）——与设备列表状态图标口径一致
      const statOk = jobs.filter(j => !j.alert && j.probeOk !== false && j.state === 'monitoring').length;
      const statOff = jobs.filter(j => j.probeOk === false).length;
      const statAlert = jobs.filter(j => !!j.alert).length;
      ov.querySelector('#mcSTotal').textContent = jobs.length;
      ov.querySelector('#mcSOk').textContent = statOk;
      ov.querySelector('#mcSOff').textContent = statOff;
      ov.querySelector('#mcSAlert').textContent = statAlert;
      ov.querySelector('#mcSBak').textContent = baks.length;
    } catch (e) { jobsEl.innerHTML = '<div class="mc-empty">加载失败</div>'; }
  }
  // 实时事件刷新
  const refreshOn = () => {
    if (document.body.contains(ov)) load();
  };
  if (window.topoMonitor) {
    const subs = [];
    for (const ch of ['onStatus', 'onProbe', 'onAlert', 'onBackup']) {
      if (typeof window.topoMonitor[ch] === 'function') {
        const fn = window.topoMonitor[ch];
        const cb = () => refreshOn();
        fn(cb);
        subs.push(cb);
      }
    }
  }
  load();
}

/* ================= 监控日志浏览器（按设备/日期浏览、搜索） ================= */
function openMonitorLogs(devicePreset) {
  const bridge = monitorBridge();
  if (!bridge || !bridge.logsTree) { toast('日志浏览器需要桌面版 NetTopo（Electron）环境'); return; }
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal lb-dialog" role="dialog" style="width:900px;height:78vh">
      <h3>监控日志浏览器</h3>
      <div class="m-sub">按设备 / 日期 / 文件浏览后台监控日志（<userData>\monitor-logs），可搜索关键字并高亮定位。</div>
      <div class="lb-main">
        <div class="lb-side">
          <div class="lb-nav">
            <label>设备</label><select id="lbDevice"></select>
            <label>日期</label><select id="lbDate"></select>
          </div>
          <div class="lb-files" id="lbFiles"></div>
        </div>
        <div class="lb-body">
          <div class="lb-toolbar">
            <input id="lbSearch" type="text" placeholder="搜索关键字…" autocomplete="off"/>
            <span id="lbCount" class="lb-count"></span>
            <button type="button" class="tb" id="lbPrev" title="上一个匹配">↑</button>
            <button type="button" class="tb" id="lbNext" title="下一个匹配">↓</button>
            <button type="button" class="tb" data-act="openfolder">打开目录</button>
            <button type="button" class="tb primary" data-act="close">关闭</button>
          </div>
          <pre class="lb-content" id="lbContent" spellcheck="false"></pre>
        </div>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  let tree = { devices: [] };
  let cur = { device: '', date: '', file: '' };
  const devSel = ov.querySelector('#lbDevice');
  const dateSel = ov.querySelector('#lbDate');
  const filesEl = ov.querySelector('#lbFiles');
  const contentEl = ov.querySelector('#lbContent');
  const searchEl = ov.querySelector('#lbSearch');
  let rawContent = '';
  let matches = [];   // {line, idx}
  let matchPos = -1;
  let globalHits = []; // 全局跨文件搜索扁平命中：{device,date,file,line,text}
  let hitPos = -1;
  let searchJob = 0;   // 竞态防护：只展示最后一次搜索的结果

  const renderFiles = () => {
    const dev = tree.devices.find(d => d.device === cur.device);
    const dt = dev && dev.dates.find(x => x.date === cur.date);
    const files = dt ? dt.files : [];
    filesEl.innerHTML = files.map(f => `<div class="lb-file${f.name === cur.file ? ' sel' : ''}" data-name="${U.escHtml(f.name)}"><span class="nm">${U.escHtml(f.name)}</span><span class="sub">${U.fmtSize(f.size)}</span></div>`).join('') || '<div class="lb-empty">该日期无日志文件</div>';
    filesEl.querySelectorAll('.lb-file').forEach(el => {
      el.onclick = async () => {
        cur.file = el.dataset.name;
        renderFiles();
        rawContent = '';
        try {
          const r = await bridge.logsRead(cur.device, cur.date, cur.file);
          if (r && r.ok) rawContent = r.content;
          else rawContent = '（读取失败：' + ((r && r.error) || '未知错误') + '）';
        } catch (e) { rawContent = '（读取失败）'; }
        // 点击具体文件：退出全局搜索态，直接浏览该文件
        if (searchEl.value.trim()) { searchEl.value = ''; globalHits = []; hitPos = -1; }
        renderFileWithTarget(-1);
      };
    });
  };
  const renderNav = () => {
    const devs = tree.devices.map(d => `<option value="${U.escHtml(d.device)}"${d.device === cur.device ? ' selected' : ''}>${U.escHtml(d.device)}</option>`).join('');
    devSel.innerHTML = devs || '<option value="">（无日志）</option>';
    const dev = tree.devices.find(d => d.device === cur.device);
    const dates = dev ? dev.dates.map(x => `<option value="${U.escHtml(x.date)}"${x.date === cur.date ? ' selected' : ''}>${U.escHtml(x.date)}</option>`).join('') : '';
    dateSel.innerHTML = dates || '<option value="">（无日期）</option>';
    renderFiles();
  };
  const applySearch = () => {
    const kw = searchEl.value.trim();
    if (!kw) { renderFileWithTarget(-1); return; }   // 无关键字：浏览当前文件
    doGlobalSearch(kw);                               // 有关键字：跨全部文件搜索
  };
  // 当前文件浏览渲染（targetLine >= 0 时定位高亮该行）
  const renderFileWithTarget = (targetLine) => {
    matches = [];
    matchPos = -1;
    const kw = searchEl.value.trim();
    const lines = rawContent ? rawContent.split('\n') : [];
    const lower = kw.toLowerCase();
    if (kw) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().indexOf(lower) >= 0) matches.push(i);
      }
    }
    const targetIdx = targetLine >= 0 ? targetLine : (matches.length ? matches[0] : -1);
    contentEl.innerHTML = lines.map((ln, i) => {
      let html = U.escHtml(ln);
      if (kw) {
        const idx = ln.toLowerCase().indexOf(lower);
        if (idx >= 0) html = U.escHtml(ln.slice(0, idx)) + '<mark>' + U.escHtml(ln.slice(idx, idx + kw.length)) + '</mark>' + U.escHtml(ln.slice(idx + kw.length));
      }
      return '<div class="lb-line' + (matches.includes(i) ? ' hit' : '') + (i === targetIdx ? ' cur' : '') + '">' + html + '</div>';
    }).join('');
    ov.querySelector('#lbCount').textContent = rawContent ? (matches.length ? matches.length + ' 处匹配' : lines.length + ' 行') : '';
    if (targetIdx >= 0) {
      const el = contentEl.querySelectorAll('.lb-line')[targetIdx];
      if (el) el.scrollIntoView({ block: 'center' });
    }
  };
  // 全局跨文件搜索：主进程扫全部日志文件，结果列表展示每个文件里的匹配行，点击跳转定位
  const doGlobalSearch = (kw) => {
    const my = ++searchJob;
    globalHits = [];
    hitPos = -1;
    clearTimeout(doGlobalSearch._t);
    doGlobalSearch._t = setTimeout(async () => {
      if (my !== searchJob) return; // 输入已变化，丢弃过期结果
      if (!bridge.logsSearch) { contentEl.innerHTML = '<div class="lb-empty">当前环境不支持全局搜索</div>'; ov.querySelector('#lbCount').textContent = ''; return; }
      let r = null;
      try { r = await bridge.logsSearch(kw); } catch (e) { r = null; }
      if (my !== searchJob) return;
      if (!r || !r.ok) {
        contentEl.innerHTML = '<div class="lb-empty">搜索失败：' + U.escHtml((r && r.error) || '未知错误') + '</div>';
        ov.querySelector('#lbCount').textContent = '';
        return;
      }
      for (const it of (r.items || [])) {
        for (const mt of (it.matches || [])) globalHits.push({ device: it.device, date: it.date, file: it.file, line: mt.line, text: mt.text });
      }
      ov.querySelector('#lbCount').textContent = r.total + ' 处匹配（' + (r.items || []).length + ' 个文件）';
      if (!globalHits.length) { contentEl.innerHTML = '<div class="lb-empty">未找到匹配内容</div>'; return; }
      const kv = kw.toLowerCase();
      contentEl.innerHTML = globalHits.map((h, i) => {
        const idx = h.text.toLowerCase().indexOf(kv);
        let html = U.escHtml(h.text);
        if (idx >= 0) html = U.escHtml(h.text.slice(0, idx)) + '<mark>' + U.escHtml(h.text.slice(idx, idx + kw.length)) + '</mark>' + U.escHtml(h.text.slice(idx + kw.length));
        return '<div class="lb-sres" data-i="' + i + '">'
          + '<span class="fr">' + U.escHtml(h.device) + ' / ' + U.escHtml(h.date) + ' / ' + U.escHtml(h.file) + ' · 第 ' + (h.line + 1) + ' 行</span>'
          + '<span class="mt">' + html + '</span></div>';
      }).join('');
      contentEl.querySelectorAll('.lb-sres').forEach(el => {
        el.onclick = () => loadHit(parseInt(el.dataset.i, 10));
      });
    }, 300);
  };
  // 加载命中文件并定位到匹配行（同步侧栏/日期选择器）
  const loadHit = async (i) => {
    if (!globalHits.length) return;
    const h = globalHits[i];
    hitPos = i;
    cur.device = h.device; cur.date = h.date; cur.file = h.file;
    devSel.value = h.device;
    dateSel.value = h.date;
    renderNav();
    rawContent = '';
    try { const r = await bridge.logsRead(h.device, h.date, h.file); if (r && r.ok) rawContent = r.content; } catch (e) { rawContent = ''; }
    renderFileWithTarget(h.line);
  };
  const jumpTo = (pos) => {
    if (!matches.length) return;
    matchPos = (pos + matches.length) % matches.length;
    const lineEls = contentEl.querySelectorAll('.lb-line');
    lineEls.forEach((el, i) => el.classList.toggle('cur', i === matches[matchPos]));
    const el = lineEls[matches[matchPos]];
    if (el) el.scrollIntoView({ block: 'center' });
  };
  devSel.addEventListener('change', () => {
    cur.device = devSel.value;
    const dev = tree.devices.find(d => d.device === cur.device);
    cur.date = dev && dev.dates.length ? dev.dates[0].date : '';
    cur.file = '';
    rawContent = '';
    renderNav();
    applySearch();
  });
  dateSel.addEventListener('change', () => {
    cur.date = dateSel.value;
    cur.file = '';
    rawContent = '';
    renderNav();
    applySearch();
  });
  searchEl.addEventListener('input', applySearch);
  const stepHit = (dir) => {
    // 全局搜索态：跨文件遍历全部命中；否则当前文件内跳转
    if (globalHits.length && searchEl.value.trim()) {
      const i = (hitPos + dir + globalHits.length) % globalHits.length;
      loadHit(i);
    } else jumpTo(matchPos + dir);
  };
  ov.querySelector('#lbPrev').onclick = () => stepHit(-1);
  ov.querySelector('#lbNext').onclick = () => stepHit(1);
  ov.querySelector('[data-act=openfolder]').onclick = async () => { try { await bridge.openLogs(cur.device || ''); } catch (e) {} };
  ov.querySelector('[data-act=close]').onclick = close;

  bridge.logsTree().then((r) => {
    if (r && r.ok) tree = r;
    if (devicePreset) {
      const hit = tree.devices.find(d => d.device === String(devicePreset));
      if (hit) { cur.device = hit.device; cur.date = hit.dates[0] ? hit.dates[0].date : ''; if (cur.date && hit.dates[0].files.length) cur.file = hit.dates[0].files[0].name; }
    }
    if (!cur.device && tree.devices.length) {
      cur.device = tree.devices[0].device;
      cur.date = tree.devices[0].dates[0] ? tree.devices[0].dates[0].date : '';
      if (cur.date && tree.devices[0].dates[0].files.length) cur.file = tree.devices[0].dates[0].files[0].name;
    }
    renderNav();
    if (cur.file) {
      bridge.logsRead(cur.device, cur.date, cur.file).then((r2) => {
        if (r2 && r2.ok) rawContent = r2.content;
        applySearch();
      }).catch(() => applySearch());
    } else applySearch();
  }).catch(() => renderNav());
}

/* ================= 配置备份中心（自动备份的历史 + 对比差异） ================= */
function openConfigBackups(devicePreset) {
  if (!window.topoConfigBackup) { toast('配置备份需要桌面版 NetTopo（Electron）环境'); return; }
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal bk-dialog" role="dialog" style="width:980px;height:80vh">
      <h3>配置备份中心</h3>
      <div class="m-sub">监控中开启「自动备份」后，设备配置会按间隔抓取归档（<userData>\config-backups）。勾选两份备份可对比差异（旧 → 新）。</div>
      <div class="bk-main">
        <div class="bk-side">
          <div class="bk-hosts" id="bkHosts"></div>
          <div class="bk-files" id="bkFiles"></div>
        </div>
        <div class="bk-body">
          <div class="bk-toolbar">
            <span id="bkDiffInfo" class="bk-diffinfo"></span>
            <button type="button" class="tb" id="bkDiff" disabled>对比选中（旧 → 新）</button>
            <button type="button" class="tb" id="bkDelete" disabled>删除选中</button>
            <button type="button" class="tb" id="bkNow">立即备份当前地址</button>
            <button type="button" class="tb" data-act="openfolder">打开目录</button>
            <button type="button" class="tb primary" data-act="close">关闭</button>
          </div>
          <pre class="bk-content" id="bkContent" spellcheck="false"></pre>
        </div>
      </div>
    </div>`;
  root.appendChild(ov);
  ov.tabIndex = -1; ov.focus();
  const close = () => ov.remove();
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  let cur = { device: '', host: '' };
  let items = [];
  let sel = new Set();

  const hostEl = ov.querySelector('#bkHosts');
  const filesEl = ov.querySelector('#bkFiles');
  const contentEl = ov.querySelector('#bkContent');
  const diffBtn = ov.querySelector('#bkDiff');
  const delBtn = ov.querySelector('#bkDelete');
  const diffInfoEl = ov.querySelector('#bkDiffInfo');

  const renderFiles = () => {
    filesEl.innerHTML = items.map(f => `<label class="bk-file${sel.has(f.name) ? ' sel' : ''}" data-name="${U.escHtml(f.name)}"><input type="checkbox" class="bk-chk" data-name="${U.escHtml(f.name)}"${sel.has(f.name) ? ' checked' : ''}/><span class="nm">${U.escHtml(f.name)}</span><span class="sub">${U.fmtDateTime(new Date(f.time))} · ${U.fmtSize(f.size)}</span></label>`).join('') || '<div class="bk-empty">该地址暂无备份（开启监控的「自动备份」后自动生成）</div>';
    filesEl.querySelectorAll('.bk-file').forEach(el => {
      el.querySelector('input').addEventListener('change', () => {
        const name = el.dataset.name;
        if (sel.has(name)) sel.delete(name); else sel.add(name);
        if (sel.size > 2) { const first = sel.values().next().value; sel.delete(first); }
        renderFiles();
        updateBtns();
      });
      el.addEventListener('dblclick', () => viewFile(el.dataset.name));
    });
  };
  const updateBtns = () => {
    diffBtn.disabled = sel.size !== 2;
    delBtn.disabled = sel.size !== 1;
  };
  const viewFile = async (name) => {
    try {
      const r = await window.topoConfigBackup.read(cur.device, cur.host, name);
      contentEl.textContent = r && r.ok ? r.content : ('（读取失败：' + ((r && r.error) || '未知错误') + '）');
      diffInfoEl.textContent = '查看 ' + name;
    } catch (e) { contentEl.textContent = '（读取失败）'; }
  };
  const fmtDiff = (d) => {
    if (!d.ok) return '（对比失败：' + (d.error || '') + '）';
    if (!d.changed) return '两份备份内容一致';
    const html = [];
    for (const h of d.hunks) {
      if (h.type === 'ctx') {
        for (const ln of h.lines) html.push('<div class="dl-ctx"><span class="no">' + (ln.aNo || '') + '</span>' + U.escHtml(ln.text) + '</div>');
      } else {
        for (const ln of h.lines) {
          const cls = ln.type === 'add' ? 'dl-add' : (ln.type === 'del' ? 'dl-del' : 'dl-ctx');
          const no = ln.type === 'add' ? ln.bNo : (ln.type === 'del' ? ln.aNo : (ln.aNo || ''));
          const mark = ln.type === 'add' ? '+' : (ln.type === 'del' ? '-' : ' ');
          html.push('<div class="' + cls + '"><span class="no">' + (no || '') + '</span>' + mark + ' ' + U.escHtml(ln.text) + '</div>');
        }
      }
    }
    return html.join('');
  };
  const loadHosts = async () => {
    try {
      const r = await window.topoConfigBackup.hosts();
      const items2 = (r && r.ok && r.items) || [];
      hostEl.innerHTML = items2.map(h => `<div class="bk-host${h.device === cur.device && h.host === cur.host ? ' sel' : ''}" data-d="${U.escHtml(h.device)}" data-h="${U.escHtml(h.host)}"><span class="nm">${U.escHtml(h.device)}</span><span class="sub">${U.escHtml(h.host)} · ${h.count} 份 · 最近 ${U.fmtDateTime(new Date(h.lastAt))}</span></div>`).join('') || '<div class="bk-empty">暂无配置备份（开启监控的「自动备份」后自动生成）</div>';
      hostEl.querySelectorAll('.bk-host').forEach(el => {
        el.onclick = async () => {
          cur.device = el.dataset.d;
          cur.host = el.dataset.h;
          sel.clear();
          loadHosts();
          const r2 = await window.topoConfigBackup.list(cur.device, cur.host);
          items = (r2 && r2.ok && r2.items) || [];
          renderFiles();
          updateBtns();
          contentEl.textContent = '';
          diffInfoEl.textContent = '';
        };
      });
      if (devicePreset) {
        const hit = items2.find(h => h.device === String(devicePreset));
        if (hit) {
          cur.device = hit.device; cur.host = hit.host;
          const r2 = await window.topoConfigBackup.list(cur.device, cur.host);
          items = (r2 && r2.ok && r2.items) || [];
          loadHosts(); // 重绘选中态
          renderFiles();
          updateBtns();
          return;
        }
      }
    } catch (e) { hostEl.innerHTML = '<div class="bk-empty">加载失败</div>'; }
  };
  diffBtn.onclick = async () => {
    if (sel.size !== 2) return;
    const [a, b] = [...sel];
    // 时间早的作为旧版本
    const fa = items.find(i => i.name === a), fb = items.find(i => i.name === b);
    const [oldN, newN] = (fa && fb && fa.time <= fb.time) ? [a, b] : [b, a];
    try {
      const d = await window.topoConfigBackup.diff(cur.device, cur.host, oldN, newN);
      if (!d || !d.ok) { diffInfoEl.textContent = ''; contentEl.textContent = '（对比失败：' + ((d && d.error) || '') + '）'; return; }
      diffInfoEl.textContent = '对比 ' + oldN + ' → ' + newN + '（+' + (d.added || 0) + '/-' + (d.removed || 0) + ' 行）';
      contentEl.innerHTML = fmtDiff(d); // 行内容已逐行 escHtml；失败分支已改走 textContent
    } catch (e) { contentEl.textContent = '（对比失败）'; }
  };
  ov.querySelector('#bkNow').onclick = async () => {
    if (!cur.host) { toast('请先选择一个管理地址'); return; }
    if (!window.topoMonitor || !window.topoMonitor.runBackup) { toast('立即备份需要监控任务在运行'); return; }
    const key = monitorKey(cur.device, cur.host);
    const r = await window.topoMonitor.runBackup(key);
    if (r && r.ok) toast('已触发备份，稍后刷新列表查看');
    else toast((r && r.error) || '触发备份失败');
  };
  delBtn.onclick = async () => {
    if (sel.size !== 1) return;
    const name = [...sel][0];
    const r = await window.topoConfigBackup.remove(cur.device, cur.host, name);
    if (r && r.ok) { sel.clear(); const r2 = await window.topoConfigBackup.list(cur.device, cur.host); items = (r2 && r2.ok && r2.items) || []; renderFiles(); updateBtns(); toast('已删除备份 ' + name); }
    else toast('删除失败');
  };
  ov.querySelector('[data-act=openfolder]').onclick = () => { window.topoConfigBackup.openFolder().catch(() => {}); };
  ov.querySelector('[data-act=close]').onclick = close;
  loadHosts();
}

/* ================= Web Shell ================= */
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
    try { const fp = localStorage.getItem('topoShellFp:' + cfg.host) || ''; cfg.expectFp = fp.indexOf('SHA256:') === 0 ? fp : ''; } catch (e) { cfg.expectFp = ''; }
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
    exportPdf,
    openMonitorConfig,
    openMonitorCenter,
    openMonitorLogs,
    openConfigBackups,
    applyMonitor,
    reconcileMonitors,
    monitorStatus: state.monitorStatus,
    // 脱敏副本：调试钩子/自动化不暴露设备密码
    monitorCfg: (() => {
      const out = {};
      for (const [k, v] of Object.entries(state.monitorCfg)) {
        out[k] = Object.assign({}, v, { hosts: (Array.isArray(v.hosts) ? v.hosts : []).map(h => Object.assign({}, h, { password: h && h.password ? '***' : '' })) });
      }
      return out;
    })()
  };
}
})();
