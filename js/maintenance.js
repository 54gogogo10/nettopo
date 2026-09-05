/* NetTopo 告警静默 / 维护窗口 —— 主进程纯 Node 模块（不依赖 Electron）
 * 通知抑制策略：维护操作（计划内重启、变更窗口）期间不弹系统通知，
 * 但监控事件照常记入事件时间线——「不打扰」不等于「不记录」。
 * 两类抑制：
 *   - 手动静默：右键设备「告警静默 1 小时」，按 deviceId 记忆到期时间（内存态，重启即清）
 *   - 维护窗口：按 deviceId 配置每日 from~to 时间段（支持跨午夜），持久化在应用设置中
 * 可在 Node 测试中直接使用。
 */
'use strict';

/** 解析 HH:MM 时间文本 → {h, m}；非法返回 null */
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** 判定当天分钟数是否落在 [from, to) 窗口内；from === to 视为空窗口；
 *  支持跨午夜（from > to，如 22:00~06:00：now >= from 或 now < to）。 */
function inWindow(nowMin, fromStr, toStr) {
  const f = parseHHMM(fromStr), t = parseHHMM(toStr);
  if (!f || !t) return null;
  const F = f.h * 60 + f.m, T = t.h * 60 + t.m;
  if (F === T) return false;
  return F < T ? (nowMin >= F && nowMin < T) : (nowMin >= F || nowMin < T);
}

/** 每日定时的下一次触发时间戳：time 形如 '08:30'；晚于 now 当日时刻（含相等）取今天，否则取明天。
 *  time 非法返回 null。供 AI 巡检日报等每日任务调度使用（与静默窗口同属运维时间策略工具）。 */
function nextDailyRun(timeStr, now) {
  const t = parseHHMM(timeStr);
  if (!t) return null;
  const n = new Date(Number.isFinite(now) ? now : Date.now());
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate(), t.h, t.m, 0, 0);
  if (next.getTime() <= n.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

class Maintenance {
  /** @param {object} [opts] opts.load(registry)：初始化时回调，用于从应用设置恢复维护窗口配置 */
  constructor(opts) {
    opts = opts || {};
    this.mutes = new Map();   // deviceId -> 到期时间戳（手动静默；到期后惰性清除）
    this.windows = new Map(); // deviceId -> {from, to}
    if (typeof opts.load === 'function') {
      try { opts.load(this); } catch (e) { /* 恢复失败按空配置 */ }
    }
  }
  /** 手动静默：minutes 钳制 1~1440；返回到期时间戳 */
  setMute(deviceId, minutes) {
    deviceId = String(deviceId == null ? '' : deviceId).slice(0, 64);
    if (!deviceId) return null;
    const min = Math.max(1, Math.min(1440, Math.floor(Number(minutes) || 0)));
    const until = Date.now() + min * 60000;
    this.mutes.set(deviceId, until);
    return until;
  }
  clearMute(deviceId) {
    return this.mutes.delete(String(deviceId == null ? '' : deviceId).slice(0, 64));
  }
  /** 配置维护窗口：w = {enabled, from, to}；enabled=false 或参数非法即删除配置 */
  setWindow(deviceId, w) {
    deviceId = String(deviceId == null ? '' : deviceId).slice(0, 64);
    if (!deviceId) return false;
    if (!w || !w.enabled || !parseHHMM(w.from) || !parseHHMM(w.to)) { this.windows.delete(deviceId); return true; }
    this.windows.set(deviceId, { from: String(w.from).trim(), to: String(w.to).trim() });
    return true;
  }
  getWindow(deviceId) {
    return this.windows.get(String(deviceId == null ? '' : deviceId).slice(0, 64)) || null;
  }
  /** 静默判定：{muted, reason:'manual'|'window', until?}；手动静默到期后惰性清除 */
  isMuted(deviceId, now) {
    deviceId = String(deviceId == null ? '' : deviceId).slice(0, 64);
    if (!deviceId) return { muted: false };
    const until = this.mutes.get(deviceId);
    if (until != null) {
      if (Date.now() < until) return { muted: true, reason: 'manual', until };
      this.mutes.delete(deviceId); // 到期即清，防 Map 无界增长
    }
    const w = this.windows.get(deviceId);
    if (w) {
      const d = new Date(Number.isFinite(now) ? now : Date.now());
      if (inWindow(d.getHours() * 60 + d.getMinutes(), w.from, w.to)) {
        return { muted: true, reason: 'window', window: w };
      }
    }
    return { muted: false };
  }
  /** 全量快照（持久化用；手动静默不落盘——重启后清空是合理语义） */
  snapshotWindows() {
    const out = {};
    for (const [k, v] of this.windows) out[k] = v;
    return out;
  }
}

module.exports = { Maintenance, inWindow, parseHHMM, nextDailyRun };
