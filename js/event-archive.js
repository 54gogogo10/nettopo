/* NetTopo 监控事件时间线归档 —— 纯 Node（主进程使用，可单测；不依赖 Electron）
 *
 * 要解决的问题：事件时间线只存内存、主进程重启即丢——同链路的在线率（SLA）、容量趋势、
 * 取证库都落盘，重启后 SLA 报表有数据而事件时间线空白；值班交接的未确认留痕也保不住。
 *
 * 语义：
 * - 归档与内存时间线同容量（默认 500 条），写入方负责截断，加载时再兜底裁剪；
 * - 单字段限长：事件 detail 平时只有一行，异常大 payload 落盘前截断，防归档被撑爆；
 *   未知字段不进归档（归档结构只认入账时写下的已知键，外部手改塞不进私货）；
 * - 坏文件如实回落空表（只读、不覆盖原文件），时间线从零开始而不是启动失败；
 * - 落盘走 tmp+rename 原子写（与 monitor-uptime / capacity 同惯例），防断电损坏；
 * - 防抖保存：告警风暴时每分钟可入账几十条事件，不能每条同步写盘；退出由 saveNow 兜底。
 */
'use strict';

const fs = require('fs');

const MAX_EVENTS = 500;  // 与主进程内存时间线同容量
const MAX_FIELD = 2000;  // detail 限长（事件携带的匹配行/摘要远短于此，防异常 payload）
const RETRY_MS = 5000;   // 落盘失败重试间隔（磁盘满/文件被占用多为短暂状态，稍候再试）
const MAX_RETRY = 5;     // 连续重试上限：防止无限重试；放弃后 _dirty 保留，下一条事件 touch 再触发

/** 字符串化并限长 */
function clampStr(v, n) {
  const s = String(v == null ? '' : v);
  return s.length > n ? s.slice(0, n) : s;
}

/** 单条事件清洗：保留已知字段、丢弃未知键；ts 非法返回 null（加载兜底与落盘前共用） */
function normalizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const ts = Number(ev.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const out = {
    ts: ts,
    type: clampStr(ev.type, 64) || 'event',
    level: clampStr(ev.level, 16) || 'info',
    key: clampStr(ev.key, 128),
    deviceId: clampStr(ev.deviceId, 128),
    host: clampStr(ev.host, 128),
    name: clampStr(ev.name, 128),
    detail: clampStr(ev.detail, MAX_FIELD)
  };
  // 确认留痕（ackAt/ackNote）与升级标记（escalatedAt）：只在已设置时携带
  if (Number.isFinite(ev.ackAt) && ev.ackAt > 0) {
    out.ackAt = ev.ackAt;
    out.ackNote = clampStr(ev.ackNote, 200);
  }
  if (Number.isFinite(ev.escalatedAt) && ev.escalatedAt > 0) out.escalatedAt = ev.escalatedAt;
  return out;
}

/** 从归档文件加载事件时间线（坏文件/不存在返回空表并如实带错误信息，不覆盖原文件） */
function loadEvents(file) {
  if (!file) return { events: [], error: null };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { events: [], error: String((e && e.message) || e) };
  }
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray(raw.events) ? raw.events : []);
  const events = list.map(normalizeEvent).filter(Boolean).sort((a, b) => a.ts - b.ts);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return { events, error: null };
}

/** 事件时间线归档器：bind 绑定内存数组（写入方照常 push/splice），touch 标脏防抖落盘 */
class EventArchive {
  /** @param {string} file 归档 JSON 路径（空串则不落盘）
   *  @param {object} [opts] { maxEvents=500, debounceMs=3000 } */
  constructor(file, opts) {
    opts = opts || {};
    this.file = typeof file === 'string' ? file : '';
    this.maxEvents = opts.maxEvents > 0 ? opts.maxEvents : MAX_EVENTS;
    this.debounceMs = opts.debounceMs > 0 ? opts.debounceMs : 3000;
    this.events = [];
    this._dirty = false;
    this._timer = null;
    this._retryFails = 0;
  }

  /** 绑定内存时间线（主进程的 monitorEvents 数组本体；入账/确认直接改它即可） */
  bind(list) {
    this.events = Array.isArray(list) ? list : [];
  }

  /** 事件有增改（入账/确认/撤销确认/升级标记）后调用：标脏并防抖落盘 */
  touch() {
    this._dirty = true;
    if (!this.file || this._timer != null) return;
    this._retryFails = 0; // 新的保存周期：重试计数从头计（上一周期达上限放弃后由本事件重新触发）
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, this.debounceMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** 立即落盘（退出兜底；无变更不写）。tmp+rename 原子写，序列化前逐条清洗限长。
   *  失败时安排有限次重试（防抖定时器已触发，不重试这批事件就永远悬在内存里）。 */
  saveNow() {
    if (!this.file || !this._dirty) return false;
    const list = this.events.map(normalizeEvent).filter(Boolean).slice(-this.maxEvents);
    const tmp = this.file + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, events: list }), 'utf8');
      fs.renameSync(tmp, this.file);
      this._dirty = false;
      this._retryFails = 0;
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      this._scheduleRetry();
      return false;
    }
  }

  /** 落盘失败重试：RETRY_MS 后再试一次，连续 MAX_RETRY 次失败后放弃（_dirty 仍为 true，
   *  下一条事件 touch 会重新走防抖触发，而不是这批事件永远不落盘） */
  _scheduleRetry() {
    if (!this.file || this._timer != null || this._retryFails >= MAX_RETRY) return;
    this._retryFails++;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, RETRY_MS);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** 停掉防抖定时器（不写盘；进程退出前由调用方 saveNow 兜底） */
  dispose() {
    if (this._timer != null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

// 双形态导出：Node 走 CommonJS，渲染层直接以 <script> 加载时挂 globalThis（裸 module 引用在浏览器抛 ReferenceError）
if (typeof module !== 'undefined' && module.exports) module.exports = { EventArchive, loadEvents, normalizeEvent, MAX_EVENTS, MAX_FIELD };
if (typeof globalThis !== 'undefined') globalThis.TopoEventArchive = { EventArchive, loadEvents, normalizeEvent, MAX_EVENTS, MAX_FIELD };
