/* NetTopo 链路连通性监测调度器 —— 主进程纯 Node 模块（不依赖 Electron）
 *
 * 职责边界：本模块只做「按间隔探测 + 状态机 + 事件」，不碰拓扑、不发系统通知、不落盘。
 *  - 拓扑 → 任务（段/目标地址）：js/link-path.js（渲染层算好后传进来）；
 *  - 发包：本机 ICMP/TCP（probeLocal）或从段起点设备执行 ping（probeDevice，经 shell.runOneShot）；
 *  - 结论 → 状态：link-path.applyProbe（去抖 + 基线语义见该模块头注）；
 *  - 通知/时间线/界面推送：electron-main.js 监听 result/state 事件后处理。
 *
 * 探测实现可注入（opts.probes）——单测里塞假实现即可在毫秒级验证调度、并发、状态翻转与清理，
 * 不必真发包。
 */
'use strict';
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const LP = require('./link-path.js');
const diag = require('./diag.js');   // 输出解码（中文 Windows 的 GBK ping 回显）与存活判定的既有口径

/** 单任务历史保留条数（面板看趋势 + 排障取证，够用且不占内存） */
const HISTORY_MAX = 60;
/** 本机模式同一轮内的并发探测数：段多（端到端路径 12 段）时既快又不至于把本机打满 */
const LOCAL_CONCURRENCY = 6;

/** 分段并发执行（保序返回；单项异常只影响该项，结果记 error） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length || 1))).fill(0).map(async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { ok: null, latencyMs: null, error: String((e && e.message) || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- 本机探测（默认实现，可被 opts.probes.local 覆盖） ----------------
 * 为「高频、多目标、周期」设计：固定 2 包 + 硬超时 kill（不留悬挂子进程）。
 * 判定复用 js/diag.js 的既有口径——decodeCmdOutput 处理中文 Windows 的 GBK 回显、
 * pingEvidenceAlive 只认「目标自身的成功回复证据」（Windows 会把「无法访问目标主机」也算成
 * Received=1，只凭统计数字会把断链判成通）。解析不出结论时返回 ok=null，不动状态。 */
/** ICMP 探测：系统 ping，2 包，硬超时后 kill（Windows 用 -n/-w，其余用 -c/-W） */
function probeIcmp(host, opts) {
  const o = opts || {};
  const timeoutMs = Math.max(500, Math.min(30000, Number(o.timeoutMs) || 3000));
  const count = String(LP.LIMITS.count);
  const args = process.platform === 'win32'
    ? ['-n', count, '-w', String(Math.max(500, Math.round(timeoutMs / 2))), host]
    : ['-c', count, '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), host];
  return new Promise((resolve) => {
    let done = false;
    let child = null;
    const chunks = [];
    const fin = (r) => { if (done) return; done = true; try { if (child) child.kill(); } catch (e) { /* ignore */ } resolve(r); };
    try { child = spawn('ping', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ ok: null, latencyMs: null, raw: '', error: '无法执行 ping：' + String((e && e.message) || e) }); return; }
    const onData = (d) => { if (chunks.length < 256) chunks.push(d); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const hard = setTimeout(() => fin({ ok: null, latencyMs: null, raw: '', error: '探测超时（' + timeoutMs + 'ms）' }), timeoutMs + 1500);
    child.on('error', (e) => { clearTimeout(hard); fin({ ok: null, latencyMs: null, raw: '', error: String((e && e.message) || e) }); });
    child.on('close', (code) => {
      clearTimeout(hard);
      const text = diag.decodeCmdOutput(Buffer.concat(chunks)).slice(0, 8192);
      if (!text.trim()) { fin({ ok: null, latencyMs: null, raw: '', error: 'ping 无输出（退出码 ' + code + '）' }); return; }
      const stats = diag.parsePingStats(text);
      let ok = null;
      if (stats) ok = diag.pingEvidenceAlive(text, stats, host);
      else if (/(?:Reply\s+from|的回复|Success rate is \d+ percent)/i.test(text)) ok = diag.pingEvidenceAlive(text, null, host);
      const lat = (stats && stats.avg != null) ? stats.avg : LP.parseProbeLatency(text);
      fin({ ok: ok, latencyMs: Number.isFinite(lat) ? lat : null, raw: text, error: ok === null ? '未能从 ping 回显判定结果' : '' });
    });
    if (typeof hard.unref === 'function') hard.unref();
  });
}
/** TCP 探测：能建连即视为该段链路可通（复用 diag.tcpProbe：超时/拒绝都算不通） */
async function probeTcp(host, opts) {
  const o = opts || {};
  const port = Math.max(1, Math.min(65535, parseInt(o.port, 10) || 80));
  const timeoutMs = Math.max(500, Math.min(30000, Number(o.timeoutMs) || 3000));
  const r = await diag.tcpProbe(host, port, timeoutMs);
  return { ok: !!r.open, latencyMs: r.open ? r.ms : null, raw: '', error: r.open ? '' : ('TCP ' + port + ' 不可达') };
}
/** 本机探测统一入口：按任务的 protocol 选 ICMP / TCP */
function probeLocal(host, opts) {
  const o = opts || {};
  if (!LP.isHost(host)) return Promise.resolve({ ok: null, latencyMs: null, raw: '', error: '目标地址非法' });
  return (String(o.protocol || 'icmp') === 'tcp') ? probeTcp(host, o) : probeIcmp(host, o);
}

class LinkMonitor extends EventEmitter {
  /** opts: { probes: { local(host, opts), device(seg, task, opts) }, now: () => Date.now(), log: (msg) => void } */
  constructor(opts) {
    super();
    const o = opts || {};
    // 默认本机探测用内置实现；设备侧探测必须由宿主注入（需要 Shell/凭据库，见 electron-main.js）
    this.probes = Object.assign({ local: probeLocal }, o.probes || {});
    this.now = typeof o.now === 'function' ? o.now : (() => Date.now());
    this.log = typeof o.log === 'function' ? o.log : (() => {});
    this.tasks = new Map();      // id -> { task, state, history, timer, busy, gen, stats }
    this.settings = { maxTasks: LP.LIMITS.maxTasks };
  }

  /** 启动（或替换）一个监测任务。载荷一律经 link-path 归一化，非法直接如实报错 */
  start(raw) {
    const task = LP.normTask(raw);
    if (!task) return { ok: false, error: '监测任务载荷非法（缺少可探测地址或 id 不合法）' };
    const exist = this.tasks.get(task.id);
    if (!exist && this.tasks.size >= this.settings.maxTasks) return { ok: false, error: '监测任务已达上限 ' + this.settings.maxTasks };
    // 设备模式必须给得出可连接的起点（否则每一轮都白跑，不如启动时就拒绝）
    if (task.mode === 'device') {
      const bad = task.segments.find(s => !s.from.host);
      if (bad) return { ok: false, error: '设备模式需要段起点设备的管理地址（第 ' + (bad.index + 1) + ' 段缺失）' };
    }
    this.stop(task.id);
    const rec = {
      task: task,
      state: {
        state: 'unknown', prevState: 'unknown', probeState: null, changed: false, baselined: false,
        okStreak: 0, failStreak: 0, up: 0, down: 0, unknown: 0, brokenAt: null, latencyMs: null,
        since: this.now(), lastProbeAt: 0, lastError: '', segments: []
      },
      history: [],
      timer: null, busy: false, gen: 0,
      stats: { probes: 0, failures: 0, events: 0, lastError: '' }
    };
    this.tasks.set(task.id, rec);
    if (task.enabled) this._schedule(rec, 0);
    this.emit('state', this.infoOf(rec, { reason: 'started' }));
    return { ok: true, key: task.id };
  }

  stop(id) {
    const rec = this.tasks.get(String(id || ''));
    if (!rec) return { ok: false, error: '任务不存在' };
    rec.gen++;                       // 作废在飞的一轮（迟到结果不再写状态/发事件）
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    this.tasks.delete(rec.task.id);
    this.emit('state', this.infoOf(rec, { reason: 'stopped' }));
    return { ok: true };
  }

  stopAll() {
    for (const id of [...this.tasks.keys()]) this.stop(id);
    return { ok: true };
  }

  /** 立即探测一轮（面板「立即探测」/ 状态刷新用）；busy 时如实告知 */
  async probeNow(id) {
    const rec = this.tasks.get(String(id || ''));
    if (!rec) return { ok: false, error: '任务不存在' };
    if (rec.busy) return { ok: false, error: '该任务正在探测中' };
    await this._runOnce(rec);
    return { ok: true, state: this.infoOf(rec) };
  }
  /** 全部任务立即探测一轮（并发任务级、串行轮次，避免瞬时打满） */
  async probeAll() {
    for (const rec of [...this.tasks.values()]) { try { await this._runOnce(rec); } catch (e) { /* 单任务失败不影响其余 */ } }
    return { ok: true, items: this.status().items };
  }

  /** 任务状态快照（渲染层直接展示；segments 为逐段明细，界面据此定位断点） */
  infoOf(rec, extra) {
    const st = rec.state;
    const seg0 = rec.task.segments[0] || { from: {} };
    const broken = (st.brokenAt != null && st.segments[st.brokenAt]) ? st.segments[st.brokenAt] : null;
    return Object.assign({
      key: rec.task.id,
      name: rec.task.name,
      kind: rec.task.kind,
      mode: rec.task.mode,
      protocol: rec.task.protocol,
      deviceId: seg0.from.deviceId || '',
      host: seg0.from.host || '',
      state: st.state,
      prevState: st.prevState,
      probeState: st.probeState,
      changed: !!st.changed,
      baseline: !!st.baseline,
      baselined: !!st.baselined,
      event: st.event || null,
      up: st.up, down: st.down, unknown: st.unknown,
      brokenAt: st.brokenAt,
      brokenTarget: broken ? broken.target : '',
      brokenFrom: broken ? broken.fromName : '',
      latencyMs: st.latencyMs,
      since: st.since,
      lastProbeAt: st.lastProbeAt,
      lastError: st.lastError || '',
      segments: (st.segments || []).map(s => ({
        index: s.index, target: s.target, ok: s.ok, latencyMs: s.latencyMs,
        fromName: s.fromName, targetKind: s.targetKind, error: s.error || ''
      })),
      linkIds: rec.task.linkIds,
      nodeIds: rec.task.nodeIds,
      stats: Object.assign({}, rec.stats)
    }, extra || {});
  }

  status() {
    return { ok: true, items: [...this.tasks.values()].map(rec => this.infoOf(rec)), count: this.tasks.size };
  }
  /** 单任务历史（近 HISTORY_MAX 条） */
  history(id) {
    const rec = this.tasks.get(String(id || ''));
    if (!rec) return { ok: false, error: '任务不存在', items: [] };
    return { ok: true, items: rec.history.slice() };
  }

  /* ---------------- 调度 ---------------- */
  _schedule(rec, delayMs) {
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    const gen = rec.gen;
    const wait = Math.max(0, Number(delayMs) || 0);
    rec.timer = setTimeout(() => {
      rec.timer = null;
      if (gen !== rec.gen) return;
      this._runOnce(rec).catch((e) => this.log('link-monitor 探测异常：' + ((e && e.message) || e)));
    }, wait);
    if (rec.timer && typeof rec.timer.unref === 'function') rec.timer.unref();
  }
  /** 跑一轮：探测所有段 → 状态机 → 发 result / state（状态翻转时） */
  async _runOnce(rec) {
    if (rec.busy) return;
    rec.busy = true;
    const gen = rec.gen;
    const task = rec.task;
    const t0 = this.now();
    try {
      const segs = task.segments;
      let results;
      if (task.mode === 'device') {
        // 设备模式：串行（每段都要起会话；并发起多条 SSH 会被设备的会话数限制掐断，也会互相抢 CPU）
        results = [];
        for (const s of segs) results.push(await this._probeSegment(rec, s));
      } else {
        // 本机模式：按目标地址去重后并发探测，再回填到各段（同一地址只发一次包）
        const targets = LP.localTargets(task);
        const probed = await mapLimit(targets, LOCAL_CONCURRENCY, (t) => this._probeLocal(rec, t.host));
        const byHost = new Map(targets.map((t, i) => [t.host, probed[i]]));
        results = segs.map(s => Object.assign({ index: s.index }, byHost.get(s.target) || { ok: null, latencyMs: null }));
      }
      if (gen !== rec.gen) return;                 // 轮次中任务被停止/重启：结果整体丢弃
      const segOut = results.map((r, i) => Object.assign({
        index: i,
        target: segs[i] ? segs[i].target : '',
        fromName: segs[i] ? (segs[i].from.name || segs[i].from.deviceId) : '',
        targetKind: segs[i] ? segs[i].targetKind : 'ifip'
      }, r));
      const next = LP.applyProbe(rec.state, segOut, {
        failThreshold: task.failThreshold, okThreshold: task.okThreshold,
        baselineFirst: task.baselineFirst, ts: t0
      });
      const changed = next.changed;
      // 段结果 + 状态一并保存（界面既看结论也看过程）
      rec.state = Object.assign({}, rec.state, next, { segments: segOut });
      rec.stats.probes++;
      if (next.state === 'down' && changed) rec.stats.failures++;
      if (next.event) rec.stats.events++;
      const firstErr = segOut.find(r => r && r.error);
      rec.state.lastError = firstErr ? String(firstErr.error || '').slice(0, 200) : '';
      rec.history.push({
        ts: t0, state: next.state, probeState: next.probeState,
        latencyMs: next.latencyMs, brokenAt: next.brokenAt, down: next.down, unknown: next.unknown
      });
      if (rec.history.length > HISTORY_MAX) rec.history.splice(0, rec.history.length - HISTORY_MAX);
      const info = this.infoOf(rec);
      this.emit('result', info);
      if (changed || next.baseline) this.emit('state', info);
    } finally {
      rec.busy = false;
      if (this.tasks.get(task.id) === rec && rec.task.enabled) {
        this._schedule(rec, Math.max(1000, rec.task.intervalSec * 1000));
      }
    }
  }

  /* ---------------- 探测实现 ---------------- */
  /** 本机侧探测（ICMP 或 TCP）：probes.local 由 electron-main.js 注入（diag.js 的实现） */
  async _probeLocal(rec, host) {
    const fn = this.probes.local;
    if (typeof fn !== 'function') return { ok: null, latencyMs: null, error: '本机探测不可用' };
    const task = rec.task;
    try {
      const r = await fn(host, { protocol: task.protocol, port: task.port, timeoutMs: task.timeoutMs });
      return { ok: (r && r.ok === true) ? true : (r && r.ok === false ? false : null), latencyMs: (r && Number.isFinite(r.latencyMs)) ? r.latencyMs : null, raw: (r && r.raw) || '', error: (r && r.error) || '' };
    } catch (e) {
      return { ok: null, latencyMs: null, error: String((e && e.message) || e) };
    }
  }
  /** 设备侧探测（段起点设备上执行 ping）：probes.device 由 electron-main.js 注入 */
  async _probeSegment(rec, seg) {
    const fn = this.probes.device;
    if (typeof fn !== 'function') return { index: seg.index, ok: null, latencyMs: null, error: '设备侧探测不可用' };
    const task = rec.task;
    const vendor = seg.from.vendor || task.vendor;
    const cmd = LP.probeCommand(vendor, seg.target, { count: LP.LIMITS.count, timeoutMs: task.timeoutMs });
    if (!cmd) return { index: seg.index, ok: null, latencyMs: null, error: '探测命令生成失败（目标地址非法）' };
    try {
      const r = await fn(seg, task, { command: cmd, vendor: vendor, timeoutMs: task.timeoutMs });
      return { index: seg.index, ok: (r && r.ok === true) ? true : (r && r.ok === false ? false : null), latencyMs: (r && Number.isFinite(r.latencyMs)) ? r.latencyMs : null, raw: (r && r.raw) || '', error: (r && r.error) || '' };
    } catch (e) {
      return { index: seg.index, ok: null, latencyMs: null, error: String((e && e.message) || e) };
    }
  }
}

module.exports = { LinkMonitor, mapLimit, probeLocal, probeIcmp, probeTcp, HISTORY_MAX, LOCAL_CONCURRENCY };
