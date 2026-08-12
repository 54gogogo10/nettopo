/* NetTopo Electron 主进程 */
'use strict';
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const { ShellManager } = require('./js/shell.js');

let mainWin = null;
let shellWin = null;
let shellReady = false;            // Shell 窗口渲染层是否已就绪（did-finish-load）
const pendingTabs = [];            // 等待新窗口加载完成的 newtab 消息
const shellQueue = [];             // 窗口就绪前到达的会话事件（避免首屏输出丢失）
const shell = new ShellManager();

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
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWin.loadFile('index.html');
  mainWin.removeMenu();
  mainWin.on('closed', () => { mainWin = null; });
}

/* ---- Web Shell IPC ---- */
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
ipcMain.on('shell:data', (e, id, data) => shell.write(id, data));
ipcMain.on('shell:resize', (e, id, cols, rows) => shell.resize(id, cols, rows));
ipcMain.on('shell:close', (e, id) => shell.close(id));
ipcMain.on('shell:quit', () => { if (shellWin && !shellWin.isDestroyed()) shellWin.close(); });

app.whenReady().then(() => {
  // 导出文件时弹出「另存为」对话框
  session.defaultSession.on('will-download', (e, item) => {
    item.setSaveDialogOptions({
      title: '保存导出文件',
      defaultPath: path.join(app.getPath('downloads'), item.getFilename())
    });
  });
  createWindow();
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
