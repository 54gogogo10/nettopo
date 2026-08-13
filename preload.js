/* NetTopo preload —— 向渲染层暴露 Web Shell IPC 桥（contextIsolation 下安全通信） */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('topoShell', {
  connect: (opts) => ipcRenderer.invoke('shell:connect', opts),
  sendData: (id, data) => ipcRenderer.send('shell:data', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('shell:resize', id, cols, rows),
  close: (id) => ipcRenderer.send('shell:close', id),
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
  openFolder: () => ipcRenderer.invoke('backup:open-folder')
});
