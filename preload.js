/* NetTopo preload —— 向渲染层暴露 Web Shell IPC 桥（contextIsolation 下安全通信） */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** 订阅主进程广播：返回退订函数。弹窗类界面（监控中心/网络服务面板等）关闭时必须退订，
 *  否则每次打开都在 ipcRenderer 上累积一个监听器，长会话下 CPU/内存随开合次数线性增长。 */
function sub(channel) {
  return (cb) => {
    const h = (_e, ...args) => { try { cb(...args); } catch (e) { /* 回调异常不中断广播 */ } };
    ipcRenderer.on(channel, h);
    return () => { try { ipcRenderer.removeListener(channel, h); } catch (e) { /* ignore */ } };
  };
}

contextBridge.exposeInMainWorld('topoShell', {
  connect: (opts) => ipcRenderer.invoke('shell:connect', opts),
  reconnect: (id) => ipcRenderer.invoke('shell:reconnect', { id }),
  sendData: (id, data) => ipcRenderer.send('shell:data', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('shell:resize', id, cols, rows),
  close: (id) => ipcRenderer.send('shell:close', id),
  trustFingerprint: (host, trust) => ipcRenderer.invoke('shell:trust', { host, trust }),
  copyText: (text) => ipcRenderer.invoke('shell:clipboard-write', text),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  pasteText: () => ipcRenderer.invoke('shell:clipboard-read'),
  onOutput: sub('shell:output'),
  onStatus: sub('shell:status'),
  onEnd: sub('shell:end'),
  onNewTab: sub('shell:newtab')
});

contextBridge.exposeInMainWorld('topoWeb', {
  open: (url, title) => ipcRenderer.invoke('web:open', { url, title }),
  onNewTab: sub('web:newtab'),
  onCertError: sub('web:cert-error'),
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
  onStatus: sub('monitor:status'),
  onProbe: sub('monitor:probe'),
  onAlert: sub('monitor:alert'),
  onBackup: sub('monitor:backup'),
  onSysinfo: sub('monitor:sysinfo'),
  ifHistory: (key) => ipcRenderer.invoke('monitor:ifhistory', { key }),
  onIfTraffic: sub('monitor:iftraffic'),
  perfHistory: (key) => ipcRenderer.invoke('monitor:perfhistory', { key }),
  onPerf: sub('monitor:perf'),
  onReboot: sub('monitor:reboot'),
  /* 已信任主机指纹（TOFU 信任库）的查看与撤销：设备换机/重装后可在此重置 */
  trustList: () => ipcRenderer.invoke('monitor:trust-list'),
  trustRevoke: (host) => ipcRenderer.invoke('monitor:trust-revoke', { host })
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

/* 在线升级（仅主窗口可用）：检查 / 下载校验 / 应用重启；进度与发现新版本经事件推送 */
contextBridge.exposeInMainWorld('topoUpdate', {
  check: () => ipcRenderer.invoke('update:check'),
  download: (assets) => ipcRenderer.invoke('update:download', { assets }),
  apply: () => ipcRenderer.invoke('update:apply'),
  reveal: () => ipcRenderer.invoke('update:reveal'),
  onStatus: sub('update:status'),
  onProgress: sub('update:progress'),
  onAvailable: sub('update:available')
});

/* 内置网络服务（TFTP / FTP / Syslog）：接收设备配置文件与收集日志（仅主窗口可用） */
contextBridge.exposeInMainWorld('topoNetSvc', {
  getConfig: () => ipcRenderer.invoke('netsvc:get'),
  setConfig: (cfg) => ipcRenderer.invoke('netsvc:set', { cfg }),
  files: () => ipcRenderer.invoke('netsvc:files'),
  fileRead: (p) => ipcRenderer.invoke('netsvc:file-read', p),
  fileDelete: (p) => ipcRenderer.invoke('netsvc:file-delete', p),
  importBackup: (p) => ipcRenderer.invoke('netsvc:import', p),
  syslogTail: (since) => ipcRenderer.invoke('netsvc:syslog-tail', { since }),
  syslogSearch: (p) => ipcRenderer.invoke('netsvc:syslog-search', p),
  openFolder: (svc) => ipcRenderer.invoke('netsvc:open-folder', { svc }),
  onFile: sub('netsvc:file'),
  onStatus: sub('netsvc:status')
});
