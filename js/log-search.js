/* NetTopo 日志检索调度器 —— 主进程纯 Node 模块（不依赖 Electron）
 * 把检索放进工作线程（js/log-search-worker.js）按次拉起、用完即弃：主进程事件循环不再被
 * 大目录的同步扫描（readdir + 逐文件读取 + 匹配）阻塞。检索是用户低频触发的操作，
 * 每次冷启动一个线程的成本（约 1-2ms）可忽略。
 * 可在 Node 测试中直接使用。
 */
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_TIMEOUT_MS = 60000;
let _seq = 0;

function searchLogs(job, timeoutMs) {
  return new Promise((resolve) => {
    let worker = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '检索超时' }), Math.max(1000, Math.floor(timeoutMs || DEFAULT_TIMEOUT_MS)));
    try {
      worker = new Worker(path.join(__dirname, 'log-search-worker.js'));
    } catch (e) { finish({ ok: false, error: '检索线程启动失败' }); return; }
    worker.on('message', (msg) => {
      if (msg && msg.type === 'done' && msg.id === job.id) {
        finish(msg.result && typeof msg.result === 'object' ? msg.result : { ok: false, error: '检索失败' });
      }
    });
    worker.on('error', () => finish({ ok: false, error: '检索线程异常' }));
    worker.postMessage({ op: 'search', id: job.id, kind: job.kind, baseDir: job.baseDir, keyword: job.keyword, hostFilter: job.hostFilter || '' });
  });
}

/** 监控日志检索（<baseDir>/<设备>/<日期>/<设备_管理口>.log 布局） */
function searchMonitorLogs(baseDir, keyword, timeoutMs) {
  return searchLogs({ id: ++_seq, kind: 'monitor', baseDir: String(baseDir || ''), keyword }, timeoutMs);
}

/** Syslog 检索（<baseDir>/<主机>/<日期>.log 布局；hostFilter 为主机目录名精确匹配） */
function searchSyslogLogs(baseDir, keyword, hostFilter, timeoutMs) {
  return searchLogs({ id: ++_seq, kind: 'syslog', baseDir: String(baseDir || ''), keyword, hostFilter: String(hostFilter || '') }, timeoutMs);
}

module.exports = { searchMonitorLogs, searchSyslogLogs };
