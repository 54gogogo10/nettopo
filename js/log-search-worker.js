/* NetTopo 日志检索工作线程 —— 主进程纯 Node（不依赖 Electron），由 js/log-search.js 按次拉起。
 * 把「目录遍历 + 逐文件读取 + 关键字匹配」从主进程移到工作线程：此前 monitor:logs-search
 * 同步扫描最多 300 文件、syslog 检索遍历全部主机/日期，大目录下一次检索会冻结主进程数秒
 * （监控采集/托盘/IPC 全部停摆）。
 * 协议：
 *   入  { id, op:'search', kind:'monitor'|'syslog', baseDir, keyword, hostFilter? }
 *   出  { type:'done', id, result }   result 形状与旧同步实现一致（渲染层无感知）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');

const LOG_DIR_RE = /^(\d{4}-\d{2}-\d{2})$/;
/* 兼容按天固定文件名（设备_管理口.log）与超限滚动/历史格式（设备_管理口_日期_时间[_n].log） */
const MONITOR_FILE_RE = /^(?:[\u4e00-\u9fa5A-Za-z0-9_.-]+)_(?:[\u4e00-\u9fa5A-Za-z0-9_.-]+)(?:_\d{8}_\d{6}(?:_\d+)?)?\.log$/;
const SYSLOG_FILE_RE = /^\d{4}-\d{2}-\d{2}\.log$/;
const MAX_FILES = 300;                 // 最多扫描的日志文件数
const MAX_PER_FILE = 4 * 1024 * 1024;  // 单文件最多读取 4MB（读尾部：最新日志更相关，且与 logs-read 截断口径一致，行号可对齐）
const MAX_TOTAL_HITS = 500;            // 总命中行数上限
const MAX_MONITOR_ITEMS = 200;         // monitor 结果条目上限
const MAX_SYSLOG_ITEMS = 100;          // syslog 结果条目上限

parentPort.on('message', (job) => {
  if (!job || typeof job.id !== 'number' || job.op !== 'search') return;
  try {
    parentPort.postMessage({ type: 'done', id: job.id, result: runSearch(job) });
  } catch (e) {
    parentPort.postMessage({ type: 'done', id: job.id, result: { ok: false, error: '检索失败：' + String((e && e.message) || e) } });
  }
});

/** 只读文件尾部 MAX_PER_FILE 字节（fd + try/finally 关闭；从字节中间切开时丢弃首个残缺半行）。
 *  返回文本；打开/读取失败返回 null（跳过该文件）。 */
function readTail(full, size) {
  try {
    const fd = fs.openSync(full, 'r');
    try {
      const len = Math.min(size, MAX_PER_FILE);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let content = buf.toString('utf8');
      if (len < size) {
        const nl = content.indexOf('\n');
        if (nl >= 0) content = content.slice(nl + 1);
      }
      return content;
    } finally {
      try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
    }
  } catch (e) { return null; }
}

function runSearch(job) {
  const keyword = String(job.keyword || '').trim().slice(0, 200);
  if (!keyword) return { ok: false, error: '关键字为空' };
  const lower = keyword.toLowerCase();
  const baseDir = String(job.baseDir || '');
  return job.kind === 'syslog' ? searchSyslog(baseDir, lower, String(job.hostFilter || '')) : searchMonitor(baseDir, lower);
}

/** 监控日志布局：<baseDir>/<设备名>/<YYYY-MM-DD>/<设备_管理口[_日期_时间[_n]].log>
 *  命中行携带行号（与 logs-read 的尾部读取口径一致，前端可定位）。 */
function searchMonitor(baseDir, lower) {
  const items = [];
  let total = 0, scanned = 0;
  let devs = [];
  try { devs = fs.readdirSync(baseDir); } catch (err) { devs = []; }
  outer:
  for (const dev of devs) {
    const devDir = path.join(baseDir, dev);
    let st;
    try { st = fs.lstatSync(devDir); } catch (err) { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    let ds = [];
    try { ds = fs.readdirSync(devDir); } catch (err) { ds = []; }
    for (const d of ds) {
      if (!LOG_DIR_RE.test(d)) continue;
      const dDir = path.join(devDir, d);
      try { st = fs.lstatSync(dDir); } catch (err) { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      let fnames = [];
      try { fnames = fs.readdirSync(dDir); } catch (err) { fnames = []; }
      for (const f of fnames) {
        if (!MONITOR_FILE_RE.test(f)) continue;
        const full = path.join(dDir, f);
        try { st = fs.lstatSync(full); } catch (err) { continue; }
        if (!st.isFile() || st.isSymbolicLink()) continue;
        if (++scanned > MAX_FILES) break outer;
        const content = readTail(full, st.size);
        if (content == null) continue;
        const lines = content.split(/\r?\n/);
        const matches = [];
        for (let i = 0; i < lines.length; i++) {
          if (total >= MAX_TOTAL_HITS) break outer;
          if (lines[i].toLowerCase().indexOf(lower) >= 0) {
            matches.push({ line: i, text: lines[i].slice(0, 300) });
            total++;
          }
        }
        if (matches.length) items.push({ device: dev, date: d, file: f, size: st.size, matches });
      }
    }
  }
  return { ok: true, total, items: items.slice(0, MAX_MONITOR_ITEMS) };
}

/** Syslog 布局：<baseDir>/<主机名或IP>/<YYYY-MM-DD>.log（日期文件倒序 = 最新优先；hostFilter 精确匹配） */
function searchSyslog(baseDir, lower, hostFilter) {
  const items = [];
  let total = 0;
  let hosts = [];
  try { hosts = fs.readdirSync(baseDir); } catch (e) { hosts = []; }
  outer:
  for (const host of hosts) {
    if (hostFilter && host !== hostFilter) continue;
    const hd = path.join(baseDir, host);
    let st;
    try { st = fs.lstatSync(hd); } catch (e) { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    let files = [];
    try { files = fs.readdirSync(hd).sort().reverse(); } catch (e) { continue; }
    for (const f of files) {
      if (!SYSLOG_FILE_RE.test(f)) continue;
      const full = path.join(hd, f);
      try { st = fs.lstatSync(full); } catch (e) { continue; }
      if (!st.isFile() || st.isSymbolicLink()) continue;
      const content = readTail(full, st.size);
      if (content == null) continue;
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        if (total >= MAX_TOTAL_HITS) break outer;
        if (lines[i] && lines[i].toLowerCase().indexOf(lower) >= 0) {
          matches.push(lines[i].slice(0, 400));
          total++;
        }
      }
      if (matches.length) items.push({ host, date: f.slice(0, 10), matches });
      if (items.length >= MAX_SYSLOG_ITEMS) break outer;
    }
  }
  return { ok: true, total, items };
}
