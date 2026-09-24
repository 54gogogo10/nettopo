/* NetTopo 可用性（SLA）报表 —— 纯逻辑（主进程与渲染层共用，不依赖 Electron）
 *
 * 数据来源是监控在线探测的采样（js/monitor.js 的 UptimeStore）：
 * - 10 分钟明细桶（默认保留 7 天）：能切分「一次中断」的起止，因此中断次数 / 累计中断时长 / MTTR /
 *   最长单次中断这些指标只有它算得出来；
 * - 按天汇总（默认保留 400 天）：体积可忽略，用于月度/季度可用率这类长期口径。
 * 区间超出明细覆盖范围时，本模块**如实降级**：可用率走按天汇总，中断明细标注「明细未覆盖」而不是
 * 拿部分数据冒充全区间——验收材料里最忌讳的就是这种「看起来精确」的假数字。
 *
 * 口径说明（会写进报表脚注，避免被当成精确到秒的计量）：
 * - 可用率 = 在线采样桶 / 有效采样桶（按 10 分钟桶计数，非秒级探针统计）；
 * - 中断时长 = 连续离线桶数 × 桶宽，最后一次中断按「至今」截断（不把未来算成中断）；
 * - 同一桶内先失败后恢复只记该桶最后一次结果（桶内闪断不可见）——这是探针采样粒度的固有限制。
 */
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => {
  const d = new Date(ts);
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
};
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** 常用区间：last7 / last30 / thisMonth / lastMonth / custom(from,to) */
function rangeOf(kind, now, from, to) {
  const t = Number.isFinite(now) ? now : Date.now();
  const k = String(kind || 'last7');
  const d = new Date(t);
  if (k === 'thisMonth') {
    const s = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return { from: s, to: t + 1, label: d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月（至今）' };
  }
  if (k === 'lastMonth') {
    const s = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    const e = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return { from: s, to: e, label: new Date(s).getFullYear() + ' 年 ' + (new Date(s).getMonth() + 1) + ' 月' };
  }
  if (k === 'custom') {
    const f = Number(from), tt = Number(to);
    if (Number.isFinite(f) && Number.isFinite(tt) && tt > f) return { from: f, to: tt, label: '自定义区间' };
  }
  if (k === 'last30') return { from: startOfDay(t - 29 * DAY_MS), to: t + 1, label: '近 30 天' };
  return { from: startOfDay(t - 6 * DAY_MS), to: t + 1, label: '近 7 天' };
}

/** 从明细桶切分中断：返回 {outages, downtimeMs, longestMs, firstDownAt, lastDownAt} */
function outagesOf(buckets, bucketMs, now) {
  let outages = 0, downtimeMs = 0, longestMs = 0, run = 0, runStart = 0;
  const closeRun = (endTs) => {
    if (!run) return;
    outages++;
    // 最后一次中断按「至今」截断；已恢复的中断按桶数×桶宽计
    const span = Math.max(0, Math.min(run * bucketMs, endTs - runStart));
    downtimeMs += span;
    if (span > longestMs) longestMs = span;
    run = 0;
  };
  for (const b of buckets) {
    if (!Array.isArray(b) || !Number.isFinite(b[0])) continue;
    if (b[1] === 0) {
      if (!run) runStart = b[0];
      run++;
    } else closeRun(b[0]);
  }
  if (run) closeRun(Number.isFinite(now) ? now : Date.now());
  return { outages, downtimeMs, longestMs };
}

/**
 * 生成报表行。
 * @param {object} p
 *  p.targets   [{key, name, host}]（要统计的设备/管理口）
 *  p.series    key -> [[bucketTs, 0|1], …]（10 分钟明细）
 *  p.daily     key -> {'YYYYMMDD': {up, down}}（按天汇总）
 *  p.from/p.to 统计区间（to 不含）
 *  p.bucketMs  桶宽（默认 10 分钟）
 *  p.now       当前时刻（测试可注入）
 *  p.minUptime SLA 目标线（默认 99.9），低于它标红
 * @returns {{ok:true, rows:[…], summary:{…}, range:{from,to,label}, coverage:{detailFrom,detailTo}}}
 */
function buildReport(p) {
  const o = p || {};
  const bucketMs = Number.isFinite(o.bucketMs) && o.bucketMs > 0 ? o.bucketMs : 10 * 60 * 1000;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const from = Number.isFinite(o.from) ? o.from : startOfDay(now - 6 * DAY_MS);
  const to = Number.isFinite(o.to) && o.to > from ? o.to : now + 1;
  const targets = Array.isArray(o.targets) ? o.targets : [];
  const series = (o.series && typeof o.series === 'object') ? o.series : {};
  const daily = (o.daily && typeof o.daily === 'object') ? o.daily : {};
  const minUptime = Number.isFinite(o.minUptime) ? o.minUptime : 99.9;

  // 明细覆盖范围（所有键里最早/最晚的合法桶）：用于判定某键在该区间是否有明细可用
  const coverage = { detailFrom: 0, detailTo: 0 };
  const validBucket = (b) => Array.isArray(b) && Number.isFinite(b[0]);
  for (const arr of Object.values(series)) {
    if (!Array.isArray(arr) || !arr.length) continue;
    // 脏数据兜底：损坏/旧版文件里可能有 null 或非数值项，逐项筛出首个与末个合法桶（不能直接取 arr[0]）
    let first = null, last = null;
    for (const b of arr) { if (!validBucket(b)) continue; if (!first) first = b[0]; last = b[0]; }
    if (first == null) continue;
    if (!coverage.detailFrom || first < coverage.detailFrom) coverage.detailFrom = first;
    if (last + bucketMs > coverage.detailTo) coverage.detailTo = last + bucketMs;
  }

  const rows = [];
  for (const t of targets) {
    const key = String((t && t.key) || '');
    if (!key) continue;
    const bucketsAll = Array.isArray(series[key]) ? series[key] : [];
    const buckets = bucketsAll.filter(b => Array.isArray(b) && Number.isFinite(b[0]) && b[0] >= from && b[0] < to);
    const days = (daily[key] && typeof daily[key] === 'object') ? daily[key] : {};
    // 按天汇总：落在区间内的整天（首尾不足一天的按比例无法从日汇总得知，故只在整段区间都无明细时使用）
    let dayUp = 0, dayDown = 0;
    const fromDay = dayKey(from), toDay = dayKey(to - 1);
    for (const [dk, v] of Object.entries(days)) {
      if (!v || dk < fromDay || dk > toDay) continue;
      dayUp += Math.max(0, parseInt(v.up, 10) || 0);
      dayDown += Math.max(0, parseInt(v.down, 10) || 0);
    }
    const detailCovers = buckets.length > 0
      && buckets[0][0] <= from + 2 * bucketMs
      && buckets[buckets.length - 1][0] + bucketMs >= to - 2 * bucketMs;
    const hasDaily = (dayUp + dayDown) > 0;

    // 两个决策分开：① 可用率取「覆盖更全」的来源；② 中断明细只要有一桶就算得出，但如实标注是否覆盖全区间。
    // （曾经的写法是「明细不覆盖全区间就整行退化成按天汇总」，结果把已经采到的中断明细也一并丢掉了。）
    let up = 0, down = 0, outages = null, downtimeMs = null, longestMs = null;
    let source = 'none', outagePartial = false;
    const detailCount = () => { let u = 0, d = 0; for (const b of buckets) { if (b[1] === 0) d++; else u++; } return { u, d }; };
    const detailOutages = () => outagesOf(buckets, bucketMs, Math.min(now, to));
    if (detailCovers) {
      const c = detailCount(); up = c.u; down = c.d; source = 'detail';
      const od = detailOutages();
      outages = od.outages; downtimeMs = od.outages ? od.downtimeMs : 0;
      longestMs = od.outages ? od.longestMs : null;
    } else if (hasDaily) {
      up = dayUp; down = dayDown; source = 'daily';   // 可用率来自覆盖整段区间的按天汇总
      if (buckets.length) {                           // 中断明细来自手上的明细桶，并标注只覆盖了一部分
        const od = detailOutages();
        outages = od.outages; downtimeMs = od.outages ? od.downtimeMs : 0;
        longestMs = od.outages ? od.longestMs : null;
        outagePartial = true;
      }
    } else if (buckets.length) {
      const c = detailCount(); up = c.u; down = c.d; source = 'detail-partial';
      const od = detailOutages();
      outages = od.outages; downtimeMs = od.outages ? od.downtimeMs : 0;
      longestMs = od.outages ? od.longestMs : null;
      outagePartial = true;
    }
    const total = up + down;
    const uptimePct = total ? (up / total) * 100 : null;
    rows.push({
      key,
      name: String((t && t.name) || key.split('@')[0] || key),
      host: String((t && t.host) || (key.indexOf('@') >= 0 ? key.slice(key.indexOf('@') + 1) : '')),
      up, down, total,
      uptimePct,
      outages, downtimeMs, longestMs,
      mttrMs: (outages && downtimeMs != null) ? Math.round(downtimeMs / outages) : null,
      source,
      partial: source !== 'detail',       // 可用率口径是否为整段区间的完整明细
      outagePartial,                      // 中断明细是否只覆盖了区间的一部分（明细保留期 < 区间长度）
      meetsSla: uptimePct == null ? null : uptimePct >= minUptime,
      // 区间内该键的采样覆盖率（区间长度 vs 采样桶数×桶宽）：过低说明设备刚纳入监控或长期未采到
      coveragePct: (() => {
        const span = to - from;
        if (!(span > 0) || !total) return 0;
        return Math.min(100, (total * bucketMs / span) * 100);
      })()
    });
  }

  const sUp = rows.reduce((s, r) => s + r.up, 0);
  const sDown = rows.reduce((s, r) => s + r.down, 0);
  const sTotal = sUp + sDown;
  const summary = {
    devices: rows.length,
    sampled: rows.filter(r => r.total > 0).length,
    up: sUp, down: sDown, total: sTotal,
    uptimePct: sTotal ? (sUp / sTotal) * 100 : null,
    outages: rows.reduce((s, r) => s + (r.outages || 0), 0),
    downtimeMs: rows.reduce((s, r) => s + (r.downtimeMs || 0), 0),
    below: rows.filter(r => r.meetsSla === false).length,
    minUptime,
    detailLimited: rows.some(r => r.source === 'daily'),
    outageLimited: rows.some(r => r.outagePartial === true)
  };
  return { ok: true, rows, summary, range: { from, to }, coverage, bucketMs };
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v >= 99.995 ? '100' : v.toFixed(v >= 99 ? 2 : 1)) + '%';
}
/** 时长文案：秒 / 分 / 时 分 / 天 时 分 */
function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return m + ' 分' + (rs ? ' ' + rs + ' 秒' : '');
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return h + ' 时' + (rm ? ' ' + rm + ' 分' : '');
  const d = Math.floor(h / 24), rh = h % 24;
  return d + ' 天' + (rh ? ' ' + rh + ' 时' : '');
}
const fmtTime = (ts) => {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};

module.exports = { buildReport, rangeOf, outagesOf, fmtPct, fmtDur, fmtTime, DAY_MS, dayKey, startOfDay };
