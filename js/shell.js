/* NetTopo Web Shell —— SSH / Telnet 会话管理（主进程，纯 Node，不依赖 Electron）
 * 由 electron-main.js 通过 IPC 桥接给渲染层；也可在 Node 测试中直接使用。
 */
'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { Client } = require('ssh2');

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_NAWS = 31;

/** 单个会话审计日志文件大小上限（超出滚动新文件，防高输出会话占满磁盘） */
const SHELL_LOG_MAX_BYTES = 32 * 1024 * 1024;

/** 文件名/目录名安全化（与 monitor.js 同款）：白名单外字符替换 + 剔除穿越成分与首尾点号 */
function sanitizeLogName(s) {
  let out = String(s == null ? '' : s);
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  out = out.replace(/\.\./g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!out) out = 'unknown';
  // Windows 保留设备名（CON/NUL/COM1…）：判定看首个圆点前的词干（con.a.b 同样保留），
  // 写入会静默失败，前缀下划线规避（与 monitor.js/backup-store 口径一致）
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = '_' + out;
  if (out.length > 60) out = out.slice(0, 60);
  return out;
}
const p2 = (n) => String(n).padStart(2, '0');
function logStamp(d) {
  d = d || new Date();
  return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}
function logDateDir(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

/* ---------- SFTP 辅助 ---------- */
/** 远程路径白名单校验：非空、无 NUL、限长 4096（SFTP 服务端自带权限体系，本地只挡明显异常）。
 *  空串按当前目录（'.'）处理由调用方决定；返回规范化后的字符串或空串（表示无效）。 */
function cleanSftpRemotePath(p, allowEmpty) {
  let s = String(p == null ? '' : p);
  if (!s.trim() && allowEmpty) s = '.';
  if (!s || s.length > 4096 || s.indexOf('\0') >= 0) return '';
  return s;
}
/** 远程 POSIX 路径拼接（浏览面板导航 / 上传目标文件名用）：
 *  SFTP 服务端几乎都为 POSIX 路径语义（Windows OpenSSH 同样接受 /），统一按 / 拼接。 */
function sftpRemoteJoin(dir, name) {
  dir = String(dir == null ? '.' : dir).trim() || '.';
  name = String(name == null ? '' : name).trim().replace(/[\r\n\0]/g, '');
  if (!name || name === '.' || name === '..' || name.indexOf('/') >= 0) return '';
  if (dir === '.' || dir === '' || dir === '~') return name;
  return (dir.endsWith('/') ? dir : dir + '/') + name;
}
/** 字节数人性化（1 位小数 KB/MB/GB；B 原样） */
function fmtSftpSize(n) {
  if (!Number.isFinite(Number(n)) || n < 0) return '';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  for (const u of units) { v /= 1024; if (v < 1024 || u === 'TB') return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u; }
  return '';
}

/* ---------- 终端输出解码（编码可选：utf8 / gbk） ---------- */
/** 流式解码器：缓存跨包的多字节半字符。utf8 用 StringDecoder（零依赖）；
 *  gbk 用 TextDecoder（Node/Electron 均为全量 ICU，small-icu 环境不支持 gbk 时回落 utf8）。
 *  仅输出方向解码：输入（键入）方向统一 UTF-8 写入，老设备中文输入请用 ASCII 命令名。 */
function makeDecoder(encoding) {
  if (encoding === 'gbk') {
    try {
      const dec = new TextDecoder('gbk');
      return {
        encoding: 'gbk',
        write: (buf) => dec.decode(buf, { stream: true }),
        end: () => { try { return dec.decode(); } catch (e) { return ''; } }
      };
    } catch (e) { /* small-icu 构建：无 gbk 支持回落 utf8 */ }
  }
  const dec = new StringDecoder('utf8');
  return { encoding: 'utf8', write: (buf) => dec.write(buf), end: () => dec.end() };
}

class ShellManager extends EventEmitter {
  /** @param {object} [opts] opts.logDir：会话审计日志根目录（通常为 userData/monitor-logs，
   *  按天归档为 <logDir>/WebShell-<主机>/<日期>/<主机>_<端口>_<时间>.log，与监控日志共用浏览/搜索） */
  constructor(opts) {
    super();
    opts = opts || {};
    this.sessions = new Map();
    this._seq = 0;
    this._params = new Map(); // sid -> 建连参数副本（断线重连用；仅内存，不落盘）
    this._pendingVerify = new Map(); // host -> [{verify, ...}]（SSH 首次连接待确认指纹；同一主机可有多个会话排队）
    this.logDir = (typeof opts.logDir === 'string' && opts.logDir.trim()) ? opts.logDir.trim() : '';
  }

  /** 建立会话。opts: {protocol:'ssh'|'telnet', host, port, username, password, cols, rows}
   *  返回 {ok:true, id} 或 {ok:false, error}；连接过程异步，结果通过 status/end 事件上报。 */
  connect(opts) {
    opts = opts || {};
    const protocol = String(opts.protocol || 'ssh').toLowerCase();
    // host/username 会进审计日志头：剔除控制字符，防内嵌换行在日志中注入伪造的「会话开始/命令」行
    const cleanLog = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '');
    const host = cleanLog(opts.host).trim();
    if (!host) return { ok: false, error: '未填写主机地址' };
    let port = parseInt(opts.port, 10);
    if (!(port >= 1)) port = protocol === 'telnet' ? 23 : 22;
    if (!(port <= 65535)) port = protocol === 'telnet' ? 23 : 22; // 端口钳制，防异常大端口
    let tout = opts.timeout != null ? parseInt(opts.timeout, 10) : undefined;
    if (!(tout > 0)) tout = undefined; // NaN/0/负数回落默认：负数会让 setTimeout 同步抛错并留下尚未挂监听的 socket
    // SSH 跳板机（可选）：先连跳板，forwardOut 开直达目标端口通道后在其上完成目标 SSH 握手
    let jump = null;
    if (opts.jump && typeof opts.jump === 'object' && String(opts.jump.host || '').trim()) {
      let jPort = parseInt(opts.jump.port, 10);
      if (!(jPort > 0)) jPort = 22;
      if (!(jPort <= 65535)) jPort = 22;
      jump = {
        host: cleanLog(opts.jump.host).trim(),
        port: jPort,
        username: cleanLog(opts.jump.username).trim() || 'admin',
        password: String(opts.jump.password || '').slice(0, 1024),
        privateKey: typeof opts.jump.privateKey === 'string' ? opts.jump.privateKey.trim() : '',
        keyPassphrase: typeof opts.jump.keyPassphrase === 'string' ? opts.jump.keyPassphrase.slice(0, 1024) : ''
      };
    }
    const base = {
      host, port, protocol,
      // 会话归属：'ui'（Web Shell 窗口，断开后可用 reconnect 复用 sid）或 'monitor'（监控/备份，
      // 断开后总是全新 connect 重建）。closeAll('monitor') 借此只关 UI 会话，不误杀后台监控连接
      owner: opts.owner === 'monitor' ? 'monitor' : 'ui',
      username: cleanLog(opts.username).trim().slice(0, 128) || 'admin',
      password: String(opts.password || ''),
      cols: Math.max(parseInt(opts.cols, 10) || 80, 10),
      rows: Math.max(parseInt(opts.rows, 10) || 24, 5),
      timeout: tout,
      expectFp: String(opts.expectFp || '').trim(),
      // Telnet 明文登录自动应答（仅 _telnet 消费；后台监控场景无人工介入，必须自动过登录提示）
      autoLogin: !!opts.autoLogin,
      jump,
      // SSH 公钥认证（可选）：私钥内容 + 私钥口令；缺省仍走密码/keyboard-interactive
      privateKey: typeof opts.privateKey === 'string' ? opts.privateKey.trim() : '',
      keyPassphrase: typeof opts.keyPassphrase === 'string' ? opts.keyPassphrase.slice(0, 1024) : '',
      // 输出编码（utf8 | gbk）：老设备/中文环境常为 GBK，其余回落 utf8
      encoding: opts.encoding === 'gbk' ? 'gbk' : 'utf8'
    };
    let session;
    try {
      if (protocol === 'ssh') session = this._ssh(base);
      else if (protocol === 'telnet') session = this._telnet(base);
      else return { ok: false, error: '不支持的协议：' + protocol };
    } catch (err) {
      // 私钥解析失败等初始化异常转为常规失败，避免监控侧任务已登记却同步抛出成僵尸
      return { ok: false, error: '连接初始化失败：' + ((err && err.message) || err) };
    }

    const id = 's' + (++this._seq);
    this._params.set(id, base); // 保存建连参数：会话断开后原地重建（reconnect）用
    this._attach(id, base, session);
    return { ok: true, id };
  }

  /** 把会话 emitter 接入事件转发（output/status/end → 按 id 对外 emit），并注册到 sessions 表。
   *  connect 与 reconnect 共用：保证两路以同一 sid 对外发事件。 */
  _attach(id, base, session) {
    const slog = this.logDir ? this._openSessionLog(base) : null; // 会话审计日志（可选）
    session.on('output', (d) => {
      this._logSessionChunk(slog, d);
      this.emit('output', id, d);
    });
    session.on('status', (info) => this.emit('status', id, info));
    session.on('end', (reason) => {
      this._closeSessionLog(slog, reason);
      this.sessions.delete(id);
      // 监控侧断开后总是以全新 connect() 重建（不复用 sid），参数副本随会话结束即清，
      // 防 7×24 重连循环下凭据副本在 _params 无界累积；UI 会话保留参数供「重新连接」
      if (base.owner === 'monitor') this._params.delete(id);
      this.emit('end', id, reason);
    });
    this.sessions.set(id, session);
  }

  /** 会话断开后用保存的建连参数原地重建（复用同一 sid）。返回 {ok:true, id} 或 {ok:false, error}。
   *  仅供 Web Shell 窗口「重新连接」使用；SSH TOFU/认证与首次建连走同一会话逻辑。 */
  reconnect(id) {
    const base = typeof id === 'string' ? this._params.get(id) : null;
    if (!base) return { ok: false, error: '会话参数不存在，无法重连' };
    // 旧会话尚未 end（如还卡在指纹确认/连接超时窗口）时禁止原地重建：
    // 同 sid 双会话会让旧会话的收尾逻辑误删新会话并向前端误报结束
    if (this.sessions.has(id)) return { ok: false, error: '会话仍在进行中，请稍候再试' };
    let session;
    try {
      session = base.protocol === 'ssh' ? this._ssh(base) : this._telnet(base);
    } catch (err) {
      return { ok: false, error: '重连初始化失败：' + ((err && err.message) || err) };
    }
    this._attach(id, base, session); // 同 sid 重建：前端终端闭包/监听全部复用，无需重新挂接
    return { ok: true, id };
  }

  /* ---------- 会话审计日志（<logDir>/WebShell-<主机>/<日期>/<主机>_<端口>_<时间>.log） ---------- */
  /** 创建审计日志写流。必须同步挂 error 监听：WriteStream 的失败（磁盘满/文件被锁）
   *  走异步 error 事件，无监听器时 EventEmitter 直接抛出并崩掉整个主进程。 */
  _makeLogStream(rec, dateDir, fname) {
    const stream = fs.createWriteStream(path.join(dateDir, fname), { flags: 'a' });
    stream.on('error', () => {
      try { stream.destroy(); } catch (e) { /* ignore */ }
      if (rec.stream === stream) rec.stream = null; // 静默降级：后续日志跳过，不影响会话本身
    });
    return stream;
  }
  _openSessionLog(base) {
    try {
      const hostSan = sanitizeLogName(base.host);
      const dateDir = path.join(this.logDir, 'WebShell-' + hostSan, logDateDir());
      fs.mkdirSync(dateDir, { recursive: true });
      let fname = hostSan + '_' + base.port + '_' + logStamp() + '.log';
      let seq = 0;
      while (fs.existsSync(path.join(dateDir, fname))) { seq++; fname = hostSan + '_' + base.port + '_' + logStamp() + '_' + seq + '.log'; }
      const rec = { stream: null, hostSan, port: base.port, bytes: 0, seq: 0,
        // 凭据掩码：恶意服务端可在认证后回显密码，原样留痕会把凭据写进日志文件——写前打码
        masks: [base.password, base.keyPassphrase, base.jump && base.jump.password]
          .filter(s => typeof s === 'string' && s.length >= 3) };
      rec.stream = this._makeLogStream(rec, dateDir, fname);
      rec.stream.write('[' + logStamp() + '] ===== 会话开始 ' + String(base.protocol).toUpperCase() + ' ' + base.host + ':' + base.port + ' 用户名: ' + base.username + ' =====\r\n');
      return rec;
    } catch (e) { return null; } // 日志失败不影响会话
  }
  _logSessionChunk(rec, data) {
    if (!rec || !rec.stream) return;
    try {
      // 单文件超限：结束当前文件，滚动带序号的新文件（文件名仍兼容日志浏览器白名单）
      if (rec.stream.bytesWritten > SHELL_LOG_MAX_BYTES) {
        rec.seq++;
        const dirName = 'WebShell-' + rec.hostSan; // hostSan 已过 sanitizeLogName 白名单
        const dateDir = this.logDir + path.sep + dirName + path.sep + logDateDir();
        // 边界终判：纵深兜底滚动目录仍在审计日志库内
        if (!dateDir.startsWith(path.resolve(this.logDir) + path.sep)) return;
        fs.mkdirSync(dateDir, { recursive: true });
        const fname = rec.hostSan + '_' + rec.port + '_' + logStamp() + '_' + rec.seq + '.log';
        rec.stream.end();
        rec.stream = this._makeLogStream(rec, dateDir, fname);
      }
      let out = data;
      if (typeof out === 'string' && rec.masks && rec.masks.length) {
        for (const p of rec.masks) { if (out.indexOf(p) >= 0) out = out.split(p).join('******'); }
      }
      rec.stream.write(typeof out === 'string' ? out : Buffer.from(out)); // 原样留痕（设备回显即含用户命令）
    } catch (e) { try { rec.stream = null; } catch (e2) { /* ignore */ } }
  }
  _closeSessionLog(rec, reason) {
    if (!rec || !rec.stream) return;
    try { rec.stream.end('[' + logStamp() + '] ===== 会话结束' + (reason ? '：' + String(reason).slice(0, 200) : '') + ' =====\r\n'); } catch (e) { /* ignore */ }
    rec.stream = null;
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s) s.write(data);
  }
  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s) return;
    // 上限钳制 65535：防止 16 位编码回绕出无意义尺寸
    s.resize(Math.min(Math.max(parseInt(cols, 10) || 80, 10), 65535),
             Math.min(Math.max(parseInt(rows, 10) || 24, 5), 65535));
  }
  close(id) {
    const s = this.sessions.get(id);
    if (s) { s._close(); this.sessions.delete(id); }
    this._params.delete(id); // 用户显式关闭标签：参数随之清掉，内存不留凭据副本
  }
  /** 关闭会话。exceptOwner 提供时跳过该归属的会话（如 Web Shell 窗口关闭时
   *  closeAll('monitor') 只收 UI 会话，后台监控连接不受牵连）。 */
  closeAll(exceptOwner) {
    for (const id of [...this.sessions.keys()]) {
      if (exceptOwner) {
        const base = this._params.get(id);
        if (base && base.owner === exceptOwner) continue;
      }
      this.close(id);
    }
    // 已断开的 UI 会话不在 sessions 里（end 即移除），close 走不到——但其建连参数（含明文
    // 密码）仍在 _params 滞留供「重新连接」；窗口关闭后前端已不可能再触发重连，一并清掉，
    // 否则用户反复开关窗口会累积不可达的凭据副本（与 close() 的「内存不留凭据」语义对齐）
    if (exceptOwner) {
      for (const id of [...this._params.keys()]) {
        const base = this._params.get(id);
        if (base && base.owner === exceptOwner) continue;
        this._params.delete(id);
      }
    }
  }

  /** SSH 首次连接指纹确认：用户信任后放行该主机的全部待确认握手（TOFU）。
   *  onlyOwner 提供时仅放行/拒绝该归属的握手，其余保持排队：后台（monitor/一次性采集）
   *  的自动信任不得绕过 UI 会话正在等待的人工确认（用户还没点「信任」连接已建立、
   *  点「取消」已无效果），反向的用户拒绝也不误杀后台采集 */
  trustFingerprint(host, trust, onlyOwner) {
    const arr = this._pendingVerify.get(host);
    if (!arr || !arr.length) return false;
    if (onlyOwner) {
      let hit = false;
      const rest = arr.filter((rec) => {
        if (rec && rec.owner === onlyOwner) { hit = true; try { rec.verify(!!trust); } catch (e) { /* ignore */ } return false; }
        return true;
      });
      if (rest.length) this._pendingVerify.set(host, rest);
      else this._pendingVerify.delete(host);
      return hit;
    }
    this._pendingVerify.delete(host);
    for (const rec of arr) { try { rec.verify(!!trust); } catch (e) { /* ignore */ } }
    return true;
  }

  /* ---------- 一次性命令执行（采集邻居表 / MAC·ARP 定位等无人值守单次采集） ---------- */
  /** 独立建立会话（SSH/Telnet），等命令行就绪后逐条下发命令并按命令分窗收集输出，完成后关闭会话。
   *  复用监控独立备份的成熟状态机（就绪判据/输出组包/凭据打码），另加：
   *  - 「---- More ----」分页提示自动补空格翻页（未关分页的设备输出不被截断）；
   *  - 首次连接指纹自动信任（TOFU，与监控同语义），事件携带指纹供渲染层记录；
   *  opts: {protocol, host, port, username, password, privateKey, keyPassphrase, jump, encoding,
   *         commands:[cmd,...], waitMs(命令输出最短等待,默认1200), cmdTimeoutMs(单命令上限,默认10000),
   *         expectFp(已知指纹则严格比对), readyTimeoutMs}
   *  返回 Promise<{ok, outputs:[{cmd,text}], fingerprint:{host,fp}|null, error, errors:[]}> */
  runOneShot(opts) {
    return new Promise((resolve) => {
      opts = opts || {};
      const cleanLog = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '');
      const protocol = String(opts.protocol || 'ssh').toLowerCase() === 'telnet' ? 'telnet' : 'ssh';
      const host = cleanLog(opts.host).trim();
      if (!host) { resolve({ ok: false, outputs: [], fingerprint: null, error: '未填写主机地址', errors: [] }); return; }
      let port = parseInt(opts.port, 10);
      if (!(port >= 1 && port <= 65535)) port = protocol === 'telnet' ? 23 : 22;
      // 命令白名单校验：含控制字符（防换行注入拆分/伪造命令）或超长的整批拒绝，空白行跳过
      const commands = [];
      let cmdInvalid = false;
      for (const c of (Array.isArray(opts.commands) ? opts.commands : [])) {
        const raw = String(c == null ? '' : c);
        if (/[\u0000-\u001f\u007f]/.test(raw) || raw.length > 256) { cmdInvalid = true; break; }
        const t = raw.trim();
        if (!t) continue;
        if (commands.length >= 16) break;
        commands.push(t);
      }
      if (cmdInvalid) { resolve({ ok: false, outputs: [], fingerprint: null, error: '命令包含控制字符或超过 256 字符，已拒绝执行', errors: [] }); return; }
      if (!commands.length) { resolve({ ok: false, outputs: [], fingerprint: null, error: '未提供要执行的命令', errors: [] }); return; }
      const clamp = (v, lo, hi, d) => { const n = parseInt(v, 10); return (n >= lo && n <= hi) ? n : d; };
      const waitMs = clamp(opts.waitMs, 200, 20000, 1200);
      const cmdTimeoutMs = clamp(opts.cmdTimeoutMs, 1000, 60000, 10000);
      const readyTimeoutMs = clamp(opts.readyTimeoutMs, 3000, 60000, 15000);
      const overallMs = readyTimeoutMs + commands.length * (cmdTimeoutMs + waitMs) + 15000;

      const r = this.connect({
        protocol, host, port,
        username: cleanLog(opts.username).trim().slice(0, 128) || 'admin',
        password: String(opts.password || ''),
        privateKey: typeof opts.privateKey === 'string' ? opts.privateKey.trim() : '',
        keyPassphrase: typeof opts.keyPassphrase === 'string' ? opts.keyPassphrase.slice(0, 1024) : '',
        jump: opts.jump && typeof opts.jump === 'object' ? opts.jump : null,
        cols: 200, rows: 50, // 宽终端：减少设备输出折行（表格解析更稳）
        autoLogin: protocol === 'telnet',
        encoding: opts.encoding === 'gbk' ? 'gbk' : 'utf8',
        expectFp: String(opts.expectFp || '').trim(),
        owner: 'monitor' // 后台采集语义：Web Shell 窗口关闭的 closeAll('monitor') 不误杀；结束后参数副本自动清理
      });
      if (!r.ok) { resolve({ ok: false, outputs: [], fingerprint: null, error: r.error || '连接失败', errors: [] }); return; }
      const sid = r.id;
      const sleep = (ms) => new Promise(x => setTimeout(x, ms));
      const eol = protocol === 'telnet' ? '\r\n' : '\n';
      // 就绪/提示符判据（与 monitor.js PROMPT_RE 同形态，不锚定行尾：首包提示符常与协商残渣粘连）
      const PROMPT_RE = /^[A-Za-z0-9_.\-\[\]()/:<> +]{0,80}[>#\]]/;
      const MORE_RE = /--+\s*more\s*--+\s*$/i;

      let settled = false;
      let curCap = null;          // 当前命令捕获窗 {lines:[], chars:0}
      let lineBuf = '';
      let promptSeen = false;     // 连接以来是否出现过命令提示符（就绪判据）
      let connectedOnce = false;
      let lastMoreAt = 0;
      const fpOut = { v: null };  // 首连指纹（TOFU 自动信任后回传渲染层记录）
      const errors = [];

      const finish = (ok, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        this.removeListener('output', onOutput);
        this.removeListener('status', onStatus);
        this.removeListener('end', onEnd);
        try { this.close(sid); } catch (e) { /* ignore */ }
        resolve({ ok: !!ok, outputs, fingerprint: fpOut.v, error: error || null, errors });
      };
      const overallTimer = setTimeout(() => {
        // 超时收尾：已收集的输出照常返回（ok=false 标注），供界面展示部分结果
        finish(false, '采集超时（部分输出已保留）');
      }, overallMs);

      /** 分页提示自动翻页：输出尾部（含未换行的半行）命中 More 即补发一个空格。节流 150ms。 */
      const maybeMore = () => {
        const now = Date.now();
        if (now - lastMoreAt < 150) return;
        const tail = (lineBuf || '').trimEnd();
        if (MORE_RE.test(tail)) { lastMoreAt = now; try { this.write(sid, ' '); } catch (e) { /* ignore */ } }
      };
      const onOutput = (sid2, data) => {
        if (sid2 !== sid) return;
        let text = String(data || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b[()][0-9A-B]/g, '');
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        lineBuf += text;
        const parts = lineBuf.split('\n');
        lineBuf = parts.pop(); // 半行留缓冲（More 提示/提示符常不带换行）
        for (const ln of parts) {
          const t = ln.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
          if (!t) continue;
          if (!promptSeen && PROMPT_RE.test(t.trim())) promptSeen = true;
          if (curCap && curCap.chars + t.length + 1 <= 1024 * 1024) { curCap.lines.push(t); curCap.chars += t.length + 1; }
        }
        maybeMore();
      };
      const onStatus = (sid2, info) => {
        if (sid2 !== sid || !info) return;
        if (info.state === 'connected') {
          connectedOnce = true;
        } else if (info.state === 'fingerprint') {
          // 无人值守采集的指纹语义与监控一致：首次连接自动信任（TOFU），变化拒绝由渲染层传入 expectFp 严格比对
          const fh = String((info && info.host) || host);
          fpOut.v = { host: fh, fp: String(info.fp || '') };
          try { this.trustFingerprint(fh, true, 'monitor'); } catch (e) { /* ignore */ }
        } else if (info.state === 'error') {
          if (!connectedOnce) { finish(false, info.text || '连接失败'); return; }
          errors.push(String(info.text || '会话错误'));
        }
      };
      const onEnd = (sid2, reason) => {
        if (sid2 !== sid) return;
        finish(false, '连接已断开：' + String(reason || '').slice(0, 120) + (outputs.length ? '（部分输出已保留）' : ''));
      };
      this.on('output', onOutput);
      this.on('status', onStatus);
      this.on('end', onEnd);

      const outputs = [];
      const waitReady = async () => {
        // 空行探测提示符（Telnet 自动登录中跳过：空行落在 Username:/Password: 上会引发提示重印）
        if (!(protocol === 'telnet' && String(opts.password || ''))) { try { this.write(sid, '\r\n'); } catch (e) { /* ignore */ } }
        const t0 = Date.now();
        while (!settled && (Date.now() - t0) < readyTimeoutMs) {
          if (promptSeen) return true;
          const tail = (lineBuf || '').trim();
          if (tail && PROMPT_RE.test(tail)) { promptSeen = true; return true; }
          await sleep(150);
        }
        return !!promptSeen; // 超时兜底：照常执行（等价监控的既有行为），命令可能被吞但输出窗口仍会等待
      };
      /** 等待当前命令完成：输出静默 ≥350ms 且半行残留为提示符形态（提示符重现 = 命令执行完毕）；
       *  输出彻底静默 ≥3s 也推进（个别设备提示符形态特殊，兜底防单命令拖满超时）；期间处理 More 翻页 */
      const waitCmdDone = async () => {
        const t0 = Date.now();
        let lastLen = -1, quietMs = 0;
        while (!settled && (Date.now() - t0) < cmdTimeoutMs) {
          maybeMore();
          const len = curCap ? curCap.lines.length : 0;
          quietMs = (len === lastLen) ? quietMs + 100 : 0;
          lastLen = len;
          const tail = (lineBuf || '').trimEnd();
          if (quietMs >= 350 && tail && PROMPT_RE.test(tail)) break;
          if (quietMs >= 3000) break;
          await sleep(100);
        }
      };

      (async () => {
        const ready = await waitReady();
        if (!ready) errors.push('未识别到命令提示符（会话可能未就绪），已按超时继续');
        // 首条命令前的输出（登录横幅/提示符回显）不属于命令输出：丢弃
        lineBuf = '';
        for (const cmd of commands) {
          if (settled) break;
          curCap = { lines: [], chars: 0 };
          try { this.write(sid, cmd + eol); } catch (e) { errors.push('命令写入失败：' + cmd); curCap = null; outputs.push({ cmd, text: '' }); continue; }
          await sleep(Math.min(waitMs, 800)); // 最短输出等待（慢设备首包）
          await waitCmdDone();
          await sleep(150); // 尾部缓冲
          // 半行残留冲进本命令窗口（末行无换行/收尾提示符）
          const tail = (lineBuf || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
          if (tail.trim()) { curCap.lines.push(tail); curCap.chars += tail.length + 1; }
          lineBuf = '';
          // 剥命令回显：首行「提示符+命令」或命令本身
          const lines = curCap.lines;
          if (lines.length && (lines[0].trim() === cmd || lines[0].trim().endsWith(cmd))) lines.shift();
          outputs.push({ cmd, text: lines.join('\n') });
        }
        finish(true, null);
      })().catch((e) => finish(false, '采集异常：' + String((e && e.message) || e)));
    });
  }

  /* ---------- SFTP（复用已建立的 SSH 会话，同连接按需开 SFTP 通道；Telnet 会话不支持） ---------- */
  /** 取会话的 SFTP 通道。每次操作新开一条通道（open 延迟约 1 个 RTT，可接受），
   *  不做通道缓存：会话关闭/重连时无失效状态需要追踪，实现更简单可靠。 */
  _sftpOf(id) {
    const s = this.sessions.get(String(id || ''));
    if (!s) return Promise.reject(new Error('会话不存在或已断开'));
    const client = s._client;
    if (!client || typeof client.sftp !== 'function') {
      return Promise.reject(new Error('该会话不支持 SFTP（仅 SSH 会话可用，Telnet 无文件通道）'));
    }
    return new Promise((resolve, reject) => {
      try {
        client.sftp((err, ch) => {
          if (err) reject(new Error('SFTP 通道打开失败：' + (err && err.message || err)));
          else resolve(ch);
        });
      } catch (e) { reject(new Error('SFTP 通道打开失败：' + ((e && e.message) || e))); }
    });
  }
  /** 目录列表：{ok, path(规范绝对路径), items:[{name, dir, size, mtime}], error} */
  async sftpList(id, dirPath) {
    const p = cleanSftpRemotePath(dirPath, true);
    if (!p) return { ok: false, error: '远程路径无效' };
    let sftp = null;
    try {
      sftp = await this._sftpOf(id);
      const resolved = await new Promise((resolve, reject) => {
        sftp.realpath(p, (err, rp) => { try { err ? reject(err) : resolve(String(rp || p)); } catch (e) { reject(e); } });
      });
      const list = await new Promise((resolve, reject) => {
        sftp.readdir(resolved, (err, list) => { try { err ? reject(err) : resolve(list || []); } catch (e) { reject(e); } });
      });
      const items = list.map((it) => {
        const a = it.attrs || {};
        const isDir = typeof a.isDirectory === 'function' && a.isDirectory();
        const isLink = typeof a.isSymbolicLink === 'function' && a.isSymbolicLink();
        return {
          name: String(it.filename || ''),
          dir: isDir || isLink, // 符号链接按可进入处理（指向文件时由服务端报错兜底）
          size: Number.isFinite(a.size) ? a.size : null,
          mtime: Number.isFinite(a.mtime) ? a.mtime * 1000 : null
        };
      }).filter(it => it.name && it.name !== '.');
      // 目录在前、隐藏文件其次、名称不分大小写排序（与常见文件管理器口径一致）
      items.sort((a, b) => (a.dir !== b.dir) ? (a.dir ? -1 : 1)
        : (a.name.startsWith('.') !== b.name.startsWith('.')) ? (a.name.startsWith('.') ? -1 : 1)
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      return { ok: true, path: resolved, items };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (sftp) { try { sftp.end(); } catch (e) { /* ignore */ } }
    }
  }
  async sftpMkdir(id, dirPath) {
    const p = cleanSftpRemotePath(dirPath, false);
    if (!p) return { ok: false, error: '目录名无效' };
    let sftp = null;
    try {
      sftp = await this._sftpOf(id);
      await new Promise((resolve, reject) => { sftp.mkdir(p, (err) => { try { err ? reject(err) : resolve(); } catch (e) { reject(e); } }); });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (sftp) { try { sftp.end(); } catch (e) { /* ignore */ } }
    }
  }
  /** 删除远程文件或空目录（isDir=true 走 rmdir；目录需先清空，防一键误删整树） */
  async sftpRemove(id, targetPath, isDir) {
    const p = cleanSftpRemotePath(targetPath, false);
    if (!p) return { ok: false, error: '远程路径无效' };
    let sftp = null;
    try {
      sftp = await this._sftpOf(id);
      await new Promise((resolve, reject) => {
        const done = (err) => { try { err ? reject(err) : resolve(); } catch (e) { reject(e); } };
        if (isDir) sftp.rmdir(p, done); else sftp.unlink(p, done);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (sftp) { try { sftp.end(); } catch (e) { /* ignore */ } }
    }
  }
  async sftpRename(id, fromPath, toPath) {
    const from = cleanSftpRemotePath(fromPath, false);
    const to = cleanSftpRemotePath(toPath, false);
    if (!from || !to) return { ok: false, error: '远程路径无效' };
    if (from === to) return { ok: false, error: '新路径与原路径相同' };
    let sftp = null;
    try {
      sftp = await this._sftpOf(id);
      await new Promise((resolve, reject) => { sftp.rename(from, to, (err) => { try { err ? reject(err) : resolve(); } catch (e) { reject(e); } }); });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (sftp) { try { sftp.end(); } catch (e) { /* ignore */ } }
    }
  }
  /** 下载远程文件到本地路径（localPath 由主进程「另存为」对话框产生，渲染层不传本地路径）。
   *  onProgress(info: {op:'download', id, name, transferred, total}) 节流 400ms 回调。 */
  async sftpDownload(id, remotePath, localPath, onProgress) {
    const p = cleanSftpRemotePath(remotePath, false);
    if (!p) return { ok: false, error: '远程路径无效' };
    const local = String(localPath == null ? '' : localPath).trim();
    if (!local) return { ok: false, error: '本地保存路径无效' };
    let sftp = null;
    // 先写 .part 临时文件再 rename 覆盖：用户在另存为对话框选择覆盖既有文件时，下载中途
    // 失败不得删掉原文件（系统覆盖确认的语义是「成功后才替换」，直接 unlink 会把原文件一并毁掉）
    const part = local + '.nettopo.part';
    try {
      sftp = await this._sftpOf(id);
      const total = await new Promise((resolve) => {
        sftp.stat(p, (err, st) => { try { resolve((!err && st && Number.isFinite(st.size)) ? st.size : null); } catch (e) { resolve(null); } });
      });
      await new Promise((resolve, reject) => {
        let lastEmit = 0;
        sftp.fastGet(p, part, {
          step: (transferred) => {
            if (typeof onProgress !== 'function') return;
            const now = Date.now();
            if (now - lastEmit < 400) return;
            lastEmit = now;
            try { onProgress({ op: 'download', id: String(id), name: p, transferred: transferred, total }); } catch (e) { /* ignore */ }
          }
        }, (err) => { try { err ? reject(err) : resolve(); } catch (e) { reject(e); } });
      });
      fs.renameSync(part, local);
      if (typeof onProgress === 'function') { try { onProgress({ op: 'download', id: String(id), name: p, transferred: total, total }); } catch (e) { /* ignore */ } }
      return { ok: true, path: local, size: total };
    } catch (e) {
      // 失败时只清理 .part 半成品，用户选择覆盖的本地原文件保持原样
      try { fs.unlinkSync(part); } catch (e2) { /* ignore */ }
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (sftp) { try { sftp.end(); } catch (e) { /* ignore */ } }
    }
  }
  /** 上传本地文件到远程路径（localPath 由主进程「打开文件」对话框产生） */
  async sftpUpload(id, localPath, remotePath, onProgress) {
    const local = String(localPath == null ? '' : localPath).trim();
    const p = cleanSftpRemotePath(remotePath, false);
    if (!local) return { ok: false, error: '本地文件路径无效' };
    if (!p) return { ok: false, error: '远程路径无效' };
    let sftp = null;
    try {
      let localSize = null;
      try { localSize = fs.statSync(local).size; } catch (e) { return { ok: false, error: '本地文件不可读' }; }
      sftp = await this._sftpOf(id);
      await new Promise((resolve, reject) => {
        let lastEmit = 0;
        sftp.fastPut(local, p, {
          step: (transferred) => {
            if (typeof onProgress !== 'function') return;
            const now = Date.now();
            if (now - lastEmit < 400) return;
            lastEmit = now;
            try { onProgress({ op: 'upload', id: String(id), name: p, transferred, total: localSize }); } catch (e) { /* ignore */ }
          }
        }, (err) => { try { err ? reject(err) : resolve(); } catch (e) { reject(e); } });
      });
      if (typeof onProgress === 'function') { try { onProgress({ op: 'upload', id: String(id), name: p, transferred: localSize, total: localSize }); } catch (e) { /* ignore */ } }
      return { ok: true, path: p, size: localSize };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (sftp) { try { sftp.end(); } catch (e) { /* ignore */ } }
    }
  }

  /* ---------- SSH（ssh2） ---------- */
  _ssh(o) {
    const em = new EventEmitter();
    const decoder = makeDecoder(o.encoding); // 缓存跨包多字节半字符（gbk 会话按 gbk 解码）
    const client = new Client();
    let stream = null;
    let closed = false;
    const recOwner = o.owner === 'monitor' ? 'monitor' : 'ui';
    const pendingRec = { verify: null, owner: recOwner }; // 目标主机的指纹确认记录（结束时只移除自己的，不影响同主机其它会话）
    const jumpRec = { verify: null, owner: recOwner };    // 跳板主机的指纹确认记录（独立排队）
    let jumpClient = null;
    let targetStarted = false; // 跳板通道建立后置位：此后跳板断开由目标会话收尾，避免双重 end
    const removeFromPending = (host, rec) => {
      const arr = this._pendingVerify.get(host);
      if (arr) {
        const i = arr.indexOf(rec);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) this._pendingVerify.delete(host);
      }
    };
    const finish = (reason) => {
      if (closed) return;
      closed = true;
      removeFromPending(o.host, pendingRec); // 会话结束即移除本会话的指纹等待
      if (o.jump && o.jump.host) removeFromPending(o.jump.host, jumpRec);
      try { if (stream && !stream.destroyed) stream.end(); } catch (e) { /* ignore */ }
      try { client.end(); } catch (e) { /* ignore */ }
      try { if (jumpClient) jumpClient.end(); } catch (e) { /* ignore */ }
      try { const rest = decoder.end(); if (rest) em.emit('output', rest); } catch (e) { /* ignore */ } // 冲洗残留半字符
      em.emit('end', reason || '连接已关闭');
    };

    client.on('ready', () => {
      em.emit('status', { state: 'connected', text: `已连接 ${o.host}:${o.port}（SSH）` });
      client.shell({ term: 'xterm-256color', cols: o.cols, rows: o.rows }, (err, s) => {
        if (err) { finish('无法打开远程 Shell：' + err.message); return; }
        stream = s;
        s.on('data', (d) => em.emit('output', decoder.write(d)));
        s.on('close', () => finish('连接已关闭'));
        s.on('error', (e) => em.emit('status', { state: 'error', text: e.message }));
      });
    });
    // keyboard-interactive 应答（RFC 4256 数量契约）：密码只回填到首个「口令类」提示，其余位与后续轮次空串
    const makeKi = (pwd) => {
      let n = 0;
      return (name, instructions, lang, prompts, respond) => {
        n++;
        if (n > 4) { finish('keyboard-interactive 认证轮次过多，已中止'); return; }
        let used = false;
        respond(prompts.map((p) => {
          const t = String((p && p.prompt) || '');
          // 无文案的单提示兼容旧行为（部分设备不下发提示文本但期待密码），其余非口令位一律空
          const secretish = /pass\s?(word|code)|口令|密码/i.test(t)
            || (!t && !used && prompts.length === 1);
          if (!used && secretish) { used = true; return pwd; }
          return '';
        }));
      };
    };
    // 主机密钥校验（TOFU）：目标与跳板各自独立排队确认；带 expectFp 的端（目标或跳板）严格比对
    const makeVerifier = (host, port, rec, expectFp) => (key, verify) => {
      try {
        const hex = String(key).toLowerCase();
        // ssh2 传入的是 SHA256 的 hex 摘要，转成 OpenSSH 标准 SHA256:<base64> 格式，便于与 ssh-keygen 输出核对
        const fp = 'SHA256:' + Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
        if (expectFp) {
          if (expectFp !== fp) {
            em.emit('status', { state: 'error', text: (host === o.host ? '主机' : '跳板') + '密钥指纹不匹配：' + fp + '（期望 ' + expectFp + '），可能存在中间人攻击' });
            return false;
          }
          em.emit('status', { state: 'info', host, fp, text: '主机密钥指纹: ' + fp });
          return true;
        }
        // 首次连接：暂停握手，等用户/监控确认信任该指纹（同主机多会话各自排队）
        rec.verify = verify;
        const arr = this._pendingVerify.get(host);
        if (arr) arr.push(rec);
        else this._pendingVerify.set(host, [rec]);
        em.emit('status', { state: 'fingerprint', host, port, fp, text: '首次连接，请核对主机指纹: ' + fp });
        return undefined; // 异步确认，不立即 verify
      } catch (e) {
        return false;
      }
    };
    client.on('keyboard-interactive', makeKi(o.password));
    client.on('error', (err) => {
      em.emit('status', { state: 'error', text: err.message });
      finish('连接失败：' + err.message);
    });
    client.on('close', () => finish('连接已关闭'));

    const cfg = {
      host: o.host,
      port: o.port,
      username: o.username,
      readyTimeout: 12000,
      // 周期 keepalive 探活：NAT/防火墙静默掐断空闲 TCP 后本地 socket 仍是 ESTABLISHED，
      // 无探活时命令写进黑洞要等内核级重传超时（十几分钟）才报错，监控/备份长时间假死
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      hostHash: 'sha256',
      hostVerifier: makeVerifier(o.host, o.port, pendingRec, o.expectFp || '')
    };
    if (o.privateKey) {
      cfg.privateKey = o.privateKey;
      if (o.keyPassphrase) cfg.passphrase = o.keyPassphrase; // 私钥口令错误时 ssh2 报 decrypt 错误走 error 状态
    }
    if (o.password) { cfg.password = o.password; cfg.tryKeyboard = true; }

    if (o.jump && o.jump.host) {
      // 跳板：先与跳板机建立 SSH（独立指纹确认），ready 后 forwardOut 开「目标:端口」直达通道，
      // 目标 Client 以该通道为 sock 完成真正的目标握手与会话
      jumpClient = new Client();
      jumpClient.on('keyboard-interactive', makeKi(o.jump.password));
      jumpClient.on('error', (err) => {
        em.emit('status', { state: 'error', text: '跳板：' + err.message });
        finish('跳板连接失败：' + err.message);
      });
      jumpClient.on('close', () => { if (!targetStarted) finish('跳板连接已关闭'); });
      jumpClient.on('ready', () => {
        jumpClient.forwardOut('127.0.0.1', 0, o.host, o.port, (err, chan) => {
          if (err) { finish('无法建立跳板通道：' + err.message); return; }
          targetStarted = true;
          cfg.sock = chan;
          client.connect(cfg);
        });
      });
      const jumpCfg = {
        host: o.jump.host,
        port: o.jump.port || 22,
        username: o.jump.username || o.username,
        readyTimeout: 12000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        hostHash: 'sha256',
        hostVerifier: makeVerifier(o.jump.host, o.jump.port || 22, jumpRec, o.jump.expectFp || '')
      };
      if (o.jump.privateKey) {
        jumpCfg.privateKey = o.jump.privateKey;
        if (o.jump.keyPassphrase) jumpCfg.passphrase = o.jump.keyPassphrase;
      }
      if (o.jump.password) { jumpCfg.password = o.jump.password; jumpCfg.tryKeyboard = true; }
      jumpClient.connect(jumpCfg);
    } else {
      client.connect(cfg);
    }

    em.write = (data) => { if (stream && !closed) stream.write(data); };
    // 回写 o.cols/o.rows（与 _telnet 同口径）：reconnect 按首次 connect 的 base 尺寸开新 shell 通道，
    // 不回写则重连后 pty 停留在最初的 80x24，与本地 xterm 尺寸错位（折行错乱、全屏程序花屏）
    em.resize = (cols, rows) => { o.cols = cols; o.rows = rows; if (stream && !closed) stream.setWindow(rows, cols); };
    em._close = () => finish('closed');
    em._client = client; // SFTP 复用同一 SSH 连接按需开通道（会话关闭时随 client.end() 一并失效）
    return em;
  }

  /* ---------- Telnet（RFC854 + NAWS） ---------- */
  _telnet(o) {
    const em = new EventEmitter();
    const sock = net.createConnection({ host: o.host, port: o.port });
    const decoder = makeDecoder(o.encoding); // 处理跨包的多字节（gbk 会话按 gbk 解码）
    let buf = Buffer.alloc(0);
    let closed = false;
    // 连接超时（默认 12s，测试可传 opts.timeout 缩短）；连接建立后关闭空闲超时
    sock.setTimeout(o.timeout || 12000);
    const send = (b) => { if (!sock.destroyed) sock.write(b); };
    const finish = (reason) => {
      if (loginTimer) { clearTimeout(loginTimer); loginTimer = null; }
      if (closed) return;
      closed = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      try { decoder.end(); } catch (e) { /* ignore */ }
      em.emit('end', reason || '连接已关闭');
    };

    // Telnet 明文登录自动应答（可选，o.autoLogin）。Telnet 协议无传输层认证（SSH 的认证在 _ssh
    // 握手期完成），登录靠设备弹出 Username:/Password: 提示由人工输入——后台监控无人工介入，
    // 不应答则永远等不到提示符，命令全部被吞。状态机：0 等用户名提示 → 1 已发用户名 →
    // 2 已发密码 → 3 终止（完成/失败/超窗）。仅在 password 非空时启用。
    const autoLogin = !!o.autoLogin && String(o.password || '').length > 0;
    let loginPhase = autoLogin ? 0 : 3;
    let loginBuf = '';
    let loginPwdRetry = false;
    // 登录窗口 30s：超窗后不再应答——防登录完成很久后，设备输出恰好以 "Password:" 字样结尾
    // （chunk 边界落在提示冒号处）时把凭据误发进命令行
    let loginTimer = autoLogin ? setTimeout(() => { loginPhase = 3; }, 30000) : null;
    const loginFail = (text) => {
      loginPhase = 3;
      em.emit('status', { state: 'error', text });
      finish(text);
    };
    const loginFeed = (plain) => {
      if (loginPhase >= 3) return;
      loginBuf = (loginBuf + plain).slice(-160); // 提示符可能跨包拆分（"Usernam"+"e: "），滑窗匹配尾部
      if (/(?:user\s*name|username|login)\s*[:：]\s*$/i.test(loginBuf)) {
        if (loginPhase === 2) { loginFail('Telnet 认证失败：用户名或密码被设备拒绝'); return; } // 密码已提交仍要用户名＝凭据被拒
        if (loginPhase === 0) { loginPhase = 1; send(String(o.username) + '\r\n'); }
        // phase 1 的重复 Username:（重印提示）不重复发送，等 Password:
      } else if (/password\s*[:：]\s*$/i.test(loginBuf)) {
        if (loginPhase === 2) {
          if (loginPwdRetry) { loginFail('Telnet 认证失败：密码被设备拒绝'); return; }
          loginPwdRetry = true; // 密码提示重印（探测空行落在提示上）：容忍一次重发
          send(String(o.password) + '\r\n');
          return;
        }
        loginPhase = 2; // phase 0/1：有些设备只要密码不要用户名
        send(String(o.password) + '\r\n');
      }
    };
    const sendNaws = () => {
      // RFC1073：NAWS 载荷为 16 位大端（65535 表示「未知」），载荷内出现 0xFF 必须双写 IAC 转义，否则被服务端当作 IAC 误读
      const enc = (v) => {
        v = Math.min(Math.max(v, 10), 65535);
        return [(v >> 8) & 0xff, v & 0xff].flatMap((b) => (b === IAC ? [IAC, IAC] : [b]));
      };
      send(Buffer.from([IAC, SB, OPT_NAWS, ...enc(o.cols), ...enc(o.rows), IAC, SE]));
    };

    sock.on('connect', () => {
      em.emit('status', { state: 'connected', text: `已连接 ${o.host}:${o.port}（Telnet）` });
      // 请求服务器回显 + 双方启用 SGA + NAWS 窗口尺寸
      send(Buffer.from([IAC, DO, OPT_ECHO, IAC, WILL, OPT_SGA, IAC, DO, OPT_SGA, IAC, DO, OPT_NAWS]));
      sendNaws();
    });
    let firstData = false;
    sock.on('data', (chunk) => {
      if (!firstData) { firstData = true; sock.setTimeout(0); } // 收到首包后关闭空闲超时
      buf = Buffer.concat([buf, chunk]);
      const out = [];
      while (buf.length) {
        const i = buf.indexOf(IAC);
        if (i < 0) { out.push(buf); buf = Buffer.alloc(0); break; }
        if (i > 0) { out.push(buf.slice(0, i)); buf = buf.slice(i); }
        if (buf.length < 2) break;
        const cmd = buf[1];
        if (cmd === IAC) { out.push(Buffer.from([IAC])); buf = buf.slice(2); continue; }
        if (cmd === SB) {
          const j = buf.indexOf(Buffer.from([IAC, SE]), 2);
          if (j < 0) {
            // 畸形/恶意对端持续发 IAC SB 不收尾：滞留缓冲设上限，超限断链防内存无界增长
            if (buf.length > 64 * 1024) { finish('协议数据异常：子协商无结束符'); return; }
            break;
          }
          buf = buf.slice(j + 2);
          continue;
        }
        if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
          if (buf.length < 3) break;
          const opt = buf[2];
          if (cmd === WILL) {
            if (opt === OPT_ECHO) send(Buffer.from([IAC, DO, OPT_ECHO]));       // 服务器回显
            else if (opt === OPT_SGA) send(Buffer.from([IAC, DO, OPT_SGA]));
            else send(Buffer.from([IAC, DONT, opt]));
          } else if (cmd === DO) {
            if (opt === OPT_SGA) send(Buffer.from([IAC, WILL, OPT_SGA]));
            else send(Buffer.from([IAC, WONT, opt]));
          }
          buf = buf.slice(3);
          continue;
        }
        buf = buf.slice(2); // 其它命令（NOP 等）丢弃
      }
      if (out.length) {
        const plain = decoder.write(Buffer.concat(out));
        loginFeed(plain); // 自动登录应答先于 output 事件（monitor 侧无人值守，靠这里回填凭据）
        em.emit('output', plain);
      }
    });
    sock.on('timeout', () => {
      em.emit('status', { state: 'error', text: '连接超时' });
      finish('连接超时：请检查主机地址和端口是否可达');
    });
    sock.on('error', (err) => {
      em.emit('status', { state: 'error', text: err.message });
      finish('连接失败：' + err.message);
    });
    sock.on('close', () => finish('连接已关闭'));

    em.write = (data) => { if (!closed) send(Buffer.from(String(data), 'utf8')); };
    em.resize = (cols, rows) => {
      o.cols = cols; o.rows = rows;
      if (!closed && sock.readyState === 'open') sendNaws();
    };
    em._close = () => finish('closed');
    return em;
  }
}

module.exports = { ShellManager, cleanSftpRemotePath, sftpRemoteJoin, fmtSftpSize, makeDecoder };
