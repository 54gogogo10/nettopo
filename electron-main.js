/* NetTopo Electron 主进程 */
'use strict';
const { app, BrowserWindow, session, ipcMain, dialog, Notification, Tray, Menu } = require('electron');
const path = require('path');
const { ShellManager } = require('./js/shell.js');
const { BackupStore, MAX_CONTENT_BYTES } = require('./js/backup-store.js');
const { MonitorManager, UptimeStore, fmtUptimeTicks } = require('./js/monitor.js');
const { ConfigBackupStore } = require('./js/config-backup.js');
const { NetServices } = require('./js/net-services.js');
const { searchMonitorLogs } = require('./js/log-search.js');
const { Updater } = require('./js/updater.js');
const { AiClient, AiHistoryStore, validateBaseUrl, validateProtocol, buildConfigPrompt, buildLogPrompt, buildShellPrompt, parseShellCommands, truncateText, maskKey, DEFAULT_MAX_INPUT_KB } = require('./js/ai-llm.js');

/* ---- Linux 沙箱兜底：以 root 运行（sudo / 容器 / 麒麟等受限环境）时，Chromium 强制要求 --no-sandbox，
 *   否则 SUID 沙箱初始化直接 fatal abort（"Running as root without --no-sandbox is not supported"）。
 *   仅在 root 下自动追加该开关；普通桌面用户保留完整 Chromium 沙箱（评审安全基线 sandbox:true 不受影响）。
 *   注：appendSwitch 在首个渲染进程创建前（window 创建前）同步执行，root 检查有效。 */
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

/* ---- 主进程崩溃兜底：任何渲染层回调/定时器里的同步异常（如超大 join 抛 RangeError、
 *   写流 error）此前都会直接整体崩溃，丢掉所有监控/备份状态——记录后降级继续运行 ---- */
function logCrash(kind, err) {
  try {
    const fs = require('fs');
    const line = '[' + new Date().toISOString() + '] ' + kind + ': ' + String((err && (err.stack || err.message)) || err) + '\n';
    fs.appendFileSync(path.join(app.getPath('userData'), 'main-crash.log'), line.slice(0, 8000), 'utf8');
  } catch (e) { /* 日志失败忽略 */ }
  console.error('[main]', kind, err);
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));

// 测试隔离：冒烟测试通过 NETTOPO_USERDATA 覆盖用户数据目录（临时目录），避免污染真实备份数据
if (process.env.NETTOPO_USERDATA) app.setPath('userData', process.env.NETTOPO_USERDATA);

/* ---- 单实例锁：双开会产生双托盘、内置 TFTP/FTP/Syslog 端口互抢（第二实例服务全部起不来）、
 *   两边 settings.json 互相覆盖——第二个实例直接退出并唤起已有主窗 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    }
  });
}

let mainWin = null;
let shellWin = null;
let webWin = null;
let tray = null;
let trayQuitting = false;
const trayWanted = () => loadAppSettings().trayEnabled === true; // 设置开关（创建/销毁托盘用）
// 「托盘真实可用」= 设置开且托盘创建成功：图标缺失/Linux 无系统托盘的桌面环境下创建会失败，
// 此时若仍按设置判定，关窗会隐藏成无窗无盘的僵尸进程——创建失败视同托盘关闭（关窗即退出）
const trayEnabled = () => trayWanted() && tray !== null;
let trayJobCount = 0; // 托盘菜单显示的活动监控任务数
let webReady = false;              // Web 管理页窗口渲染层是否就绪
const pendingWebTabs = [];         // 等待 Web 窗口加载完成的 newtab 消息
let certSeq = 0;
const pendingCert = new Map();     // id -> { callback, host, url, error, fp }
const allowedCerts = new Map();    // host -> 已允许的证书指纹（按指纹固定，指纹变化重新询问）
const certQueue = [];              // 窗口未就绪时到达的证书告警
let shellReady = false;            // Shell 窗口渲染层是否已就绪（did-finish-load）
const pendingTabs = [];            // 等待新窗口加载完成的 newtab 消息
const shellQueue = [];             // 窗口就绪前到达的会话事件（避免首屏输出丢失）
// 会话审计日志与监控日志同库（monitor-logs），日志浏览器/全局搜索天然覆盖 Web Shell 会话
const shell = new ShellManager({ logDir: path.join(app.getPath('userData'), 'monitor-logs') });

/* ---- 设备后台静默监控（复用 Web Shell 底层连接，独立监视任务） ---- */
const configBackup = new ConfigBackupStore(path.join(app.getPath('userData'), 'config-backups'));
const monitor = new MonitorManager(shell, path.join(app.getPath('userData'), 'monitor-logs'), path.join(app.getPath('userData'), 'monitor-trust.json'), { backupStore: configBackup });

/* ---- 在线率采样（监控中心 7 天趋势）：探测结果按 10 分钟桶落盘 ---- */
const uptimeStore = new UptimeStore(path.join(app.getPath('userData'), 'monitor-uptime.json'));
monitor.on('probe', (info) => { try { uptimeStore.record(info.key, info.ok === true); } catch (e) { /* ignore */ } });
setInterval(() => uptimeStore.flush(), 5 * 60 * 1000).unref();

/* ---- 内置网络服务（TFTP / FTP / Syslog）：接收设备推送的配置文件与集中收集日志 ---- */
const netSvc = new NetServices({
  baseDir: path.join(app.getPath('userData'), 'net-services'),
  configBackup: configBackup
});
netSvc.on('file', (info) => {
  // 设备推文件是低频事件：实时推送面板 + 系统通知（等待设备 copy 命令执行完成时很有用）
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('netsvc:file', info);
  if (notifyEnabled()) {
    notifyUser('网络拓扑管理软件 · 收到设备文件',
      (info.svc === 'tftp' ? 'TFTP' : 'FTP') + ' 收到 ' + info.name + '（来自 ' + info.ip + '，' + info.size + ' 字节），可在「网络服务」面板导入配置备份库');
  }
});
netSvc.on('status', (st) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('netsvc:status', st); });

/** 本机 IPv4 地址列表（面板展示，方便在设备侧配置 tftp/ftp/loghost 指向） */
function localIPv4s() {
  const os = require('os');
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) {
        if (it && it.family === 'IPv4' && !it.internal) out.push(it.address);
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

/* ---- 应用设置持久化（备份目录等，存于用户数据目录 settings.json） ---- */
let appSettings = null;
function getSettingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadAppSettings() {
  if (appSettings) return appSettings;
  appSettings = {};
  try {
    const fs = require('fs');
    if (fs.existsSync(getSettingsFile())) {
      const raw = JSON.parse(fs.readFileSync(getSettingsFile(), 'utf8'));
      if (raw && typeof raw === 'object') appSettings = raw;
    }
  } catch (e) { appSettings = {}; }
  return appSettings;
}
function saveAppSettings() {
  try {
    const fs = require('fs');
    fs.writeFileSync(getSettingsFile(), JSON.stringify(appSettings || {}, null, 2), 'utf8');
  } catch (e) { /* 失败不阻断 */ }
}
function defaultBackupDir() {
  return path.join(app.getPath('userData'), 'backups');
}
function effectiveBackupDir() {
  const cfg = loadAppSettings().backupDir;
  if (typeof cfg === 'string' && cfg.trim()) return cfg.trim();
  return defaultBackupDir();
}

/* ---- 工程备份库（用户数据目录 backups/ 或用户自定义目录） ---- */
let backupStore = null;
function getBackupStore() {
  if (!backupStore) backupStore = new BackupStore(effectiveBackupDir());
  return backupStore;
}
function resetBackupStore() { backupStore = null; }

/* ---- 系统托盘常驻 ---- */
function rebuildTrayMenu() {
  if (!tray) return;
  const items = [];
  items.push({ label: '监控任务：' + trayJobCount + ' 个', enabled: false });
  items.push({ type: 'separator' });
  items.push({ label: '显示主窗口', click: () => {
    if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); }
  } });
  items.push({ label: '停止全部监控', click: () => { monitor.stopAll(); trayJobCount = 0; rebuildTrayMenu(); } });
  items.push({ type: 'separator' });
  items.push({ label: '退出', click: () => { trayQuitting = true; monitor.stopAll(); shell.closeAll(); app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}
function applyTray() {
  if (trayWanted() && !tray) {
    try {
      tray = new Tray(path.join(__dirname, 'icon.png'));
      tray.setToolTip('网络拓扑管理软件（后台监控运行中）');
      tray.on('click', () => { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); } });
      rebuildTrayMenu();
    } catch (e) { tray = null; }
  } else if (!trayWanted() && tray) {
    try { tray.destroy(); } catch (e) { /* ignore */ }
    tray = null;
  }
}

/* ---- Web Shell 独立窗口（多标签） ---- */
function createShellWindow() {
  if (shellWin && !shellWin.isDestroyed()) {
    if (shellWin.isMinimized()) shellWin.restore();
    shellWin.focus();
    return shellWin;
  }
  shellWin = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 640,
    minHeight: 400,
    autoHideMenuBar: true,
    title: '网络拓扑管理软件 · Web Shell',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  shellWin.loadFile('shell.html');
  shellWin.removeMenu();
  shellWin.on('closed', () => {
    shellWin = null;
    shellReady = false;
    shellQueue.length = 0;
    pendingTabs.length = 0; // 丢弃未送达的标签消息，避免下次打开出现死标签
    // 只收 UI 会话：后台监控/备份与 Web Shell 共用同一连接管理器，无差别 closeAll 会把
    // 进行中的监控连接与配置备份一并强断（监控任务随后引发一轮无谓的重连风暴）
    shell.closeAll('monitor');
  });
  shellWin.webContents.once('did-finish-load', () => {
    // 先送达标签消息，再冲刷连接过程中的输出，避免首屏输出丢失
    while (pendingTabs.length) shellWin.webContents.send('shell:newtab', pendingTabs.shift());
    shellReady = true;
    while (shellQueue.length) {
      const [type, id, payload] = shellQueue.shift();
      shellWin.webContents.send(type, id, payload);
    }
  });
  return shellWin;
}

/** 会话事件统一出口：窗口未就绪时先入队，就绪后按序发送 */
function emitShell(type, id, payload) {
  if (!shellWin || shellWin.isDestroyed()) return;
  if (!shellReady) { shellQueue.push([type, id, payload]); return; }
  shellWin.webContents.send(type, id, payload);
}

function openShellTab(info) {
  const win = createShellWindow();
  if (win.webContents.isLoading()) pendingTabs.push(info);
  else win.webContents.send('shell:newtab', info);
}

// 会话事件 → 只发往 Web Shell 窗口（标签页在那里）
shell.on('output', (id, data) => emitShell('shell:output', id, data));
shell.on('status', (id, info) => emitShell('shell:status', id, info));
shell.on('end', (id, reason) => emitShell('shell:end', id, reason));

// 监控状态只发往主窗口（侧栏标记），不打扰其它窗口
monitor.on('status', (info) => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('monitor:status', info);
  const n = monitor.status().length;
  if (n !== trayJobCount) { trayJobCount = n; if (tray) rebuildTrayMenu(); }
});
// 监控事件历史（供监控中心时间线；主进程保存最近 500 条）
const monitorEvents = [];
function recordMonitorEvent(info, type, detail) {
  let name = info.name || '';
  // 兜底：事件未携带设备名时从任务状态表补齐（避免时间线显示 deviceId）
  if (!name && info && info.key) {
    try {
      const it = monitor.status().find(s => s.key === info.key);
      if (it && it.name) name = it.name;
    } catch (e) { /* ignore */ }
  }
  monitorEvents.push({ ts: Date.now(), type: type, key: info.key, deviceId: info.deviceId, host: info.host, name: name, detail: detail || '' });
  if (monitorEvents.length > 500) monitorEvents.splice(0, monitorEvents.length - 500);
}
// 在线探测状态 → 主窗口；离线/恢复转换时弹系统通知（受 settings.monitorNotify 开关控制）
const lastProbeOk = new Map();      // key -> 上次探测结果
const lastAlertOn = new Map();      // key -> 上次告警状态
const lastAlertPatterns = new Map(); // key -> 上次告警命中关键字集合（新增关键字时再记录事件）
const lastBackupErrAt = new Map();  // key -> 上次备份失败通知时间
const notifyEnabled = () => loadAppSettings().monitorNotify !== false;
function sendMonitor(channel, info) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, info);
}
function notifyUser(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: title, body: body, silent: false });
    n.on('click', () => { if (mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });
    n.show();
  } catch (e) { /* 通知失败不阻断 */ }
}
monitor.on('probe', (info) => {
  sendMonitor('monitor:probe', info);
  const prev = lastProbeOk.get(info.key);
  if (info.ok === false && prev !== false) {
    lastProbeOk.set(info.key, false);
    recordMonitorEvent(info, 'offline', '探测失败，设备可能离线');
    if (notifyEnabled()) notifyUser('网络拓扑管理软件 · 设备离线', info.name + '（' + info.host + '）探测失败，设备可能离线');
  } else if (info.ok === true && prev === false) {
    lastProbeOk.set(info.key, true);
    recordMonitorEvent(info, 'recovery', '探测恢复在线');
    if (notifyEnabled()) notifyUser('网络拓扑管理软件 · 设备恢复', info.name + '（' + info.host + '）已恢复在线');
  } else {
    lastProbeOk.set(info.key, info.ok);
  }
});
monitor.on('alert', (info) => {
  sendMonitor('monitor:alert', info);
  const detail = '输出匹配告警关键字「' + (info.pattern || '') + '」' + (info.matchedText ? '：' + info.matchedText : '');
  if (info.matched) {
    // 首次告警，或命中集合新增关键字（多告警陆续出现）时各记录一条事件
    const cur = (info.patterns || []).filter(Boolean);
    const prev = lastAlertPatterns.get(info.key);
    const added = prev ? cur.filter(p => !prev.includes(p)) : cur;
    if (!prev) {
      lastAlertOn.set(info.key, true);
      lastAlertPatterns.set(info.key, cur);
      recordMonitorEvent(info, 'alert', detail);
      if (notifyEnabled()) notifyUser('网络拓扑管理软件 · 输出告警', info.name + '（' + info.host + '）' + detail);
    } else if (added.length) {
      lastAlertPatterns.set(info.key, cur);
      recordMonitorEvent(info, 'alert', detail + '（新增 ' + added.join('、') + '）');
      if (notifyEnabled()) notifyUser('网络拓扑管理软件 · 输出告警', info.name + '（' + info.host + '）' + detail);
    }
  } else if (lastAlertOn.get(info.key) === true) {
    lastAlertOn.set(info.key, false);
    lastAlertPatterns.delete(info.key);
    recordMonitorEvent(info, 'alert-clear', '告警解除');
  }
});
monitor.on('trust', (info) => {
  // 首次连接自动信任主机指纹：安全敏感事件，始终通知用户（不随 monitorNotify 开关关闭）
  notifyUser('网络拓扑管理软件 · 首次信任主机指纹',
    info.name + '（' + info.host + '）首次连接已自动信任指纹 ' + info.fp + '；后续指纹变化将拒绝连接');
});
const lastBackupChangeAt = new Map(); // key -> 上次变更通知时间（节流）
monitor.on('compliance', (info) => {
  sendMonitor('monitor:compliance', info);
  const detail = info.ok
    ? '合规巡检通过（' + info.total + ' 项）'
    : '合规违规 ' + info.failed + '/' + info.total + '：' + (info.items || []).map(i => i.name).join('、');
  recordMonitorEvent(info, 'compliance', detail);
  if (!info.ok && notifyEnabled()) notifyUser('网络拓扑管理软件 · 配置合规违规', info.name + '（' + info.host + '）' + detail);
});
monitor.on('sysinfo', (info) => sendMonitor('monitor:sysinfo', info));
// SNMP 性能采样（CPU/内存/sysUpTime）：实时推送监控中心「性能」页
monitor.on('perf', (info) => sendMonitor('monitor:perf', info));
// 设备重启检测（sysUpTime 骤减）：记入事件时间线并弹系统通知
monitor.on('reboot', (info) => {
  sendMonitor('monitor:reboot', info);
  const detail = '设备可能已重启（sysUpTime ' + fmtUptimeTicks(info.prev) + ' → ' + fmtUptimeTicks(info.cur) + '）';
  recordMonitorEvent(info, 'reboot', detail);
  if (notifyEnabled()) notifyUser('网络拓扑管理软件 · 设备重启', info.name + '（' + info.host + '）' + detail);
});
// SNMP 接口流量：实时采样推送主窗口；接口 up/down 跳变记入事件时间线并弹通知（接口离线才弹）
monitor.on('iftraffic', (info) => sendMonitor('monitor:iftraffic', info));
monitor.on('ifstatus', (info) => {
  for (const ch of (info.changes || [])) {
    if (!ch || (ch.to !== 'up' && ch.to !== 'down')) continue;
    recordMonitorEvent(info, ch.to === 'down' ? 'if-down' : 'if-up',
      '接口 ' + ch.name + ' ' + (ch.to === 'down' ? 'DOWN（离线）' : 'UP（恢复）'));
    if (ch.to === 'down' && notifyEnabled()) {
      notifyUser('网络拓扑管理软件 · 接口离线', info.name + '（' + info.host + '）接口 ' + ch.name + ' DOWN');
    }
  }
});
monitor.on('backup', (info) => {
  sendMonitor('monitor:backup', info);
  // 开启了「无变化不新增」且本次内容与上次一致（skipped）：不新增文件，时间线不刷“与上次一致”事件
  if (info.skipped) return;
  if (!notifyEnabled()) return;
  if (info.ok) {
    if (info.first) recordMonitorEvent(info, 'backup', '首次备份：' + (info.fileName || ''));
    else if (info.changed) recordMonitorEvent(info, 'backup-change', '配置有变化（+' + (info.added || 0) + '/-' + (info.removed || 0) + ' 行）：' + (info.fileName || ''));
    else recordMonitorEvent(info, 'backup', '与上次一致：' + (info.fileName || ''));
    if (info.changed) {
      const now = Date.now();
      const last = lastBackupChangeAt.get(info.key) || 0;
      if (now - last > 30 * 60 * 1000) {
        lastBackupChangeAt.set(info.key, now);
        notifyUser('网络拓扑管理软件 · 配置变更', info.name + '（' + info.host + '）配置与上次备份不同（+' + (info.added || 0) + '/-' + (info.removed || 0) + ' 行）');
      }
    }
  } else {
    recordMonitorEvent(info, 'backup-error', (info.error || '备份失败'));
    const now = Date.now();
    const prevErr = lastBackupErrAt.get(info.key) || 0;
    if (now - prevErr > 10 * 60 * 1000) {
      lastBackupErrAt.set(info.key, now);
      notifyUser('网络拓扑管理软件 · 配置备份失败', info.name + '（' + info.host + '）：' + (info.error || '未知错误'));
    }
  }
});

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1024,
    minHeight: 640,
    autoHideMenuBar: true,
    title: '网络拓扑管理软件',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWin.loadFile('index.html');
  mainWin.removeMenu();
  // 托盘常驻：关闭按钮 = 最小化到托盘（后台监控继续）；退出走托盘菜单或设置关闭
  mainWin.on('close', (e) => {
    if (trayEnabled() && !trayQuitting) {
      e.preventDefault();
      mainWin.hide();
      if (tray && tray.displayBalloon) { try { tray.displayBalloon({ title: '网络拓扑管理软件 已最小化到托盘', content: '后台监控仍在运行，点击托盘图标可恢复主窗口' }); } catch (err) { /* ignore */ } }
    }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

/* ---- 设备管理 Web 页独立窗口（多标签） ---- */
function createWebWindow() {
  if (webWin && !webWin.isDestroyed()) {
    if (webWin.isMinimized()) webWin.restore();
    webWin.focus();
    return webWin;
  }
  webWin = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    autoHideMenuBar: true,
    title: '网络拓扑管理软件 · 设备管理页',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true, // 标签页内嵌浏览器视图
      preload: path.join(__dirname, 'preload.js')
    }
  });
  webWin.loadFile('webview.html');
  webWin.removeMenu();
  webWin.on('closed', () => {
    webWin = null;
    webReady = false;
    pendingWebTabs.length = 0;
    certQueue.length = 0; // 丢弃未送达的证书告警
    for (const rec of pendingCert.values()) { try { rec.callback(false); } catch (e) { /* ignore */ } }
    pendingCert.clear();
  });
  webWin.webContents.once('did-finish-load', () => {
    while (pendingWebTabs.length) webWin.webContents.send('web:newtab', pendingWebTabs.shift());
    webReady = true;
    while (certQueue.length) webWin.webContents.send('web:cert-error', certQueue.shift());
  });
  // 设备页面 window.open 弹窗 → 转为本窗口新标签（必须在加载前安装）
  webWin.webContents.on('did-attach-webview', (e, guest) => {
    try {
      guest.setWindowOpenHandler(({ url }) => {
        // 仅放行 http/https，避免设备页面弹出 file:/javascript: 等危险地址
        if (/^https?:\/\//i.test(url) && webWin && !webWin.isDestroyed()) webWin.webContents.send('web:newtab', { url });
        return { action: 'deny' };
      });
    } catch (err) { /* ignore */ }
  });
  return webWin;
}

/** 证书告警统一出口：窗口未就绪先入队；无窗口则直接拒绝该请求 */
function emitCertError(info) {
  if (!webWin || webWin.isDestroyed()) {
    const rec = pendingCert.get(info.id);
    if (rec) { pendingCert.delete(info.id); rec.callback(false); }
    return;
  }
  if (!webReady) { certQueue.push(info); return; }
  webWin.webContents.send('web:cert-error', info);
}

function openWebTab(info) {
  const win = createWebWindow();
  if (win.webContents.isLoading()) pendingWebTabs.push(info);
  else win.webContents.send('web:newtab', info);
}

/* ---- IPC 安全辅助 ---- */
function isHttpUrl(u) {
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; } catch (e) { return false; }
}

/* ---- 机密落盘（FTP 服务口令等 settings.json 内容）：safeStorage 加密，前缀 enc1: 标记密文。
 *   加密不可用时保持原值落盘（行为与旧版一致）；解密失败返回空串（口令回退默认，需重新保存） ---- */
const ENC_PREFIX = 'enc1:';
function encryptSecretValue(text) {
  try {
    const { safeStorage } = require('electron');
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return String(text);
    return ENC_PREFIX + safeStorage.encryptString(String(text)).toString('base64');
  } catch (e) { return String(text); }
}
function decryptSecretValue(value) {
  const v = String(value == null ? '' : value);
  if (v.indexOf(ENC_PREFIX) !== 0) return v;
  try {
    const { safeStorage } = require('electron');
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(v.slice(ENC_PREFIX.length), 'base64')) || '';
  } catch (e) { return ''; }
}

/* ---- Web Shell IPC ---- */
/** Shell 相关 IPC 仅允许主窗口与 Shell 窗口调用（两窗口都加载同一 preload） */
function shellSender(e) {
  return !!(e && e.sender && (
    (mainWin && !mainWin.isDestroyed() && e.sender === mainWin.webContents) ||
    (shellWin && !shellWin.isDestroyed() && e.sender === shellWin.webContents)
  ));
}
ipcMain.handle('web:cert-allow', (e, payload) => {
  if (!webWin || webWin.isDestroyed() || e.sender !== webWin.webContents) return { ok: false, error: 'forbidden' };
  const rec = pendingCert.get(payload && payload.id);
  if (!rec) return { ok: false, error: '请求已过期' };
  pendingCert.delete(payload.id);
  // 记住的是「主机 + 证书指纹」：同主机指纹变化后仍需重新确认（防证书被替换的中间人）
  if (payload.allow && payload.remember && rec.fp) allowedCerts.set(rec.host, rec.fp);
  rec.callback(!!payload.allow);
  return { ok: true };
});
ipcMain.handle('web:open', (e, opts) => {
  // 仅主窗口可发起（设备右键菜单），防其它渲染层向设备页窗口注入标签
  if (!mainWin || mainWin.isDestroyed() || e.sender !== mainWin.webContents) return { ok: false, error: 'forbidden' };
  opts = opts || {};
  const url = String(opts.url || '').trim();
  if (!isHttpUrl(url)) return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' };
  if (url.length > 2048) return { ok: false, error: 'URL 过长' };
  openWebTab({ url, title: String(opts.title || url).slice(0, 80) });
  return { ok: true };
});
ipcMain.handle('shell:connect', (e, opts) => {
  if (!shellSender(e)) return { ok: false, error: 'forbidden' };
  opts = opts || {};
  const r = shell.connect(opts);
  if (r.ok) {
    const host = String(opts.host || '').trim();
    const proto = String(opts.protocol || 'ssh').toUpperCase();
    openShellTab({ sid: r.id, title: (opts.title || host) + ' · ' + proto + ' ' + host + ':' + (opts.port || (proto === 'TELNET' ? 23 : 22)) });
  }
  return r;
});
ipcMain.handle('shell:trust', (e, p) => {
  if (!shellWin || shellWin.isDestroyed() || e.sender !== shellWin.webContents) return { ok: false, error: 'forbidden' };
  return { ok: shell.trustFingerprint(String((p && p.host) || ''), !!(p && p.trust)) };
});
ipcMain.handle('shell:reconnect', (e, p) => {
  // 会话断开后原地重连：用保存的建连参数重建同一 sid 的会话（不新开标签，前端终端复用）
  if (!shellSender(e)) return { ok: false, error: 'forbidden' };
  const sid = String((p && p.id) || '');
  if (!/^s\d+$/.test(sid)) return { ok: false, error: '无效会话' };
  return shell.reconnect(sid);
});
ipcMain.on('shell:data', (e, id, data) => {
  if (!shellSender(e)) return;
  if (typeof data !== 'string') return; // 仅接受字符串：防非字符串绕过限长并致流写入崩溃
  if (data.length > 1024 * 1024) return; // 防超大粘贴/异常数据
  shell.write(id, data);
});
ipcMain.on('shell:resize', (e, id, cols, rows) => { if (shellSender(e)) shell.resize(id, cols, rows); });
ipcMain.on('shell:close', (e, id) => { if (shellSender(e)) shell.close(id); });
ipcMain.handle('shell:clipboard-write', (e, text) => {
  if (!shellSender(e)) return { ok: false, error: 'forbidden' };
  text = String(text == null ? '' : text);
  if (text.length > 1024 * 1024) return { ok: false, error: '内容过大' }; // 与 shell:data 一致限长
  const { clipboard } = require('electron');
  clipboard.writeText(text);
  return { ok: true };
});
ipcMain.handle('shell:open-external', (e, url) => {
  if (!shellSender(e)) return { ok: false, error: 'forbidden' };
  const u = String(url || '');
  if (u.length < 2048 && isHttpUrl(u)) require('electron').shell.openExternal(u);
  return { ok: true };
});
ipcMain.handle('shell:clipboard-read', (e) => {
  if (!shellSender(e)) return '';
  return require('electron').clipboard.readText();
});

/* ---- 工程备份管理 IPC（仅主窗口可调用，防其它窗口/被注入脚本越权读写备份） ---- */
function backupGuard(e) {
  return !!(mainWin && !mainWin.isDestroyed() && e && e.sender === mainWin.webContents);
}
ipcMain.handle('backup:save', (e, p) => {
  if (!backupGuard(e)) return { ok: false, error: 'forbidden' };
  const content = String((p && p.content) || '');
  // 与 BackupStore 的字节上限（MAX_CONTENT_BYTES）保持一致；字符串 length 是 UTF-16 码元，中文场景偏小，按字节拦截
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) return { ok: false, error: '备份内容过大' };
  return getBackupStore().save(content, (p && p.label) === 'auto' ? 'auto' : 'manual', parseInt((p && p.keep), 10));
});
ipcMain.handle('backup:list', (e) => backupGuard(e) ? getBackupStore().list() : { ok: false, error: 'forbidden' });
ipcMain.handle('backup:read', (e, p) => backupGuard(e) ? getBackupStore().read(String((p && p.name) || '')) : { ok: false, error: 'forbidden' });
ipcMain.handle('backup:delete', (e, p) => {
  if (!backupGuard(e)) return { ok: false, error: 'forbidden' };
  if (p && p.all) return getBackupStore().removeAll();
  return getBackupStore().remove(String((p && p.name) || ''));
});
ipcMain.handle('backup:open-folder', (e) => backupGuard(e)
  ? require('electron').shell.openPath(getBackupStore().dir).then(() => ({ ok: true }), (err) => ({ ok: false, error: String(err && err.message || err) }))
  : { ok: false, error: 'forbidden' });
ipcMain.handle('backup:get-dir', (e) => backupGuard(e)
  ? { ok: true, dir: effectiveBackupDir(), defaultDir: defaultBackupDir(), custom: !!loadAppSettings().backupDir }
  : { ok: false, error: 'forbidden' });
ipcMain.handle('backup:choose-dir', async (e) => {
  if (!backupGuard(e)) return { ok: false, error: 'forbidden' };
  try {
    const r = await dialog.showOpenDialog(mainWin, {
      title: '选择备份工程目录',
      defaultPath: effectiveBackupDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const dir = r.filePaths[0];
    loadAppSettings().backupDir = dir;
    saveAppSettings();
    resetBackupStore();
    return { ok: true, dir: effectiveBackupDir(), custom: true };
  } catch (err) {
    return { ok: false, error: '选择目录失败：' + String(err && err.message || err) };
  }
});
ipcMain.handle('backup:reset-dir', (e) => {
  if (!backupGuard(e)) return { ok: false, error: 'forbidden' };
  delete loadAppSettings().backupDir;
  saveAppSettings();
  resetBackupStore();
  return { ok: true, dir: effectiveBackupDir(), custom: false };
});

/* ---- 后台静默监控 IPC（仅主窗口可调用） ---- */
function monitorGuard(e) {
  return !!(mainWin && !mainWin.isDestroyed() && e && e.sender === mainWin.webContents);
}
ipcMain.handle('monitor:start', (e, opts) => monitorGuard(e) ? monitor.start(opts || {}) : { ok: false, error: 'forbidden' });
ipcMain.handle('monitor:stop', (e, p) => monitorGuard(e) ? monitor.stop(String((p && p.key) || '')) : { ok: false, error: 'forbidden' });
ipcMain.handle('monitor:stopAll', (e) => monitorGuard(e) ? monitor.stopAll() : { ok: false, error: 'forbidden' });
ipcMain.handle('monitor:status', (e) => monitorGuard(e) ? { ok: true, items: monitor.status() } : { ok: false, error: 'forbidden' });
ipcMain.handle('monitor:open-logs', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const dir = monitor.openLogs(String((p && p.key) || ''));
  return require('electron').shell.openPath(dir).then(() => ({ ok: true, dir }), (err) => ({ ok: false, error: String(err && err.message || err) }));
});
ipcMain.handle('monitor:run-backup', (e, p) => monitorGuard(e) ? monitor.runBackupNow(String((p && p.key) || '')) : { ok: false, error: 'forbidden' });
ipcMain.handle('secure:encrypt', (e, text) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  text = String(text == null ? '' : text);
  if (!text) return { ok: true, cipher: '' };
  if (text.length > 4096) return { ok: false, error: '内容过长' };
  try {
    const { safeStorage } = require('electron');
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '系统加密不可用' };
    return { ok: true, cipher: safeStorage.encryptString(text).toString('base64') };
  } catch (err) { return { ok: false, error: '加密失败' }; }
});
ipcMain.handle('secure:decrypt', (e, cipher) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  cipher = String(cipher == null ? '' : cipher);
  if (!cipher || cipher.length > 8192) return { ok: false, error: '密文无效' };
  try {
    const { safeStorage } = require('electron');
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '系统加密不可用' };
    const text = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    // decryptString 对损坏/异机密文不抛错而是返回空串：须显式判失败，否则监控拿空密码
    // 无限重试登录（表象是认证失败，实为 DPAPI 密钥已随换机/重装丢失，排障方向完全错误）
    if (!text) return { ok: false, error: '解密失败（密文无效或本机加密密钥已变化，请重新保存密码）' };
    return { ok: true, text };
  } catch (err) { return { ok: false, error: '解密失败' }; }
});
ipcMain.handle('monitor:get-settings', (e) => monitorGuard(e) ? { ok: true, notify: loadAppSettings().monitorNotify !== false, tray: trayEnabled() } : { ok: false, error: 'forbidden' });
ipcMain.handle('monitor:set-settings', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  if (p && typeof p.notify === 'boolean') {
    loadAppSettings().monitorNotify = p.notify;
    saveAppSettings();
  }
  return { ok: true, notify: loadAppSettings().monitorNotify !== false };
});
ipcMain.handle('monitor:overview', (e) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  return {
    ok: true,
    jobs: monitor.status(),
    events: monitorEvents.slice(-200).reverse(),
    backups: (configBackup.hosts().items || []).slice(0, 100)
  };
});
// 在线率趋势（近 7 天，10 分钟桶；key → [[bucketTs, 0|1], ...]）
ipcMain.handle('monitor:uptime', (e) => monitorGuard(e)
  ? { ok: true, series: uptimeStore.snapshot() }
  : { ok: false, error: 'forbidden' });
// 接口流量历史（监控中心「接口流量」页按需拉取采样序列）
ipcMain.handle('monitor:ifhistory', (e, key) => monitorGuard(e)
  ? monitor.ifHistory(String((key && key.key) || key || ''))
  : { ok: false, error: 'forbidden' });
// CPU/内存/sysUpTime 采样历史（监控中心「性能」页按需拉取）
ipcMain.handle('monitor:perfhistory', (e, key) => monitorGuard(e)
  ? monitor.perfHistory(String((key && key.key) || key || ''))
  : { ok: false, error: 'forbidden' });
// 测试钩子（仅冒烟测试环境）：模拟用户点击窗口关闭按钮
if (process.env.NETTOPO_USERDATA) {
  ipcMain.handle('monitor:test-close', (e) => {
    if (!monitorGuard(e)) return { ok: false };
    if (mainWin && !mainWin.isDestroyed()) mainWin.close();
    return { ok: true };
  });
}
ipcMain.handle('monitor:tray', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  if (p && typeof p.enabled === 'boolean') {
    loadAppSettings().trayEnabled = p.enabled;
    saveAppSettings();
    applyTray();
  }
  return { ok: true, enabled: trayEnabled() };
});

/* ---- 已信任主机指纹管理（TOFU 信任库的查看/撤销） ---- */
ipcMain.handle('monitor:trust-list', (e) => monitorGuard(e) ? monitor.trustList() : { ok: false, error: 'forbidden' });
ipcMain.handle('monitor:trust-revoke', (e, p) => monitorGuard(e) ? monitor.trustRevoke(String((p && p.host) || '')) : { ok: false, error: 'forbidden' });

/* ---- 在线升级（仅主窗口可调用）----
 * 源为 GitHub Releases：检查/下载/校验/换入全部在主进程完成，渲染层只收进度与结果。
 * apply 成功后延迟退出（trayQuitting 置位绕过「关窗到托盘」），由辅助进程拉起新版。 */
let updater = null;
function getUpdater() {
  if (!updater) {
    updater = new Updater({
      repo: '54gogogo10/nettopo',
      currentVersion: app.getVersion(),
      platform: process.platform,
      updateDir: app.getPath('userData') + path.sep + 'updates',
      // 便携版运行时 exe 是启动器自身（PORTABLE_EXECUTABLE_FILE 由打包器注入）；开发态指向 node_modules 的 electron，apply 会拒绝
      exePath: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      isPackaged: app.isPackaged
    });
    const push = (ch, data) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data); };
    updater.on('status', (s) => push('update:status', s));
    updater.on('progress', (p) => push('update:progress', p));
  }
  return updater;
}
ipcMain.handle('update:check', (e) => monitorGuard(e) ? getUpdater().check() : { ok: false, error: 'forbidden' });
ipcMain.handle('update:download', async (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const u = getUpdater();
  let assets = p && p.assets;
  if (!assets) {
    // 渲染层未携带资产信息（如经启动通知进入的流程）：重新检查取最新资产
    const c = await u.check();
    if (!c.ok || !c.update || !c.assets) return { ok: false, error: (c && c.error) || '当前没有可下载的升级资产' };
    assets = c.assets;
  }
  return u.downloadAndVerify(assets);
});
ipcMain.handle('update:apply', (e) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const r = getUpdater().apply();
  if (r && r.ok && r.restart) {
    // 先让 invoke 应答送达渲染层再退出；trayQuitting 置位绕过「关闭即隐藏到托盘」
    setTimeout(() => { trayQuitting = true; app.quit(); }, 600);
  }
  return r;
});
ipcMain.handle('update:reveal', (e) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const fs = require('fs');
  const u = getUpdater();
  if (!u.pendingFile || !fs.existsSync(u.pendingFile)) return { ok: false, error: '尚无已下载的升级包' };
  // 只允许打开本模块升级目录内的文件（防渲染层借 IPC 揭示任意路径）
  const updatesRoot = u.updateDir.endsWith(path.sep) ? u.updateDir : u.updateDir + path.sep;
  if (!u.pendingFile.startsWith(updatesRoot)) return { ok: false, error: 'forbidden' };
  require('electron').shell.showItemInFolder(u.pendingFile);
  return { ok: true };
});

/* ---- 监控日志浏览器：目录树 + 内容读取（路径逐级白名单校验） ---- */
const LOG_DIR_RE = /^(\d{4}-\d{2}-\d{2})$/;
function safeLogComponent(name, allowDate) {
  name = String(name || '');
  if (!name || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('..') >= 0 || name.length > 120) return null;
  if (allowDate && !LOG_DIR_RE.test(name)) return null;
  return name;
}
ipcMain.handle('monitor:logs-tree', (e) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const fs = require('fs');
  const base = monitor.logBaseDir;
  const devices = [];
  let names = [];
  try { names = fs.readdirSync(base); } catch (err) { names = []; }
  for (const dev of names) {
    const devDir = path.join(base, dev);
    let st;
    try { st = fs.lstatSync(devDir); } catch (err) { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const dates = [];
    let ds = [];
    try { ds = fs.readdirSync(devDir); } catch (err) { ds = []; }
    for (const d of ds) {
      if (!LOG_DIR_RE.test(d)) continue;
      const dDir = path.join(devDir, d);
      try { st = fs.lstatSync(dDir); } catch (err) { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const files = [];
      let fnames = [];
      try { fnames = fs.readdirSync(dDir); } catch (err) { fnames = []; }
      for (const f of fnames.slice(-300)) {
        // 兼容按天固定文件名（设备_管理口.log）与超限滚动/历史格式（设备_管理口_日期_时间[_n].log）
        if (!/^(?:[\u4e00-\u9fa5A-Za-z0-9_.-]+)_(?:[\u4e00-\u9fa5A-Za-z0-9_.-]+)(?:_\d{8}_\d{6}(?:_\d+)?)?\.log$/.test(f)) continue;
        const full = path.join(dDir, f);
        try { st = fs.lstatSync(full); } catch (err) { continue; }
        if (!st.isFile() || st.isSymbolicLink()) continue;
        files.push({ name: f, time: st.mtimeMs, size: st.size });
      }
      files.sort((a, b) => (b.time - a.time) || (a.name < b.name ? 1 : -1));
      if (files.length) dates.push({ date: d, files: files.slice(0, 100) });
    }
    dates.sort((a, b) => (a.date < b.date ? 1 : -1));
    if (dates.length) devices.push({ device: dev, dates });
  }
  devices.sort((a, b) => (a.device < b.device ? 1 : -1));
  return { ok: true, devices };
});
ipcMain.handle('monitor:logs-read', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const device = safeLogComponent(p && p.device, false);
  const date = safeLogComponent(p && p.date, true);
  const file = safeLogComponent(p && p.file, false);
  if (!device || !date || !file || !/^[\u4e00-\u9fa5A-Za-z0-9_.-]+\.log$/.test(file)) return { ok: false, error: '非法的日志文件路径' };
  const fs = require('fs');
  const full = monitor.logBaseDir + path.sep + device + path.sep + date + path.sep + file;
  // 边界终判：device/date/file 均已过 safeLogComponent 白名单，纵深兜底拼接结果仍在日志库内
  if (!full.startsWith(path.resolve(monitor.logBaseDir) + path.sep)) return { ok: false, error: '非法的日志文件路径' };
  try {
    const st = fs.lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) return { ok: false, error: '日志文件不存在' };
    // 超 4MB 只读尾部（丢弃首个残缺半行）：与 logs-search 的尾部读取同口径，命中行号保持可对齐；
    // 渲染层按 truncated 标记提示「仅显示末尾 4MB」
    let content = '', truncated = false;
    if (st.size > 4 * 1024 * 1024) {
      truncated = true;
      const fd = fs.openSync(full, 'r');
      try {
        const buf = Buffer.alloc(4 * 1024 * 1024);
        fs.readSync(fd, buf, 0, buf.length, st.size - buf.length);
        content = buf.toString('utf8');
        const nl = content.indexOf('\n');
        if (nl >= 0) content = content.slice(nl + 1);
      } finally {
        try { fs.closeSync(fd); } catch (err2) { /* ignore */ }
      }
    } else {
      content = fs.readFileSync(full, 'utf8');
    }
    return { ok: true, content, size: st.size, truncated };
  } catch (err) {
    return { ok: false, error: '读取日志失败' };
  }
});

ipcMain.handle('monitor:logs-search', (e, p) => {
  if (!monitorGuard(e)) return Promise.resolve({ ok: false, error: 'forbidden' });
  const keyword = String((p && p.keyword) || '').trim().slice(0, 200);
  if (!keyword) return Promise.resolve({ ok: false, error: '关键字为空' });
  // 检索在工作线程内执行：大目录（300 文件 × 4MB）的同步扫描不再冻结主进程
  return searchMonitorLogs(monitor.logBaseDir, keyword);
});

/* ---- 设备配置备份 IPC（复用 monitorGuard 防越权） ---- */
function backupCfgPath(p) {
  const device = String((p && p.device) || '');
  const host = String((p && p.host) || '');
  if (!device || !host || device.indexOf('..') >= 0 || host.indexOf('..') >= 0) return null;
  return { device, host };
}
ipcMain.handle('backupcfg:hosts', (e) => monitorGuard(e) ? configBackup.hosts() : { ok: false, error: 'forbidden' });
ipcMain.handle('backupcfg:list', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const dh = backupCfgPath(p);
  return dh ? configBackup.list(dh.device, dh.host) : { ok: false, error: '非法的设备/主机' };
});
ipcMain.handle('backupcfg:read', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const dh = backupCfgPath(p);
  return dh ? configBackup.read(dh.device, dh.host, String((p && p.name) || '')) : { ok: false, error: '非法的设备/主机' };
});
ipcMain.handle('backupcfg:remove', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const dh = backupCfgPath(p);
  return dh ? configBackup.remove(dh.device, dh.host, String((p && p.name) || '')) : { ok: false, error: '非法的设备/主机' };
});
ipcMain.handle('backupcfg:diff', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const dh = backupCfgPath(p);
  if (!dh) return { ok: false, error: '非法的设备/主机' };
  const a = String((p && p.a) || ''), b = String((p && p.b) || '');
  if (!a || !b) return { ok: false, error: '请选择两份备份' };
  if (a === b) return { ok: false, error: '请选择两份不同的备份' };
  return configBackup.diff(dh.device, dh.host, a, b);
});
ipcMain.handle('backupcfg:open', (e) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  try { require('fs').mkdirSync(configBackup.baseDir, { recursive: true }); } catch (err) { /* ignore */ }
  return require('electron').shell.openPath(configBackup.baseDir).then(() => ({ ok: true }), (err) => ({ ok: false, error: String(err && err.message || err) }));
});

/* ---- 内置网络服务 IPC（TFTP / FTP / Syslog，仅主窗口可调用） ---- */
ipcMain.handle('netsvc:get', (e) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  return { ok: true, cfg: netSvc.getConfig(), status: netSvc.status(), ips: localIPv4s() };
});
ipcMain.handle('netsvc:set', async (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const cfg = (p && p.cfg && typeof p.cfg === 'object') ? p.cfg : {};
  const status = await netSvc.applyConfig(cfg);
  // 运行态用明文；落盘前把 FTP 口令密文化（与项目「密码经 safeStorage 落盘」惯例对齐，
  // 此前明文写 settings.json，本机其他用户可读）
  try {
    const stored = JSON.parse(JSON.stringify(cfg));
    if (stored.ftp && typeof stored.ftp === 'object' && typeof stored.ftp.password === 'string'
      && stored.ftp.password && stored.ftp.password.indexOf(ENC_PREFIX) !== 0) {
      stored.ftp.password = encryptSecretValue(stored.ftp.password);
    }
    loadAppSettings().netSvc = stored;
    saveAppSettings();
  } catch (err) { /* 落盘失败不影响运行态 */ }
  return { ok: true, cfg: netSvc.getConfig(), status };
});
ipcMain.handle('netsvc:files', (e) => monitorGuard(e) ? netSvc.listFiles() : { ok: false, error: 'forbidden' });
ipcMain.handle('netsvc:file-read', (e, p) => monitorGuard(e) ? netSvc.readFile(p) : { ok: false, error: 'forbidden' });
ipcMain.handle('netsvc:file-delete', (e, p) => monitorGuard(e) ? netSvc.deleteFile(p) : { ok: false, error: 'forbidden' });
ipcMain.handle('netsvc:import', (e, p) => monitorGuard(e) ? netSvc.importBackup(p) : { ok: false, error: 'forbidden' });
ipcMain.handle('netsvc:syslog-tail', (e, p) => monitorGuard(e) ? netSvc.syslogTail(p && p.since) : { ok: false, error: 'forbidden' });
ipcMain.handle('netsvc:syslog-search', (e, p) => monitorGuard(e) ? netSvc.syslogSearch(p) : { ok: false, error: 'forbidden' });
ipcMain.handle('netsvc:open-folder', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const dir = netSvc.dirOf(String((p && p.svc) || ''));
  if (!dir) return { ok: false, error: '未知的服务' };
  return require('electron').shell.openPath(dir).then(() => ({ ok: true, dir }), (err) => ({ ok: false, error: String(err && err.message || err) }));
});

/* ---- Syslog 历史日志文件只读通道（AI 解析日志的取数口；仅主窗口可调用）----
 * 目录结构：<netSvc.syslogDir>/<主机目录>/<YYYY-MM-DD>.log，逐级白名单校验（与 monitor:logs-read 同口径） */
ipcMain.handle('netsvc:syslog-files', (e) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const fs = require('fs');
  const base = netSvc.syslogDir;
  const hosts = [];
  let names = [];
  try { names = fs.readdirSync(base); } catch (err) { names = []; }
  for (const host of names) {
    const hDir = path.join(base, host);
    let st;
    try { st = fs.lstatSync(hDir); } catch (err) { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const dates = [];
    let ds = [];
    try { ds = fs.readdirSync(hDir); } catch (err) { ds = []; }
    for (const d of ds) {
      const m = d.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      const full = path.join(hDir, d);
      let fst;
      try { fst = fs.lstatSync(full); } catch (err) { continue; }
      if (!fst.isFile() || fst.isSymbolicLink()) continue;
      dates.push({ date: m[1], name: d, size: fst.size, time: fst.mtimeMs });
    }
    dates.sort((a, b) => (a.date < b.date ? 1 : -1));
    if (dates.length) hosts.push({ host, dates: dates.slice(0, 120) });
  }
  hosts.sort((a, b) => (a.host < b.host ? 1 : -1));
  return { ok: true, hosts };
});
ipcMain.handle('netsvc:syslog-read', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const host = safeLogComponent(p && p.host, false);
  const date = safeLogComponent(p && p.date, true);
  if (!host || !date) return { ok: false, error: '非法的日志文件路径' };
  const fs = require('fs');
  const full = netSvc.syslogDir + path.sep + host + path.sep + date + '.log';
  // 边界终判：host/date 均已过 safeLogComponent 白名单，纵深兜底拼接结果仍在 syslog 库内
  if (!full.startsWith(path.resolve(netSvc.syslogDir) + path.sep)) return { ok: false, error: '非法的日志文件路径' };
  try {
    const st = fs.lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) return { ok: false, error: '日志文件不存在' };
    // 超 4MB 只读尾部（丢弃首个残缺半行）：与 monitor:logs-read 同口径
    let content = '', truncated = false;
    if (st.size > 4 * 1024 * 1024) {
      truncated = true;
      const fd = fs.openSync(full, 'r');
      try {
        const buf = Buffer.alloc(4 * 1024 * 1024);
        fs.readSync(fd, buf, 0, buf.length, st.size - buf.length);
        content = buf.toString('utf8');
        const nl = content.indexOf('\n');
        if (nl >= 0) content = content.slice(nl + 1);
      } finally {
        try { fs.closeSync(fd); } catch (err2) { /* ignore */ }
      }
    } else {
      content = fs.readFileSync(full, 'utf8');
    }
    return { ok: true, content, size: st.size, truncated };
  } catch (err) {
    return { ok: false, error: '读取日志失败' };
  }
});

/* ---- AI 解析（LLM，仅主窗口可调用）----
 * OpenAI 兼容接口的调用全部在主进程完成（渲染层 CSP 禁止直连外网）；
 * API Key 经 safeStorage 密文存 settings.json 的 ai 键，明文只在主进程内存中出现、不回传渲染层。 */
function aiCfgFromSettings() {
  const s = loadAppSettings().ai || {};
  return {
    baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : '',
    model: typeof s.model === 'string' ? s.model : '',
    apiKey: s.apiKeyEnc ? decryptSecretValue(s.apiKeyEnc) : '',
    maxInputKB: Number(s.maxInputKB) > 0 ? Math.min(2048, Math.floor(Number(s.maxInputKB))) : DEFAULT_MAX_INPUT_KB,
    protocol: validateProtocol(s.protocol)
  };
}
/** 分析记录库（惰性单例，库存 userData/ai-analysis） */
let aiHistory = null;
function getAiHistory() {
  if (!aiHistory) aiHistory = new AiHistoryStore(path.join(app.getPath('userData'), 'ai-analysis'));
  return aiHistory;
}
/** 进行中的分析客户端（ai:cancel 的取消目标；客户端按次新建，结束即清空） */
let aiActiveClient = null;
ipcMain.handle('ai:get-config', (e) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const c = aiCfgFromSettings();
  return { ok: true, baseUrl: c.baseUrl, model: c.model, maxInputKB: c.maxInputKB, protocol: c.protocol, apiKeySet: !!c.apiKey, apiKeyMasked: maskKey(c.apiKey) };
});
ipcMain.handle('ai:set-config', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const s = loadAppSettings();
  if (!s.ai || typeof s.ai !== 'object') s.ai = {};
  if (p && 'protocol' in p) s.ai.protocol = validateProtocol(p.protocol);
  if (p && 'baseUrl' in p) {
    const base = validateBaseUrl(p.baseUrl); // 空值合法（表示未配置）；非法格式直接拒绝并提示
    if (!base && String(p.baseUrl || '').trim()) return { ok: false, error: 'API 地址无效：需以 http:// 或 https:// 开头' };
    s.ai.baseUrl = base;
  }
  if (p && 'model' in p) s.ai.model = String(p.model || '').trim().slice(0, 200);
  if (p && 'maxInputKB' in p) {
    const n = Math.floor(Number(p.maxInputKB));
    s.ai.maxInputKB = (n >= 4 && n <= 2048) ? n : DEFAULT_MAX_INPUT_KB;
  }
  if (p && p.clearApiKey) delete s.ai.apiKeyEnc;
  else if (p && typeof p.apiKey === 'string' && p.apiKey) s.ai.apiKeyEnc = encryptSecretValue(p.apiKey); // 空串=保持不变
  saveAppSettings();
  const c = aiCfgFromSettings();
  return { ok: true, baseUrl: c.baseUrl, model: c.model, maxInputKB: c.maxInputKB, protocol: c.protocol, apiKeySet: !!c.apiKey, apiKeyMasked: maskKey(c.apiKey) };
});
ipcMain.handle('ai:test', async (e) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const client = new AiClient(aiCfgFromSettings());
  return client.test();
});
ipcMain.handle('ai:list-models', async (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const protocol = validateProtocol(p && p.protocol);
  const baseUrl = String((p && p.baseUrl) || '');
  if (!validateBaseUrl(baseUrl)) return { ok: false, error: '请先填写有效的 API 地址（http:// 或 https:// 开头）' };
  // 表单未填 Key 时回退已保存的 Key（编辑已配置服务时不必重复输入）
  let apiKey = String((p && p.apiKey) || '');
  if (!apiKey) apiKey = aiCfgFromSettings().apiKey;
  const client = new AiClient({ baseUrl, apiKey, protocol });
  return client.listModels();
});
ipcMain.handle('ai:analyze', async (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const kind = String((p && p.kind) || '');
  if (kind !== 'config' && kind !== 'syslog' && kind !== 'monlog') return { ok: false, error: '未知的分析类型' };
  const content = String((p && p.content) == null ? '' : p.content);
  if (!content.trim()) return { ok: false, error: '分析内容为空' };
  if (Buffer.byteLength(content, 'utf8') > 32 * 1024 * 1024) return { ok: false, error: '分析内容过大' };
  const client = new AiClient(aiCfgFromSettings());
  if (!client.ready) return { ok: false, error: !client.baseUrl ? '请先在 AI 设置中配置 API 地址' : '请先在 AI 设置中配置模型名' };
  // 输入按设置上限截断（配置保头部、日志保尾部），再组装提示词
  const cut = truncateText(content, (aiCfgFromSettings().maxInputKB || DEFAULT_MAX_INPUT_KB) * 1024, kind === 'config' ? 'head' : 'tail');
  const messages = (kind === 'config' ? buildConfigPrompt(cut.text, p && p.extra) : buildLogPrompt(kind, cut.text, p && p.extra));
  const title = String((p && p.title) || '').slice(0, 200);
  // 流式增量批量转发主窗口（120ms 合批，避免高频 IPC 淹没渲染层）
  const push = (ch, data) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data); };
  let pend = '';
  let lastFlush = Date.now();
  const onDelta = (d) => {
    pend += d;
    const now = Date.now();
    if (now - lastFlush >= 120) { lastFlush = now; if (pend) { push('ai:chunk', { text: pend }); pend = ''; } }
  };
  client.on('chunk', (c) => { if (c && c.text) onDelta(c.text); });
  aiActiveClient = client;
  const r = await client.chat({ messages, onDelta });
  aiActiveClient = null;
  if (pend) push('ai:chunk', { text: pend });
  if (r && r.ok) {
    // 成功的分析落历史库（含截断标注），供「分析记录」回看/导出
    const hist = getAiHistory().add({
      kind, title, model: r.model || client.model, ms: r.ms, usage: r.usage,
      content: (cut.truncated ? '【输入已截断：原文共 ' + cut.totalBytes + ' 字节】\n\n' : '') + r.text
    });
    if (!hist.ok) console.warn('[ai] 分析记录保存失败：' + hist.error);
  }
  return r;
});
/* ---- Web Shell AI 命令助手：自然语言需求 → 终端命令（主窗口与 Shell 窗口均可发起） ---- */
const aiShellClients = new Set(); // 进行中的命令生成客户端（ai:cancel 一并取消）
ipcMain.handle('ai:cancel', (e) => {
  // 取消属无害操作：主窗口（分析/命令生成）与 Shell 窗口（命令生成）均可发起
  if (!monitorGuard(e) && !shellSender(e)) return { ok: false, error: 'forbidden' };
  // 客户端按次新建（防重入），进行中的请求挂在最近一次分析上：用模块级引用兜底取消
  if (aiActiveClient) aiActiveClient.cancel();
  for (const c of aiShellClients) c.cancel();
  return { ok: true };
});
ipcMain.handle('ai:history-list', (e) => monitorGuard(e) ? getAiHistory().list() : { ok: false, error: 'forbidden' });
ipcMain.handle('ai:history-read', (e, p) => monitorGuard(e) ? getAiHistory().read(String((p && p.name) || '')) : { ok: false, error: 'forbidden' });
ipcMain.handle('ai:history-remove', (e, p) => monitorGuard(e) ? getAiHistory().remove(String((p && p.name) || '')) : { ok: false, error: 'forbidden' });
ipcMain.handle('ai:history-clear', (e) => monitorGuard(e) ? getAiHistory().clear() : { ok: false, error: 'forbidden' });
ipcMain.handle('ai:shell-chat', async (e, p) => {
  if (!shellSender(e)) return { ok: false, error: 'forbidden' };
  const requirement = String((p && p.requirement) || '').trim();
  if (!requirement) return { ok: false, error: '需求描述为空' };
  if (requirement.length > 4000) return { ok: false, error: '需求描述过长（上限 4000 字符）' };
  const client = new AiClient(aiCfgFromSettings());
  if (!client.ready) return { ok: false, error: '请先在主窗口菜单「AI 设置」中配置 API 地址与模型名' };
  // 终端上下文保尾部截断（提示词注入面收敛：内容在提示词中声明为不可信数据）
  const cut = truncateText(String((p && p.termContext) == null ? '' : p.termContext), 32 * 1024, 'tail');
  // 设备类型注入（SHELL_DEVICE_TYPES 白名单键，非法值回落 auto 不注入）
  const messages = buildShellPrompt(requirement, cut.text, String((p && p.deviceType) || ''));
  aiShellClients.add(client);
  try {
    const r = await client.chat({ messages, maxTokens: 1024 });
    if (!r.ok) return r;
    const parsed = parseShellCommands(r.text);
    return {
      ok: parsed.ok, commands: parsed.commands, refused: parsed.refused, reason: parsed.reason,
      reply: r.text, model: r.model || client.model, ms: r.ms
    };
  } finally {
    aiShellClients.delete(client);
  }
});

app.whenReady().then(() => {
  // 导出文件时弹出「另存为」对话框
  session.defaultSession.on('will-download', (e, item) => {
    item.setSaveDialogOptions({
      title: '保存导出文件',
      defaultPath: path.join(app.getPath('downloads'), item.getFilename())
    });
  });
  // 设备管理 Web 页兼容性：使用干净的 Chrome UA（去掉 Electron 标识，避免设备页面误判）
  // 弹窗抑制与 window.open 转标签由 webview 元素的 preload/allowpopups 处理
  session.fromPartition('persist:nettopo-web').setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  // 设备管理页（webview 分区，远程不可信内容）权限默认拒绝：通知/地理位置/媒体等一律不授予
  // （fullscreen 例外，设备控制台全屏查看属正常诉求）；同步权限检查同口径
  const webPartition = session.fromPartition('persist:nettopo-web');
  webPartition.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'fullscreen'));
  webPartition.setPermissionCheckHandler((wc, permission) => permission === 'fullscreen');
  // 设备管理页（webview 分区，远程不可信内容）下载同样弹出「另存为」，避免静默写文件到下载目录
  session.fromPartition('persist:nettopo-web').on('will-download', (e, item) => {
    item.setSaveDialogOptions({
      title: '保存下载文件',
      defaultPath: path.join(app.getPath('downloads'), item.getFilename())
    });
  });
  createWindow();
  applyTray();
  // 启动 30s 后静默检查一次在线升级：仅发现新版本时通知渲染层（检查失败完全静默，不打扰）
  setTimeout(() => {
    try {
      getUpdater().check().then((r) => {
        if (r && r.ok && r.update && mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('update:available', { version: r.latest.version, notes: r.latest.notes, url: r.latest.url, reason: r.reason });
        }
      }).catch(() => { /* ignore */ });
    } catch (e) { /* ignore */ }
  }, 30 * 1000);
  // 内置网络服务：上次启用的服务自动恢复（配置存 settings.netSvc；FTP 口令为 enc1: 密文，恢复前解密）
  try {
    const saved = loadAppSettings().netSvc;
    if (saved && typeof saved === 'object') {
      const restored = JSON.parse(JSON.stringify(saved));
      if (restored.ftp && typeof restored.ftp === 'object' && typeof restored.ftp.password === 'string'
        && restored.ftp.password.indexOf(ENC_PREFIX) === 0) {
        restored.ftp.password = decryptSecretValue(restored.ftp.password);
      }
      netSvc.applyConfig(restored).catch(() => { /* 恢复失败由面板状态展示 */ });
    }
  } catch (e) { /* ignore */ }
  // Linux 无密钥环（gnome-keyring/kwallet）时 safeStorage 回退 basic_text（弱混淆非加密）：
  // 工程文件内的设备密码近似明文，启动时明确提示一次，提醒注意文件访问权限
  if (process.platform === 'linux') {
    try {
      const { safeStorage } = require('electron');
      if (safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === 'basic_text') {
        setTimeout(() => notifyUser('网络拓扑管理软件 · 凭据保护降级',
          '未检测到系统密钥环（gnome-keyring/kwallet），设备密码仅以弱混淆方式保存在本机工程文件中，请注意文件访问权限'), 3000);
      }
    } catch (e) { /* ignore */ }
  }
  // 设备管理 Web 页（webview）证书处理：自签名/无效证书需用户手动确认
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (webContents.getType() !== 'webview') return; // 仅处理设备管理页内嵌浏览器
    let host = '';
    try { host = new URL(url).host; } catch (e) { host = url; }
    // 按证书指纹信任：仅当「本次运行已允许该主机且指纹一致」才静默放行；指纹变化视为证书被替换，重新询问
    if (allowedCerts.get(host) === certificate.fingerprint) { callback(true); return; }
    event.preventDefault();
    const id = 'cert' + (++certSeq);
    pendingCert.set(id, { callback, host, url, error, fp: certificate.fingerprint });
    emitCertError({ id, host, url, error });
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); } // 托盘模式隐藏后经 Dock 唤回
  });
  // 导航守卫：宿主窗口（主窗/Shell 窗/设备页宿主窗）只允许 file:// 本地页面——
  // 一旦被诱导跳转到远程页面，preload 桥（topoShell/topoBackup）将随之泄露；webview guest 不受限
  app.on('web-contents-created', (e, contents) => {
    contents.on('will-navigate', (ev, url) => {
      if (contents.getType() === 'webview') return; // 设备页内嵌 guest 自由导航（另有 popup 拦截）
      if (!/^file:/i.test(String(url))) ev.preventDefault();
    });
    // 纵深：guest 一律无 preload、无 Node；src 仅放行 http(s)（渲染层已校验，此处兜底）
    contents.on('will-attach-webview', (ev, webPreferences, params) => {
      try {
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        if (!/^https?:\/\//i.test(String((params && params.src) || ''))) ev.preventDefault();
      } catch (err) { /* ignore */ }
    });
    if (contents.getType() !== 'webview') {
      try { contents.setWindowOpenHandler(() => ({ action: 'deny' })); } catch (err) { /* ignore */ }
    }
  });
});

app.on('before-quit', () => { trayQuitting = true; });
app.on('will-quit', () => {
  monitor.stopAll();
  shell.closeAll();
  uptimeStore.flush();
  netSvc.stopAll();
  if (tray) { try { tray.destroy(); } catch (e) { /* ignore */ } tray = null; }
});

app.on('window-all-closed', () => {
  // 托盘常驻模式：所有窗口关闭后继续在后台运行监控；否则退出
  if (process.platform !== 'darwin' && !(trayEnabled() && !trayQuitting)) app.quit();
});
