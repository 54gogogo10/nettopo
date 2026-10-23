/* NetTopo 设备级告警通知聚合 —— 纯 Node（主进程使用，可单测；不依赖 Electron）
 *
 * 要解决的问题：同一台设备故障时会触发多条互相独立的通知——48 口交换机闪断 = 48 条
 * 「接口离线」，外加指标 / 错包 / 备份失败各一条，系统通知与提示音被刷屏。
 * 告警依赖抑制只归并「下游离线」，这里的设备级聚合是第二道闸：
 *
 * 语义（只作用于系统通知出口 notifyForDevice；事件时间线各调用点照常全量记录，证据不丢）：
 * - 同一设备在窗口期（默认 60 秒）内的**告警级**（warning 及以上）通知：
 *   第一条立即发出，后续条目缓存，窗口到期由调用方 flushOne 取走并合并为一条摘要
 *   （「N 条告警：接口离线×3、指标告警×1」），提示音 / Webhook 随摘要按最高等级发一次；
 * - 恢复与提示级（info）不进聚合，由调用方直接放行——恢复必须及时可见；
 * - 单设备缓存条数封顶（默认 50）：超出只计数不占内存，摘要如实标注「另有 N 条」。
 *
 * 本模块只管「攒与取」，不持定时器、不发通知——窗口定时与发送由宿主（electron-main）接线，
 * 保证纯逻辑可在 Node 测试中直接驱动。
 */
'use strict';

const DEFAULT_WINDOW_MS = 60000;  // 聚合窗口：从该设备第一条被缓存的告警起算
const DEFAULT_MAX_PER_DEVICE = 50; // 单设备缓存条数上限（超出只计数）

/** kind 从通知标题提取（「网络拓扑管理软件 · 接口离线」→「接口离线」），用于摘要分类计数 */
function kindOf(title) {
  const s = String(title == null ? '' : title);
  const i = s.lastIndexOf('·');
  return (i >= 0 ? s.slice(i + 1) : s).trim() || '告警';
}

class NotifyAggregator {
  /** @param {object} [opts] { windowMs=60000, maxPerDevice=50 } */
  constructor(opts) {
    opts = opts || {};
    this.windowMs = opts.windowMs > 0 ? opts.windowMs : DEFAULT_WINDOW_MS;
    this.maxPerDevice = opts.maxPerDevice > 0 ? opts.maxPerDevice : DEFAULT_MAX_PER_DEVICE;
    this.map = new Map(); // deviceId -> { items:[{title,body,level}], dropped, startedAt }
  }

  /** 告警入账。返回 'now'（窗口内第一条，立即发）或 'hold'（已缓存，等窗口到期 flushOne） */
  push(deviceId, title, body, level, now) {
    const key = String(deviceId == null ? '' : deviceId).slice(0, 128);
    if (!key) return 'now'; // 无设备归属的通知名不聚合（如全局升级通知）
    const t = Number.isFinite(now) ? now : Date.now();
    const cur = this.map.get(key);
    if (!cur || t - cur.startedAt >= this.windowMs) {
      // 新窗口：本条作为首条立即发出，同时开窗等待后续
      this.map.set(key, { items: [], dropped: 0, startedAt: t, first: { title: String(title), body: String(body), level: level } });
      return 'now';
    }
    if (cur.items.length >= this.maxPerDevice) {
      cur.dropped++;
      return 'hold';
    }
    cur.items.push({ title: String(title), body: String(body), level: level });
    return 'hold';
  }

  /** 取走该设备窗口内的缓存（窗口未到期也可调用：定时器到期即取）。
   *  无缓存返回 null；有缓存返回 { count, dropped, byKind, level, firstBody }，level 为缓存中最高等级。 */
  flushOne(deviceId) {
    const key = String(deviceId == null ? '' : deviceId);
    const cur = this.map.get(key);
    this.map.delete(key);
    if (!cur || !cur.items.length) return null;
    const byKind = {};
    let level = null;
    for (const it of cur.items) {
      const k = kindOf(it.title);
      byKind[k] = (byKind[k] || 0) + 1;
      level = AlertLevelPick(level, it.level);
    }
    return {
      count: cur.items.length,
      dropped: cur.dropped,
      byKind: byKind,
      level: level || cur.first.level,
      firstBody: String(cur.first && cur.first.body || '')
    };
  }

  /** 调试/统计：当前缓存中的设备数与条目数 */
  stats() {
    let items = 0, dropped = 0;
    for (const v of this.map.values()) { items += v.items.length; dropped += v.dropped; }
    return { devices: this.map.size, items: items, dropped: dropped };
  }
}

/** 两等级取高（等级次序由 js/alert-level.js 定义；此处内联 rank 表避免循环依赖，
 *  alert-level 双形态导出，主进程 require 它同样可用——但本模块保持零依赖更利于单测） */
const RANK = { info: 0, warning: 1, critical: 2, emergency: 3 };
function AlertLevelPick(a, b) {
  const ra = RANK[a] != null ? RANK[a] : -1;
  const rb = RANK[b] != null ? RANK[b] : -1;
  if (ra < 0) return b;
  if (rb < 0) return a;
  return ra >= rb ? a : b;
}

// 双形态导出：Node 走 CommonJS，渲染层直接以 <script> 加载时挂 globalThis（裸 module 引用在浏览器抛 ReferenceError）
if (typeof module !== 'undefined' && module.exports) module.exports = { NotifyAggregator, kindOf, DEFAULT_WINDOW_MS, DEFAULT_MAX_PER_DEVICE };
if (typeof globalThis !== 'undefined') globalThis.TopoNotifyMerge = { NotifyAggregator, kindOf, DEFAULT_WINDOW_MS, DEFAULT_MAX_PER_DEVICE };
