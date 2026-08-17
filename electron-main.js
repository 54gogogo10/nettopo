/* NetTopo Electron 主进程 */
'use strict';
const { app, BrowserWindow, session, ipcMain, dialog, Notification, Tray, Menu } = require('electron');
const path = require('path');
const { ShellManager } = require('./js/shell.js');
const { BackupStore, MAX_CONTENT_BYTES } = require('./js/backup-store.js');
const { MonitorManager } = require('./js/monitor.js');
const { ConfigBackupStore } = require('./js/config-backup.js');

// 测试隔离：冒烟测试通过 NETTOPO_USERDATA 覆盖用户数据目录（临时目录），避免污染真实备份数据
if (process.env.NETTOPO_USERDATA) app.setPath('userData', process.env.NETTOPO_USERDATA);

let mainWin = null;
let shellWin = null;
let webWin = null;
let tray = null;
let trayQuitting = false;
const trayEnabled = () => loadAppSettings().trayEnabled === true;
let trayJobCount = 0; // 托盘菜单显示的活动监控任务数
let webReady = false;              // Web 管理页窗口渲染层是否就绪
const pendingWebTabs = [];         // 等待 Web 窗口加载完成的 newtab 消息
let certSeq = 0;
const pendingCert = new Map();     // id -> { callback, host, url, error }
const allowedCerts = new Set();    // 本次运行已手动允许的主机（host）
const certQueue = [];              // 窗口未就绪时到达的证书告警
let shellReady = false;            // Shell 窗口渲染层是否已就绪（did-finish-load）
const pendingTabs = [];            // 等待新窗口加载完成的 newtab 消息
const shellQueue = [];             // 窗口就绪前到达的会话事件（避免首屏输出丢失）
const shell = new ShellManager();

/* ---- 设备后台静默监控（复用 Web Shell 底层连接，独立监视任务） ---- */
const configBackup = new ConfigBackupStore(path.join(app.getPath('userData'), 'config-backups'));
const monitor = new MonitorManager(shell, path.join(app.getPath('userData'), 'monitor-logs'), path.join(app.getPath('userData'), 'monitor-trust.json'), { backupStore: configBackup });

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
  if (trayEnabled() && !tray) {
    try {
      tray = new Tray(path.join(__dirname, 'icon.png'));
      tray.setToolTip('NetTopo 网络拓扑设计器（后台监控运行中）');
      tray.on('click', () => { if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); } });
      rebuildTrayMenu();
    } catch (e) { tray = null; }
  } else if (!trayEnabled() && tray) {
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
    title: 'NetTopo Web Shell',
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
    shell.closeAll(); // 窗口关闭即结束全部会话
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
    if (notifyEnabled()) notifyUser('NetTopo · 设备离线', info.name + '（' + info.host + '）探测失败，设备可能离线');
  } else if (info.ok === true && prev === false) {
    lastProbeOk.set(info.key, true);
    recordMonitorEvent(info, 'recovery', '探测恢复在线');
    if (notifyEnabled()) notifyUser('NetTopo · 设备恢复', info.name + '（' + info.host + '）已恢复在线');
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
      if (notifyEnabled()) notifyUser('NetTopo · 输出告警', info.name + '（' + info.host + '）' + detail);
    } else if (added.length) {
      lastAlertPatterns.set(info.key, cur);
      recordMonitorEvent(info, 'alert', detail + '（新增 ' + added.join('、') + '）');
      if (notifyEnabled()) notifyUser('NetTopo · 输出告警', info.name + '（' + info.host + '）' + detail);
    }
  } else if (lastAlertOn.get(info.key) === true) {
    lastAlertOn.set(info.key, false);
    lastAlertPatterns.delete(info.key);
    recordMonitorEvent(info, 'alert-clear', '告警解除');
  }
});
monitor.on('trust', (info) => {
  // 首次连接自动信任主机指纹：安全敏感事件，始终通知用户（不随 monitorNotify 开关关闭）
  notifyUser('NetTopo · 首次信任主机指纹',
    info.name + '（' + info.host + '）首次连接已自动信任指纹 ' + info.fp + '；后续指纹变化将拒绝连接');
});
const lastBackupChangeAt = new Map(); // key -> 上次变更通知时间（节流）
monitor.on('backup', (info) => {
  sendMonitor('monitor:backup', info);
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
        notifyUser('NetTopo · 配置变更', info.name + '（' + info.host + '）配置与上次备份不同（+' + (info.added || 0) + '/-' + (info.removed || 0) + ' 行）');
      }
    }
  } else {
    recordMonitorEvent(info, 'backup-error', (info.error || '备份失败'));
    const now = Date.now();
    const prevErr = lastBackupErrAt.get(info.key) || 0;
    if (now - prevErr > 10 * 60 * 1000) {
      lastBackupErrAt.set(info.key, now);
      notifyUser('NetTopo · 配置备份失败', info.name + '（' + info.host + '）：' + (info.error || '未知错误'));
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
    title: 'NetTopo 网络拓扑设计器',
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
      if (tray && tray.displayBalloon) { try { tray.displayBalloon({ title: 'NetTopo 已最小化到托盘', content: '后台监控仍在运行，点击托盘图标可恢复主窗口' }); } catch (err) { /* ignore */ } }
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
    title: 'NetTopo 设备管理页',
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
  if (payload.allow && payload.remember) allowedCerts.add(rec.host);
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
    return { ok: true, text: safeStorage.decryptString(Buffer.from(cipher, 'base64')) };
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
  const full = path.join(monitor.logBaseDir, device, date, file);
  try {
    const st = fs.lstatSync(full);
    if (!st.isFile() || st.isSymbolicLink()) return { ok: false, error: '日志文件不存在' };
    if (st.size > 4 * 1024 * 1024) return { ok: false, error: '日志文件过大（超过 4MB），请打开目录查看' };
    return { ok: true, content: fs.readFileSync(full, 'utf8'), size: st.size };
  } catch (err) {
    return { ok: false, error: '读取日志失败' };
  }
});

ipcMain.handle('monitor:logs-search', (e, p) => {
  if (!monitorGuard(e)) return { ok: false, error: 'forbidden' };
  const fs = require('fs');
  const keyword = String((p && p.keyword) || '').trim().slice(0, 200);
  if (!keyword) return { ok: false, error: '关键字为空' };
  const lower = keyword.toLowerCase();
  // 防护上限：防目录爆炸 / 超大文件 / 命中过多拖慢界面
  const MAX_FILES = 300;                     // 最多扫描的日志文件数
  const MAX_PER_FILE = 4 * 1024 * 1024;      // 单文件最多读取 4MB
  const MAX_TOTAL_HITS = 500;                // 总命中行数上限
  const FILE_RE = /^(?:[\u4e00-\u9fa5A-Za-z0-9_.-]+)_(?:[\u4e00-\u9fa5A-Za-z0-9_.-]+)(?:_\d{8}_\d{6}(?:_\d+)?)?\.log$/;
  const items = [];
  let total = 0, scanned = 0;
  let devs = [];
  try { devs = fs.readdirSync(monitor.logBaseDir); } catch (err) { devs = []; }
  outer:
  for (const dev of devs) {
    const devDir = path.join(monitor.logBaseDir, dev);
    let st;
    try { st = fs.lstatSync(devDir); } catch (err) { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    let ds = [];
    try { ds = fs.readdirSync(devDir); } catch (err) { ds = []; }
    for (const d of ds) {
      if (!LOG_DIR_RE.test(d)) continue;
      const dDir = path.join(devDir, d);
      try { st = fs.lstatSync(dDir); } catch (err) { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      let fnames = [];
      try { fnames = fs.readdirSync(dDir); } catch (err) { fnames = []; }
      for (const f of fnames) {
        if (!FILE_RE.test(f)) continue;
        const full = path.join(dDir, f);
        try { st = fs.lstatSync(full); } catch (err) { continue; }
        if (!st.isFile() || st.isSymbolicLink()) continue;
        if (++scanned > MAX_FILES) break outer;
        let content = '';
        try {
          const fd = fs.openSync(full, 'r');
          const buf = Buffer.alloc(Math.min(st.size, MAX_PER_FILE));
          fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          content = buf.toString('utf8');
        } catch (err) { continue; }
        const lines = content.split(/\r?\n/);
        const matches = [];
        for (let i = 0; i < lines.length; i++) {
          if (total >= MAX_TOTAL_HITS) break outer;
          if (lines[i].toLowerCase().indexOf(lower) >= 0) {
            matches.push({ line: i, text: lines[i].slice(0, 300) });
            total++;
          }
        }
        if (matches.length) items.push({ device: dev, date: d, file: f, size: st.size, matches });
      }
    }
  }
  return { ok: true, keyword, total, items: items.slice(0, 200) };
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
  createWindow();
  applyTray();
  // 设备管理 Web 页（webview）证书处理：自签名/无效证书需用户手动确认
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (webContents.getType() !== 'webview') return; // 仅处理设备管理页内嵌浏览器
    let host = '';
    try { host = new URL(url).host; } catch (e) { host = url; }
    if (allowedCerts.has(host)) { callback(true); return; }
    event.preventDefault();
    const id = 'cert' + (++certSeq);
    pendingCert.set(id, { callback, host, url, error });
    emitCertError({ id, host, url, error });
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 导航守卫：宿主窗口（主窗/Shell 窗/设备页宿主窗）只允许 file:// 本地页面——
  // 一旦被诱导跳转到远程页面，preload 桥（topoShell/topoBackup）将随之泄露；webview guest 不受限
  app.on('web-contents-created', (e, contents) => {
    contents.on('will-navigate', (ev, url) => {
      if (contents.getType() === 'webview') return; // 设备页内嵌 guest 自由导航（另有 popup 拦截）
      if (!/^file:/i.test(String(url))) ev.preventDefault();
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
  if (tray) { try { tray.destroy(); } catch (e) { /* ignore */ } tray = null; }
});

app.on('window-all-closed', () => {
  // 托盘常驻模式：所有窗口关闭后继续在后台运行监控；否则退出
  if (process.platform !== 'darwin' && !(trayEnabled() && !trayQuitting)) app.quit();
});
