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
// .part 临时名单调序号：pid+毫秒时间戳在并发同名传输（同 IP 不同源端口 WRQ）同毫秒时会撞名
let svcTmpSeq = 0;
const RETRANSMIT_MS = 1000;      // 对端不应答时的重发间隔
const MAX_RETRIES = 6;           // 连续重发次数上限（超限判定对端已死）
// 首块（对端从未应答过）的重传上限：RRQ 是无握手的盲请求，源地址可伪造，服务端会直接把 DATA1
// 发往伪造地址并按 MAX_RETRIES 重发——16 字节请求换来 7×512B ≈ 3.5KB（放大 225×，标准 UDP 反射面）。
// 对端一次都没应答时只发 1 次重传（合计 2 包 ≈ 1KB，放大降到 64×）；一旦收到过应答即证明对端真实
// 可达，恢复常规重传次数（不影响正常传输的可靠性）
const MAX_RETRIES_INITIAL = 1;
const SESSION_IDLE_MS = 30000;   // 会话整体空闲上限
// 握手期空闲上限：尚未发生任何数据交换的会话只给这么长时间（旧值 30s 让伪造源占住的槽位存活过久）
const HANDSHAKE_IDLE_MS = 5000;
const MAX_NAME_LEN = 120;

/** 文件名安全化：白名单外的字符替换，拒绝穿越成分（返回 null 表示整个请求拒收） */
function sanitizeTftpName(name) {
  let s = String(name == null ? '' : name).trim();
  if (!s) return null;
  // 请求里的路径分隔符与穿越成分一律拒收（设备推配置只用纯文件名）；':' 在 Windows 上
  // 会被解释为 NTFS 交替数据流（文件不可见），与全库清洗口径一致替换掉
  if (s.indexOf('/') >= 0 || s.indexOf('\\') >= 0 || s.indexOf('\0') >= 0) return null;
  if (s.indexOf('..') >= 0) return null;
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s = '_' + s;
  s = s.replace(/[\u0000-\u001f\u007f]/g, '_').replace(/:/g, '_');
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
    this.finishing = false;      // WRQ 收尾窗口：最终块已收（ws.end）但 rename 结果未定
    // 「已进展」= 与本会话真正交换过数据（WRQ 收到 DATA / RRQ 收到 ACK）。伪造源地址永远做不到，
    // 因此只有它会占用握手期短超时；真实传输一旦进展就转入常规空闲超时
    this.progressed = false;
  }

  _bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.abort(new Error('会话空闲超时')),
      this.progressed ? SESSION_IDLE_MS : HANDSHAKE_IDLE_MS);
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
    const cap = this.progressed ? MAX_RETRIES : MAX_RETRIES_INITIAL; // 对端从未应答：不做长重传（防反射放大）
    if (++this.retries > cap) { this.abort(new Error('重传超限')); return; }
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
      // RFC 1350 的 TID 语义：地址与端口都必须与首包来源一致，缺一半可被同 IP 其它端口注入伪造包
      if (rinfo.address !== this.peer.address || rinfo.port !== this.peer.port) return;
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
      // 流式读：readFileSync 一次性同步读会在大文件（上限 32MB）时阻塞主进程事件循环数百毫秒，
      // 期间所有 IPC/监控采集停摆——改为按块拉取的 ReadStream（发送为锁步：一次只需一块在途）
      this.rs = fs.createReadStream(this.finalPath, { highWaterMark: Math.max(this.blksize || 512, 512) });
      this.rsBuf = Buffer.alloc(0);   // 已从流中取出尚未发走的字节
      this.rsEnded = false;           // 流已到尾（rsBuf 为空时 _readBlock 返回 0 字节块）
      this.eofSent = false;           // 已发出短块/空块（其 ACK 后会话完成）
      this.rs.on('data', (d) => { this.rsBuf = Buffer.concat([this.rsBuf, d]); this.rs.pause(); this._rsWake && this._rsWake(); });
      this.rs.on('end', () => { this.rsEnded = true; this._rsWake && this._rsWake(); });
      this.rs.on('error', () => this.abort(new Error('读取文件失败')));
      this.rs.pause();
      return true;
    } catch (e) {
      if (e && e.code === 'TOOBIG') this._sendError(3, 'File too large');
      else this._sendError(1, 'File not found');
      this.close();
      return false;
    }
  }

  /** 取下一发送块（恰好 blksize 字节；文件尾为短块；空文件/整块对齐尾为 0 字节块，RFC 1350） */
  _readBlock() {
    const need = this.blksize || 512;
    return new Promise((resolve) => {
      const take = () => {
        if (this.rsBuf.length >= need || this.rsEnded) {
          const chunk = this.rsBuf.slice(0, need);
          this.rsBuf = this.rsBuf.slice(chunk.length);
          this._rsWake = null;
          if (!this.rsEnded && this.rs) this.rs.resume();
          resolve(chunk);
        } else {
          this._rsWake = take;
          if (this.rs && !this.rsEnded) this.rs.resume();
        }
      };
      take();
    });
  }

  _openWrite() {
    try {
      fs.mkdirSync(path.dirname(this.finalPath), { recursive: true });
      this.tmpPath = this.finalPath + '.part-' + process.pid + '-' + Date.now() + '-' + (svcTmpSeq++);
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

  async _sendNextData() {
    if (this.closed) return;
    // 上一块已是短块/空块（EOF 标记）且已收到其 ACK：传输完成
    if (this.eofSent) {
      this.server.stats.txFiles++; // 字段名是 stats（旧代码误写 _stats，同步路径被 try/catch 吞成统计漏计）
      this.close();
      return;
    }
    const chunk = await this._readBlock();
    if (this.closed) return; // 等块期间会话可能已被对端 ERROR/超时中止
    this.blockCounter++;
    if (chunk.length < (this.blksize || 512)) this.eofSent = true; // 最后一块（含 0 字节空块）
    this._send(this._data(this.blockCounter, chunk));
  }

  _onPacket(buf) {
    if (buf.length < 4) return;
    const opcode = buf.readUInt16BE(0);
    if (opcode === 5) { this.close(); return; } // 对端报错：放弃
    if (opcode === 4) { // ACK
      if (this.kind !== 'rrq') return;
      const n = buf.readUInt16BE(2);
      this.progressed = true; // 对端真实可达（伪造源收不到我们的包，也就回不了 ACK）
      // _sendNextData 为 async（流式取块）：同步 throw 会变成 rejection 绕过本处的 try/catch，
      // 补 .catch 走 abort 清理，防 unhandled rejection 崩主进程
      if (n === (this.blockCounter & 0xffff)) this._sendNextData().catch((e) => this.abort(e));
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
        // 收尾窗口（最终块已收、rename 结果未定）不提前回 ACK：若随后 rename 失败，
        // 设备已凭 ACK 认定推送成功而忽略 ERROR，配置实际丢失——静默等 finish 回调统一裁决
        if (this.finishing) return;
        this._send(this._ack(n));
        return;
      }
      if (n !== ((this.blockCounter + 1) & 0xffff)) return; // 乱序：丢弃等待重传
      this.progressed = true; // 收到按序数据块 = 对端真实可达
      this.blockCounter++;
      this.bytes += chunk.length;
      if (this.bytes > this.server.maxFileSize) {
        this._sendError(3, 'File too large');
        this.abort(new Error('超过单文件大小上限'));
        return;
      }
      const isFinal = chunk.length < this.blksize;
      if (isFinal) { this.finishing = true; this.ws.end(chunk); }
      else { this.ws.write(chunk); this._send(this._ack(n)); }
      if (isFinal) {
        this._stopTimers();
        this.ws.on('finish', () => {
          let renamed = true;
          try { fs.renameSync(this.tmpPath, this.finalPath); } catch (e) { renamed = false; }
          this.tmpPath = null;
          if (!renamed) {
            // 目标被占用（Windows 下用户正在编辑器里打开同名文件等）：如实向设备报错、不广播收件，
            // 保留 .part 临时文件供事后找回——此前回 ACK 会让设备显示推送成功而配置实际丢失
            this._sendError(0, 'Target file busy (rename failed)');
            this.close();
            return;
          }
          // rename 成功才算真正完成：此前写流出错时 abort 仍要负责清理 .part
          this.finished = true;
          // 先回 ACK 再登记文件（客户端拿到 ACK 即认为推完）：emit 的监听器（面板推送/系统通知）
          // 同步执行会推迟 ACK，设备在重传窗口内收不到最终 ACK 会触发一次无谓重传
          this._send(this._ack(n));
          this.server._fileReceived(this);
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
    // 中止后若来源目录已空则顺手删掉：伪造源 IP 的 WRQ（未完成传输）不再残留空目录累积
    if (this.kind === 'wrq' && this.finalPath) {
      try { fs.rmdirSync(path.dirname(this.finalPath)); } catch (e) { /* 非空/不存在：忽略 */ }
    }
    if (err && !this.closed) { try { this._sendError(0, 'Transfer aborted'); } catch (e) { /* ignore */ } }
    this.server._sessionEnded(this, err);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._stopTimers();
    if (this.rs) { const r = this.rs; this.rs = null; this._rsWake = null; try { r.destroy(); } catch (e) { /* ignore */ } }
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
    // 单来源 IP 并发会话上限：慢会话（收 ACK0 后不发数据，等 30s 空闲超时）可用 8 个槽位
    // 饿死同网段其它设备的配置推送——按 IP 分配配额（NAT 后多设备场景留 4）
    this.maxSessionsPerIp = Math.max(1, Math.floor(Number(opts.maxSessionsPerIp) || 4));
    this.sock = null;
    this.port = 0;
    this.running = false;
    this.lastError = '';
    this.sessions = new Map(); // 'addr:port' -> TftpSession
    this.stats = { rxFiles: 0, rxBytes: 0, txFiles: 0, denied: 0, evicted: 0 };
    try { fs.mkdirSync(this.rootDir, { recursive: true }); } catch (e) { /* start 时再报 */ }
  }

  /** 逐出「尚未进展」的最久会话（腾出一个会话槽）。返回是否成功逐出。
   *  未进展 = 从未与本服务交换过数据（WRQ 未收到 DATA / RRQ 未收到 ACK），UDP 伪源无法做到；
   *  这让伪造源占用槽位的效果只是瞬时的，真实设备永远能进来（与 syslog/trap 的 LRU 名额同思路）。 */
  _evictStalledSession() {
    for (const [key, s] of this.sessions) {
      if (s.progressed || s.closed) continue;
      this.sessions.delete(key);
      this.stats.evicted++;
      try { s.abort(new Error('会话槽不足，逐出未进展的会话')); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
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
      // 满员时**优先逐出「尚未进展」的最久会话**（伪造源地址占的槽永远不会进展）——
      // 旧实现直接回 ERROR 4，攻击者只要用 2 个伪源每 30 秒补发 8 个包即可无限期占满全部槽位，
      // 真实设备的 copy running-config tftp 恒失败（单来源 IP 配额对 UDP 伪源无效，正是被这点绕过）。
      // 无可逐出者（全部会话都已真实交换过数据）才如实拒绝。
      if (!this._evictStalledSession()) {
        this.stats.denied++;
        this._sendErrorTo(rinfo, 4, 'Too many sessions');
        return;
      }
    }
    // 单来源 IP 配额：一个真实主机最多占 maxSessionsPerIp 个会话槽（防同一台设备开过多慢会话）；
    // 注意它只对「真实来源」有意义，防伪源依赖上面的逐出机制
    let perIp = 0;
    for (const s of this.sessions.values()) { if (s.peer.address === rinfo.address && s.progressed) perIp++; }
    if (perIp >= this.maxSessionsPerIp) {
      this.stats.denied++;
      this._sendErrorTo(rinfo, 4, 'Too many sessions for this host');
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
      sessions: this.sessions.size, rxFiles: this.stats.rxFiles, rxBytes: this.stats.rxBytes,
    denied: this.stats.denied, evicted: this.stats.evicted
    };
  }
}

module.exports = { TftpServer, sanitizeTftpName, sanitizeIpDir };
