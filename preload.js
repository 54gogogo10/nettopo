/* NetTopo preload —— 向渲染层暴露 Web Shell IPC 桥（contextIsolation 下安全通信） */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('topoShell', {
  connect: (opts) => ipcRenderer.invoke('shell:connect', opts),
  sendData: (id, data) => ipcRenderer.send('shell:data', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('shell:resize', id, cols, rows),
  close: (id) => ipcRenderer.send('shell:close', id),
  trustFingerprint: (host, trust) => ipcRenderer.invoke('shell:trust', { host, trust }),
  copyText: (text) => ipcRenderer.invoke('shell:clipboard-write', text),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  pasteText: () => ipcRenderer.invoke('shell:clipboard-read'),
  onOutput: (cb) => ipcRenderer.on('shell:output', (_e, id, data) => cb(id, data)),
  onStatus: (cb) => ipcRenderer.on('shell:status', (_e, id, info) => cb(id, info)),
  onEnd: (cb) => ipcRenderer.on('shell:end', (_e, id, reason) => cb(id, reason)),
  onNewTab: (cb) => ipcRenderer.on('shell:newtab', (_e, info) => cb(info))
});

contextBridge.exposeInMainWorld('topoWeb', {
  open: (url, title) => ipcRenderer.invoke('web:open', { url, title }),
  onNewTab: (cb) => ipcRenderer.on('web:newtab', (_e, info) => cb(info)),
  onCertError: (cb) => ipcRenderer.on('web:cert-error', (_e, info) => cb(info)),
  allowCert: (payload) => ipcRenderer.invoke('web:cert-allow', payload)
});

contextBridge.exposeInMainWorld('topoBackup', {
  save: (payload) => ipcRenderer.invoke('backup:save', payload),
  list: () => ipcRenderer.invoke('backup:list'),
  read: (name) => ipcRenderer.invoke('backup:read', { name }),
  remove: (name) => ipcRenderer.invoke('backup:delete', { name }),
  removeAll: () => ipcRenderer.invoke('backup:delete', { all: true }),
  openFolder: () => ipcRenderer.invoke('backup:open-folder'),
  getDir: () => ipcRenderer.invoke('backup:get-dir'),
  chooseDir: () => ipcRenderer.invoke('backup:choose-dir'),
  resetDir: () => ipcRenderer.invoke('backup:reset-dir')
});

contextBridge.exposeInMainWorld('topoMonitor', {
  start: (opts) => ipcRenderer.invoke('monitor:start', opts),
  stop: (key) => ipcRenderer.invoke('monitor:stop', { key }),
  stopAll: () => ipcRenderer.invoke('monitor:stopAll'),
  status: () => ipcRenderer.invoke('monitor:status'),
  openLogs: (key) => ipcRenderer.invoke('monitor:open-logs', { key }),
  logsTree: () => ipcRenderer.invoke('monitor:logs-tree'),
  logsRead: (device, date, file) => ipcRenderer.invoke('monitor:logs-read', { device, date, file }),
  logsSearch: (keyword) => ipcRenderer.invoke('monitor:logs-search', { keyword }),
  runBackup: (key) => ipcRenderer.invoke('monitor:run-backup', { key }),
  getSettings: () => ipcRenderer.invoke('monitor:get-settings'),
  setSettings: (notify) => ipcRenderer.invoke('monitor:set-settings', { notify }),
  setTray: (enabled) => ipcRenderer.invoke('monitor:tray', { enabled }),
  testClose: () => ipcRenderer.invoke('monitor:test-close'),
  overview: () => ipcRenderer.invoke('monitor:overview'),
  uptime: () => ipcRenderer.invoke('monitor:uptime'),
  onStatus: (cb) => ipcRenderer.on('monitor:status', (_e, info) => cb(info)),
  onProbe: (cb) => ipcRenderer.on('monitor:probe', (_e, info) => cb(info)),
  onAlert: (cb) => ipcRenderer.on('monitor:alert', (_e, info) => cb(info)),
  onBackup: (cb) => ipcRenderer.on('monitor:backup', (_e, info) => cb(info)),
  onSysinfo: (cb) => ipcRenderer.on('monitor:sysinfo', (_e, info) => cb(info)),
  ifHistory: (key) => ipcRenderer.invoke('monitor:ifhistory', { key }),
  onIfTraffic: (cb) => ipcRenderer.on('monitor:iftraffic', (_e, info) => cb(info))
});

contextBridge.exposeInMainWorld('topoConfigBackup', {
  hosts: () => ipcRenderer.invoke('backupcfg:hosts'),
  list: (device, host) => ipcRenderer.invoke('backupcfg:list', { device, host }),
  read: (device, host, name) => ipcRenderer.invoke('backupcfg:read', { device, host, name }),
  remove: (device, host, name) => ipcRenderer.invoke('backupcfg:remove', { device, host, name }),
  diff: (device, host, a, b) => ipcRenderer.invoke('backupcfg:diff', { device, host, a, b }),
  openFolder: () => ipcRenderer.invoke('backupcfg:open')
});

/* 密码等机密字段经主进程 safeStorage 加密后落盘（仅主窗口可用，主进程校验） */
contextBridge.exposeInMainWorld('topoSecure', {
  encryptSecret: (text) => ipcRenderer.invoke('secure:encrypt', text),
  decryptSecret: (cipher) => ipcRenderer.invoke('secure:decrypt', cipher)
});
