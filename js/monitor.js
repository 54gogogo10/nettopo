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

/** 文件名/目录名安全化：去掉 Windows 与常见控制字符，去空白、限长。
 *  注意：正则必须独立匹配字符类（不得写成 "/字符类"——那要求字面 / 前缀，永不匹配），
 *  并额外剔除路径穿越成分（..）与首尾点号/空白（防日志目录逃逸 + Windows 命名限制）。 */
function sanitizeFilename(s) {
  let out = String(s == null ? '' : s);
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  out = out.replace(/\.\./g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!out) out = 'device';
  if (out.length > 60) out = out.slice(0, 60);
  return out;
}

/** 清理备份捕获行：只保留命令执行后的输出内容。
 *  - 输入的命令行（或其终端回显，可能带「提示符+命令」前缀，如 Switch#display current-configuration）一律不保留
 *  - 提示符行（Switch# / R1> 等）不保留
 *  返回：过滤后的行数组（保留原始行文本） */
function cleanBackupLines(lines, cmds) {
  const out = [];
  const list = Array.isArray(cmds) ? cmds : [];
  for (const raw of (Array.isArray(lines) ? lines : [])) {
    const t = String(raw == null ? '' : raw).replace(/\s+$/, '');
    if (!t) continue;
    if (list.some(c => c && (t === c || t.endsWith(c)))) continue; // 输入的命令行（可能带提示符前缀）
    if (/^[A-Za-z0-9_.\-\[\]()/:<> +]{0,80}[>#]$/.test(t)) continue; // 提示符行
    out.push(raw);
  }
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
    const readOnly = !!opts.readOnly; // 仅读取模式：不执行周期循环命令，只记录设备主动输出（连接时执行命令仍会执行一次）
    const cmds = Array.isArray(opts.commands) ? opts.commands : [];
    const commands = [];
    for (const c of cmds) {
      const s = String(c == null ? '' : c).trim();
      if (!s) continue;
      if (commands.length >= 64) break;
      commands.push(s.length > 512 ? s.slice(0, 512) : s);
    }
    // 连接时执行命令：每次连接建立成功时仅执行一次（先于周期循环；重连后的新会话也会再执行一次）；支持多条（数组或按行分割）
    const onConnectCmds = [];
    {
      const ocRaw = Array.isArray(opts.onConnect) ? opts.onConnect : String(opts.onConnect == null ? '' : opts.onConnect).split(/\r?\n/);
      for (const c of ocRaw) {
        const s = String(c == null ? '' : c).trim();
        if (!s) continue;
        if (onConnectCmds.length >= 16) break;
        onConnectCmds.push(s.length > 512 ? s.slice(0, 512) : s);
      }
    }
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
    // 命令与模式校验：非仅读取须有周期命令，或勾选在线探测使用「仅探测」模式（保持连接、不执行周期命令）
    if (!commands.length && !readOnly && !probe.enabled) return { ok: false, error: '未配置要执行的命令，或勾选「在线探测」使用仅探测模式' };
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
    // ---- 配置自动备份（定时抓取 running-config 类命令输出；命令可多条） ----
    const backup = {};
    const bOpt = opts.backup && typeof opts.backup === 'object' ? opts.backup : {};
    backup.enabled = !!bOpt.enabled;
    const backupCmds = [];
    {
      const bRaw = Array.isArray(bOpt.command) ? bOpt.command : String(bOpt.command == null ? '' : bOpt.command).split(/\r?\n/);
      for (const c of bRaw) {
        const s = String(c == null ? '' : c).trim();
        if (!s) continue;
        if (backupCmds.length >= 16) break;
        backupCmds.push(s.length > 256 ? s.slice(0, 256) : s);
      }
    }
    backup.commands = backupCmds.length ? backupCmds : ['display current-configuration'];
    // 备份连接方式：session = 复用监控会话；own = 每次备份单独建立连接
    backup.mode = String(bOpt.mode || 'session').toLowerCase() === 'own' ? 'own' : 'session';
    // 无变化不新增：内容与上一份完全一致时跳过保存（不生成新文件），仅更新状态
    backup.skipIfSame = !!bOpt.skipIfSame;
    let backupIntervalSec = parseFloat(bOpt.intervalSec);
    if (!Number.isFinite(backupIntervalSec)) backupIntervalSec = 3600;
    backup.intervalSec = Math.max(60, Math.min(86400, backupIntervalSec));
    let backupWaitMs = parseFloat(bOpt.waitMs);
    if (!Number.isFinite(backupWaitMs)) backupWaitMs = 1000; // 备份命令每条间隔默认 1 秒
    backup.waitMs = Math.max(500, Math.min(60000, backupWaitMs));
    return {
      ok: true,
      cfg: { key, deviceId, name, protocol, host, port, username, password, expectFp, commands, onConnect: onConnectCmds, readOnly, intervalSec, cmdDelayMs, retrySec, initDelayMs, probe, alerts, backup }
    };
  }

  _newJob(cfg) {
    return {
      key: cfg.key, deviceId: cfg.deviceId, name: cfg.name,
      protocol: cfg.protocol, host: cfg.host, port: cfg.port,
      username: cfg.username, password: cfg.password,
      expectFp: cfg.expectFp || '',
      commands: cfg.commands.slice(),
      onConnect: (cfg.onConnect || []).slice(),
      readOnly: !!cfg.readOnly,
      intervalSec: cfg.intervalSec, cmdDelayMs: cfg.cmdDelayMs, retrySec: cfg.retrySec,
      initDelayMs: cfg.initDelayMs,
      probe: Object.assign({ enabled: false, type: 'tcp', intervalSec: 30 }, cfg.probe || {}),
      alerts: (cfg.alerts || []).map(a => ({ pattern: a.pattern, note: a.note, re: a.re })),
      backup: Object.assign({ enabled: false, commands: ['display current-configuration'], mode: 'session', skipIfSame: false, intervalSec: 3600, waitMs: 1000 }, cfg.backup || {}),
      probeOk: null, probeLatency: null, probeFailSince: null, probeTimer: null, _probeBusy: false,
      alerting: false, alertInfo: null, _cycleActive: false, _alertPending: [],
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
        backup: job.backupLast ? { name: job.backupLast.name, at: job.backupLast.at, changed: !!job.backupLast.changed, first: !!job.backupLast.first, error: job.backupLast.error || null } : null,
        backupEnabled: !!job.backup.enabled, backupMode: job.backup.mode
      });
    }
    return out;
  }

  /** 立即触发一次配置备份（用于界面「立即备份」按钮）；key 可为 deviceId@host 或 设备名@主机。
   *  返回 {ok, saved, skipped, name, error}，界面据此给出明确反馈（保存 / 无变化跳过 / 失败原因）。 */
  async runBackupNow(key) {
    key = String(key || '');
    let job = this.jobs.get(key);
    // 兼容用设备名@主机（备份中心目录名）触发：按 name+host 匹配
    if (!job && key.indexOf('@') >= 0) {
      const sp = key.indexOf('@');
      const nm = key.slice(0, sp), hst = key.slice(sp + 1);
      job = [...this.jobs.values()].find(j => (j.name || j.deviceId) === nm && j.host === hst) || null;
      // 兼容备份目录名被安全化（含特殊字符）后的设备名/主机名
      if (!job) {
        job = [...this.jobs.values()].find(j => sanitizeFilename(j.name || j.deviceId) === nm && sanitizeFilename(j.host) === hst) || null;
      }
    }
    if (!job) return { ok: false, error: '该地址没有正在运行的监控任务（请先在「设备监控」中启动）' };
    if (!job.backup.enabled) return { ok: false, error: '该任务未开启自动备份' };
    if (job.stopping || !job.enabled) return { ok: false, error: '任务已停止' };
    // 复用监控会话的备份要求会话在线；独立连接模式内部自建会话，断线重连时也能立即备份
    if (job.backup.mode !== 'own' && job.state !== 'monitoring') return { ok: false, error: '监控会话未在线（当前：' + (job.statusText || job.state) + '）' };
    job._bkResult = null;
    await this._runBackup(job, job.gen);
    const r = job._bkResult || {};
    return { ok: true, saved: !!r.saved, skipped: !!r.skipped, name: r.name || null, error: r.error || null };
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
    if (job._alertTimer) { clearTimeout(job._alertTimer); job._alertTimer = null; }
    job._backupCap = null;
    job._cycleActive = false;
    job._alertPending = [];
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
  _openLog(job, forceNew) {
    const date = fmtDateDir();
    // 按天归档：同日内的连接/重连/滚动后复用同一文件继续追加，不重复生成
    if (!forceNew && job.logStream && job.logDate === date) return;
    this._closeLog(job);
    const dir = path.join(this._deviceDir(job), date);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    // 文件名含主机地址：同一设备多个管理口各自独立日志，互不覆盖
    const safe = sanitizeFilename(job.name || job.deviceId);
    const safeHost = sanitizeFilename(job.host || 'unknown');
    let fname;
    if (!forceNew) {
      // 每日一个固定文件：<设备名>_<管理口>.log（同日重连/重启只追加，不新建）
      fname = safe + '_' + safeHost + '.log';
    } else {
      // 单文件超过大小上限滚动：追加时间戳序号，生成独立文件（罕见，防高输出占满磁盘）
      let seq = 0;
      do {
        seq++;
        fname = safe + '_' + safeHost + '_' + fmtDateTime() + '_' + seq + '.log';
      } while (fs.existsSync(path.join(dir, fname)));
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
    if (job.logStream.bytesWritten > MAX_LOG_BYTES) this._openLog(job, true);
    if (!job.logStream) return;
    try { job.logStream.write('[' + fmtTimestamp() + '] ' + text + '\n'); } catch (e) { /* ignore */ }
  }
  _logCmd(job, cmd) {
    this._logLine(job, '>> ' + cmd);
  }

  /* ---------------- 命令循环 ---------------- */
  _bootstrap(job) {
    job.state = 'monitoring';
    // 状态文本三态：监控中（有周期命令）/ 仅读取中 / 仅探测中（无命令无仅读取，只做在线探测）
    const modeText = job.readOnly ? '仅读取中：' : (job.commands.length ? '监控中：' : '仅探测中：');
    job.statusText = modeText + job.host + ':' + job.port + '（' + job.protocol.toUpperCase() + '）';
    this._openLog(job);
    this._logLine(job, '===== 开始后台监控 =====');
    this._logLine(job, '主机: ' + job.host + ':' + job.port + ' 协议: ' + job.protocol.toUpperCase() + ' 用户名: ' + job.username);
    if (job.readOnly) this._logLine(job, '模式: 仅读取（不执行命令，持续记录设备输出）');
    else if (!job.commands.length) this._logLine(job, '模式: 仅探测（不执行命令，只做在线状态探测）');
    this._emit(job);
    // 在线探测：连接建立后立即探测一次，并按间隔调度
    if (job.probe.enabled) {
      this._probeOnce(job);
      this._scheduleProbe(job);
    }
    if (job.readOnly && !(job.onConnect && job.onConnect.length)) {
      // 仅读取且无连接时命令：不执行周期循环，只保持连接并记录输出；自动备份仍按间隔抓取（备份命令为只读操作）
      if (job.backup.enabled) {
        job.gen++;
        const gen = job.gen;
        clearTimeout(job.backupTimer);
        job.backupTimer = setTimeout(() => this._runBackup(job, gen), Math.max(job.initDelayMs, 1000) + 1500);
      }
      return;
    }
    job.gen++;
    const gen = job.gen;
    clearTimeout(job.loopTimer);
    if (job.onConnect && job.onConnect.length) {
      // 连接时执行命令：每次连接建立成功仅执行一次，先于周期循环（仅读取/仅探测模式同样执行，用于会话初始化）
      this._logLine(job, '连接时执行命令（每次连接成功仅执行一次）: ' + job.onConnect.join('；'));
      job.loopTimer = setTimeout(() => {
        this._runOnConnect(job, gen);
        if (job.readOnly || !job.commands.length) return; // 仅读取/仅探测模式：不进入周期循环
        if (!job.enabled || job.stopping || gen !== job.gen) return;
        job.loopTimer = setTimeout(() => this._runCycle(job, gen), job.initDelayMs + 800);
      }, job.initDelayMs);
    } else if (job.commands.length) {
      job.loopTimer = setTimeout(() => this._runCycle(job, gen), job.initDelayMs);
    }
    // 无命令且无连接时命令（仅探测模式）：不调度周期循环
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
    try {
      const eol = job.protocol === 'telnet' ? '\r\n' : '\n';
      for (const cmd of job.commands) {
        if (!job.enabled || job.state !== 'monitoring' || gen !== job.gen) break;
        this._logCmd(job, cmd);
        try { this.shell.write(job.sid, cmd + eol); } catch (e) { /* ignore */ }
        if (job.cmdDelayMs > 0) await sleep(job.cmdDelayMs);
      }
    } finally {
      job._cycleActive = false; // 中途退出（会话断开/停止）也必须释放互斥位，避免永久卡死
    }
    if (!job.enabled || gen !== job.gen) return;
    this._checkAlerts(job);
    job.loopTimer = setTimeout(() => this._runCycle(job, job.gen), job.intervalSec * 1000);
  }

  /* ---------------- 连接时执行命令（每次连接成功仅执行一次，可多条依次执行） ---------------- */
  _runOnConnect(job, gen) {
    if (!job.enabled || job.stopping || gen !== job.gen || job.state !== 'monitoring' || !job.sid) return;
    const eol = job.protocol === 'telnet' ? '\r\n' : '\n';
    (async () => {
      for (const cmd of job.onConnect) {
        if (!job.enabled || job.stopping || gen !== job.gen || !job.sid) return;
        this._logCmd(job, cmd + '（连接时执行）');
        try { this.shell.write(job.sid, cmd + eol); } catch (e) { /* ignore */ }
        if (job.cmdDelayMs > 0) await sleep(job.cmdDelayMs);
      }
    })();
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
        // 告警缓冲：周期循环、连接时执行命令、仅读取模式的设备主动输出，全部纳入关键字告警匹配
        if (job.alerts.length && job._alertPending && job._alertPending.length < 20000) job._alertPending.push(t);
        if (job._backupCap) captured.push(t);
      }
    }
    // 仅读取模式：不跑周期循环，输出到达后去抖检查告警（避免高频输出逐行触发正则）
    if (job.readOnly && job.alerts.length && job._alertPending && job._alertPending.length && !job._alertTimer) {
      job._alertTimer = setTimeout(() => {
        job._alertTimer = null;
        if (job.enabled && !job.stopping) this._checkAlerts(job);
      }, 500);
    }
    // 备份捕获：过滤命令回显（多条命令集合，含「提示符+命令」整行）与提示符行
    if (job._backupCap && captured.length) {
      for (const t of cleanBackupLines(captured, job._backupCap.commands)) job._backupCap.lines.push(t);
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
      else { job.probeFailSince = null; if (job.statusText.indexOf('探测离线') >= 0) job.statusText = (job.readOnly ? '仅读取中：' : (job.commands.length ? '监控中：' : '仅探测中：')) + job.host + ':' + job.port + '（' + job.protocol.toUpperCase() + '）'; }
      if (changed) {
        this._logLine(job, ok ? '探测恢复：' + job.host + ':' + job.port + '（' + latency + 'ms）' : '警告：探测失败，' + job.host + ':' + job.port + ' 可能离线');
        this.emit('probe', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, ok, latencyMs: latency, failSince: job.probeFailSince });
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

  /* ---------------- 输出关键字告警（周期循环 / 连接时命令 / 仅读取输出均参与） ---------------- */
  _checkAlerts(job) {
    if (!job.alerts.length || !job._alertPending) return;
    const lines = job._alertPending;
    let text = lines.join('\n');
    // 限制正则输入规模：既限内存也限灾难性回溯的最坏耗时
    if (text.length > MAX_ALERT_TEXT_CHARS) text = text.slice(0, MAX_ALERT_TEXT_CHARS);
    job._alertPending = [];
    // 本轮命中的全部关键字（按配置顺序，去重）；告警解除需所有关键字同时不再命中
    const hit = [];
    if (text) {
      for (const a of job.alerts) { if (a.re.test(text) && !hit.includes(a)) hit.push(a); }
    }
    const nowAlerting = hit.length > 0;
    const patternJoined = hit.map(h => h.pattern).join('、');
    // 状态翻转，或命中集合变化（多告警增/减）时更新状态与事件
    const changed = nowAlerting !== job.alerting || (nowAlerting && (!job.alertInfo || job.alertInfo.pattern !== patternJoined));
    if (changed) {
      // 匹配到的具体行内容（取首个命中行，供事件时间线 / 系统通知展示）
      let matchedText = '';
      if (nowAlerting) {
        for (const ln of lines) { for (const h of hit) { if (h.re.test(ln)) { matchedText = ln.trim().slice(0, 200); break; } } if (matchedText) break; }
      }
      job.alerting = nowAlerting;
      job.alertInfo = nowAlerting ? { pattern: patternJoined, note: hit.map(h => h.note).join('、'), at: Date.now(), matchedText, patterns: hit.map(h => h.pattern) } : null;
      this._logLine(job, nowAlerting ? '【告警】输出匹配关键字「' + patternJoined + '」' + (matchedText ? '：' + matchedText : '') : '【告警解除】输出不再匹配任何告警关键字');
      this.emit('alert', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, matched: nowAlerting, pattern: nowAlerting ? patternJoined : null, note: nowAlerting ? job.alertInfo.note : null, matchedText: nowAlerting ? matchedText : null, patterns: nowAlerting ? job.alertInfo.patterns : null });
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
    if (!job.enabled || !job.backup.enabled || gen !== job.gen || !this.backupStore) {
      job._bkResult = { saved: false, skipped: false, error: '任务未在运行' };
      return job._bkResult;
    }
    if (job.stopping || job.fatal) {
      job._bkResult = { saved: false, skipped: false, error: '任务已停止' };
      return job._bkResult;
    }
    // 复用监控会话必须在线；独立连接模式可自建会话（监控断线重连时也能立即备份）
    if (job.backup.mode !== 'own' && job.state !== 'monitoring') {
      job._bkResult = { saved: false, skipped: false, error: '监控会话未在线（当前：' + (job.statusText || job.state) + '）' };
      return job._bkResult;
    }
    if (job.backupRunning || job._cycleActive) {
      // 与命令循环撞车：等待其结束再执行（至多 40 秒），不让本轮被甩掉
      const t0 = Date.now();
      while ((job.backupRunning || job._cycleActive) && !job.stopping && !job.fatal) {
        if (Date.now() - t0 > 40000) {
          job._bkResult = { saved: false, skipped: false, error: '备份/命令循环持续进行中，已放弃本轮' };
          return job._bkResult;
        }
        await sleep(200);
      }
      if (job.stopping || job.fatal || gen !== job.gen) {
        job._bkResult = { saved: false, skipped: false, error: '任务已停止' };
        return job._bkResult;
      }
    }
    job._bkResult = null;
    job.backupRunning = true;
    job._cycleActive = true; // 备份期间暂停命令循环（独立连接模式同样占用该互斥位）
    try {
      if (job.backup.mode === 'own') await this._runBackupOwn(job, gen);
      else await this._runBackupShared(job, gen);
    } catch (err) {
      this._finishBackup(job, gen, { ok: false, error: String((err && err.message) || err) });
    } finally {
      job.backupRunning = false;
      job._cycleActive = false;
      if (job.enabled && !job.stopping && gen === job.gen) this._scheduleBackup(job);
    }
    return job._bkResult || { saved: false, skipped: false, error: '未产生备份结果' };
  }

  /** 备份方式 A：复用监控会话执行备份命令（输出经 _backupCap 捕获） */
  async _runBackupShared(job, gen) {
    this._rollLogIfNeeded(job);
    this._logCmd(job, job.backup.commands.join('；') + '（配置备份）');
    job._backupCap = { commands: job.backup.commands.slice(), lines: [], startedAt: Date.now() };
    const eol = job.protocol === 'telnet' ? '\r\n' : '\n';
    for (const cmd of job.backup.commands) {
      if (!job.enabled || job.stopping || gen !== job.gen || !job.sid) { job._backupCap = null; return; }
      try { this.shell.write(job.sid, cmd + eol); } catch (e) { job._backupCap = null; this._finishBackup(job, gen, { ok: false, error: '写入失败' }); return; }
      await sleep(job.backup.waitMs);
    }
    await sleep(300); // 尾部输出缓冲
    const cap = job._backupCap;
    job._backupCap = null;
    if (!job.enabled || job.stopping || gen !== job.gen || !cap) return;
    this._saveBackup(job, gen, cap.lines.join('\n'));
  }

  /** 备份方式 B：每次备份单独建立连接执行命令（不干扰监控会话，输出独立收集） */
  _runBackupOwn(job, gen) {
    return new Promise((resolve) => {
      const r = this.shell.connect({
        protocol: job.protocol, host: job.host, port: job.port,
        username: job.username, password: job.password,
        cols: 120, rows: 40, expectFp: job.expectFp || ''
      });
      if (!r.ok) { this._finishBackup(job, gen, { ok: false, error: r.error || '备份连接失败' }); resolve(); return; }
      const sid = r.id;
      let settled = false;
      const settle = (res) => { if (settled) return; settled = true; resolve(res); };
      const fail = (err) => { settle(); this._finishBackup(job, gen, { ok: false, error: err }); };
      // 独立会话指纹处理（与监控会话相同的信任语义）
      const onStatus = (sid2, info) => {
        if (sid2 !== sid) return;
        if (info.state === 'connected') {
          clearTimeout(connTimer);
          this.shell.removeListener('status', onStatus);
          settle();
          this._runBackupOwnCmds(job, gen, sid);
        } else if (info.state === 'fingerprint') {
          const host = job.host;
          const fp = String(info.fp || '');
          const known = this.trusted.get(host);
          if (known && known !== fp) { fail('备份连接：主机指纹变化，已拒绝连接'); return; }
          if (!known) {
            this.trusted.set(host, fp);
            this._saveTrust();
            this.emit('trust', { key: job.key, deviceId: job.deviceId, name: job.name, host, fp });
          }
          try { this.shell.trustFingerprint(host, true); } catch (e) { /* ignore */ }
        } else if (info.state === 'error') {
          this.shell.removeListener('status', onStatus);
          fail(info.text || '备份连接失败');
        }
      };
      this.shell.on('status', onStatus);
      // 连接超时保护（15s 未连上即失败）
      const connTimer = setTimeout(() => { this.shell.removeListener('status', onStatus); fail('备份连接超时'); }, 15000);
    });
  }

  /** 独立备份会话：写命令序列并收集输出（不进监控日志） */
  _runBackupOwnCmds(job, gen, sid) {
    const lines = [];
    const eol = job.protocol === 'telnet' ? '\r\n' : '\n';
    const onOut = (sid2, data) => {
      if (sid2 !== sid) return;
      let text = String(data || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b[()][0-9A-B]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      for (const ln of text.split('\n')) {
        const t = ln.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
        if (t) lines.push(t);
      }
    };
    this.shell.on('output', onOut);
    (async () => {
      for (const cmd of job.backup.commands) {
        if (!job.enabled || job.stopping || gen !== job.gen) break;
        try { this.shell.write(sid, cmd + eol); } catch (e) { /* ignore */ }
        await sleep(job.backup.waitMs);
      }
      await sleep(400); // 尾部输出缓冲
      this.shell.removeListener('output', onOut);
      try { this.shell.close(sid); } catch (e) { /* ignore */ }
      if (!job.enabled || job.stopping || gen !== job.gen) return;
      // 过滤命令回显（含提示符前缀整行）与提示符行：只保留命令执行后的输出内容
      this._saveBackup(job, gen, cleanBackupLines(lines, job.backup.commands).join('\n'));
    })();
  }

  /** 保存备份内容并广播结果（含 first 标记：首份不算“有变化”）
   *  可选「无变化不新增」（job.backup.skipIfSame）：与最近一份完全一致时跳过保存 */
  _saveBackup(job, gen, content) {
    if (!this.backupStore) return;
    if (!content.trim()) {
      job._bkResult = { saved: false, skipped: false, error: '命令无输出' };
      job.backupLast = { at: Date.now(), error: '无输出' };
      this._logLine(job, '配置备份：命令无输出，已跳过');
      return;
    }
    const deviceKey = job.name || job.deviceId;
    if (job.backup.skipIfSame) {
      const prevName = this.backupStore.latest(deviceKey, job.host);
      if (prevName) {
        const prev = this.backupStore.read(deviceKey, job.host, prevName);
        if (prev.ok && prev.content === content) {
          // 与上一份完全一致：不新增备份文件，仅刷新状态与广播
          job._bkResult = { saved: false, skipped: true, name: prevName };
          job.backupLast = { name: prevName, at: Date.now(), changed: false, same: true };
          this._logLine(job, '配置备份：与上次一致，未新增备份文件（' + prevName + '）');
          this.emit('backup', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, ok: true, skipped: true, changed: false, fileName: prevName, first: false });
          this._emit(job);
          return;
        }
      }
    }
    const r = this.backupStore.save(deviceKey, job.host, content);
    if (!r.ok) {
      job._bkResult = { saved: false, skipped: false, error: r.error };
      job.backupLast = { at: Date.now(), error: r.error };
      this._logLine(job, '配置备份失败：' + r.error);
      this.emit('backup', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, ok: false, error: r.error });
      return;
    }
    let diffInfo = null;
    if (r.prev) {
      const d = this.backupStore.diff(job.name || job.deviceId, job.host, r.prev, r.name);
      if (d.ok) diffInfo = { added: d.added, removed: d.removed, changed: d.changed };
    }
    const changed = diffInfo ? diffInfo.changed : true;
    job._bkResult = { saved: true, skipped: false, name: r.name, first: !!r.first, changed };
    job.backupLast = { name: r.name, at: Date.now(), changed, added: diffInfo ? diffInfo.added : null, removed: diffInfo ? diffInfo.removed : null, first: !!r.first };
    this._logLine(job, '配置备份已保存：' + r.name + '（' + content.split('\n').length + ' 行）' + (r.first ? '（首份）' : (diffInfo ? (changed ? '，与上次差异 +' + diffInfo.added + '/-' + diffInfo.removed + ' 行' : '，与上次一致') : '')));
    this.emit('backup', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, ok: true, fileName: r.name, first: !!r.first, prev: r.prev, changed, added: diffInfo ? diffInfo.added : null, removed: diffInfo ? diffInfo.removed : null });
  }
  /** 备份失败收尾（仅记录与广播；下次调度由 _runBackup 的 finally 负责） */
  _finishBackup(job, gen, res) {
    if (res && !res.ok) {
      job._bkResult = { saved: false, skipped: false, error: res.error };
      job.backupLast = { at: Date.now(), error: res.error };
      this._logLine(job, '配置备份失败：' + res.error);
      this.emit('backup', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, ok: false, error: res.error });
    }
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
      backup: job.backupLast ? { name: job.backupLast.name, at: job.backupLast.at, changed: !!job.backupLast.changed, first: !!job.backupLast.first, error: job.backupLast.error || null } : null
    });
  }
}

module.exports = { MonitorManager, sanitizeFilename, cleanBackupLines };

