/* NetTopo Electron 主进程 */
'use strict';
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
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
      spellcheck: false
    }
  });
  win.loadFile('index.html');
  win.removeMenu();
}

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
