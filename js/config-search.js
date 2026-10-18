/* NetTopo 配置备份全文检索 —— 主进程纯 Node 模块（不依赖 Electron）
 *
 * 解决什么问题：配置备份库此前只能「按设备看列表、勾两份 diff」。值班时最常问的却是跨设备/跨时间的问题——
 * 「10.1.1.0/24 到底配在哪些设备上」「谁还开着 telnet」「这条 ACL 是从哪台设备抄过去的」。
 * 逐个设备点开翻，等于没有检索。
 *
 * 设计：
 * - 扫描目录布局与 js/config-backup.js 完全一致：<baseDir>/<设备>/<主机>/cfg_YYYYMMDD_HHMMSS[_n].cfg；
 *   只读普通文件，跳过符号链接，单文件上限与备份库一致（8MB）。
 * - 扫描放工作线程（js/config-search-worker.js）里跑：备份库可能有上千份配置，同步扫会冻结主进程。
 * - 查询支持纯文本 / 正则、大小写、设备、时间范围；返回命中行与上下文行（行号 1 基）。
 * - 默认对口令类内容打码（password / secret / community / key-string…），避免检索结果被截图或导出时泄密；
 *   界面可显式关闭打码（管理员本就能查看备份原文）。
 *
 * 诚实标注：命中上限（默认 300）只保证「前 N 处」完整，超出时 truncated=true，不假装扫全了。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const MAX_FILES = 3000;                 // 最多扫描的备份文件数（每台设备保留 50 份，3000 份≈60 台满档）
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 与 ConfigBackupStore 的单份上限一致
const MAX_HITS = 500;
const MAX_LINE_LEN = 400;               // 命中行/上下文行展示上限（防止超长 banner 撑爆界面）
const DEFAULT_MAX_RESULTS = 300;
const DEFAULT_CONTEXT = 2;
const DEFAULT_TIMEOUT_MS = 60000;

/* 备份文件名：cfg_20261018_221500.cfg（同一秒重复保存时带 _2 后缀） */
const FILE_RE = /^cfg_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\d+)?\.cfg$/;

/** 解析备份文件名中的时间（本地时区，与 config-backup 生成文件名的口径一致）。
 *  返回毫秒时间戳；不认识的名字返回 null。 */
function parseBackupName(name) {
  const m = FILE_RE.exec(String(name || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), s = Number(m[6]);
  const ts = new Date(y, mo, d, h, mi, s).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** 口令打码：从关键字起到行尾全部替换为 ******。
 *  宁可多遮（如 snmp-server community public RO 会连 RO 一起遮），也不漏遮——检索结果常被截图与导出。
 *  例外：Cisco 的 key chain NAME 不是口令，保持原样。 */
function maskSecrets(line) {
  const s = String(line == null ? '' : line);
  // 行内出现口令关键字时，从该关键字之后全部打码；key chain 除外
  const re = /(^|\s)(password|passwd|pwd|secret|community|key-string|authentication-key|auth-key|cipher|encryption-key)(\s+)(.*)$/i;
  const m = re.exec(s);
  if (!m) return s;
  if (/^\s*key\s+chain\b/i.test(s)) return s;
  return s.slice(0, m.index + m[1].length + m[2].length) + ' ******';
}

/** 查询归一化（IPC 与单测共用）：非法正则/空关键字返回 {ok:false,error}。
 *  context 为上下文行数（0~5），maxResults 1~MAX_HITS，from/to 为毫秒时间戳。 */
function normalizeConfigQuery(q) {
  q = (q && typeof q === 'object') ? q : {};
  const keyword = String(q.keyword == null ? '' : q.keyword).trim().slice(0, 200);
  if (!keyword) return { ok: false, error: '请输入检索关键字' };
  const regex = q.regex === true;
  let re = null;
  if (regex) {
    try { re = new RegExp(keyword, q.caseSensitive === true ? '' : 'i'); }
    catch (e) { return { ok: false, error: '正则表达式无效：' + String((e && e.message) || e) }; }
  }
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  return {
    ok: true,
    query: {
      keyword,
      regex,
      caseSensitive: q.caseSensitive === true,
      device: String(q.device == null ? '' : q.device).trim().slice(0, 200),
      from: Math.max(0, num(q.from, 0)),
      to: Math.max(0, num(q.to, 0)),
      context: Math.max(0, Math.min(5, num(q.context, DEFAULT_CONTEXT))),
      maxResults: Math.max(1, Math.min(MAX_HITS, num(q.maxResults, DEFAULT_MAX_RESULTS))),
      maskSecrets: q.maskSecrets !== false
    }
  };
}

/** 同步扫描（工作线程与单测共用）。opts = { baseDir, query }。
 *  返回 { ok, total, files, scanned, skipped, truncated, elapsedMs, items }。 */
function scanConfigs(opts) {
  const t0 = Date.now();
  const baseDir = String((opts && opts.baseDir) || '');
  const norm = normalizeConfigQuery(opts && opts.query);
  if (!norm.ok) return norm;
  const q = norm.query;
  // 匹配器：纯文本走 includes（大小写敏感时不做 lower），正则在归一化时已编译
  let re = null;
  if (q.regex) re = new RegExp(q.keyword, q.caseSensitive ? '' : 'i');
  const lowerKw = q.caseSensitive ? '' : q.keyword.toLowerCase();
  const hit = (line) => {
    if (re) return re.test(line);
    return q.caseSensitive ? line.indexOf(q.keyword) >= 0 : line.toLowerCase().indexOf(lowerKw) >= 0;
  };

  // 1. 枚举「设备/主机」目录，收集候选备份文件
  const files = [];
  let skipped = 0;
  let devs = [];
  try { devs = fs.readdirSync(baseDir); } catch (err) { devs = []; }
  for (const dev of devs) {
    if (q.device && dev !== q.device) continue;
    const devDir = path.join(baseDir, dev);
    let st;
    try { st = fs.lstatSync(devDir); } catch (err) { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    let hosts = [];
    try { hosts = fs.readdirSync(devDir); } catch (err) { hosts = []; }
    for (const host of hosts) {
      const hDir = path.join(devDir, host);
      try { st = fs.lstatSync(hDir); } catch (err) { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      let names = [];
      try { names = fs.readdirSync(hDir); } catch (err) { names = []; }
      for (const name of names) {
        const ts = parseBackupName(name);
        if (ts == null) continue;
        if (q.from && ts < q.from) { skipped++; continue; }
        if (q.to && ts > q.to) { skipped++; continue; }
        const full = path.join(hDir, name);
        try { st = fs.lstatSync(full); } catch (err) { continue; }
        if (!st.isFile() || st.isSymbolicLink()) continue;
        if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
        files.push({ device: dev, host, name, full, ts, size: st.size });
      }
    }
  }
  // 2. 最新备份优先（排查时先看最近一次），同时间按设备/主机/文件名定序，保证结果可复现
  files.sort((a, b) => (b.ts - a.ts) || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0)
    || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const scanList = files.slice(0, MAX_FILES);
  const fileTruncated = files.length > scanList.length;

  // 3. 逐文件读取 + 匹配
  const items = [];
  let total = 0;
  let truncated = false;
  for (const f of scanList) {
    if (total >= q.maxResults) { truncated = true; break; }
    let text;
    try { text = fs.readFileSync(f.full, 'utf8'); } catch (err) { skipped++; continue; }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (total >= q.maxResults) { truncated = true; break; }
      const raw = String(lines[i] == null ? '' : lines[i]);
      if (!hit(raw)) continue;
      const shown = raw.slice(0, MAX_LINE_LEN);
      const before = [];
      const after = [];
      const ctx = q.context;
      for (let k = Math.max(0, i - ctx); k < i; k++) before.push(String(lines[k] == null ? '' : lines[k]).slice(0, MAX_LINE_LEN));
      for (let k = i + 1; k <= Math.min(lines.length - 1, i + ctx); k++) after.push(String(lines[k] == null ? '' : lines[k]).slice(0, MAX_LINE_LEN));
      const masked = q.maskSecrets;
      matches.push({
        line: i + 1,
        text: masked ? maskSecrets(shown) : shown,
        before: before.map(x => masked ? maskSecrets(x) : x),
        after: after.map(x => masked ? maskSecrets(x) : x)
      });
      total++;
    }
    if (matches.length) {
      items.push({ device: f.device, host: f.host, name: f.name, ts: f.ts, size: f.size, matches });
    }
    if (truncated) break;
  }

  return {
    ok: true,
    total,
    files: items.length,
    scanned: scanList.length,
    skipped,
    truncated: truncated || fileTruncated,
    elapsedMs: Date.now() - t0,
    masked: q.maskSecrets,
    query: { keyword: q.keyword, regex: q.regex, caseSensitive: q.caseSensitive, device: q.device, context: q.context },
    items
  };
}

let _seq = 0;
/** 工作线程调度：一次检索一个线程，用完即弃；超时/异常返回 {ok:false}，不冻结主进程。
 *  baseDir（备份库根目录）与 query 由主进程填，渲染层拿不到任意路径。 */
function searchConfigBackups(baseDir, query, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++_seq;
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
      worker = new Worker(path.join(__dirname, 'config-search-worker.js'));
    } catch (e) { finish({ ok: false, error: '检索线程启动失败' }); return; }
    worker.on('message', (msg) => {
      if (msg && msg.type === 'done' && msg.id === id) {
        finish(msg.result && typeof msg.result === 'object' ? msg.result : { ok: false, error: '检索失败' });
      }
    });
    worker.on('error', () => finish({ ok: false, error: '检索线程异常' }));
    worker.postMessage({ op: 'search', id, baseDir: String(baseDir || ''), query: query || {} });
  });
}

module.exports = {
  parseBackupName, maskSecrets, normalizeConfigQuery, scanConfigs, searchConfigBackups,
  MAX_FILES, MAX_FILE_BYTES, MAX_HITS, DEFAULT_MAX_RESULTS, DEFAULT_CONTEXT
};
