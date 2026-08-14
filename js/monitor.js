/* NetTopo 设备后台静默监控 —— 主进程纯 Node 模块（不依赖 Electron）
 * 复用 js/shell.js 的 ShellManager 建立 SSH/Telnet 会话；本模块负责：
 *   - 按循环周期定时发送命令
 *   - 把全部输出（含命令回显）逐行带时间戳写入日志文件
 *   - 日志按日期归档到带日期的目录，跨天自动切换
 *   - 会话异常断开自动重连，直到手动停止
 *   - SSH 首连主机指纹静默信任并记录（后续指纹变化视为中间人拒绝）
 * 可在 Node 测试中直接使用。
 */
'use strict';
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

/** 文件名/目录名安全化：去掉 Windows 与常见控制字符，去空白、限长 */
function sanitizeFilename(s) {
  let out = String(s == null ? '' : s);
  out = out.replace(/\/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  if (!out) out = 'device';
  if (out.length > 60) out = out.slice(0, 60);
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
function fmtDateTime(d) {
  d = d || new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
      + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
function fmtDateDir(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function fmtTimestamp(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 默认值 / 限制（与渲染层保持一致） */
const DEFAULTS = {
  protocol: 'ssh',
  port: 22, telnetPort: 23,
  username: 'admin',
  intervalSec: 300,
  cmdDelayMs: 1000,
  initDelayMs: 1500,
  retrySec: 30
};

/** 单个日志文件大小上限（超出即滚动新文件，防高输出设备占满磁盘） */
const MAX_LOG_BYTES = 32 * 1024 * 1024;
/** 无换行输出的强制断行阈值（防行缓冲无界增长） */
const MAX_LINEBUF_CHARS = 256 * 1024;
/** 告警检查的累计输出文本上限（限制正则最坏耗时） */
const MAX_ALERT_TEXT_CHARS = 64 * 1024;

class MonitorManager extends EventEmitter {
  /** @param {import('./shell').ShellManager} shell 共享的会话管理器
   *  @param {string} logBaseDir 日志根目录（如 userData/monitor-logs）
   *  @param {string} trustFile  指纹记录文件（如 userData/monitor-trust.json） */
  constructor(shell, logBaseDir, trustFile, opts) {
    super();
    opts = opts || {};
    this.shell = shell;
    this.logBaseDir = logBaseDir;
    this.trustFile = trustFile;
    this.backupStore = opts.backupStore || null;
    this.jobs = new Map();       // key -> job
    this._bySid = new Map();     // sid -> key
    this.trusted = new Map();    // host -> fp
    this._loadTrust();
    // 一次性订阅底层会话事件，按 sid 路由到任务
    shell.on('output', (sid, data) => this._onOutput(sid, data));
    shell.on('status', (sid, info) => this._onStatus(sid, info));
    shell.on('end', (sid, reason) => this._onEnd(sid, reason));
  }

  /* ---------------- 指纹记录 ---------------- */
  _loadTrust() {
    try {
      if (!this.trustFile || !fs.existsSync(this.trustFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.trustFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [h, fp] of Object.entries(raw)) {
          if (typeof h === 'string' && typeof fp === 'string' && fp) this.trusted.set(h, fp);
        }
      }
    } catch (e) { /* 读取失败忽略，当作无记录 */ }
  }
  _saveTrust() {
    if (!this.trustFile) return;
    try {
      const obj = {};
      for (const [h, fp] of this.trusted) obj[h] = fp;
      fs.writeFileSync(this.trustFile, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) { /* 失败不中断监控 */ }
  }

  /* ---------------- 入参校验 ---------------- */
  _validate(opts) {
    opts = opts || {};
    const key = String(opts.key || '').trim();
    if (!key || key.length > 64) return { ok: false, error: '监控标识（key）缺失或过长' };
    // 期望的 SSH 主机指纹（SHA256:<base64>）：渲染层复用 Web Shell 已信任指纹时传入，非空则严格比对
    const expectFp = String(opts.expectFp || '').trim().slice(0, 256);
    // key 形如 <deviceId>@<host>：同一设备多个管理口对应多个任务，按 deviceId 聚合
    const keyHost = key.lastIndexOf('@');
    const explicitDeviceId = String(opts.deviceId || '').trim();
    const deviceId = explicitDeviceId || (keyHost > 0 ? key.slice(0, keyHost) : key);
    const name = String(opts.name == null ? '' : opts.name).slice(0, 200);
    const protocol = String(opts.protocol || 'ssh').toLowerCase();
    if (protocol !== 'ssh' && protocol !== 'telnet') return { ok: false, error: '不支持的协议：' + protocol };
    const host = String(opts.host || '').trim();
    if (!host || host.length > 256) return { ok: false, error: '请填写主机地址' };
    let port = parseInt(opts.port, 10);
    if (!(port > 0)) port = protocol === 'telnet' ? DEFAULTS.telnetPort : DEFAULTS.port;
    if (port < 1 || port > 65535) return { ok: false, error: '端口无效' };
    const username = String(opts.username || '').trim().slice(0, 128) || DEFAULTS.username;
    const password = String(opts.password || '').slice(0, 1024);
    const readOnly = !!opts.readOnly; // 仅读取模式：连接后不执行命令，只记录设备主动输出的内容
    const cmds = Array.isArray(opts.commands) ? opts.commands : [];
    const commands = [];
    for (const c of cmds) {
      const s = String(c == null ? '' : c).trim();
      if (!s) continue;
      if (commands.length >= 64) break;
      commands.push(s.length > 512 ? s.slice(0, 512) : s);
    }
    if (!commands.length && !readOnly) return { ok: false, error: '未配置要执行的命令' };
    let intervalSec = parseFloat(opts.intervalSec);
    if (!Number.isFinite(intervalSec)) intervalSec = DEFAULTS.intervalSec;
    intervalSec = Math.max(1, Math.min(86400, intervalSec));
    let cmdDelayMs = parseFloat(opts.cmdDelayMs);
    if (!Number.isFinite(cmdDelayMs)) cmdDelayMs = DEFAULTS.cmdDelayMs;
    cmdDelayMs = Math.max(0, Math.min(60000, cmdDelayMs));
    let retrySec = parseFloat(opts.retrySec);
    if (!Number.isFinite(retrySec)) retrySec = DEFAULTS.retrySec;
    retrySec = Math.max(5, Math.min(3600, retrySec));
    let initDelayMs = parseFloat(opts.initDelayMs);
    if (!Number.isFinite(initDelayMs)) initDelayMs = DEFAULTS.initDelayMs;
    initDelayMs = Math.max(0, Math.min(30000, initDelayMs));
    // ---- 在线状态探测（TCP/ICMP） ----
    const probe = {};
    const pOpt = opts.probe && typeof opts.probe === 'object' ? opts.probe : {};
    probe.enabled = !!pOpt.enabled;
    probe.type = String(pOpt.type || 'tcp').toLowerCase() === 'icmp' ? 'icmp' : 'tcp';
    let probePort = parseInt(pOpt.port, 10);
    probe.port = (probePort > 0 && probePort <= 65535) ? probePort : 0; // 0 = 探测管理端口
    let probeIntervalSec = parseFloat(pOpt.intervalSec);
    if (!Number.isFinite(probeIntervalSec)) probeIntervalSec = 30;
    probe.intervalSec = Math.max(5, Math.min(3600, probeIntervalSec));
    // ---- 输出关键字告警（每行一个正则，可带 # 备注） ----
    const alerts = [];
    const aRaw = Array.isArray(opts.alerts) ? opts.alerts : [];
    for (const a of aRaw) {
      let pattern = '', note = '';
      if (a && typeof a === 'object') { pattern = String(a.pattern || ''); note = String(a.note || ''); }
      else pattern = String(a == null ? '' : a);
      pattern = pattern.trim();
      if (!pattern) continue;
      if (pattern.indexOf('#') >= 0) { const i = pattern.indexOf('#'); note = pattern.slice(i + 1).trim(); pattern = pattern.slice(0, i).trim(); }
      if (!pattern) continue;
      if (pattern.length > 256) pattern = pattern.slice(0, 256);
      // 启发式拒绝嵌套量词（如 (a+)+ / (ab*)*）：主进程同步执行，尽力避免灾难性回溯拖死界面（非完备防线）
      if (/\([^()]*[+*][^()]*\)[+*{]/.test(pattern)) continue;
      let re = null;
      try { re = new RegExp(pattern, 'i'); } catch (e) { re = null; }
      if (!re) continue;
      if (alerts.length >= 32) break;
      alerts.push({ pattern, note: note || pattern, re });
    }
    // ---- 配置自动备份（定时抓取 running-config 类命令输出） ----
    const backup = {};
    const bOpt = opts.backup && typeof opts.backup === 'object' ? opts.backup : {};
    backup.enabled = !!bOpt.enabled;
    backup.command = String(bOpt.command || 'display current-configuration').trim().slice(0, 256) || 'display current-configuration';
    let backupIntervalSec = parseFloat(bOpt.intervalSec);
    if (!Number.isFinite(backupIntervalSec)) backupIntervalSec = 3600;
    backup.intervalSec = Math.max(60, Math.min(86400, backupIntervalSec));
    let backupWaitMs = parseFloat(bOpt.waitMs);
    if (!Number.isFinite(backupWaitMs)) backupWaitMs = 3000;
    backup.waitMs = Math.max(500, Math.min(60000, backupWaitMs));
    return {
      ok: true,
      cfg: { key, deviceId, name, protocol, host, port, username, password, expectFp, commands, readOnly, intervalSec, cmdDelayMs, retrySec, initDelayMs, probe, alerts, backup }
    };
  }

  _newJob(cfg) {
    return {
      key: cfg.key, deviceId: cfg.deviceId, name: cfg.name,
      protocol: cfg.protocol, host: cfg.host, port: cfg.port,
      username: cfg.username, password: cfg.password,
      expectFp: cfg.expectFp || '',
      commands: cfg.commands.slice(),
      readOnly: !!cfg.readOnly,
      intervalSec: cfg.intervalSec, cmdDelayMs: cfg.cmdDelayMs, retrySec: cfg.retrySec,
      initDelayMs: cfg.initDelayMs,
      probe: Object.assign({ enabled: false, type: 'tcp', intervalSec: 30 }, cfg.probe || {}),
      alerts: (cfg.alerts || []).map(a => ({ pattern: a.pattern, note: a.note, re: a.re })),
      backup: Object.assign({ enabled: false, command: 'display current-configuration', intervalSec: 3600, waitMs: 3000 }, cfg.backup || {}),
      probeOk: null, probeLatency: null, probeFailSince: null, probeTimer: null, _probeBusy: false,
      alerting: false, alertInfo: null, _cycleActive: false, _cycleLines: null,
      backupTimer: null, backupRunning: false, backupLast: null, _backupCap: null,
      sid: null, state: 'connecting', statusText: '连接中…',
      enabled: true, stopping: false, fatal: false,
      since: Date.now(), gen: 1,
      logStream: null, logPath: '', logDate: '',
      lineBuf: '', loopTimer: null, retryTimer: null
    };
  }

  /* ---------------- 对外 API ---------------- */
  start(opts) {
    const v = this._validate(opts);
    if (!v.ok) return v;
    const cfg = v.cfg;
    // 同 key 已存在先拆除旧任务（会造成短暂断连，但保证一致）
    const old = this.jobs.get(cfg.key);
    if (old) this._teardown(old, true);
    const job = this._newJob(cfg);
    this.jobs.set(cfg.key, job);
    this._emit(job);
    this._startConnect(job);
    return { ok: true, id: cfg.key };
  }

  stop(key) {
    key = String(key || '').trim();
    if (!key) return { ok: true };
    // key 可为完整任务 key（deviceId@host）：停止该任务；也可为 deviceId：停止该设备全部管理口的任务
    let matched = false;
    for (const job of [...this.jobs.values()]) {
      if (job.key === key || (key.indexOf('@') < 0 && job.deviceId === key)) {
        this._teardown(job, false);
        matched = true;
      }
    }
    return { ok: true, stopped: matched };
  }

  stopAll() {
    for (const k of [...this.jobs.keys()]) this.stop(k);
    return { ok: true };
  }

  /** 返回活跃任务状态快照（供渲染层启动同步；同一设备的多个管理口各占一条） */
  status() {
    const out = [];
    for (const job of this.jobs.values()) {
      out.push({
        key: job.key, deviceId: job.deviceId, host: job.host, name: job.name,
        state: job.state, text: job.statusText, since: job.since, readOnly: !!job.readOnly,
        probeOk: job.probeOk, probeLatency: job.probeLatency, probeFailSince: job.probeFailSince,
        alert: job.alertInfo ? job.alertInfo.pattern : null,
        backup: job.backupLast ? { name: job.backupLast.name, at: job.backupLast.at, changed: !!job.backupLast.changed } : null
      });
    }
    return out;
  }

  /** 立即触发一次配置备份（用于界面「立即备份」按钮）；key 为 deviceId@host */
  runBackupNow(key) {
    key = String(key || '');
    let job = this.jobs.get(key);
    // 兼容用设备名@主机（备份中心目录名）触发：按 name+host 匹配
    if (!job && key.indexOf('@') >= 0) {
      const sp = key.indexOf('@');
      const nm = key.slice(0, sp), hst = key.slice(sp + 1);
      job = [...this.jobs.values()].find(j => (j.name || j.deviceId) === nm && j.host === hst) || null;
    }
    if (!job) return { ok: false, error: '任务不存在' };
    if (!job.backup.enabled) return { ok: false, error: '该任务未开启自动备份' };
    if (job.state !== 'monitoring') return { ok: false, error: '任务未在运行' };
    this._runBackup(job, job.gen);
    return { ok: true };
  }

  /** 返回某设备日志目录（不存在则返回日志根目录）；key 可为 deviceId 或 deviceId@host */
  openLogs(key) {
    key = String(key || '').trim();
    let job = this.jobs.get(key);
    if (!job && key.indexOf('@') < 0) {
      job = [...this.jobs.values()].find(j => j.deviceId === key) || null;
    }
    return job ? path.join(this.logBaseDir, sanitizeFilename(job.name || job.deviceId)) : this.logBaseDir;
  }

  /* ---------------- 拆除 ---------------- */
  _teardown(job, mayReconnect) {
    job.enabled = false;
    job.stopping = true;
    job.gen++;
    this.jobs.delete(job.key);
    if (job.sid) this._bySid.delete(job.sid);
    if (job.loopTimer) { clearTimeout(job.loopTimer); job.loopTimer = null; }
    if (job.retryTimer) { clearTimeout(job.retryTimer); job.retryTimer = null; }
    if (job.probeTimer) { clearTimeout(job.probeTimer); job.probeTimer = null; }
    if (job.backupTimer) { clearTimeout(job.backupTimer); job.backupTimer = null; }
    job._backupCap = null;
    job._cycleActive = false;
    this._closeLog(job);
    if (job.sid) { try { this.shell.close(job.sid); } catch (e) { /* ignore */ } }
    job.sid = null;
    if (!mayReconnect) this._emit(job, 'stopped', '已停止');
  }

  /* ---------------- 连接 / 重连 ---------------- */
  _startConnect(job) {
    if (!job.enabled || job.stopping) return;
    job.state = 'connecting';
    job.statusText = '连接中…';
    job.gen++;
    const gen = job.gen;
    this._emit(job);
    const r = this.shell.connect({
      protocol: job.protocol,
      host: job.host,
      port: job.port,
      username: job.username,
      password: job.password,
      cols: 120, rows: 40,
      expectFp: job.expectFp || ''
    });
    if (!r.ok) {
      if (gen !== job.gen || !job.enabled) return;
      job.statusText = '连接失败：' + (r.error || '未知错误');
      this._scheduleReconnect(job, gen);
      return;
    }
    job.sid = r.id;
    this._bySid.set(r.id, job.key);
  }

  _scheduleReconnect(job, gen) {
    if (!job.enabled || job.stopping || gen !== job.gen) return;
    job.state = 'reconnecting';
    this._emit(job);
    clearTimeout(job.retryTimer);
    job.retryTimer = setTimeout(() => {
      if (job.enabled && !job.stopping && gen === job.gen) this._startConnect(job);
    }, job.retrySec * 1000);
  }

  /* ---------------- 日志 ---------------- */
  _deviceDir(job) {
    return path.join(this.logBaseDir, sanitizeFilename(job.name || job.deviceId));
  }
  _openLog(job) {
    this._closeLog(job);
    const date = fmtDateDir();
    const dir = path.join(this._deviceDir(job), date);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    // 文件名含主机地址：同一设备多个管理口各自独立日志，互不覆盖
    const safe = sanitizeFilename(job.name || job.deviceId);
    const safeHost = sanitizeFilename(job.host || 'unknown');
    let fname = safe + '_' + safeHost + '_' + fmtDateTime() + '.log';
    // 同秒内滚动时加序号后缀，避免 'a' 模式重新打开刚关闭的文件
    let seq = 0;
    while (fs.existsSync(path.join(dir, fname))) {
      seq++;
      fname = safe + '_' + safeHost + '_' + fmtDateTime() + '_' + seq + '.log';
    }
    job.logDate = date;
    job.logPath = path.join(dir, fname);
    try { job.logStream = fs.createWriteStream(job.logPath, { flags: 'a', encoding: 'utf8' }); }
    catch (e) { job.logStream = null; }
  }
  _closeLog(job) {
    if (job.logStream) { try { job.logStream.end(); } catch (e) { /* ignore */ } job.logStream = null; }
  }
  _rollLogIfNeeded(job) {
    if (fmtDateDir() !== job.logDate) this._openLog(job);
  }
  _logLine(job, text) {
    if (!job.logStream) this._openLog(job);
    if (!job.logStream) return;
    // 单文件超过大小上限即滚动新文件（防高输出设备占满磁盘）
    if (job.logStream.bytesWritten > MAX_LOG_BYTES) this._openLog(job);
    if (!job.logStream) return;
    try { job.logStream.write('[' + fmtTimestamp() + '] ' + text + '\n'); } catch (e) { /* ignore */ }
  }
  _logCmd(job, cmd) {
    this._logLine(job, '>> ' + cmd);
  }

  /* ---------------- 命令循环 ---------------- */
  _bootstrap(job) {
    job.state = 'monitoring';
    job.statusText = (job.readOnly ? '仅读取中：' : '监控中：') + job.host + ':' + job.port + '（' + job.protocol.toUpperCase() + '）';
    this._openLog(job);
    this._logLine(job, '===== 开始后台监控 =====');
    this._logLine(job, '主机: ' + job.host + ':' + job.port + ' 协议: ' + job.protocol.toUpperCase() + ' 用户名: ' + job.username);
    if (job.readOnly) this._logLine(job, '模式: 仅读取（不执行命令，持续记录设备输出）');
    this._emit(job);
    // 在线探测：连接建立后立即探测一次，并按间隔调度
    if (job.probe.enabled) {
      this._probeOnce(job);
      this._scheduleProbe(job);
    }
    if (job.readOnly) return; // 仅读取模式：不调度命令循环，只保持连接并记录输出
    job.gen++;
    const gen = job.gen;
    clearTimeout(job.loopTimer);
    job.loopTimer = setTimeout(() => this._runCycle(job, gen), job.initDelayMs);
    // 配置自动备份：先于命令循环执行一次，之后按备份间隔调度（用当前 gen，避免快照过期）
    if (job.backup.enabled) {
      clearTimeout(job.backupTimer);
      job.backupTimer = setTimeout(() => this._runBackup(job, gen), Math.max(job.initDelayMs, 1000) + 1500);
    }
  }

  async _runCycle(job, gen) {
    if (!job.enabled || job.state !== 'monitoring' || gen !== job.gen || job.readOnly) return;
    // 配置备份捕获期间暂停命令循环（避免输出互相污染），1 秒后再试
    if (job._cycleActive) {
      clearTimeout(job.loopTimer);
      job.loopTimer = setTimeout(() => this._runCycle(job, gen), 1000);
      return;
    }
    this._rollLogIfNeeded(job);
    this._logLine(job, '----- 命令轮次 ' + fmtTimestamp() + ' -----');
    job._cycleActive = true;
    job._cycleLines = [];
    const eol = job.protocol === 'telnet' ? '\r\n' : '\n';
    for (const cmd of job.commands) {
      if (!job.enabled || job.state !== 'monitoring' || gen !== job.gen) return;
      this._logCmd(job, cmd);
      try { this.shell.write(job.sid, cmd + eol); } catch (e) { /* ignore */ }
      if (job.cmdDelayMs > 0) await sleep(job.cmdDelayMs);
    }
    job._cycleActive = false;
    if (!job.enabled || gen !== job.gen) return;
    this._checkAlerts(job);
    job.loopTimer = setTimeout(() => this._runCycle(job, job.gen), job.intervalSec * 1000);
  }

  /* ---------------- 底层事件路由 ---------------- */
  _onOutput(sid, data) {
    const key = this._bySid.get(sid);
    const job = key && this.jobs.get(key);
    if (!job || !job.logStream) return;
    let text = String(data || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b[()][0-9A-B]/g, '');
    // 去掉独立的回车（CRLF / CR 均归一为换行）
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    job.lineBuf += text;
    // 设备长时间不输出换行时强制断行，防行缓冲无界增长（主进程内存）
    if (job.lineBuf.length > MAX_LINEBUF_CHARS) {
      const cut = job.lineBuf.slice(0, MAX_LINEBUF_CHARS).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      if (cut) this._logLine(job, cut);
      job.lineBuf = job.lineBuf.slice(MAX_LINEBUF_CHARS);
    }
    const parts = job.lineBuf.split('\n');
    job.lineBuf = parts.pop(); // 保留半行
    const captured = [];
    for (const ln of parts) {
      const t = ln.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      if (t) {
        this._logLine(job, t);
        if (job._cycleActive && job.alerts.length && job._cycleLines && job._cycleLines.length < 20000) job._cycleLines.push(t);
        if (job._backupCap) captured.push(t);
      }
    }
    // 备份捕获：过滤命令回显与提示符行
    if (job._backupCap && captured.length) {
      for (const t of captured) {
        const cmd = job._backupCap.cmd;
        if (t === cmd || t.indexOf(cmd) === 0) continue;
        if (/^[A-Za-z0-9_.\-\[\]()/:<> ]{0,64}\s*[>#]$/.test(t)) continue; // 提示符行
        job._backupCap.lines.push(t);
      }
    }
  }

  _onStatus(sid, info) {
    const key = this._bySid.get(sid);
    const job = key && this.jobs.get(key);
    if (!job || !info) return;
    const state = info.state;
    if (state === 'connected') {
      this._bootstrap(job);
    } else if (state === 'fingerprint') {
      this._handleFingerprint(job, info);
    } else if (state === 'error') {
      job.statusText = info.text || job.statusText;
    } else if (state === 'info' && info.text) {
      this._logLine(job, info.text);
    }
  }

  _handleFingerprint(job, info) {
    const host = job.host;
    const fp = String(info.fp || '');
    const known = this.trusted.get(host);
    if (known) {
      if (known === fp) {
        this._logLine(job, '主机指纹一致，通过验证。');
      } else {
        job.statusText = '主机指纹变化，可能遭到中间人攻击，已拒绝连接';
        job.fatal = true;
        this._logLine(job, '警告：主机指纹变化（' + fp + '），可能为中间人攻击，已拒绝连接。');
        this._emit(job, 'error', job.statusText);
        this._teardown(job, false);
        return;
      }
    } else {
      this._logLine(job, '首次连接，已自动信任主机指纹 SHA256: ' + fp);
      this.trusted.set(host, fp);
      this._saveTrust();
      // 首连自动信任属安全敏感事件：通知主进程弹出系统通知（后续指纹变化仍会拒连）
      this.emit('trust', { key: job.key, deviceId: job.deviceId, name: job.name, host, fp });
    }
    try { this.shell.trustFingerprint(host, true); } catch (e) { /* ignore */ }
  }

  _onEnd(sid, reason) {
    const key = this._bySid.get(sid);
    if (!key) return; // 已拆除/重启的旧会话，忽略
    this._bySid.delete(sid);
    const job = this.jobs.get(key);
    if (!job) return;
    job.sid = null;
    if (job.stopping || !job.enabled) {
      if (!job.stopping) this._emit(job, 'stopped', reason || '已停止');
      return;
    }
    this._closeLog(job);
    job._backupCap = null;
    job._cycleActive = false;
    const gen = job.gen;
    job.state = 'reconnecting';
    job.statusText = '连接断开：' + (reason || '连接已关闭') + '，准备重连';
    this._emit(job);
    clearTimeout(job.retryTimer);
    job.retryTimer = setTimeout(() => {
      if (job.enabled && !job.stopping && !job.fatal && gen === job.gen) this._startConnect(job);
    }, job.retrySec * 1000);
  }

  /* ---------------- 在线状态探测（TCP / ICMP） ---------------- */
  _scheduleProbe(job) {
    clearTimeout(job.probeTimer);
    job.probeTimer = setTimeout(() => this._probeOnce(job), job.probe.intervalSec * 1000);
  }
  _probeOnce(job) {
    if (!job.enabled || job.stopping || job.state !== 'monitoring' || job._probeBusy) return;
    job._probeBusy = true;
    const t0 = Date.now();
    const done = (ok) => {
      job._probeBusy = false;
      if (!job.enabled || job.stopping || job.state !== 'monitoring') return;
      const latency = Date.now() - t0;
      const changed = job.probeOk !== ok;
      job.probeOk = ok;
      job.probeLatency = latency;
      if (!ok) { if (!job.probeFailSince) job.probeFailSince = Date.now(); job.statusText = job.statusText.split('（')[0] + '（探测离线，自 ' + fmtTimestamp(new Date(job.probeFailSince)) + '）'; }
      else { job.probeFailSince = null; if (job.statusText.indexOf('探测离线') >= 0) job.statusText = (job.readOnly ? '仅读取中：' : '监控中：') + job.host + ':' + job.port + '（' + job.protocol.toUpperCase() + '）'; }
      if (changed) {
        this._logLine(job, ok ? '探测恢复：' + job.host + ':' + job.port + '（' + latency + 'ms）' : '警告：探测失败，' + job.host + ':' + job.port + ' 可能离线');
        this.emit('probe', { key: job.key, deviceId: job.deviceId, host: job.host, ok, latencyMs: latency, failSince: job.probeFailSince });
        this._emit(job);
      }
      if (job.enabled && !job.stopping && job.state === 'monitoring') this._scheduleProbe(job);
    };
    if (job.probe.type === 'icmp') {
      const args = process.platform === 'win32' ? ['-n', '1', '-w', '2000', job.host] : ['-c', '1', '-W', '2', job.host];
      let child = null;
      try { child = spawn('ping', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch (e) { done(false); return; }
      let out = '';
      let finished = false;
      const fin = (ok) => { if (!finished) { finished = true; try { child.kill(); } catch (e) {} done(ok); } };
      const t2 = setTimeout(() => fin(false), 4000);
      child.stdout.on('data', (d) => { out += d.toString(); if (/TTL=|ttl=|time=|time<|rtt/i.test(out)) fin(true); });
      child.on('error', () => fin(false));
      child.on('close', (code) => { clearTimeout(t2); fin(code === 0); });
      child.stdout.on('end', () => clearTimeout(t2));
      return;
    }
    // TCP 连接探测：默认探测管理端口（可被 probe.port 覆盖，如探测业务服务口）
    const sock = net.connect({ host: job.host, port: job.probe.port || job.port, timeout: 3000 });
    const fin = (ok) => { try { sock.destroy(); } catch (e) {} done(ok); };
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
    sock.once('timeout', () => fin(false));
  }

  /* ---------------- 输出关键字告警 ---------------- */
  _checkAlerts(job) {
    if (!job.alerts.length) return;
    let text = (job._cycleLines || []).join('\n');
    // 限制正则输入规模：既限内存也限灾难性回溯的最坏耗时
    if (text.length > MAX_ALERT_TEXT_CHARS) text = text.slice(0, MAX_ALERT_TEXT_CHARS);
    job._cycleLines = null;
    let matched = null;
    if (text) {
      for (const a of job.alerts) { if (a.re.test(text)) { matched = a; break; } }
    }
    const nowAlerting = !!matched;
    if (nowAlerting !== job.alerting) {
      job.alerting = nowAlerting;
      job.alertInfo = nowAlerting ? { pattern: matched.pattern, note: matched.note, at: Date.now() } : null;
      this._logLine(job, nowAlerting ? '【告警】输出匹配关键字「' + matched.pattern + '」' : '【告警恢复】输出不再匹配关键字');
      this.emit('alert', { key: job.key, deviceId: job.deviceId, host: job.host, matched: nowAlerting, pattern: nowAlerting ? matched.pattern : null, note: nowAlerting ? matched.note : null });
      this._emit(job);
    }
  }

  /* ---------------- 配置自动备份 ---------------- */
  _scheduleBackup(job) {
    if (!job.backup.enabled) return;
    clearTimeout(job.backupTimer);
    job.backupTimer = setTimeout(() => this._runBackup(job, job.gen), job.backup.intervalSec * 1000);
  }
  async _runBackup(job, gen) {
    if (!job.enabled || !job.backup.enabled || job.state !== 'monitoring' || gen !== job.gen || !this.backupStore) return;
    if (job.backupRunning || job._cycleActive) {
      // 与命令循环撞车：2 秒后再试，不跳过本轮
      clearTimeout(job.backupTimer);
      job.backupTimer = setTimeout(() => this._runBackup(job, job.gen), 2000);
      return;
    }
    job.backupRunning = true;
    job._cycleActive = true; // 暂停命令循环直到备份完成
    this._rollLogIfNeeded(job);
    this._logCmd(job, job.backup.command + '（配置备份）');
    job._backupCap = { cmd: job.backup.command, lines: [], startedAt: Date.now() };
    const eol = job.protocol === 'telnet' ? '\r\n' : '\n';
    try { this.shell.write(job.sid, job.backup.command + eol); } catch (e) { job._backupCap = null; job.backupRunning = false; job._cycleActive = false; this._finishBackup(job, gen, { ok: false, error: '写入失败' }); return; }
    const waitMs = job.backup.waitMs;
    await sleep(waitMs);
    const cap = job._backupCap;
    job._backupCap = null;
    job.backupRunning = false;
    job._cycleActive = false;
    if (!job.enabled || job.stopping || gen !== job.gen || !cap) { this._scheduleBackup(job); return; }
    const content = cap.lines.join('\n');
    if (!content.trim()) {
      job.backupLast = { at: Date.now(), error: '无输出' };
      this._logLine(job, '配置备份：命令无输出，已跳过');
      this._scheduleBackup(job);
      return;
    }
    const r = this.backupStore.save(job.name || job.deviceId, job.host, content);
    if (!r.ok) {
      job.backupLast = { at: Date.now(), error: r.error };
      this._logLine(job, '配置备份失败：' + r.error);
      this.emit('backup', { key: job.key, deviceId: job.deviceId, host: job.host, ok: false, error: r.error });
      this._scheduleBackup(job);
      return;
    }
    let diffInfo = null;
    if (r.prev) {
      const d = this.backupStore.diff(job.name || job.deviceId, job.host, r.prev, r.name);
      if (d.ok) diffInfo = { added: d.added, removed: d.removed, changed: d.changed };
    }
    const changed = diffInfo ? diffInfo.changed : true;
    job.backupLast = { name: r.name, at: Date.now(), changed, added: diffInfo ? diffInfo.added : null, removed: diffInfo ? diffInfo.removed : null };
    this._logLine(job, '配置备份已保存：' + r.name + '（' + cap.lines.length + ' 行）' + (r.first ? '（首份）' : (diffInfo ? (changed ? '，与上次差异 +' + diffInfo.added + '/-' + diffInfo.removed + ' 行' : '，与上次一致') : '')));
    this.emit('backup', { key: job.key, deviceId: job.deviceId, host: job.host, ok: true, name: r.name, first: !!r.first, prev: r.prev, changed, added: diffInfo ? diffInfo.added : null, removed: diffInfo ? diffInfo.removed : null });
    this._scheduleBackup(job);
  }
  _finishBackup(job, gen, res) {
    if (res && !res.ok) {
      job.backupLast = { at: Date.now(), error: res.error };
      this._logLine(job, '配置备份失败：' + res.error);
      this.emit('backup', { key: job.key, deviceId: job.deviceId, host: job.host, ok: false, error: res.error });
    }
    if (job.enabled && !job.stopping && gen === job.gen) this._scheduleBackup(job);
  }

  /* ---------------- 状态广播 ---------------- */
  _emit(job, state, text) {
    this.emit('status', {
      key: job.key,
      deviceId: job.deviceId,
      host: job.host,
      name: job.name,
      state: state || job.state,
      text: text || job.statusText,
      since: job.since,
      probeOk: job.probeOk,
      alert: job.alertInfo ? job.alertInfo.pattern : null,
      backup: job.backupLast ? { name: job.backupLast.name, at: job.backupLast.at, changed: !!job.backupLast.changed, error: job.backupLast.error || null } : null
    });
  }
}

module.exports = { MonitorManager, sanitizeFilename };

