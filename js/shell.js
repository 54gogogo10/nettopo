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
      keyPassphrase: typeof opts.keyPassphrase === 'string' ? opts.keyPassphrase.slice(0, 1024) : ''
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
  }

  /** SSH 首次连接指纹确认：用户信任后放行该主机的全部待确认握手（TOFU） */
  trustFingerprint(host, trust) {
    const arr = this._pendingVerify.get(host);
    if (!arr || !arr.length) return false;
    this._pendingVerify.delete(host);
    for (const rec of arr) { try { rec.verify(!!trust); } catch (e) { /* ignore */ } }
    return true;
  }

  /* ---------- SSH（ssh2） ---------- */
  _ssh(o) {
    const em = new EventEmitter();
    const decoder = new StringDecoder('utf8'); // 与 telnet 路径一致：缓存跨包的多字节 UTF-8 半字符
    const client = new Client();
    let stream = null;
    let closed = false;
    const pendingRec = { verify: null }; // 目标主机的指纹确认记录（结束时只移除自己的，不影响同主机其它会话）
    const jumpRec = { verify: null };    // 跳板主机的指纹确认记录（独立排队）
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
    // 主机密钥校验（TOFU）：目标与跳板各自独立排队确认；带 expectFp 的目标严格比对
    const makeVerifier = (host, rec) => (key, verify) => {
      try {
        const hex = String(key).toLowerCase();
        // ssh2 传入的是 SHA256 的 hex 摘要，转成 OpenSSH 标准 SHA256:<base64> 格式，便于与 ssh-keygen 输出核对
        const fp = 'SHA256:' + Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
        if (o.expectFp && host === o.host) {
          if (o.expectFp !== fp) {
            em.emit('status', { state: 'error', text: '主机密钥指纹不匹配：' + fp + '（期望 ' + o.expectFp + '），可能存在中间人攻击' });
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
        em.emit('status', { state: 'fingerprint', host, fp, text: '首次连接，请核对主机指纹: ' + fp });
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
      hostVerifier: makeVerifier(o.host, pendingRec)
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
        hostVerifier: makeVerifier(o.jump.host, jumpRec)
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
    em.resize = (cols, rows) => { if (stream && !closed) stream.setWindow(rows, cols); };
    em._close = () => finish('closed');
    return em;
  }

  /* ---------- Telnet（RFC854 + NAWS） ---------- */
  _telnet(o) {
    const em = new EventEmitter();
    const sock = net.createConnection({ host: o.host, port: o.port });
    const decoder = new StringDecoder('utf8'); // 处理跨包的多字节 UTF-8
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

module.exports = { ShellManager };
