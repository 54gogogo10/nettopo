/* NetTopo 容量趋势库 —— 主进程纯 Node 模块（不依赖 Electron）
 *
 * 解决什么问题：接口流量历史此前只活在 MonitorManager 的内存环形缓冲里（IF_HIST_MAX 条，重启即丢），
 * 监控中心报表窗口只有 1 小时 / 24 小时 / 7 天。于是「这条上联什么时候会打满」「这个月 95th 多少」
 * 这两个容量规划问题，软件里没有数据可答。
 *
 * 本模块把 ifTable 采样降采样后落盘：
 * - 按「设备@管理地址 → 接口 → 本地日期」聚合：样本数、在线样本、收发累计/峰值、28 档对数直方图；
 * - 直方图保留 HIST_DAYS 天，用于合并计算窗口 95th（不是把日 P95 再平均）；更早的日期只留日 P95；
 * - 每日记录保留 KEEP_DAYS 天，单接口按日压缩，单文件超过上限时从最旧日期开始丢，绝不无界增长；
 * - 每台设备一个文件（userData/capacity/<hash>.json），原子写；损坏的单设备文件跳过并计数，不影响其它设备。
 *
 * 诚实口径（界面与报表必须原样带出）：
 * - 95th 是「本机按监控间隔采到的速率样本」的分位数，不是 5 分钟固定探针的运营商口径；采样越稀，峰值越容易被抹平。
 * - 直方图只有 HIST_DAYS 天：窗口更长时，P95 只覆盖有直方图的那部分样本，coverage 如实给出，不用部分数据冒充整段。
 * - 首次采样没有计数器差值（rate=null）不计入样本，也不当 0；接口 down 时采不到速率同样不计入。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_VERSION = 1;
const KEEP_DAYS = 180;                 // 每日记录保留天数
const HIST_DAYS = 32;                  // 直方图保留天数（覆盖「本月 / 近 30 天」）
const MAX_KEYS = 200;                  // 最多设备数
const MAX_IFS_PER_KEY = 96;            // 单设备最多跟踪接口数（活跃接口优先，超限丢弃并计数）
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DAY_MS = 86400000;

/* 直方图边界（kbps）：覆盖 1M~100G 的常见链路，并在 100M/1G 附近加密。
 * 28 个桶；P95 落在某桶时同时给出桶的上下界，界面按「中点 ± 桶宽」展示——
 * 只报一个数会显得比实际更精确，容量规划需要知道误差范围。 */
const HIST_EDGES_KBPS = [0, 10, 100, 1000, 5000, 10000, 25000, 50000, 75000, 100000,
  150000, 200000, 300000, 400000, 500000, 750000, 1000000, 1500000, 2000000, 3000000,
  5000000, 7500000, 10000000, 15000000, 20000000, 30000000, 50000000, 75000000, 100000000];
const HIST_BUCKETS = HIST_EDGES_KBPS.length - 1;

const pad2 = (n) => (n < 10 ? '0' : '') + n;
/** 本地日期键（YYYY-MM-DD）：与用户看到的「哪天」一致，跨时区不做 UTC 换算 */
function dayKey(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
/** 日期键 → 本地零点毫秒；非法返回 NaN */
function dayStart(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}
function bucketOf(kbps) {
  const v = Number(kbps);
  if (!Number.isFinite(v) || v <= 0) return 0;
  for (let i = 0; i < HIST_BUCKETS; i++) if (v < HIST_EDGES_KBPS[i + 1]) return i;
  return HIST_BUCKETS - 1;
}
function histP95(hist) {
  if (!Array.isArray(hist) || hist.length !== HIST_BUCKETS) return null;
  let total = 0;
  for (const n of hist) total += Number(n) || 0;
  if (!total) return null;
  const target = total * 0.95;
  let cum = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    cum += Number(hist[i]) || 0;
    if (cum >= target) {
      const low = HIST_EDGES_KBPS[i], high = HIST_EDGES_KBPS[i + 1];
      return { kbps: Math.round((low + high) / 2), low, high, bucket: i, samples: total };
    }
  }
  const last = HIST_EDGES_KBPS[HIST_BUCKETS];
  return { kbps: last, low: HIST_EDGES_KBPS[HIST_BUCKETS - 1], high: last, bucket: HIST_BUCKETS - 1, samples: total };
}

/** 文件名安全化：key 可能含设备名里的任意字符，用哈希定名，内容里保存原 key。 */
function fileOfKey(baseDir, key) {
  const h = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
  return path.join(baseDir, 'k_' + h + '.json');
}

function emptyIface(name, speed) {
  return { n: String(name || '').slice(0, 96), sp: Number(speed) || 0, d: {}, h: {}, dropped: 0 };
}
function emptyKey(key, name, host) {
  return { key: String(key), name: String(name || ''), host: String(host || ''), ifs: {}, updatedAt: 0 };
}
function newDay() {
  // [samples, upSamples, inSumKbps, inMaxKbps, outSumKbps, outMaxKbps, inP95Kbps, outP95Kbps]
  return [0, 0, 0, 0, 0, 0, null, null];
}

class CapacityStore {
  constructor(baseDir, opts) {
    this.baseDir = String(baseDir || '');
    this.keepDays = Math.max(1, Math.min(3650, Number(opts && opts.keepDays) || KEEP_DAYS));
    this.histDays = Math.max(1, Math.min(this.keepDays, Number(opts && opts.histDays) || HIST_DAYS));
    this.maxIfs = Math.max(1, Number(opts && opts.maxIfs) || MAX_IFS_PER_KEY);
    this.map = new Map();     // key -> keyRecord
    this.dirty = new Set();   // 待落盘 key
    this.stats = { droppedIfs: 0, droppedDays: 0, badFiles: 0, truncatedFiles: 0 };
  }

  _ensureDir() {
    try { fs.mkdirSync(this.baseDir, { recursive: true }); } catch (e) { /* ignore */ }
  }

  /** 读取一台设备文件；损坏/版本不符返回 null 并计数（不覆盖原文件，除非后续 record 明确改写）。 */
  _load(key) {
    if (this.map.has(key)) return this.map.get(key);
    const file = fileOfKey(this.baseDir, key);
    let rec = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.v === FILE_VERSION && raw.key === key && raw.ifs && typeof raw.ifs === 'object') {
        rec = { key: raw.key, name: String(raw.name || ''), host: String(raw.host || ''), ifs: {}, updatedAt: Number(raw.updatedAt) || 0 };
        for (const [name, it] of Object.entries(raw.ifs)) {
          if (!it || typeof it !== 'object') continue;
          const iface = emptyIface(it.n || name, it.sp);
          if (it.d && typeof it.d === 'object') {
            for (const [dk, arr] of Object.entries(it.d)) {
              if (!Array.isArray(arr) || arr.length < 8) continue;
              const nums = arr.map((v, i) => (i === 6 || i === 7) ? (Number.isFinite(Number(v)) ? Number(v) : null) : (Number(v) || 0));
              if (Number.isFinite(dayStart(dk))) iface.d[dk] = nums; // 显式日期合法性判定（dayStart 非法返回 NaN）
            }
          }
          if (it.h && typeof it.h === 'object') {
            for (const [dk, h] of Object.entries(it.h)) {
              if (!Array.isArray(h) || !Array.isArray(h[0]) || !Array.isArray(h[1])) continue;
              if (h[0].length !== HIST_BUCKETS || h[1].length !== HIST_BUCKETS) continue;
              if (!Number.isFinite(dayStart(dk))) continue; // 日期键非法的直方图与日记录同口径剔除
              iface.h[dk] = [h[0].map(n => Number(n) || 0), h[1].map(n => Number(n) || 0)];
            }
          }
          rec.ifs[name] = iface;
        }
      }
    } catch (e) {
      let exists = false;
      try { exists = fs.existsSync(file); } catch (e2) { exists = false; }
      if (exists) this.stats.badFiles++;
      rec = null;
    }
    if (!rec) rec = emptyKey(key, '', '');
    this.map.set(key, rec);
    return rec;
  }

  /** 记录一轮 ifTable 采样。ifs: [{n, oper, speed, in, out}]，in/out 为 bps（首采样/回绕为 null）。
   *  ts 由调用方给（测试可注入），同一秒重复调用会累加样本数——调用方按监控间隔调用即可。 */
  record(ts, key, name, host, ifs) {
    key = String(key || '').trim();
    if (!key || !Array.isArray(ifs) || !ifs.length) return { ok: false, error: '参数为空' };
    if (this.map.size >= MAX_KEYS && !this.map.has(key)) return { ok: false, error: '设备数已达上限' };
    const rec = this._load(key);
    if (name && !rec.name) rec.name = String(name).slice(0, 200);
    if (host && !rec.host) rec.host = String(host).slice(0, 200);
    const now = Number(ts) || Date.now();
    const dk = dayKey(now);
    let changed = false;
    for (const raw of ifs) {
      if (!raw || typeof raw !== 'object') continue;
      const inBps = raw.in == null ? null : Number(raw.in);
      const outBps = raw.out == null ? null : Number(raw.out);
      if (inBps == null && outBps == null) continue; // 首采样 / 无计数器差值：不计样本，也不当 0
      if (!Number.isFinite(inBps) && !Number.isFinite(outBps)) continue;
      const nameIf = String(raw.n == null ? '' : raw.n).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 96);
      if (!nameIf) continue;
      let iface = rec.ifs[nameIf];
      if (!iface) {
        if (Object.keys(rec.ifs).length >= this.maxIfs) { this.stats.droppedIfs++; continue; }
        iface = rec.ifs[nameIf] = emptyIface(nameIf, raw.speed);
      }
      if (Number(raw.speed) > 0) iface.sp = Number(raw.speed);
      let d = iface.d[dk];
      if (!d) d = iface.d[dk] = newDay();
      d[0]++;
      if (raw.oper === 'up') d[1]++;
      const inK = Number.isFinite(inBps) ? Math.max(0, Math.round(inBps / 1000)) : 0;
      const outK = Number.isFinite(outBps) ? Math.max(0, Math.round(outBps / 1000)) : 0;
      if (Number.isFinite(inBps)) { d[2] += inK; if (inK > d[3]) d[3] = inK; }
      if (Number.isFinite(outBps)) { d[4] += outK; if (outK > d[5]) d[5] = outK; }
      let h = iface.h[dk];
      if (!h) h = iface.h[dk] = [new Array(HIST_BUCKETS).fill(0), new Array(HIST_BUCKETS).fill(0)];
      if (Number.isFinite(inBps)) h[0][bucketOf(inK)]++;
      if (Number.isFinite(outBps)) h[1][bucketOf(outK)]++;
      changed = true;
    }
    if (!changed) return { ok: false, error: '本轮无有效速率样本' };
    rec.updatedAt = now;
    this._prune(rec, now);
    this.dirty.add(key);
    return { ok: true };
  }

  /** 清理：把超过 histDays 的直方图折算成日 P95 后丢弃；超过 keepDays 的日期整条删除。 */
  _prune(rec, now) {
    const histCut = dayStart(dayKey(now - this.histDays * MAX_DAY_MS));
    const keepCut = dayStart(dayKey(now - this.keepDays * MAX_DAY_MS));
    for (const iface of Object.values(rec.ifs)) {
      for (const dk of Object.keys(iface.h)) {
        const t = dayStart(dk);
        if (!Number.isFinite(t)) { delete iface.h[dk]; continue; }
        if (t < histCut) {
          const d = iface.d[dk];
          if (d) {
            const pi = histP95(iface.h[dk][0]);
            const po = histP95(iface.h[dk][1]);
            if (pi && d[6] == null) d[6] = pi.kbps;
            if (po && d[7] == null) d[7] = po.kbps;
          }
          delete iface.h[dk]; // 原始直方图删除，只留日 P95
        }
      }
      for (const dk of Object.keys(iface.d)) {
        const t = dayStart(dk);
        if (!Number.isFinite(t) || t < keepCut) { delete iface.d[dk]; this.stats.droppedDays++; }
      }
    }
  }

  /** 落盘（仅写 dirty 的 key；原子写 tmp+rename）。返回 {ok, written, bytes, errors} */
  flush() {
    if (!this.dirty.size) return { ok: true, written: 0, bytes: 0, errors: 0 };
    this._ensureDir();
    let written = 0, bytes = 0, errors = 0;
    for (const key of [...this.dirty]) {
      const rec = this.map.get(key);
      if (!rec) { this.dirty.delete(key); continue; }
      // 单文件上限：从最旧日期开始丢，直到序列化后小于上限（正常数据远不会触发）
      let text = '';
      for (let attempt = 0; attempt < 6; attempt++) {
        text = JSON.stringify({ v: FILE_VERSION, key: rec.key, name: rec.name, host: rec.host, updatedAt: rec.updatedAt, ifs: rec.ifs });
        if (Buffer.byteLength(text, 'utf8') <= MAX_FILE_BYTES) break;
        if (!this._dropOldest(rec)) break;
        this.stats.truncatedFiles++;
      }
      const file = fileOfKey(this.baseDir, key);
      const tmp = file + '.tmp-' + process.pid;
      try {
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, file);
        written++;
        bytes += Buffer.byteLength(text, 'utf8');
        this.dirty.delete(key);
      } catch (e) {
        errors++;
        try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      }
    }
    return { ok: errors === 0, written, bytes, errors };
  }

  _dropOldest(rec) {
    let oldest = null;
    for (const iface of Object.values(rec.ifs)) {
      for (const dk of Object.keys(iface.d)) {
        const t = dayStart(dk);
        if (Number.isFinite(t) && (!oldest || t < oldest.t)) oldest = { t, dk };
      }
    }
    if (!oldest) return false;
    for (const iface of Object.values(rec.ifs)) { delete iface.d[oldest.dk]; delete iface.h[oldest.dk]; }
    return true;
  }

  /** 列出已落盘的 key 文件（不加载全部内容）。 */
  listKeys() {
    let names = [];
    try { names = fs.readdirSync(this.baseDir); } catch (e) { names = []; }
    const out = [];
    for (const n of names) {
      if (!/^k_[0-9a-f]{16}\.json$/.test(n)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.baseDir, n), 'utf8'));
        if (raw && raw.v === FILE_VERSION && typeof raw.key === 'string') out.push({ key: raw.key, name: raw.name || '', host: raw.host || '' });
      } catch (e) { this.stats.badFiles++; }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  _loadAll() {
    for (const k of this.listKeys()) this._load(k.key);
    return this.map;
  }

  /** 容量报表：窗口内逐接口汇总。from/to 为毫秒；缺省近 30 天。
   *  返回 {ok, rows, range, summary, stats}；rows 按峰值（收+发取大）降序。 */
  report(opts) {
    const o = opts || {};
    const now = Number(o.now) || Date.now();
    const to = Number(o.to) || now;
    const from = Number(o.from) || (to - 30 * MAX_DAY_MS);
    const fromDay = dayStart(dayKey(from));
    const toDay = dayStart(dayKey(to));
    const keys = this._loadAll();
    const rows = [];
    for (const rec of keys.values()) {
      if (o.key && rec.key !== o.key) continue;
      for (const [name, iface] of Object.entries(rec.ifs)) {
        let s = 0, up = 0, iS = 0, iM = 0, oS = 0, oM = 0;
        let hi = new Array(HIST_BUCKETS).fill(0), ho = new Array(HIST_BUCKETS).fill(0), histS = 0;
        let days = 0;
        // 直方图只保留 histDays 天：更早的日期只有日 P95，按样本数加权估算窗口 P95（并标 approx）
        let p95InW = 0, p95InN = 0, p95OutW = 0, p95OutN = 0;
        for (const [dk, d] of Object.entries(iface.d)) {
          const t = dayStart(dk);
          if (!Number.isFinite(t) || t < fromDay || t > toDay) continue;
          days++;
          s += d[0]; up += d[1];
          iS += d[2]; iM = Math.max(iM, d[3]);
          oS += d[4]; oM = Math.max(oM, d[5]);
          const h = iface.h[dk];
          if (h) {
            let hs = 0;
            for (let i = 0; i < HIST_BUCKETS; i++) { hi[i] += h[0][i]; ho[i] += h[1][i]; hs += h[0][i] + h[1][i]; }
            histS += Math.round(hs / 2);
          }
          // 每日 P95（有直方图用直方图，过期日期用折算值）按样本数加权：窗口跨过直方图保留期时用它兜底
          const dayPi = h ? histP95(h[0]) : (d[6] != null ? { kbps: d[6] } : null);
          const dayPo = h ? histP95(h[1]) : (d[7] != null ? { kbps: d[7] } : null);
          if (dayPi) { p95InW += dayPi.kbps * d[0]; p95InN += d[0]; }
          if (dayPo) { p95OutW += dayPo.kbps * d[0]; p95OutN += d[0]; }
        }
        if (!s) continue;
        const coveragePct = Math.max(0, Math.min(100, Math.round(histS / s * 1000) / 10));
        let pi = histP95(hi), po = histP95(ho);
        // 只有全部样本都落在直方图保留期内才用合并直方图；否则用按日 P95 加权估算，并如实标 approx
        if (coveragePct < 99.5) {
          if (p95InN) pi = { kbps: Math.round(p95InW / p95InN), low: null, high: null, approx: true };
          if (p95OutN) po = { kbps: Math.round(p95OutW / p95OutN), low: null, high: null, approx: true };
        } else {
          if (!pi && p95InN) pi = { kbps: Math.round(p95InW / p95InN), low: null, high: null, approx: true };
          if (!po && p95OutN) po = { kbps: Math.round(p95OutW / p95OutN), low: null, high: null, approx: true };
        }
        const peak = Math.max(iM, oM);
        rows.push({
          key: rec.key, name: rec.name || rec.key, host: rec.host || '',
          ifName: name, speedBps: iface.sp || 0,
          days, samples: s, upSamples: up,
          availPct: s ? Math.round(up / s * 1000) / 10 : null,
          inAvgKbps: Math.round(iS / s), outAvgKbps: Math.round(oS / s),
          inMaxKbps: iM, outMaxKbps: oM,
          inP95Kbps: pi ? pi.kbps : null, inP95LowKbps: pi ? pi.low : null, inP95HighKbps: pi ? pi.high : null, inP95Approx: !!(pi && pi.approx),
          outP95Kbps: po ? po.kbps : null, outP95LowKbps: po ? po.low : null, outP95HighKbps: po ? po.high : null, outP95Approx: !!(po && po.approx),
          p95Coverage: coveragePct,
          peakKbps: peak,
          // 峰值利用率（%）：峰值 kbps × 1000 / 速率 bps × 100
          utilizationPct: (iface.sp > 0 && peak > 0) ? Math.round(peak * 100000 / iface.sp * 100) / 100 : null
        });
      }
    }
    rows.sort((a, b) => (b.peakKbps - a.peakKbps) || (a.name < b.name ? -1 : 1) || (a.ifName < b.ifName ? -1 : 1));
    return {
      ok: true,
      range: { from, to, fromDay: dayKey(fromDay), toDay: dayKey(toDay) },
      rows,
      summary: { devices: new Set(rows.map(r => r.key)).size, ifaces: rows.length, histDays: this.histDays, keepDays: this.keepDays },
      stats: Object.assign({}, this.stats)
    };
  }

  /** 单接口日趋势（容量趋势图）：返回窗口内每天的平均/峰值/日 P95。 */
  trend(key, ifName, opts) {
    const rec = this._load(String(key || ''));
    const iface = rec.ifs[String(ifName || '')];
    if (!iface) return { ok: false, error: '接口不存在' };
    const o = opts || {};
    const now = Number(o.now) || Date.now();
    const to = Number(o.to) || now;
    const from = Number(o.from) || (to - 90 * MAX_DAY_MS);
    const fromDay = dayStart(dayKey(from));
    const toDay = dayStart(dayKey(to));
    const out = [];
    for (const [dk, d] of Object.entries(iface.d)) {
      const t = dayStart(dk);
      if (!Number.isFinite(t) || t < fromDay || t > toDay) continue;
      const h = iface.h[dk];
      const pi = h ? histP95(h[0]) : null;
      const po = h ? histP95(h[1]) : null;
      out.push({
        date: dk, samples: d[0], upSamples: d[1],
        inAvgKbps: d[0] ? Math.round(d[2] / d[0]) : 0, outAvgKbps: d[0] ? Math.round(d[4] / d[0]) : 0,
        inMaxKbps: d[3], outMaxKbps: d[5],
        inP95Kbps: pi ? pi.kbps : (d[6] == null ? null : d[6]),
        inP95LowKbps: pi ? pi.low : null, inP95HighKbps: pi ? pi.high : null,
        outP95Kbps: po ? po.kbps : (d[7] == null ? null : d[7]),
        outP95LowKbps: po ? po.low : null, outP95HighKbps: po ? po.high : null
      });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { ok: true, key: rec.key, ifName: iface.n, speedBps: iface.sp, days: out };
  }

  /** 监控面板/诊断用状态 */
  status() {
    let bytes = 0, files = 0;
    try {
      const names = fs.readdirSync(this.baseDir);
      for (const n of names) {
        if (!/^k_[0-9a-f]{16}\.json$/.test(n)) continue;
        files++;
        try { bytes += fs.statSync(path.join(this.baseDir, n)).size; } catch (e) { /* ignore */ }
      }
    } catch (e) { /* 目录不存在按空库 */ }
    return { ok: true, files, bytes, dirty: this.dirty.size, stats: Object.assign({}, this.stats), histDays: this.histDays, keepDays: this.keepDays };
  }

  /** 删除一台设备的容量历史（界面「清除容量数据」用；文件不存在也算成功）。 */
  remove(key) {
    const k = String(key || '');
    this.map.delete(k);
    this.dirty.delete(k);
    try { fs.unlinkSync(fileOfKey(this.baseDir, k)); } catch (e) { /* ignore */ }
    return { ok: true };
  }
}

module.exports = {
  CapacityStore, dayKey, dayStart, bucketOf, histP95,
  HIST_EDGES_KBPS, HIST_BUCKETS, KEEP_DAYS, HIST_DAYS, MAX_IFS_PER_KEY, MAX_FILE_BYTES
};
