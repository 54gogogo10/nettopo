/* NetTopo 配置备份检索工作线程 —— 主进程纯 Node（不依赖 Electron），由 js/config-search.js 按次拉起。
 *
 * 为什么单独开线程：备份库可能上千份配置（每台设备最多 50 份、单份最大 8MB），同步扫目录并逐文件读取
 * 会把主进程（监控采集 / 托盘 / 全部 IPC）冻结数秒。检索是用户低频触发的操作，按次拉起线程的成本可忽略。
 *
 * 协议：
 *   入  { op:'search', id, baseDir, query }
 *   出  { type:'done', id, result }   result 与 scanConfigs 的返回值一致
 */
'use strict';
const { parentPort } = require('worker_threads');
const { scanConfigs } = require('./config-search.js');

parentPort.on('message', (job) => {
  if (!job || typeof job.id !== 'number' || job.op !== 'search') return;
  let result;
  try {
    result = scanConfigs({ baseDir: job.baseDir, query: job.query });
  } catch (e) {
    result = { ok: false, error: '检索失败：' + String((e && e.message) || e) };
  }
  parentPort.postMessage({ type: 'done', id: job.id, result });
});
