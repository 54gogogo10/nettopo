/* NetTopo 内置 TFTP 服务器 —— 主进程纯 Node 模块（不依赖 Electron）
 * 用途：局域网设备执行 copy running-config tftp://<本机IP>/<文件名> 时接收配置文件落盘。
 * 实现 RFC 1350（RRQ/WRQ/DATA/ACK/ERROR）+ RFC 2347/2348/2349 扩展选项（blksize / tsize，OACK 协商）。
 * 设计要点：
 *   - 每个传输会话使用独立 UDP 套接字（RFC 1350 的 TID 语义），主套接字只接第一个请求包
 *   - 文件按来源 IP 分目录落盘：<rootDir>/<来源IP>/<文件名>（先写 .part 临时文件，完成后改名，半截文件不残留成品名）
 *   - 文件名白名单清洗 + 路径穿越拒绝（含 .. 与分隔符的请求直接 ERROR），最终路径必须仍在 rootDir 内
 *   - 块号 16 位回绕按计数器取模处理；对端重传（重复块）只重发 ACK，不重复写盘
 *   - 会话空闲 / 重传超时自动清理，写超限（maxFileSize）以 ERROR 3 中止
 * 可在 Node 测试中直接使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const DEFAULT_BLKSIZE = 512;
const MIN_BLKSIZE = 8;
const MAX_BLKSIZE = 65464;
const RETRANSMIT_MS = 1000;      // 对端不应答时的重发间隔
const MAX_RETRIES = 6;           // 连续重发次数上限（超限判定对端已死）
const SESSION_IDLE_MS = 30000;   // 会话整体空闲上限
const MAX_NAME_LEN = 120;

/** 文件名安全化：白名单外的字符替换，拒绝穿越成分（返回 null 表示整个请求拒收） */
function sanitizeTftpName(name) {
  let s = String(name == null ? '' : name).trim();
  if (!s) return null;
  // 请求里的路径分隔符与穿越成分一律拒收（设备推配置只用纯文件名）
  if (s.indexOf('/') >= 0 || s.indexOf('\\') >= 0 || s.indexOf('\0') >= 0) return null;
  if (s.indexOf('..') >= 0) return null;
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s = '_' + s;
  s = s.replace(/[\u0000-\u001f\u007f]/g, '_');
  if (s.length > MAX_NAME_LEN) s = s.slice(0, MAX_NAME_LEN);
  s = s.replace(/[. ]+$/, '');
  return s || null;
}

/** 来源 IP → 目录名（IPv6 冒号等替换为 _，防分隔符注入） */
function sanitizeIpDir(ip) {
  let s = String(ip == null ? '' : ip).trim();
  s = s.replace(/[^A-Za-z0-9._-]/g, '_');
  if (s.length > 60) s = s.slice(0, 60);
  return s || 'unknown';
}

const padBuf = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; };

class TftpSession {
  /**
   * @param server   TftpServer 实例
   * @param kind     'rrq' | 'wrq'
   * @param peer     { address, port } 对端首个请求包来源
   * @param fileName 清洗后的目标文件名
   * @param options  客户端请求的扩展选项（小写键）
   */
  constructor(server, kind, peer, fileName, options) {
    this.server = server;
    this.kind = kind;
    this.peer = peer;
    this.fileName = fileName;
    this.blksize = DEFAULT_BLKSIZE;
    this.options = options || {};
    this.sock = null;
    this.closed = false;
    this.retries = 0;
    this.lastSent = null;        // 最近发送的包（超时重发用）
    this.timer = null;           // 重发定时器
    this.idleTimer = null;       // 会话空闲清理
    // WRQ：接收计数（含 16 位回绕）；RRQ：已发送的块号计数
    this.blockCounter = 0;
    this.bytes = 0;
    this.ws = null;              // WRQ 写入流
    this.tmpPath = null;
    this.finalPath = null;
    this.readBuf = null;         // RRQ 文件内容
    this.finished = false;
  }

  _bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.abort(new Error('会话空闲超时')), SESSION_IDLE_MS);
    this.idleTimer.unref();
  }

  _send(buf) {
    if (this.closed || !this.sock) return;
    this.lastSent = buf;
    try { this.sock.send(buf, 0, buf.length, this.peer.port, this.peer.address); } catch (e) { /* ignore */ }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._retransmit(), RETRANSMIT_MS);
    this.timer.unref();
    this._bumpIdle();
  }

  _retransmit() {
    if (this.closed) return;
    if (++this.retries > MAX_RETRIES) { this.abort(new Error('重传超限')); return; }
    this._send(this.lastSent);
  }

  _stopTimers() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /** 建立会话套接字并完成首包协商（OACK / ACK0 / DATA1） */
  start() {
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('message', (buf, rinfo) => {
      if (rinfo.address !== this.peer.address) return; // 只信任首包来源
      this.retries = 0;
      try { this._onPacket(buf); } catch (e) { this.abort(e); }
    });
    sock.on('error', () => this.abort(new Error('会话套接字异常')));
    return new Promise((resolve) => {
      sock.bind(0, () => {
        // WRQ 有选项先 OACK，否则直接 ACK block0；RRQ 有选项先 OACK，否则直接发 DATA1
        const opts = this.options;
        const accepted = [];
        if (Number.isFinite(opts.blksize)) {
          this.blksize = Math.min(MAX_BLKSIZE, Math.max(MIN_BLKSIZE, Math.floor(opts.blksize)));
          accepted.push(['blksize', String(this.blksize)]);
        }
        if (Number.isFinite(opts.tsize)) {
          // RRQ：回真实文件大小；WRQ：回显客户端声明的大小（RFC 2349）
          const sz = this.kind === 'rrq' ? this._fileSize() : Math.max(0, Math.floor(opts.tsize));
          accepted.push(['tsize', String(sz)]);
        }
        if (this.kind === 'wrq') {
          this._openWrite();
          if (accepted.length) this._send(this._oack(accepted));
          else this._send(this._ack(0));
        } else {
          if (!this._openRead()) return; // 文件不可读时已回 ERROR 并清理
          if (accepted.length) this._send(this._oack(accepted));
          else this._sendNextData();
        }
        resolve();
      });
    });
  }

  _fileSize() {
    try { return fs.lstatSync(this.finalPath).size; } catch (e) { return 0; }
  }

  _openRead() {
    try {
      const st = fs.lstatSync(this.finalPath);
      if (!st.isFile() || st.isSymbolicLink()) throw Object.assign(new Error('not file'), { code: 'NOTFILE' });
      if (st.size > this.server.maxFileSize) throw Object.assign(new Error('too large'), { code: 'TOOBIG' });
      this.readBuf = fs.readFileSync(this.finalPath);
      return true;
    } catch (e) {
      if (e && e.code === 'TOOBIG') this._sendError(3, 'File too large');
      else this._sendError(1, 'File not found');
      this.close();
      return false;
    }
  }

  _openWrite() {
    try {
      fs.mkdirSync(path.dirname(this.finalPath), { recursive: true });
      this.tmpPath = this.finalPath + '.part-' + process.pid + '-' + Date.now();
      this.ws = fs.createWriteStream(this.tmpPath, { flags: 'w' });
      this.ws.on('error', (e) => this.abort(e));
      this.server._sessionStarted(this);
    } catch (e) {
      this._sendError(2, 'Access violation');
      this.close();
    }
  }

  _oack(pairs) {
    const parts = [Buffer.from([0, 6])];
    for (const [k, v] of pairs) {
      parts.push(Buffer.from(k + '\0', 'utf8'), Buffer.from(v + '\0', 'utf8'));
    }
    return Buffer.concat(parts);
  }

  _ack(n) { return Buffer.concat([Buffer.from([0, 4]), padBuf(n)]); }
  _data(n, chunk) { return Buffer.concat([Buffer.from([0, 3]), padBuf(n), chunk]); }
  _sendError(code, msg) {
    this._send(Buffer.concat([Buffer.from([0, 5]), padBuf(code), Buffer.from(String(msg || 'Error') + '\0', 'utf8')]));
  }

  _sendNextData() {
    const len = this.readBuf ? this.readBuf.length : 0;
    const off = this.blockCounter * this.blksize;
    // off === len：文件为空 / 恰好整块对齐——必须补一个 0 字节数据块标记结束（RFC 1350）
    // off > len：结束块（或其前的短块）已被 ACK，传输完成
    if (off > len) {
      this.server._stats.txFiles++;
      this.close();
      return;
    }
    this.blockCounter++;
    const chunk = off === len ? Buffer.alloc(0) : this.readBuf.slice(off, off + this.blksize);
    this._send(this._data(this.blockCounter, chunk));
  }

  _onPacket(buf) {
    if (buf.length < 4) return;
    const opcode = buf.readUInt16BE(0);
    if (opcode === 5) { this.close(); return; } // 对端报错：放弃
    if (opcode === 4) { // ACK
      if (this.kind !== 'rrq') return;
      const n = buf.readUInt16BE(2);
      if (n === (this.blockCounter & 0xffff)) this._sendNextData();
      // 过期 ACK（重复确认）忽略，等待重发定时器处理
      return;
    }
    if (opcode === 3) { // DATA
      if (this.kind !== 'wrq' || !this.ws) return;
      if (buf.length < 4) return;
      const n = buf.readUInt16BE(2);
      const chunk = buf.slice(4);
      const prev = (this.blockCounter & 0xffff); // 最近一次已写盘的块号（0 表示尚未写盘）
      if (n === prev && this.blockCounter > 0) { // 对端重传：只补 ACK
        this._send(this._ack(n));
        return;
      }
      if (n !== ((this.blockCounter + 1) & 0xffff)) return; // 乱序：丢弃等待重传
      this.blockCounter++;
      this.bytes += chunk.length;
      if (this.bytes > this.server.maxFileSize) {
        this._sendError(3, 'File too large');
        this.abort(new Error('超过单文件大小上限'));
        return;
      }
      const isFinal = chunk.length < this.blksize;
      if (isFinal) this.ws.end(chunk);
      else { this.ws.write(chunk); this._send(this._ack(n)); }
      if (isFinal) {
        this.finished = true;
        this._stopTimers();
        this.ws.on('finish', () => {
          try { fs.renameSync(this.tmpPath, this.finalPath); } catch (e) { /* 目标被占用等：保留临时文件 */ }
          this.tmpPath = null;
          this.server._fileReceived(this);
          // 先回 ACK 再登记文件（客户端拿到 ACK 即认为推完）
          this._send(this._ack(n));
          this.close();
        });
      }
    }
  }

  abort(err) {
    if (this.closed) return;
    if (!this.finished && this.tmpPath) { try { fs.unlinkSync(this.tmpPath); } catch (e) { /* ignore */ } }
    this.tmpPath = null;
    try { if (this.ws) this.ws.destroy(); } catch (e) { /* ignore */ }
    if (err && !this.closed) { try { this._sendError(0, 'Transfer aborted'); } catch (e) { /* ignore */ } }
    this.server._sessionEnded(this, err);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._stopTimers();
    // 注意：dgram send 后立即 close 会丢弃尚未发出的数据报（最后一个 ACK 客户端收不到会一直重传），
    // 关闭推迟到下一轮事件循环，保证 ACK 先离机
    if (this.sock) { const s = this.sock; this.sock = null; setImmediate(() => { try { s.close(); } catch (e) { /* ignore */ } }); }
    this.server._sessionEnded(this, null);
  }
}

class TftpServer extends EventEmitter {
  /** @param opts { rootDir, maxFileSize=32MB, maxSessions=8 } */
  constructor(opts) {
    super();
    opts = opts || {};
    this.rootDir = opts.rootDir;
    this.maxFileSize = Math.max(1024, Math.floor(Number(opts.maxFileSize) || 32 * 1024 * 1024));
    this.maxSessions = Math.max(1, Math.floor(Number(opts.maxSessions) || 8));
    this.sock = null;
    this.port = 0;
    this.running = false;
    this.lastError = '';
    this.sessions = new Map(); // 'addr:port' -> TftpSession
    this.stats = { rxFiles: 0, rxBytes: 0, txFiles: 0, denied: 0 };
    try { fs.mkdirSync(this.rootDir, { recursive: true }); } catch (e) { /* start 时再报 */ }
  }

  /** 解析请求包：opcode / 文件名 / 模式 / 扩展选项。返回 null 表示包非法 */
  static parseRequest(buf) {
    if (!buf || buf.length < 6 || buf.readUInt16BE(0) > 2 || buf.readUInt16BE(0) < 1) return null;
    const opcode = buf.readUInt16BE(0);
    const zeros = [];
    for (let i = 2; i < buf.length; i++) if (buf[i] === 0) zeros.push(i);
    if (zeros.length < 2) return null;
    const fileName = buf.toString('utf8', 2, zeros[0]);
    const mode = buf.toString('utf8', zeros[0] + 1, zeros[1]).toLowerCase();
    const options = {};
    let p = zeros[1] + 1;
    while (p < buf.length) {
      const nz = [];
      for (let i = p; i < buf.length; i++) if (buf[i] === 0) { nz.push(i); if (nz.length === 2) break; }
      if (nz.length < 2) break;
      const k = buf.toString('utf8', p, nz[0]).toLowerCase();
      const v = buf.toString('utf8', nz[0] + 1, nz[1]);
      options[k] = /^\d+$/.test(v) ? parseInt(v, 10) : v;
      p = nz[1] + 1;
    }
    return { opcode, fileName, mode, options };
  }

  start(port) {
    if (this.running) return Promise.resolve({ ok: true, port: this.port });
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch (e) { /* ignore */ }
        this.running = false;
        this.lastError = String((err && err.message) || err);
        resolve({ ok: false, error: this._bindHint(this.lastError) });
      };
      sock.once('error', fail);
      sock.bind(port || 0, () => {
        if (settled) return;
        settled = true;
        this.sock = sock;
        this.port = sock.address().port;
        this.running = true;
        this.lastError = '';
        sock.on('message', (buf, rinfo) => {
          if (!this.running) return;
          try { this._onMessage(buf, rinfo); } catch (e) { this.lastError = String(e && e.message || e); }
        });
        sock.on('error', (err) => { this.lastError = String(err && err.message || err); this.stop(); });
        sock.on('close', () => { this.running = false; });
        resolve({ ok: true, port: this.port });
      });
    });
  }

  /** 端口占用/权限类报错附上可操作的提示（Linux 非 root 绑 69 需提权或换高位端口） */
  _bindHint(err) {
    const e = String(err || '');
    if (/EACCES|permission/i.test(e)) return '监听端口被系统拒绝（Linux 下 69 等特权端口需 root，请在面板改用高位端口）';
    if (/EADDRINUSE/i.test(e)) return '端口已被占用（其它 TFTP 服务或本软件另一实例）';
    return e || '监听失败';
  }

  async stop() {
    this.running = false;
    for (const s of [...this.sessions.values()]) { try { s.abort(new Error('服务停止')); } catch (e) { /* ignore */ } }
    if (this.sock) { const s = this.sock; this.sock = null; try { s.close(); } catch (e) { /* ignore */ } }
  }

  _onMessage(buf, rinfo) {
    const key = rinfo.address + ':' + rinfo.port;
    if (this.sessions.has(key)) return; // 后续包走会话套接字，主套接字直接忽略
    const req = TftpServer.parseRequest(buf);
    if (!req) { this.stats.denied++; return; }
    if (req.opcode !== 1 && req.opcode !== 2) return;
    const name = sanitizeTftpName(req.fileName);
    if (!name) {
      this.stats.denied++;
      this._sendErrorTo(rinfo, 2, 'Illegal filename');
      return;
    }
    if (this.sessions.size >= this.maxSessions) {
      this.stats.denied++;
      this._sendErrorTo(rinfo, 4, 'Too many sessions');
      return;
    }
    const dir = path.resolve(this.rootDir, sanitizeIpDir(rinfo.address));
    const base = path.resolve(this.rootDir) + path.sep;
    if (!dir.startsWith(base)) { this.stats.denied++; this._sendErrorTo(rinfo, 2, 'Access violation'); return; }
    const sess = new TftpSession(this, req.opcode === 1 ? 'rrq' : 'wrq',
      { address: rinfo.address, port: rinfo.port }, name, req.options);
    sess.finalPath = path.join(dir, name);
    // RRQ：文件不存在时在 start() 里回 ERROR；WRQ：目录/文件名就绪
    this.sessions.set(key, sess);
    sess.start().catch(() => { this.sessions.delete(key); });
  }

  _sendErrorTo(rinfo, code, msg) {
    if (!this.sock) return;
    const buf = Buffer.concat([Buffer.from([0, 5]), padBuf(code), Buffer.from(msg + '\0', 'utf8')]);
    try { this.sock.send(buf, 0, buf.length, rinfo.port, rinfo.address); } catch (e) { /* ignore */ }
  }

  _sessionStarted() { /* 钩子（统计用） */ }
  _sessionEnded(sess) {
    const key = sess.peer.address + ':' + sess.peer.port;
    if (this.sessions.get(key) === sess) this.sessions.delete(key);
  }

  _fileReceived(sess) {
    this.stats.rxFiles++;
    this.stats.rxBytes += sess.bytes;
    this.emit('file', { svc: 'tftp', ip: sess.peer.address, name: sess.fileName, size: sess.bytes, path: sess.finalPath });
  }

  status() {
    return {
      running: this.running, port: this.port, error: this.lastError,
      sessions: this.sessions.size, rxFiles: this.stats.rxFiles, rxBytes: this.stats.rxBytes, denied: this.stats.denied
    };
  }
}

module.exports = { TftpServer, sanitizeTftpName, sanitizeIpDir };
