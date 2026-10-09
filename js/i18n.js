/* NetTopo GUI 界面语言层（中文 ⇄ English）—— 双形态导出（渲染层经 globalThis.TopoI18n，Node 测试可直接 require）
 * ---------------------------------------------------------------------------
 * 设计口径：**源文案词典式**——界面调用点保持中文原文不变，t() 按当前语言查词典翻译，
 * 未命中的词条回落中文原文。这样：
 *   ① 存量与新增代码零改造即可接入（openDrop / openCtx / toast / setHint / openModal 已挂钩）；
 *   ② 翻译覆盖可持续增长——往 EN 词典加一行即多翻译一处，漏翻不报错、不出现空白文案；
 *   ③ 词典仅覆盖「界面铬件」（菜单 / 右键菜单 / 常用按钮 / 常用提示 / 工具栏），用户数据
 *      （设备名、备注、监控输出等）永远原样显示，不参与翻译。
 * 语言选择持久化在 localStorage（浏览器与 Electron 渲染层同源可用），键 nettopo.lang。
 * 范围：主窗口（index.html）；Web Shell / 设备管理页独立窗口暂未接入。
 * --------------------------------------------------------------------------- */
'use strict';
(function (global) {
  const KEY = 'nettopo.lang';
  const LANGS = ['zh', 'en'];

  const store = (() => {
    try { if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.setItem === 'function') return localStorage; } catch (e) { /* ignore */ }
    return null;
  })();

  const normalizeLang = (l) => (LANGS.indexOf(String(l || '').toLowerCase()) >= 0 ? String(l).toLowerCase() : 'zh');

  const readLang = () => {
    try { return normalizeLang(store && store.getItem ? store.getItem(KEY) : 'zh'); } catch (e) { return 'zh'; }
  };

  let lang = readLang();
  const listeners = [];

  /* ---- 语言包（用户/社区词典）：白名单清洗后存 localStorage，覆盖内建 EN 词条 ---- */
  const PACK_KEY = 'nettopo.langpack';
  const PACK_FORMAT = 'nettopo-langpack';
  const PACK_VERSION = 1;
  const PACK_MAX_ENTRIES = 3000;
  let userPack = {};
  const readUserPack = () => {
    try {
      const raw = store && store.getItem ? store.getItem(PACK_KEY) : '';
      if (!raw) return;
      const obj = JSON.parse(raw);
      const cleaned = cleanPackEntries(obj && obj.entries ? obj.entries : obj);
      if (!cleaned.rejected) userPack = cleaned.entries;
    } catch (e) { /* 损坏语言包按无语言包处理 */ }
  };
  /** 词条白名单清洗：仅接受 string→string；键长/值长封顶；原型链键一律丢弃并计数 */
  const cleanPackEntries = (obj) => {
    const out = {};
    let dropped = 0, n = 0;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { entries: out, dropped: 0, rejected: true };
    for (const k of Object.keys(obj)) {
      if (n >= PACK_MAX_ENTRIES) { dropped++; continue; }
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') { dropped++; continue; }
      if (typeof k !== 'string' || !k.trim() || k.length > 200) { dropped++; continue; }
      const v = obj[k];
      if (typeof v !== 'string' || v.length > 4000) { dropped++; continue; }
      out[k] = v; n++;
    }
    return { entries: out, dropped, rejected: false };
  };
  readUserPack();

  /** 导出语言包：内建 EN 词典 + 用户词条合并（词条即翻译的单一事实来源） */
  const exportPack = () => {
    const entries = Object.assign({}, EN, userPack);
    return { format: PACK_FORMAT, formatVersion: PACK_VERSION, lang: 'en', name: 'English', count: Object.keys(entries).length, exportedAt: new Date().toISOString(), entries };
  };

  /** 导入语言包：白名单清洗，merge（默认，覆盖同名词条）或 replace；返回 {ok,count,dropped,rejected} */
  const importPack = (obj, mode) => {
    const body = obj && typeof obj === 'object' && obj.entries ? obj.entries : obj;
    const cleaned = cleanPackEntries(body);
    if (cleaned.rejected) return { ok: false, count: 0, dropped: 0, error: '语言包格式不正确（需要 {entries:{中文原文:译文}} 映射）' };
    userPack = mode === 'replace' ? cleaned.entries : Object.assign({}, userPack, cleaned.entries);
    try { if (store) store.setItem(PACK_KEY, JSON.stringify({ format: PACK_FORMAT, formatVersion: PACK_VERSION, entries: userPack })); } catch (e) { /* 存储超限按未持久化处理 */ }
    for (const cb of listeners) { try { cb(lang); } catch (e) { /* ignore */ } }
    return { ok: true, count: Object.keys(cleaned.entries).length, dropped: cleaned.dropped };
  };

  const clearPack = () => {
    userPack = {};
    try { if (store) store.removeItem(PACK_KEY); } catch (e) { /* ignore */ }
  };

  /** 英文词典：键 = 界面中文原文（与源码逐字一致，含省略号与括号），值 = 英文文案 */
  const EN = {
    // ---- 工具栏与通用按钮 ----
    '文件': 'File', '编辑': 'Edit', '布局': 'Layout', '显示': 'View', '监控': 'Monitor', '导出': 'Export',
    '撤销': 'Undo', '重做': 'Redo',
    '确定': 'OK', '取消': 'Cancel', '保存': 'Save', '关闭': 'Close', '删除': 'Delete', '知道了': 'Got it',
    '导入拓扑': 'Import Topology',
    '导入连线表格': 'Import Link Spreadsheet', '新建空白画布': 'New Blank Canvas', '载入示例拓扑': 'Load Sample Topology',
    '切换明暗主题': 'Toggle Light/Dark Theme', '使用帮助': 'Usage Help', '关于': 'About',
    '文件：新建 / 导入表格 / 示例 / 保存工程 / 打开工程': 'File: New / Import / Sample / Save / Open project',
    '编辑：添加设备 / 添加连线 / 类型管理 / 删除': 'Edit: Add device / link / type manager / delete',
    '布局：自动布局 / 适应视图 / 拓扑校验': 'Layout: Auto layout / fit view / validation',
    '显示：链路标注 / 子网分组': 'View: Link labels / subnet grouping',
    '监控：监控中心 / 设备监控 / 日志 / 配置备份': 'Monitor: Center / device monitoring / logs / config backups',
    'AI：解析设备配置 / 解析设备日志 / 分析记录 / 设置': 'AI: Analyze configs / logs / history / settings',
    '导出：CSV / Excel / PDF / 图片 / Visio': 'Export: CSV / Excel / PDF / image / Visio',
    '新建图纸页（当前拓扑成为第 1 页）': 'New sheet page (current topology becomes page 1)',
    '退出当前模式': 'Exit current mode',
    // ---- 文件菜单 ----
    '导入表格…': 'Import Spreadsheet…',
    '从邻居表导入（LLDP/CDP）…': 'Import from Neighbor Table (LLDP/CDP)…',
    '拓扑自动发现…': 'Auto-Discover Topology…',
    '保存工程…': 'Save Project…',
    '打开工程…': 'Open Project…',
    '对比工程…': 'Compare Projects…',
    '自动备份工程…': 'Project Auto-Backup…',
    '备份管理…': 'Backup Manager…',
    // ---- 编辑菜单 ----
    '添加设备': 'Add Device', '添加连线': 'Add Link', '添加文本框': 'Add Text Box',
    '添加区域…': 'Add Region…',
    '从模板添加设备…': 'Add Device from Template…',
    '对齐 / 分布选中…': 'Align / Distribute Selection…',
    '批量重命名…': 'Batch Rename…',
    'IP 批量改段…': 'Batch IP Renumber…',
    'IP 子网计算器…': 'IP Subnet Calculator…',
    '接口总表…': 'Interface Table…',
    'IP 地址管理…': 'IP Address Management (IPAM)…',
    '自定义字段…': 'Custom Fields…',
    '机柜视图（U 位）…': 'Rack View (U-Slots)…',
    '类型管理…': 'Type Manager…',
    '删除选中': 'Delete Selection',
    // ---- 布局菜单 ----
    '自动布局（力导向）(L)': 'Auto Layout (Force-Directed) (L)',
    '环形布局': 'Ring Layout',
    '分层布局（按类型）': 'Layered Layout (by Type)',
    '三层架构布局（核心-汇聚-接入）': 'Three-Tier Layout (Core–Aggregation–Access)',
    '拓扑分层布局（最少交叉）': 'Topological Layering (Min-Crossing)',
    '网格布局': 'Grid Layout',
    '适应视图 (F)': 'Fit to View (F)',
    '适应视图': 'Fit to View',
    '自动布局': 'Auto Layout',
    '直角布线（正交走线）': 'Orthogonal (Right-Angle) Routing',
    '直角布线（正交走线） ✓': 'Orthogonal (Right-Angle) Routing ✓',
    '路径分析…': 'Path Analysis…',
    '网段分析…': 'Subnet Analysis…',
    '拓扑校验': 'Topology Validation',
    '单点故障分析': 'Single Point of Failure Analysis',
    // ---- 监控菜单 ----
    '监控中心…': 'Monitor Center…',
    '监控状态叠加（节点角标）': 'Monitor Status Overlay (Node Badges)',
    '✓ 监控状态叠加（节点角标）': '✓ Monitor Status Overlay (Node Badges)',
    '链路流量叠加（连线徽标）': 'Link Utilization Overlay (Link Badges)',
    '✓ 链路流量叠加（连线徽标）': '✓ Link Utilization Overlay (Link Badges)',
    '配置合规检查…': 'Compliance Baseline Check…',
    '设备监控（静默采集）…': 'Device Monitoring (Silent Collection)…',
    '告警等级与提示音…': 'Alert Levels & Sounds…',
    '告警外发（Webhook）…': 'Alert Webhook Delivery…',
    '链路连通性监测…': 'Link Connectivity Monitoring…',
    '链路状态叠加（连线着色）': 'Link Status Overlay (Link Coloring)',
    '✓ 链路状态叠加（连线着色）': '✓ Link Status Overlay (Link Coloring)',
    '凭据库（设备访问凭据集中维护）…': 'Credential Vault (Centralized Device Credentials)…',
    '监控日志…': 'Monitor Logs…',
    '配置备份…': 'Config Backups…',
    '网络服务（TFTP / FTP / Syslog / Trap）…': 'Network Services (TFTP / FTP / Syslog / Trap)…',
    '诊断工具箱（Ping / 路由跟踪 / 端口 / 网段 / SNMP）…': 'Diagnostics Toolbox (Ping / Traceroute / Ports / Subnet / SNMP)…',
    '二层拓扑推断（SNMP 转发表）…': 'L2 Topology Inference (SNMP FDB)…',
    '可用性报表（SLA）…': 'Availability Report (SLA)…',
    '巡检报告（一键生成）…': 'Inspection Report (One-Click)…',
    'MAC/ARP 终端定位…': 'MAC/ARP Endpoint Locator…',
    '批量巡检（只读命令）…': 'Batch Inspection (Read-Only)…',
    '配置变更下发…': 'Config Change Deployment…',
    '三层邻居与协议视图（BGP / OSPF）…': 'L3 Neighbors & Protocol View (BGP / OSPF)…',
    '托盘常驻（关闭窗口后台继续监控）': 'Tray Icon (Keep Monitoring in Background)',
    // ---- AI 菜单 ----
    '解析设备配置…': 'Analyze Device Config…',
    '解析设备日志…': 'Analyze Device Logs…',
    '巡检日报定时…': 'Schedule Daily AI Report…',
    '分析记录…': 'Analysis History…',
    'AI 设置…': 'AI Settings…',
    // ---- 显示菜单 ----
    '链路标注': 'Link Labels',
    '子网分组': 'Subnet Grouping',
    '机房平面图底图…': 'Floor Plan Underlay…',
    '监控大屏模式（值班投屏）': 'NOC Dashboard Mode (Wall Display)',
    '清除故障标记': 'Clear Fault Marks',
    '清除路径高亮': 'Clear Path Highlight',
    // ---- 导出菜单 ----
    '导出 CSV 表格': 'Export CSV',
    '导出 Excel 表格': 'Export Excel',
    '导出交互式拓扑 HTML（可点击看详情）': 'Export Interactive Topology HTML (Click for Details)',
    '导出资产清单（Excel）': 'Export Asset Inventory (Excel)',
    '导出 PDF': 'Export PDF',
    '导出图片（PNG / SVG）': 'Export Image (PNG / SVG)',
    '复制图片到剪贴板': 'Copy Image to Clipboard',
    '导出 Visio': 'Export Visio',
    '导出设计报告（HTML）': 'Export Design Report (HTML)',
    '生成设备配置…': 'Generate Device Configs…',
    '导出 IP 规划清单…': 'Export IP Plan…',
    // ---- 画布右键菜单 ----
    '编辑设备…': 'Edit Device…',
    '定位到视图': 'Locate in View',
    'Web Shell（SSH/Telnet）…': 'Web Shell (SSH/Telnet)…',
    '采集邻居表（SSH）…': 'Collect Neighbor Table (SSH)…',
    '告警静默 1 小时': 'Mute Alerts for 1 Hour',
    '打开设备管理页面': 'Open Device Web Page',
    '恢复自适应尺寸': 'Reset to Auto Size',
    '删除设备及连线': 'Delete Device & Links',
    '编辑连线…': 'Edit Link…',
    '恢复链路（解除故障）': 'Restore Link (Clear Fault)',
    '标记链路故障（模拟断链）': 'Mark Link Faulted (Simulate Outage)',
    '取消聚合标记': 'Remove Aggregation Mark',
    '与平行链路组成聚合组…': 'Group Parallel Links into LAG…',
    '删除连线': 'Delete Link',
    '编辑文本框…': 'Edit Text Box…',
    '删除文本框': 'Delete Text Box',
    '在此添加设备': 'Add Device Here',
    '在此添加文本框': 'Add Text Box Here',
    '在此添加区域…': 'Add Region Here…',
    '添加连线…': 'Add Link…',
    '编辑区域…': 'Edit Region…',
    '删除区域（框内设备保留）': 'Delete Region (Devices Kept)',
    // ---- 常用提示（toast / hint）----
    '已切换为直角布线（PDF/PNG 导出同步）': 'Switched to orthogonal routing (PDF/PNG export in sync)',
    '已切换为直线布线': 'Switched to straight routing',
    '已开启监控状态叠加：节点右上角显示状态圆点': 'Monitor status overlay on: status dot at node top-right',
    '已关闭监控状态叠加': 'Monitor status overlay off',
    '已开启链路流量叠加：连线中点显示实时利用率（需设备开启「接口流量」SNMP 采集）': 'Link utilization overlay on: mid-link utilization badge (requires per-device "interface traffic" SNMP collection)',
    '已关闭链路流量叠加': 'Link utilization overlay off',
    '已开启链路状态叠加：连通绿 / 中断红（虚线闪烁）/ 未知灰': 'Link status overlay on: green up / red down (flashing dashed) / gray unknown',
    '已关闭链路状态叠加': 'Link status overlay off',
    '请先选中一台设备，或右键设备进入': 'Select a device first, or right-click a device',
    '托盘常驻需要桌面版软件': 'Tray icon requires the desktop app',
    '已启用托盘常驻：关闭窗口后监控在后台继续，点击托盘图标恢复': 'Tray icon enabled: monitoring keeps running after the window closes; click the tray icon to restore',
    '已关闭托盘常驻': 'Tray icon disabled',
    '设置失败': 'Operation failed',
    '当前没有路径高亮': 'No path highlight to clear',
    '已清除路径高亮': 'Path highlight cleared',
    '连线模式：依次点击两台设备；Esc 或右键取消': 'Link mode: click two devices in turn; Esc or right-click to cancel',
    '放置模式：点击画布空白处放置设备；Esc 或右键取消': 'Place mode: click empty canvas to place a device; Esc or right-click to cancel',
    '已选源设备，再点击目标设备（Esc 取消）': 'Source selected — click the target device (Esc to cancel)',
    '已切换为英文界面（Language switched to English）': 'Language switched to English（已切换为英文界面）',
    '已切换为中文界面（Language switched to Chinese）': '已切换为中文界面（Language switched to Chinese）'
  };

  /** 翻译：中文原文 → 当前语言；用户语言包优先（社区/用户修正覆盖内建），均未命中回落原文（用户数据永远原样） */
  const t = (s) => {
    const str = String(s == null ? '' : s);
    if (lang === 'zh') return str;
    if (Object.prototype.hasOwnProperty.call(userPack, str)) return userPack[str];
    if (Object.prototype.hasOwnProperty.call(EN, str)) return EN[str];
    return str;
  };

  const getLang = () => lang;

  const setLang = (l) => {
    lang = normalizeLang(l);
    try { if (store) store.setItem(KEY, lang); } catch (e) { /* ignore */ }
    for (const cb of listeners) { try { cb(lang); } catch (e) { /* ignore */ } }
    return lang;
  };

  const onChange = (cb) => { if (typeof cb === 'function') listeners.push(cb); };

  /** 静态铬件走查：工具栏按钮文字与标题、空状态按钮（双向生效——首次走查时把中文原文
   *  存入 data-i18n-* 快照，切回中文时按快照还原；菜单/弹窗在下次打开时经 t() 生效） */
  const applyChrome = (doc) => {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return false;
    let n = 0;
    for (const b of d.querySelectorAll('#toolbar .tb, .tb-group .tb')) {
      for (const sp of b.querySelectorAll(':scope > span')) {
        if (sp.dataset.i18nOrig == null) sp.dataset.i18nOrig = sp.textContent;
        const v = lang === 'zh' ? sp.dataset.i18nOrig : t(sp.dataset.i18nOrig);
        if (v !== sp.textContent) { sp.textContent = v; n++; }
      }
      if (b.title) {
        if (b.dataset.i18nOrigTitle == null) b.dataset.i18nOrigTitle = b.title;
        const v = lang === 'zh' ? b.dataset.i18nOrigTitle : t(b.dataset.i18nOrigTitle);
        if (v !== b.title) { b.title = v; n++; }
      }
    }
    for (const el of d.querySelectorAll('[data-i18n]')) {
      if (el.dataset.i18nOrig == null) el.dataset.i18nOrig = el.getAttribute('data-i18n');
      const v = lang === 'zh' ? el.dataset.i18nOrig : t(el.dataset.i18nOrig);
      if (v !== el.textContent) { el.textContent = v; n++; }
    }
    return n > 0;
  };

  const api = { t, getLang, setLang, onChange, applyChrome, normalizeLang, LANGS, exportPack, importPack, clearPack, packSize: () => Object.keys(userPack).length };
  global.TopoI18n = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
