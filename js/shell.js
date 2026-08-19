/* NetTopo Web Shell —— SSH / Telnet 会话管理（主进程，纯 Node，不依赖 Electron）
 * 由 electron-main.js 通过 IPC 桥接给渲染层；也可在 Node 测试中直接使用。
 */
'use strict';
const { EventEmitter } = require('events');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { Client } = require('ssh2');

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_NAWS = 31;

class ShellManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this._seq = 0;
    this._pendingVerify = new Map(); // host -> [{verify, ...}]（SSH 首次连接待确认指纹；同一主机可有多个会话排队）
  }

  /** 建立会话。opts: {protocol:'ssh'|'telnet', host, port, username, password, cols, rows}
   *  返回 {ok:true, id} 或 {ok:false, error}；连接过程异步，结果通过 status/end 事件上报。 */
  connect(opts) {
    opts = opts || {};
    const protocol = String(opts.protocol || 'ssh').toLowerCase();
    const host = String(opts.host || '').trim();
    if (!host) return { ok: false, error: '未填写主机地址' };
    let port = parseInt(opts.port, 10);
    if (!(port >= 1)) port = protocol === 'telnet' ? 23 : 22;
    if (!(port <= 65535)) port = protocol === 'telnet' ? 23 : 22; // 端口钳制，防异常大端口
    const base = {
      host, port,
      username: String(opts.username || '').trim() || 'admin',
      password: String(opts.password || ''),
      cols: Math.max(parseInt(opts.cols, 10) || 80, 10),
      rows: Math.max(parseInt(opts.rows, 10) || 24, 5),
      timeout: opts.timeout != null ? parseInt(opts.timeout, 10) : undefined,
      expectFp: String(opts.expectFp || '').trim()
    };
    let session;
    if (protocol === 'ssh') session = this._ssh(base);
    else if (protocol === 'telnet') session = this._telnet(base);
    else return { ok: false, error: '不支持的协议：' + protocol };

    const id = 's' + (++this._seq);
    session.on('output', (d) => this.emit('output', id, d));
    session.on('status', (info) => this.emit('status', id, info));
    session.on('end', (reason) => {
      this.sessions.delete(id);
      this.emit('end', id, reason);
    });
    this.sessions.set(id, session);
    return { ok: true, id };
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s) s.write(data);
  }
  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s) s.resize(Math.max(parseInt(cols, 10) || 80, 10), Math.max(parseInt(rows, 10) || 24, 5));
  }
  close(id) {
    const s = this.sessions.get(id);
    if (s) { s._close(); this.sessions.delete(id); }
  }
  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
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
    const client = new Client();
    let stream = null;
    let closed = false;
    let kiPrompt = 0; // keyboard-interactive 提示计数（仅首个回填密码）
    const pendingRec = { verify: null }; // 本会话的指纹确认记录（结束时只移除自己的，不影响同主机其它会话）
    const finish = (reason) => {
      if (closed) return;
      closed = true;
      const arr = this._pendingVerify.get(o.host); // 会话结束即移除本会话的指纹等待
      if (arr) {
        const i = arr.indexOf(pendingRec);
        if (i >= 0) arr.splice(i, 1);
        if (!arr.length) this._pendingVerify.delete(o.host);
      }
      try { if (stream && !stream.destroyed) stream.end(); } catch (e) { /* ignore */ }
      try { client.end(); } catch (e) { /* ignore */ }
      em.emit('end', reason || '连接已关闭');
    };

    client.on('ready', () => {
      em.emit('status', { state: 'connected', text: `已连接 ${o.host}:${o.port}（SSH）` });
      client.shell({ term: 'xterm-256color', cols: o.cols, rows: o.rows }, (err, s) => {
        if (err) { finish('无法打开远程 Shell：' + err.message); return; }
        stream = s;
        s.on('data', (d) => em.emit('output', d.toString('utf8')));
        s.on('close', () => finish('连接已关闭'));
        s.on('error', (e) => em.emit('status', { state: 'error', text: e.message }));
      });
    });
    client.on('keyboard-interactive', (name, instructions, lang, prompts, respond) => {
      // 仅首个提示回填密码（密码类提示）；后续提示（OTP/验证码/二次确认等）回空，
      // 避免把密码发送到非密码提示位
      kiPrompt++;
      respond(kiPrompt === 1 ? [o.password] : prompts.map(() => ''));
    });
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
      hostHash: 'sha256',
      // 主机密钥校验：首次连接弹出指纹确认（TOFU）；已信任主机校验指纹变化（防中间人）
      hostVerifier: (key, verify) => {
        try {
          const hex = String(key).toLowerCase();
          // ssh2 传入的是 SHA256 的 hex 摘要，转成 OpenSSH 标准 SHA256:<base64> 格式，便于与 ssh-keygen 输出核对
          const fp = 'SHA256:' + Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '');
          if (o.expectFp) {
            if (o.expectFp !== fp) {
              em.emit('status', { state: 'error', text: '主机密钥指纹不匹配：' + fp + '（期望 ' + o.expectFp + '），可能存在中间人攻击' });
              return false;
            }
            em.emit('status', { state: 'info', host: o.host, fp, text: '主机密钥指纹: ' + fp });
            return true;
          }
          // 首次连接：暂停握手，等用户确认信任该指纹（同主机多会话各自排队）
          pendingRec.verify = verify;
          const arr = this._pendingVerify.get(o.host);
          if (arr) arr.push(pendingRec);
          else this._pendingVerify.set(o.host, [pendingRec]);
          em.emit('status', { state: 'fingerprint', host: o.host, fp, text: '首次连接，请核对主机指纹: ' + fp });
          return undefined; // 异步确认，不立即 verify
        } catch (e) {
          return false;
        }
      }
    };
    if (o.password) { cfg.password = o.password; cfg.tryKeyboard = true; }
    client.connect(cfg);

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
      if (closed) return;
      closed = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      try { decoder.end(); } catch (e) { /* ignore */ }
      em.emit('end', reason || '连接已关闭');
    };
    const sendNaws = () => {
      const c = Math.max(o.cols, 10), r = Math.max(o.rows, 5);
      send(Buffer.from([IAC, SB, OPT_NAWS, (c >> 8) & 0xff, c & 0xff, (r >> 8) & 0xff, r & 0xff, IAC, SE]));
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
          if (j < 0) break;
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
      if (out.length) em.emit('output', decoder.write(Buffer.concat(out)));
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
