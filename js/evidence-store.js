/* NetTopo 故障取证库 —— 主进程纯 Node 模块（不依赖 Electron）
 *
 * 解决什么问题：告警只说明「断了 / 命中关键字 / 指标超阈值」，原因还得人工登录设备敲命令；等值班的人
 * 看到通知、打开软件、找到设备、连上去，现场往往已经变了。事件时间线也只有结论，没有证据。
 *
 * 本模块把「告警时刻设备上到底什么样」存成可回看的证据包：
 * - 每条证据绑定事件时间戳（eventTs），与事件时间线一一对应；
 * - 命令输出原文保存（最多 12 条、单条 64KB、整包 512KB，超出截断并标注），不静默丢；
 * - 每台设备一个文件，原子写；最多保留 1000 份 / 128MB，按事件时间滚动淘汰；
 * - 只存主进程拿到的纯数据，不执行任何命令——采集由渲染层按只读白名单完成（见 app.js autoEvidence）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_VERSION = 1;
const MAX_FILES = 1000;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_COMMANDS = 12;
const MAX_CMD_TEXT = 64 * 1024;
const MAX_TOTAL_TEXT = 512 * 1024;
const MAX_DETAIL = 500;
const ID_RE = /^ev_(\d{13})_([0-9a-f]{8})(?:_(\d))?$/;

function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .slice(0, max == null ? 2000 : max);
}
function cleanLine(v, max) { return cleanText(v, max).replace(/[\r\n]+/g, ' ').trim(); }

function summarize(rec) {
  return {
    id: rec.id, createdAt: rec.createdAt, eventTs: rec.eventTs, eventType: rec.eventType,
    eventDetail: rec.eventDetail, deviceId: rec.deviceId, name: rec.name, host: rec.host,
    vendor: rec.vendor, ok: !!rec.ok, error: rec.error || '', ms: rec.ms || 0,
    commands: (rec.commands || []).map(c => ({ cmd: c.cmd, text: c.text, error: c.error || '', truncated: !!c.truncated })),
    truncated: !!rec.truncated
  };
}

class EvidenceStore {
  constructor(baseDir, opts) {
    this.baseDir = String(baseDir || '');
    this.maxFiles = Math.max(10, Number(opts && opts.maxFiles) || MAX_FILES);
    this.maxBytes = Math.max(1024, Number(opts && opts.maxBytes) || MAX_TOTAL_BYTES);
    this.stats = { saved: 0, pruned: 0, badFiles: 0 };
  }

  _ensureDir() { try { fs.mkdirSync(this.baseDir, { recursive: true }); } catch (e) { /* ignore */ } }
  _file(id) { return path.join(this.baseDir, id + '.json'); }

  /** 保存一次取证。payload 由渲染层给出：{eventTs,eventType,eventDetail,deviceId,name,host,vendor,ok,error,ms,commands}。
   *  返回 {ok,id,truncated}；非法输入返回 {ok:false,error}。 */
  save(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const eventTs = Number(p.eventTs);
    if (!Number.isFinite(eventTs) || eventTs <= 0) return { ok: false, error: '缺少事件时间戳' };
    const deviceId = cleanLine(p.deviceId, 120);
    if (!deviceId) return { ok: false, error: '缺少设备标识' };
    let truncated = false;
    let total = 0;
    const cmds = [];
    for (const raw of Array.isArray(p.commands) ? p.commands : []) {
      if (cmds.length >= MAX_COMMANDS) { truncated = true; break; }
      if (!raw || typeof raw !== 'object') continue;
      let text = cleanText(raw.text, MAX_CMD_TEXT);
      if (String(raw.text == null ? '' : raw.text).length > MAX_CMD_TEXT) truncated = true;
      if (total + text.length > MAX_TOTAL_TEXT) {
        const room = Math.max(0, MAX_TOTAL_TEXT - total);
        text = text.slice(0, room);
        truncated = true;
      }
      total += text.length;
      cmds.push({ cmd: cleanLine(raw.cmd, 256), text, error: cleanLine(raw.error, 500), truncated: !!raw.truncated || text.length < String(raw.text == null ? '' : raw.text).length });
    }
    if (!cmds.length) return { ok: false, error: '没有可保存的命令输出' };
    const base = 'ev_' + eventTs + '_' + crypto.createHash('sha1').update(deviceId + '|' + eventTs + '|' + (p.host || '')).digest('hex').slice(0, 8);
    this._ensureDir();
    let id = base;
    for (let i = 2; i <= 9 && fs.existsSync(this._file(id)); i++) id = base + '_' + i;
    if (fs.existsSync(this._file(id))) return { ok: false, error: '同一事件的取证已存在' };
    const rec = {
      v: FILE_VERSION, id, createdAt: Date.now(), eventTs,
      eventType: cleanLine(p.eventType, 40), eventDetail: cleanLine(p.eventDetail, MAX_DETAIL),
      deviceId, name: cleanLine(p.name, 200), host: cleanLine(p.host, 200), vendor: cleanLine(p.vendor, 40),
      ok: p.ok === true, error: cleanLine(p.error, 500), ms: Math.max(0, Number(p.ms) || 0),
      commands: cmds, truncated
    };
    const text = JSON.stringify(rec);
    const tmp = this._file(id) + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, this._file(id));
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      return { ok: false, error: '写入取证文件失败：' + String((e && e.message) || e) };
    }
    this.stats.saved++;
    this._prune();
    return { ok: true, id, truncated };
  }

  /** 列取证摘要（按事件时间倒序）。筛选：from/to（毫秒，对 eventTs）、deviceId、limit（默认 100，最多 500）。 */
  list(opts) {
    const o = opts || {};
    const from = Number(o.from) || 0;
    const to = Number(o.to) || 0;
    const dev = cleanLine(o.deviceId, 120);
    const limit = Math.max(1, Math.min(500, Number(o.limit) || 100));
    let names = [];
    try { names = fs.readdirSync(this.baseDir); } catch (e) { names = []; }
    const items = [];
    for (const n of names) {
      if (!/^ev_\d{13}_[0-9a-f]{8}(?:_\d)?\.json$/.test(n)) continue;
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(this.baseDir, n), 'utf8')); }
      catch (e) { this.stats.badFiles++; continue; }
      if (!rec || rec.v !== FILE_VERSION || !ID_RE.test(String(rec.id || ''))) { this.stats.badFiles++; continue; }
      if (dev && rec.deviceId !== dev) continue;
      if (from && rec.eventTs < from) continue;
      if (to && rec.eventTs > to) continue;
      items.push(rec);
    }
    items.sort((a, b) => (b.eventTs - a.eventTs) || (b.createdAt - a.createdAt));
    return { ok: true, total: items.length, items: items.slice(0, limit).map(summarize) };
  }

  /** 读一份完整取证（含命令全文）；id 非法或不存在返回 {ok:false}。 */
  read(id) {
    const s = String(id || '');
    if (!ID_RE.test(s)) return { ok: false, error: '非法的取证编号' };
    try {
      const rec = JSON.parse(fs.readFileSync(this._file(s), 'utf8'));
      if (!rec || rec.v !== FILE_VERSION || rec.id !== s) return { ok: false, error: '取证文件损坏' };
      return { ok: true, item: summarize(rec) };
    } catch (e) {
      return { ok: false, error: '取证不存在或已损坏' };
    }
  }

  remove(id) {
    const s = String(id || '');
    if (!ID_RE.test(s)) return { ok: false, error: '非法的取证编号' };
    try { fs.unlinkSync(this._file(s)); return { ok: true }; }
    catch (e) { return { ok: false, error: '删除失败' }; }
  }

  /** 查找某条事件的取证（事件时间线点击「证据」时用；同一事件可能有多台设备）。 */
  byEvent(eventTs) {
    return this.list({ from: Number(eventTs), to: Number(eventTs), limit: 50 });
  }

  status() {
    let files = 0, bytes = 0;
    try {
      for (const n of fs.readdirSync(this.baseDir)) {
        if (!/^ev_\d{13}_[0-9a-f]{8}(?:_\d)?\.json$/.test(n)) continue;
        files++;
        try { bytes += fs.statSync(path.join(this.baseDir, n)).size; } catch (e) { /* ignore */ }
      }
    } catch (e) { /* 目录不存在按空库 */ }
    return { ok: true, files, bytes, maxFiles: this.maxFiles, stats: Object.assign({}, this.stats) };
  }

  /** 滚动淘汰：先按份数，再按总字节；从最旧（事件时间）开始删。 */
  _prune() {
    let list = [];
    try { list = fs.readdirSync(this.baseDir).filter(n => /^ev_\d{13}_[0-9a-f]{8}(?:_\d)?\.json$/.test(n)); }
    catch (e) { return; }
    const withTs = [];
    for (const n of list) {
      try {
        const st = fs.statSync(path.join(this.baseDir, n));
        const m = ID_RE.exec(n.slice(0, -5));
        withTs.push({ n, t: m ? Number(m[1]) : 0, size: st.size });
      } catch (e) { /* ignore */ }
    }
    withTs.sort((a, b) => (a.t - b.t) || (a.n < b.n ? -1 : 1));
    let total = withTs.reduce((s, x) => s + x.size, 0);
    let count = withTs.length;
    while ((count > this.maxFiles || total > this.maxBytes) && withTs.length) {
      const x = withTs.shift();
      try { fs.unlinkSync(path.join(this.baseDir, x.n)); count--; total -= x.size; this.stats.pruned++; }
      catch (e) { /* ignore */ }
    }
  }

  /** 清空全部取证（界面「清空取证」；返回删除份数） */
  clear() {
    let names = [];
    try { names = fs.readdirSync(this.baseDir); } catch (e) { names = []; }
    let removed = 0;
    for (const n of names) {
      if (!/^ev_\d{13}_[0-9a-f]{8}(?:_\d)?\.json$/.test(n)) continue;
      try { fs.unlinkSync(path.join(this.baseDir, n)); removed++; } catch (e) { /* ignore */ }
    }
    return { ok: true, removed };
  }
}

module.exports = { EvidenceStore, MAX_FILES, MAX_COMMANDS, MAX_CMD_TEXT, MAX_TOTAL_TEXT };
