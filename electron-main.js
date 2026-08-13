/* NetTopo Electron 主进程 */
'use strict';
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const { ShellManager } = require('./js/shell.js');
const { BackupStore } = require('./js/backup-store.js');

// 测试隔离：冒烟测试通过 NETTOPO_USERDATA 覆盖用户数据目录（临时目录），避免污染真实备份数据
if (process.env.NETTOPO_USERDATA) app.setPath('userData', process.env.NETTOPO_USERDATA);

let mainWin = null;
let shellWin = null;
let webWin = null;
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

/* ---- 工程备份库（用户数据目录 backups/） ---- */
let backupStore = null;
function getBackupStore() {
  if (!backupStore) backupStore = new BackupStore(path.join(app.getPath('userData'), 'backups'));
  return backupStore;
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
  opts = opts || {};
  const url = String(opts.url || '').trim();
  if (!isHttpUrl(url)) return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' };
  if (url.length > 2048) return { ok: false, error: 'URL 过长' };
  openWebTab({ url, title: String(opts.title || url).slice(0, 80) });
  return { ok: true };
});
ipcMain.handle('shell:connect', (e, opts) => {
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
  if (typeof data !== 'string') return; // 仅接受字符串：防非字符串绕过限长并致流写入崩溃
  if (data.length > 1024 * 1024) return; // 防超大粘贴/异常数据
  shell.write(id, data);
});
ipcMain.on('shell:resize', (e, id, cols, rows) => shell.resize(id, cols, rows));
ipcMain.on('shell:close', (e, id) => shell.close(id));
ipcMain.handle('shell:clipboard-write', (e, text) => { const { clipboard } = require('electron'); clipboard.writeText(String(text == null ? '' : text)); });
ipcMain.handle('shell:open-external', (e, url) => {
  const u = String(url || '');
  if (u.length < 2048 && isHttpUrl(u)) require('electron').shell.openExternal(u);
  return { ok: true };
});
ipcMain.handle('shell:clipboard-read', () => require('electron').clipboard.readText());

/* ---- 工程备份管理 IPC（仅主窗口可调用，防其它窗口/被注入脚本越权读写备份） ---- */
function backupGuard(e) {
  return !!(mainWin && !mainWin.isDestroyed() && e && e.sender === mainWin.webContents);
}
ipcMain.handle('backup:save', (e, p) => {
  if (!backupGuard(e)) return { ok: false, error: 'forbidden' };
  const content = String((p && p.content) || '');
  if (content.length > 70 * 1024 * 1024) return { ok: false, error: '备份内容过大' }; // IPC 侧快速拦截，避免序列化超大 payload
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
});

app.on('will-quit', () => {
  shell.closeAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
