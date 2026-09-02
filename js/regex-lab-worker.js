/* NetTopo 正则执行工作线程 —— 主进程纯 Node（不依赖 Electron），由 js/regex-lab.js 按次拉起。
 * 职责：在工作线程内执行用户可配置的正则（告警关键字/合规规则）。灾难性回溯只会拖死本线程，
 * 主进程侧以超时终止并拉黑该模式，事件循环永不被阻塞。
 * 协议：
 *   入  { id, items: [{ pattern, flags, op:'test'|'scan', text?, lines?, maxHits? }] }
 *   出  { type:'begin', id, index }                     每项执行前先报号：超时据此定位元凶模式
 *   出  { type:'done',  id, results: [...] , error? }   全部执行完（或构造即失败）后一次性返回
 */
'use strict';
const { parentPort } = require('worker_threads');

parentPort.on('message', (job) => {
  if (!job || typeof job.id !== 'number' || !Array.isArray(job.items)) return;
  const results = [];
  try {
    for (let i = 0; i < job.items.length; i++) {
      const it = job.items[i];
      // 先报号再执行：主进程超时终止时按最后一个 begin 定位卡死的模式
      parentPort.postMessage({ type: 'begin', id: job.id, index: i });
      const re = new RegExp(it.pattern, it.flags || '');
      if (it.op === 'scan') {
        // 合规巡检：逐行扫描，命中行号列表（截断到 maxHits）
        const lines = Array.isArray(it.lines) ? it.lines : [];
        const maxHits = Math.max(1, Math.floor(it.maxHits || 20));
        const hits = [];
        for (let l = 0; l < lines.length && hits.length < maxHits; l++) {
          if (re.test(lines[l])) hits.push(l);
        }
        results.push({ ok: true, hits });
      } else {
        // 告警匹配：整段文本 test + 可选的首个命中行（供事件时间线展示）
        const hit = re.test(String(it.text || ''));
        let line = null;
        if (hit && Array.isArray(it.lines)) {
          for (const ln of it.lines) { if (re.test(ln)) { line = String(ln).trim().slice(0, 200); break; } }
        }
        results.push({ ok: true, hit, line });
      }
    }
    parentPort.postMessage({ type: 'done', id: job.id, results });
  } catch (e) {
    parentPort.postMessage({ type: 'done', id: job.id, error: String((e && e.message) || e), results });
  }
});
