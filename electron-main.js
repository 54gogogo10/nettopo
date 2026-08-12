/* NetTopo Electron 主进程 */
'use strict';
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const { ShellManager } = require('./js/shell.js');

let mainWin = null;
const shell = new ShellManager();
// 会话事件 → 渲染层
shell.on('output', (id, data) => mainWin && mainWin.webContents.send('shell:output', id, data));
shell.on('status', (id, info) => mainWin && mainWin.webContents.send('shell:status', id, info));
shell.on('end', (id, reason) => mainWin && mainWin.webContents.send('shell:end', id, reason));

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
ipcMain.handle('shell:connect', (e, opts) => shell.connect(opts));
ipcMain.on('shell:data', (e, id, data) => shell.write(id, data));
ipcMain.on('shell:resize', (e, id, cols, rows) => shell.resize(id, cols, rows));
ipcMain.on('shell:close', (e, id) => shell.close(id));

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
