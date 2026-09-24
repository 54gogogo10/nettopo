/* NetTopo 事件时间线确认 —— 纯逻辑（主进程使用，可单测；不依赖 Electron）
 *
 * 要解决的问题：事件时间线只增不减，几十条离线/告警堆在一起时，「哪些已经看过了」全靠脑子记。
 * 这里给每条事件加确认留痕（确认时刻 + 备注），并提供未确认计数——值班交接时一眼看出还没人看过的条目。
 *
 * 语义：
 * - 确认只落在事件对象上（ackAt / ackNote），随事件一起被时间线容量上限滚动淘汰，不额外占空间；
 * - 事件按时间戳定位（ts 唯一性由写入方保证：同一毫秒的重复事件会被合并为一条）；
 * - 备注做长度与控制字符清洗（它会被渲染到界面与导出件里）；
 * - 重复确认不覆盖首次确认时刻（保留「谁先看过」这一事实），只更新备注。
 */
'use strict';

const MAX_NOTE = 200;

/** 备注清洗：去控制字符、限长 */
function normalizeNote(note) {
  return String(note == null ? '' : note).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NOTE);
}

/** 未确认事件数 */
function unackedCount(events) {
  return (Array.isArray(events) ? events : []).filter(e => e && !e.ackAt).length;
}

/** 确认一条事件（原地修改并返回结果）。ts 必须是已存在事件的写入时刻 */
function applyAck(events, payload, now) {
  const list = Array.isArray(events) ? events : [];
  const ts = Number(payload && payload.ts);
  if (!Number.isFinite(ts)) return { ok: false, error: '缺少事件时间戳' };
  const ev = list.find(e => e && Number(e.ts) === ts);
  if (!ev) return { ok: false, error: '事件不存在（可能已被时间线滚动淘汰）' };
  const at = Number.isFinite(now) ? now : Date.now();
  const first = !ev.ackAt;
  if (first) ev.ackAt = at;            // 首次确认才记时刻：重复确认不覆盖「谁先看过」
  const note = normalizeNote(payload && payload.note);
  if (note) ev.ackNote = note;
  else if (first) ev.ackNote = '';
  return { ok: true, first, ackAt: ev.ackAt, ackNote: ev.ackNote || '', unacked: unackedCount(list) };
}

/** 取消确认（误点确认时回退） */
function clearAck(events, payload) {
  const list = Array.isArray(events) ? events : [];
  const ts = Number(payload && payload.ts);
  if (!Number.isFinite(ts)) return { ok: false, error: '缺少事件时间戳' };
  const ev = list.find(e => e && Number(e.ts) === ts);
  if (!ev) return { ok: false, error: '事件不存在（可能已被时间线滚动淘汰）' };
  delete ev.ackAt;
  delete ev.ackNote;
  return { ok: true, unacked: unackedCount(list) };
}

module.exports = { applyAck, clearAck, unackedCount, normalizeNote, MAX_NOTE };
if (typeof globalThis !== 'undefined') globalThis.TopoEventAck = { applyAck, clearAck, unackedCount, normalizeNote, MAX_NOTE };
