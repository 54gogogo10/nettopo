/* NetTopo 内置 FTP 服务器 —— 主进程纯 Node 模块（不依赖 Electron）
 * 用途：局域网设备执行 copy running-config ftp://<用户名>:<密码>@<本机IP>/<文件名> 时接收配置文件落盘，
 *       或供运维下载（RETR）/浏览（LIST）已接收的文件。
 * 实现 RFC 959 最小服务端子集：USER/PASS 认证、TYPE/STRU/MODE、PASV/EPSV/PORT 数据通道、
 *       STOR/RETR/LIST/NLST/SIZE/MDTM/PWD/CWD/CDUP/MKD/DELE/NOOP/QUIT/ABOR/REST(0)，FEAT/OPTS UTF8。
 * 设计要点：
 *   - 单账号认证（面板配置用户名/密码），连续失败 5 次断开
 *   - 全部文件操作锁定在 rootDir 内（虚拟路径白名单解析，拒 ..、盘符、分隔符注入），杜绝穿越
 *   - 被动模式端口范围可配（默认随机高位端口）；PORT 主动模式同支持（部分设备默认主动）
 *   - 单文件大小上限 maxFileSize，超限以 552 中止并删除半截文件；空闲超时 421 断开
 * 可在 Node 测试中直接使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATA_CONN_TIMEOUT_MS = 30000; // 数据通道建立等待上限
const MAX_CMD_LEN = 2048;           // 单条命令长度上限（防滥用）

const pad2 = (n) => String(n).padStart(2, '0');

/** 虚拟路径 → rootDir 内的真实路径。非法（穿越/盘符/分隔符注入）返回 null */
function resolveWithin(rootDir, vpath) {
  let p = String(vpath == null ? '' : vpath).trim();
  // RFC 959 允许 PWD/CWD 回复带引号，个别客户端 STOR 参数也可能带引号：剥掉
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
  const segs = [];
  for (const raw of p.split('/')) {
    const s = raw.trim();
    if (!s || s === '.') continue;
    if (s === '..' || s.indexOf('\\') >= 0 || s.indexOf(':') >= 0 || s.indexOf('\0') >= 0) return null;
    segs.push(s);
  }
  const root = path.resolve(rootDir);
  const full = segs.length ? path.resolve(root, ...segs) : root;
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** 数据连接就绪的包装：PASV 等待对端连入 / PORT 主动连出 */
class DataLink {
  constructor(conn, isPasv) {
    this.conn = conn;   // net.Server（PASV）或目标地址（PORT）
    this.isPasv = isPasv;
  }
}

class FtpConnection {
  constructor(server, socket) {
    this.server = server;
    this.sock = socket;
    this.buf = Buffer.alloc(0);
    this.authed = false;
    this.pendingUser = '';
    this.failCount = 0;
    this.utf8 = false;
    this.cwd = '';                 // 相对 rootDir 的虚拟目录（'' = '/'）
    this.type = 'I';
    this.pasvSrv = null;           // 待用的被动监听
    this.pasvSockPromise = null;
    this.portAddr = null;          // PORT 目标 {host,port}
    this.busy = false;             // 传输进行中（ABOR 用）
    this.closed = false;
    this.idleTimer = null;
    this.lastCmdAt = Date.now();
  }

  reply(a, b) {
    if (this.closed) return;
    const line = b == null ? String(a) : (a + ' ' + b);
    try { this.sock.write(line + '\r\n'); } catch (e) { /* ignore */ }
  }

  _bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.reply('421 空闲超时，连接关闭。');
      this.destroy();
    }, this.server.idleTimeoutMs);
    this.idleTimer.unref();
  }

  start() {
    this._bumpIdle();
    this.reply('220 NetTopo FTP 服务就绪。');
    this.sock.on('data', (d) => this._onData(d));
    this.sock.on('error', () => this.destroy());
    this.sock.on('close', () => this.destroy());
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this._closePasv();
    try { this.sock.destroy(); } catch (e) { /* ignore */ }
    this.server._connClosed(this);
  }

  _closePasv() {
    if (this.pasvSrv) { try { this.pasvSrv.close(); } catch (e) { /* ignore */ } this.pasvSrv = null; }
    if (this.pasvPending && this.pasvPending.sock) { try { this.pasvPending.sock.destroy(); } catch (e) { /* ignore */ } }
    this.pasvPending = null;
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 64 * 1024) { this.reply('500 命令过长。'); this.destroy(); return; }
    let idx;
    while ((idx = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.slice(0, idx).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (line.length > MAX_CMD_LEN) { this.reply('500 命令过长。'); continue; }
      this._dispatch(line);
      if (this.closed) return;
    }
  }

  _vpath(arg) {
    // 参数可能是绝对 /name、相对 name 或带子目录 a/b/name：一律折算到 cwd 下
    let p = String(arg == null ? '' : arg).trim();
    if (p.startsWith('/')) return resolveWithin(this.server.rootDir, p);
    return resolveWithin(this.server.rootDir, (this.cwd ? this.cwd + '/' : '') + p);
  }

  _dispatch(line) {
    this._bumpIdle();
    const sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
    switch (cmd) {
      case 'USER': this._cmdUser(arg); break;
      case 'PASS': this._cmdPass(arg); break;
      case 'AUTH': this.reply('502 不支持。'); break;
      case 'SYST': this.reply('215 UNIX Type: L8'); break;
      case 'FEAT': this.reply('211-Features:\r\n UTF8\r\n SIZE\r\n MDTM\r\n REST STREAM\r\n PASV\r\n EPSV\r\n TVFS\r\n211 End'); break;
      case 'OPTS':
        if (/^UTF8\s+ON$/i.test(arg)) { this.utf8 = true; this.reply('200 Always in UTF-8 mode.'); }
        else this.reply('504 不支持的选项。');
        break;
      case 'TYPE':
        if (arg === 'I' || arg === 'A' || arg === 'L 8') { this.type = arg === 'I' ? 'I' : 'A'; this.reply('200 切换到 ' + (this.type === 'I' ? '二进制' : 'ASCII') + '模式。'); }
        else this.reply('504 不支持的 TYPE。');
        break;
      case 'STRU': this.reply(arg.toUpperCase() === 'F' ? '200 OK.' : '504 仅支持 F。'); break;
      case 'MODE': this.reply(arg.toUpperCase() === 'S' ? '200 OK.' : '504 仅支持 S。'); break;
      case 'PWD': this.reply('257 "' + (this.cwd ? '/' + this.cwd : '/') + '" 是当前目录。'); break;
      case 'CWD': this._cmdCwd(arg); break;
      case 'CDUP': this._cmdCwd('..'); break;
      case 'NOOP': this.reply('200 NOOP OK.'); break;
      case 'QUIT': this.reply('221 再见。'); this.destroy(); break;
      case 'ABOR': this.reply('226 没有正在进行的传输。'); break;
      case 'PASV': this._cmdPasv(); break;
      case 'EPSV': this._cmdEpsv(); break;
      case 'PORT': this._cmdPort(arg); break;
      case 'STOR': this._cmdStor(arg); break;
      case 'RETR': this._cmdRetr(arg); break;
      case 'LIST': this._cmdList(arg, true); break;
      case 'NLST': this._cmdList(arg, false); break;
      case 'SIZE': this._cmdSize(arg); break;
      case 'MDTM': this._cmdMdtm(arg); break;
      case 'MKD': case 'XMKD': this._cmdMkd(arg); break;
      case 'DELE': this._cmdDele(arg); break;
      case 'RMD': this._cmdRmd(arg); break;
      case 'REST': this.reply(/^[0-9]+$/.test(arg) && parseInt(arg, 10) === 0 ? '350 重新从 0 开始。' : '504 仅支持 REST 0。'); break;
      case 'STAT': this.reply('211-NetTopo FTP\r\n211 结束'); break;
      case 'HELP': this.reply('214 站点命令：USER PASS TYPE PASV PORT STOR RETR LIST SIZE QUIT'); break;
      default: this.reply('500 未知命令。');
    }
  }

  _cmdUser(arg) {
    if (!arg) { this.reply('501 参数缺失。'); return; }
    this.pendingUser = arg;
    this.reply('331 请输入密码。');
  }

  _cmdPass(arg) {
    if (!this.pendingUser) { this.reply('503 请先 USER。'); return; }
    if (this.pendingUser === this.server.username && String(arg) === this.server.password) {
      this.authed = true;
      this.failCount = 0;
      this.reply('230 登录成功。');
    } else {
      if (++this.failCount >= 5) { this.reply('530 登录失败次数过多。'); this.destroy(); return; }
      this.reply('530 登录失败：用户名或密码错误。');
    }
    this.pendingUser = '';
  }

  _requireAuth() {
    if (this.authed) return true;
    this.reply('530 请先登录。');
    return false;
  }

  _cmdCwd(arg) {
    if (!this._requireAuth()) return;
    let target;
    if (arg === '..') {
      const segs = this.cwd ? this.cwd.split('/') : [];
      segs.pop();
      target = segs.join('/');
      this.cwd = target;
      this.reply('250 目录已切换。');
      return;
    }
    const full = this._vpath(arg);
    if (!full) { this.reply('550 路径非法。'); return; }
    try {
      const st = fs.lstatSync(full);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error();
      const root = path.resolve(this.server.rootDir);
      this.cwd = full === root ? '' : full.slice(root.length + 1).split(path.sep).join('/');
      this.reply('250 目录已切换。');
    } catch (e) { this.reply('550 目录不存在。'); }
  }

  /** 建立被动监听（本轮传输有效；范围端口占用时依次向后轮询，全部占用降级随机端口）。
   *  连接监听器必须在 listen 的同时就挂好：客户端收到 227 后可能立刻连入，
   *  若此时还没有 'connection' 监听，Node 会直接销毁已接受的连接（net.Server 语义）。 */
  _makePasv() {
    this._closePasv();
    const srv = net.createServer();
    this.pasvSrv = srv;
    this.pasvPending = { sock: null, resolve: null, timer: null }; // 对端连入 / STOR-RETR 消费，二者先到先得
    srv.on('connection', (s) => {
      try { srv.close(); } catch (e) { /* ignore */ }
      this.pasvSrv = null;
      const p = this.pasvPending;
      if (!p) { try { s.destroy(); } catch (e) { /* ignore */ } return; }
      clearTimeout(p.timer);
      if (p.resolve) { this.pasvPending = null; p.resolve(s); }
      else p.sock = s; // STOR/RETR 还没来：先持有这条连入（this.pasvPending 保持指向 p）
    });
    const tryListen = (port) => new Promise((resolve) => {
      if (this.closed) return resolve(false);
      const onErr = () => resolve(false);
      const onOk = () => { srv.removeListener('error', onErr); resolve(true); };
      srv.once('error', onErr);
      srv.once('listening', onOk);
      try { srv.listen(port, '0.0.0.0'); }
      catch (e) { srv.removeListener('error', onErr); srv.removeListener('listening', onOk); resolve(false); }
    });
    const range = this.server.pasvRange();
    return (async () => {
      for (let i = 0; i < range.count; i++) {
        if (await tryListen(range.min + ((range.next + i) % range.count))) return srv.address() ? srv.address().port : null;
      }
      if (await tryListen(0)) return srv.address() ? srv.address().port : null;
      this._closePasv();
      return null;
    })();
  }

  _advertisedIp() {
    let ip = this.sock.localAddress || '127.0.0.1';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip === '::1') ip = '127.0.0.1';
    return ip;
  }

  _cmdPasv() {
    if (!this._requireAuth()) return;
    this._makePasv().then((port) => {
      if (this.closed || !port) { this.reply('425 无法建立数据连接。'); return; }
      const ip = this._advertisedIp();
      const quads = ip.split('.').map(Number);
      if (quads.length !== 4 || quads.some(q => !Number.isInteger(q) || q < 0 || q > 255)) {
        this.reply('425 无法通告数据连接地址。');
        this._closePasv();
        return;
      }
      this.portAddr = null;
      this.reply('227 进入被动模式 (' + quads.join(',') + ',' + Math.floor(port / 256) + ',' + (port % 256) + ')。');
    });
  }

  _cmdEpsv() {
    if (!this._requireAuth()) return;
    this._makePasv().then((port) => {
      if (this.closed || !port) { this.reply('425 无法建立数据连接。'); return; }
      this.portAddr = null;
      this.reply('229 进入扩展被动模式 (|||' + port + '|)');
    });
  }

  _cmdPort(arg) {
    if (!this._requireAuth()) return;
    const parts = String(arg || '').split(',').map(s => parseInt(s, 10));
    if (parts.length !== 6 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
      this.reply('501 PORT 参数非法。');
      return;
    }
    // 防 FTP 反弹：PORT 目标必须与控制连接对端同源，否则认证后的客户端可借本服务
    // 向任意第三方 host:port 收发流量（内网端口探测面）
    const host = parts.slice(0, 4).join('.');
    const peerIp = (this.sock.remoteAddress || '').replace(/^::ffff:/, '');
    if (host !== peerIp) { this.reply('501 PORT 目标地址与控制连接来源不一致。'); return; }
    this._closePasv();
    this.portAddr = { host, port: parts[4] * 256 + parts[5] };
    this.reply('200 PORT 命令成功。');
  }

  /** 取一条可用的数据 socket（PASV：等对端连入或复用已连入的；PORT：主动连出） */
  _openData() {
    if (this.pasvPending || this.pasvSrv) {
      const p = this.pasvPending;
      if (p && p.sock) { this.pasvPending = null; return Promise.resolve(p.sock); }
      if (p && p.resolve) return Promise.resolve(null); // 已有人在等：不该发生（单命令串行）
      if (!p) return Promise.resolve(null);
      return new Promise((resolve) => {
        p.resolve = resolve;
        p.timer = setTimeout(() => {
          const cur = this.pasvPending;
          if (cur === p) { this.pasvPending = null; this._closePasv(); }
          resolve(null);
        }, DATA_CONN_TIMEOUT_MS);
      });
    }
    if (this.portAddr) {
      const addr = this.portAddr;
      this.portAddr = null;
      return new Promise((resolve) => {
        const s = net.connect(addr.port, addr.host);
        const t = setTimeout(() => { s.destroy(); resolve(null); }, DATA_CONN_TIMEOUT_MS);
        s.once('connect', () => { clearTimeout(t); resolve(s); });
        s.once('error', () => { clearTimeout(t); resolve(null); });
      });
    }
    return Promise.resolve(null);
  }

  _cmdStor(arg) {
    if (!this._requireAuth()) return;
    const full = this._vpath(arg);
    if (!full) { this.reply('550 路径非法。'); return; }
    const name = path.basename(full);
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const st = fs.lstatSync(full);
      if (st.isDirectory()) { this.reply('550 目标是目录。'); return; }
      if (!this.server.overwrite) { this.reply('550 文件已存在（未开启覆盖）。'); return; }
    } catch (e) { /* 不存在：正常 */ }
    const peerIp = this.sock.remoteAddress ? this.sock.remoteAddress.replace(/^::ffff:/, '') : '';
    this.reply('150 准备接收数据。');
    this.busy = true;
    this._openData().then((dataSock) => {
      if (this.closed || !dataSock) { this.reply('425 数据连接建立失败。'); this.busy = false; return; }
      const tmp = full + '.part-' + process.pid + '-' + Date.now();
      const ws = fs.createWriteStream(tmp, { flags: 'w' });
      let size = 0;
      let failed = false;
      const bail = (code, msg) => {
        if (failed) return;
        failed = true;
        try { ws.destroy(); } catch (e) { /* ignore */ }
        try { dataSock.destroy(); } catch (e) { /* ignore */ }
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
        this.reply(code, msg);
        this.busy = false;
      };
      // 写流异步错误（磁盘满/临时文件被锁）必须挂监听：无监听的 error 事件会崩掉主进程，
      // 且 Node 的 end 回调在流出错时仍会触发——不带 failed 门卫会把半截文件 rename 成成品
      ws.on('error', () => bail(451, '写入目标文件失败。'));
      dataSock.on('data', (chunk) => {
        this._bumpIdle(); // 数据传输期没有控制命令，空闲超时不能掐断慢速大文件
        size += chunk.length;
        if (size > this.server.maxFileSize) { bail(552, '超出单文件大小上限，传输中止。'); return; }
        ws.write(chunk);
      });
      dataSock.on('error', () => bail(426, '数据连接异常，传输中止。'));
      dataSock.on('close', (hadErr) => {
        if (failed) return;
        if (hadErr) { bail(426, '数据连接异常关闭。'); return; }
        ws.end(() => {
          if (failed) return;
          try { fs.renameSync(tmp, full); } catch (e) { bail(451, '写入目标文件失败。'); return; }
          this.server.stats.rxFiles++;
          this.server.stats.rxBytes += size;
          this.reply('226 传输完成（' + size + ' 字节）。');
          this.busy = false;
          this.server.emit('file', { svc: 'ftp', ip: peerIp, name, size, path: full, op: 'stor' });
        });
      });
    });
  }

  _cmdRetr(arg) {
    if (!this._requireAuth()) return;
    const full = this._vpath(arg);
    if (!full) { this.reply('550 路径非法。'); return; }
    let st;
    try {
      st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error();
    } catch (e) { this.reply('550 文件不存在。'); return; }
    this.reply('150 准备发送数据。');
    this.busy = true;
    this._openData().then((dataSock) => {
      if (this.closed || !dataSock) { this.reply('425 数据连接建立失败。'); this.busy = false; return; }
      const rs = fs.createReadStream(full);
      let failed = false;
      rs.on('data', () => this._bumpIdle()); // 下载传输期同样不能被空闲超时掐断
      rs.on('error', () => { if (!failed) { failed = true; this.reply('451 读取文件失败。'); try { dataSock.destroy(); } catch (e) { /* ignore */ } this.busy = false; } });
      dataSock.on('error', () => { if (!failed) { failed = true; try { rs.destroy(); } catch (e) { /* ignore */ } this.reply(426, '数据连接异常，传输中止。'); this.busy = false; } });
      dataSock.on('close', () => {
        if (failed) return;
        this.reply('226 传输完成。');
        this.busy = false;
        this.server.stats.txFiles++;
      });
      rs.pipe(dataSock);
    });
  }

  _cmdList(arg, long) {
    if (!this._requireAuth()) return;
    // 忽略 -a/-l 之类开关参数
    const p = String(arg || '').replace(/^-\w*\s*/, '').trim();
    const full = p ? this._vpath(p) : this._vpath(this.cwd || '/');
    if (!full) { this.reply('550 路径非法。'); return; }
    let names = [];
    try { names = fs.readdirSync(full); } catch (e) { this.reply('550 目录不存在。'); return; }
    const lines = [];
    for (const n of names.slice(0, 500)) {
      if (n.endsWith('.part') || n.includes('.part-')) continue;
      let st;
      try { st = fs.lstatSync(path.join(full, n)); } catch (e) { continue; }
      if (st.isSymbolicLink()) continue;
      if (!long) { lines.push(n); continue; }
      const d = new Date(st.mtimeMs);
      const dateStr = MONTHS[d.getMonth()] + ' ' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      const perm = st.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--';
      lines.push(perm + ' 1 nettopo nettopo ' + String(st.size).padStart(12) + ' ' + dateStr + ' ' + n);
    }
    this.reply('150 这里是目录列表。');
    this.busy = true;
    this._openData().then((dataSock) => {
      if (this.closed || !dataSock) { this.reply('425 数据连接建立失败。'); this.busy = false; return; }
      dataSock.end(lines.length ? lines.join('\r\n') + '\r\n' : '');
      dataSock.on('close', () => { if (!this.closed) { this.reply('226 目录列表发送完成。'); this.busy = false; } });
      dataSock.on('error', () => { if (!this.closed) { this.reply(426, '数据连接异常。'); this.busy = false; } });
    });
  }

  _cmdSize(arg) {
    if (!this._requireAuth()) return;
    const full = this._vpath(arg);
    if (!full) { this.reply('550 路径非法。'); return; }
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error();
      this.reply('213 ' + st.size);
    } catch (e) { this.reply('550 文件不存在。'); }
  }

  _cmdMdtm(arg) {
    if (!this._requireAuth()) return;
    const full = this._vpath(arg);
    if (!full) { this.reply('550 路径非法。'); return; }
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error();
      const d = new Date(st.mtimeMs);
      this.reply('213 ' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()));
    } catch (e) { this.reply('550 文件不存在。'); }
  }

  _cmdMkd(arg) {
    if (!this._requireAuth()) return;
    const full = this._vpath(arg);
    if (!full) { this.reply('550 路径非法。'); return; }
    try { fs.mkdirSync(full, { recursive: false }); this.reply('257 目录已创建。'); }
    catch (e) { this.reply('550 无法创建目录。'); }
  }

  _cmdRmd(arg) {
    if (!this._requireAuth()) return;
    const full = this._vpath(arg);
    if (!full || full === path.resolve(this.server.rootDir)) { this.reply('550 路径非法。'); return; }
    try { fs.rmdirSync(full); this.reply('250 目录已删除。'); }
    catch (e) { this.reply('550 无法删除目录。'); }
  }

  _cmdDele(arg) {
    if (!this._requireAuth()) return;
    const full = this._vpath(arg);
    if (!full) { this.reply('550 路径非法。'); return; }
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error();
      fs.unlinkSync(full);
      this.reply('250 文件已删除。');
    } catch (e) { this.reply('550 删除失败：文件不存在或被占用。'); }
  }
}

class FtpServer extends EventEmitter {
  /** @param opts { rootDir, username, password, maxFileSize, maxSessions, idleTimeoutMs, pasvMin, pasvMax, overwrite } */
  constructor(opts) {
    super();
    opts = opts || {};
    this.rootDir = opts.rootDir;
    this.username = String(opts.username || 'nettopo');
    this.password = String(opts.password == null ? 'nettopo' : opts.password);
    this.maxFileSize = Math.max(1024, Math.floor(Number(opts.maxFileSize) || 64 * 1024 * 1024));
    this.maxSessions = Math.max(1, Math.floor(Number(opts.maxSessions) || 4));
    this.idleTimeoutMs = Math.max(10000, Math.floor(Number(opts.idleTimeoutMs) || 10 * 60 * 1000));
    this.overwrite = opts.overwrite !== false;
    this.pasvMin = Math.floor(Number(opts.pasvMin) || 0);
    this.pasvMax = Math.floor(Number(opts.pasvMax) || 0);
    this._pasvNext = 0;
    this.srv = null;
    this.port = 0;
    this.running = false;
    this.lastError = '';
    this.conns = new Set();
    this.stats = { rxFiles: 0, rxBytes: 0, txFiles: 0, denied: 0 };
    try { fs.mkdirSync(this.rootDir, { recursive: true }); } catch (e) { /* start 时再报 */ }
  }

  /** 认证与限制项热更新（不重启监听） */
  setAuth(o) {
    o = o || {};
    if (typeof o.username === 'string' && o.username.trim()) this.username = o.username.trim().slice(0, 64);
    if (typeof o.password === 'string') this.password = o.password.slice(0, 64);
    if (typeof o.overwrite === 'boolean') this.overwrite = o.overwrite;
    if (Number.isFinite(Number(o.maxFileSize))) this.maxFileSize = Math.max(1024, Math.floor(Number(o.maxFileSize)));
  }

  pasvRange() {
    let min = this.pasvMin, max = this.pasvMax;
    if (!(min >= 1024 && max >= min && max - min <= 2000)) return { min: 0, count: 0, next: 0 };
    const count = max - min + 1;
    const next = (this._pasvNext++) % count;
    return { min, count, next };
  }

  start(port) {
    if (this.running) return Promise.resolve({ ok: true, port: this.port });
    return new Promise((resolve) => {
      const srv = net.createServer();
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { srv.close(); } catch (e) { /* ignore */ }
        this.running = false;
        this.lastError = String((err && err.message) || err);
        resolve({ ok: false, error: this._bindHint(this.lastError) });
      };
      srv.once('error', fail);
      srv.listen(port || 0, '0.0.0.0', () => {
        if (settled) return;
        settled = true;
        this.srv = srv;
        this.port = srv.address().port;
        this.running = true;
        this.lastError = '';
        srv.on('connection', (socket) => {
          if (this.conns.size >= this.maxSessions) {
            this.stats.denied++;
            try { socket.end('421 连接数已达上限。\r\n'); } catch (e) { /* ignore */ }
            return;
          }
          const conn = new FtpConnection(this, socket);
          this.conns.add(conn);
          conn.start();
        });
        srv.on('error', (err) => { this.lastError = String(err && err.message || err); this.stop(); });
        srv.on('close', () => { this.running = false; });
        resolve({ ok: true, port: this.port });
      });
    });
  }

  _bindHint(err) {
    const e = String(err || '');
    if (/EACCES|permission/i.test(e)) return '监听端口被系统拒绝（Linux 下 21 等特权端口需 root，请在面板改用高位端口）';
    if (/EADDRINUSE/i.test(e)) return '端口已被占用（其它 FTP 服务或本软件另一实例）';
    return e || '监听失败';
  }

  async stop() {
    this.running = false;
    for (const c of [...this.conns]) { try { c.destroy(); } catch (e) { /* ignore */ } }
    if (this.srv) { const s = this.srv; this.srv = null; try { s.close(); } catch (e) { /* ignore */ } }
  }

  _connClosed(conn) { this.conns.delete(conn); }

  status() {
    return {
      running: this.running, port: this.port, error: this.lastError,
      sessions: this.conns.size, rxFiles: this.stats.rxFiles, rxBytes: this.stats.rxBytes, denied: this.stats.denied
    };
  }
}

module.exports = { FtpServer, resolveWithin };
