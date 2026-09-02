/* NetTopo 内置 Syslog 服务器 —— 主进程纯 Node 模块（不依赖 Electron）
 * 用途：局域网设备配置 logging host <本机IP>（Cisco）/ info-center loghost <本机IP>（华为/H3C）后，
 *       集中收集设备日志：按 来源主机/日期 归档落盘 + 内存环形缓冲供界面实时查看与关键字检索。
 * 实现：
 *   - UDP（RFC 3164 BSD syslog，也兼容 RFC 5424 头）与可选 TCP（RFC 6587，换行分隔 / 字节数 framing）
 *   - 消息解析：PRI(设施/严重级别) → RFC5424 → RFC3164 → 裸文本 三级回退；无时间戳用本机接收时间
 *   - 存储：<baseDir>/<主机名或来源IP>/<YYYY-MM-DD>.log，行格式「时间 [级别/设施] 主机 消息」
 *   - 防洪限速（每秒 maxPerSec 条，超出丢弃并计数）、按天滚动、过期清理（keepDays）
 *   - 目录/文件名全部白名单清洗 + 最终路径必须仍在 baseDir 内，杜绝穿越
 * 可在 Node 测试中直接使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const SEV_NAMES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const FAC_NAMES = ['kernel', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_MSG_LEN = 8 * 1024;        // 单条消息长度上限（超长截断）
const MAX_RING = 1000;               // 环形缓冲条数
const TAIL_MAX = 300;                // 单次返回条数上限
const MAX_LINE_SEARCH = 4 * 1024 * 1024; // 检索单文件读取上限

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');

/** 主机名/来源 IP → 目录名（白名单清洗，防分隔符注入与穿越） */
function sanitizeHostDir(s) {
  let out = String(s == null ? '' : s).trim();
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_');
  out = out.replace(/\.\./g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!out) out = 'unknown';
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = '_' + out;
  if (out.length > 60) out = out.slice(0, 60);
  return out;
}

/** 解析一条 syslog 消息（文本已按 framing 切出）。peerHost 为传输层来源地址（兜底主机名）
 *  返回 { pri, facility, severity, ts(ms|null), host, tag, msg } */
function parseSyslogMsg(text, peerHost) {
  let rest = String(text == null ? '' : text);
  let pri = null;
  const m = rest.match(/^<(\d{1,3})>/);
  if (m) {
    pri = Math.min(191, Math.max(0, parseInt(m[1], 10) || 0));
    rest = rest.slice(m[0].length);
  }
  let ts = null;
  let host = String(peerHost || '').replace(/^::ffff:/, '') || 'unknown';
  let tag = '';
  let msg = rest;
  let hit = false;
  // RFC 5424：VERSION=1 ISO 时间戳 HOST APP PROCID MSGID SD MSG
  const m5 = rest.match(/^1 (\S+) (\S+) (\S+) (\S+) (\S+)(?: ([\s\S]*))?$/);
  if (m5) {
    ts = parseIsoTs(m5[1]);
    if (m5[2] !== '-') host = m5[2];
    tag = m5[3] !== '-' ? m5[3] : '';
    msg = m5[6] == null ? '' : m5[6];
    // 剥 STRUCTURED-DATA（一或多个 [...] 块；转义 \] 忽略）
    let body = msg;
    while (body.startsWith('[')) {
      let i = 1, closed = false;
      for (; i < body.length; i++) {
        if (body[i] === '\\') { i++; continue; }
        if (body[i] === ']') { closed = true; break; }
      }
      if (!closed) break;
      body = body.slice(i + 1);
    }
    msg = body.replace(/^[ \t]+/, '');
    hit = ts != null;
  }
  // RFC 3164：Mmm dd HH:MM:SS HOST TAG[: ]MSG（无年份 → 本地当前年；跨年边界回退一年）
  if (!hit) {
    const m3 = rest.match(/^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\S+)(?: ([\s\S]*))?$/);
    if (m3) {
      const mi = MONTHS.indexOf(m3[1]);
      if (mi >= 0) {
        const now = new Date();
        let d = new Date(now.getFullYear(), mi, parseInt(m3[2], 10), parseInt(m3[3], 10), parseInt(m3[4], 10), parseInt(m3[5], 10));
        if (d.getTime() > now.getTime() + 86400000) d = new Date(now.getFullYear() - 1, mi, parseInt(m3[2], 10), parseInt(m3[3], 10), parseInt(m3[4], 10), parseInt(m3[5], 10));
        ts = d.getTime();
        host = m3[6];
        msg = m3[7] == null ? '' : m3[7];
        hit = true;
      }
    }
  }
  // TAG 提取：sshd[123]: / %LINK-3-UPDOWN: / daemon.info 形态取首词（冒号留在分隔位不入 tag）
  const mt = msg.match(/^([A-Za-z0-9_.%\\/+\-#]+)(?:\[\d+\])?:?\s*/);
  if (mt && mt[1].length <= 32) tag = tag || mt[1];
  msg = msg.replace(/[\r\n]+$/, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if (msg.length > MAX_MSG_LEN) msg = msg.slice(0, MAX_MSG_LEN);
  const facility = pri == null ? null : Math.floor(pri / 8);
  const severity = pri == null ? null : pri % 8;
  return { pri, facility, severity, ts, host, tag, msg };
}

function parseIsoTs(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/);
  if (!m) return null;
  const ms = m[7] ? parseInt((m[7] + '00').slice(0, 3), 10) : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  if (m[8] && m[8] !== 'Z') {
    // +08:00 表示墙钟超前 UTC 8 小时：UTC = 墙钟 − 偏移（负偏移则加回）
    const off = (+m[8].slice(1, 3)) * 60 + (+m[8].slice(4, 6));
    t += (m[8][0] === '-' ? 1 : -1) * off * 60000;
  } else if (!m[8]) {
    // 无时区标记按本地时间解释（设备与采集机通常同时区）
    const l = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
    t = l.getTime();
  }
  return t;
}

function fmtLogLine(d, ent) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + pad3(d.getMilliseconds())
    + ' [' + (ent.severity == null ? '-' : SEV_NAMES[ent.severity]) + '/' + (ent.facility == null ? '-' : FAC_NAMES[ent.facility] || String(ent.facility)) + '] '
    + ent.host + ' ' + (ent.msg || '');
}

function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

class SyslogServer extends EventEmitter {
  /** @param opts { baseDir, ringMax=1000, keepDays=90, maxPerSec=200 } */
  constructor(opts) {
    super();
    opts = opts || {};
    this.baseDir = opts.baseDir;
    this.ringMax = Math.max(50, Math.floor(Number(opts.ringMax) || MAX_RING));
    this.keepDays = Math.max(1, Math.floor(Number(opts.keepDays) || 90));
    this.maxPerSec = Math.max(10, Math.floor(Number(opts.maxPerSec) || 200));
    this.udp = null;
    this.tcp = null;
    this.port = 0;
    this.tcpOn = false;
    this.running = false;
    this.lastError = '';
    this.ring = [];
    this.seq = 0;
    this.streams = new Map();   // 'host\x00date' -> fs.WriteStream
    this.lastDay = '';
    this.stats = { rxMsgs: 0, dropped: 0, hosts: 0 };
    this._winStart = 0;
    this._winCount = 0;
    try { fs.mkdirSync(this.baseDir, { recursive: true }); } catch (e) { /* start 时再报 */ }
    this._cleanupOld();
  }

  start(port, withTcp) {
    if (this.running) return Promise.resolve({ ok: true, port: this.port });
    const wantTcp = withTcp === true;
    return new Promise((resolve) => {
      const udp = dgram.createSocket('udp4');
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { udp.close(); } catch (e) { /* ignore */ }
        this.running = false;
        this.lastError = String((err && err.message) || err);
        resolve({ ok: false, error: this._bindHint(this.lastError) });
      };
      udp.once('error', fail);
      udp.bind(port || 0, () => {
        if (settled) return;
        const udpPort = udp.address().port;
        const afterUdp = () => {
          if (settled) return;
          settled = true;
          this.udp = udp;
          this.port = udpPort;
          this.running = true;
          this.lastError = '';
          udp.on('message', (buf, rinfo) => {
            try { this._ingest(buf.toString('utf8'), rinfo.address); } catch (e) { /* ignore */ }
          });
          udp.on('error', (err) => { this.lastError = String(err && err.message || err); this.stop(); });
          udp.on('close', () => { this.running = false; });
          resolve({ ok: true, port: this.port });
        };
        if (!wantTcp) { afterUdp(); return; }
        const tcp = net.createServer();
        const failTcp = (err) => {
          if (settled) return;
          settled = true;
          try { udp.close(); } catch (e) { /* ignore */ }
          try { tcp.close(); } catch (e) { /* ignore */ }
          this.running = false;
          this.lastError = String((err && err.message) || err);
          resolve({ ok: false, error: this._bindHint(this.lastError) });
        };
        tcp.once('error', failTcp);
        // TCP 与 UDP 同端口（不同协议互不冲突）；仅接受整行/字节数 framing 的 RFC 6587。
        // 随机端口场景（port=0）TCP 必须跟随 UDP 实际绑定的端口，保证「同端口」语义
        tcp.listen(udpPort, '0.0.0.0', () => {
          if (settled) return;
          tcp.removeListener('error', failTcp);
          this.tcp = tcp;
          tcp.on('error', (err) => { this.lastError = String(err && err.message || err); this.stop(); });
          tcp.on('connection', (s) => this._onTcpConn(s));
          afterUdp();
        });
      });
    });
  }

  _onTcpConn(sock) {
    let acc = Buffer.alloc(0);
    // 空闲保护覆盖整个连接生命周期：每收到数据都重置（否则发过一条消息后保护消失，
    // 对端僵死/NAT 重置出的半开 TCP 连接会缓慢累积句柄）
    let idle = null;
    const bumpIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { try { sock.destroy(); } catch (e) { /* ignore */ } }, 5 * 60 * 1000);
      idle.unref();
    };
    bumpIdle();
    const peer = sock.remoteAddress || '';
    // framing 判定（RFC 6587）：null 未知，'octet' 已确认字节数帧，'newline' 已确认换行切分。
    // 裸文本消息以「数字 空格」开头（如 "100 errors detected"）会被误读成 octet 帧头且帧
    // 永远凑不齐——帧未收全期间若已等到换行，则判定本连接为换行 framing，避免整条流死锁丢日志
    let framing = null;
    sock.on('data', (d) => {
      bumpIdle();
      acc = Buffer.concat([acc, d]);
      if (acc.length > 1 * 1024 * 1024) { try { sock.destroy(); } catch (e) { /* ignore */ } return; }
      // 循环切帧：RFC 6587 字节数 framing（"NNN msg"，首字节为数字）优先，否则换行分隔的非透明 framing
      for (;;) {
        if (framing !== 'newline') {
          const head = acc.toString('latin1', 0, 16).match(/^(\d{1,10}) /);
          if (head) {
            const prefixLen = head[1].length + 1;
            const len = parseInt(head[1], 10);
            if (len > MAX_MSG_LEN * 4) { try { sock.destroy(); } catch (e) { /* ignore */ } return; }
            if (acc.length >= prefixLen + len) {
              this._ingest(acc.slice(prefixLen, prefixLen + len).toString('utf8'), peer);
              acc = acc.slice(prefixLen + len);
              framing = 'octet';
              continue;
            }
            if (acc.indexOf(0x0a) >= 0) framing = 'newline'; // 换行先到：并非 octet 流，落回换行切分
            else break; // 帧未收全，等待后续数据
          }
        }
        const nl = acc.indexOf(0x0a);
        if (nl >= 0) {
          this._ingest(acc.toString('utf8', 0, nl).replace(/\r$/, ''), peer);
          acc = acc.slice(nl + 1);
          continue;
        }
        break;
      }
    });
    sock.on('error', () => { if (idle) clearTimeout(idle); });
    sock.on('close', () => { if (idle) clearTimeout(idle); });
  }

  _bindHint(err) {
    const e = String(err || '');
    if (/EACCES|permission/i.test(e)) return '监听端口被系统拒绝（Linux 下 514 等特权端口需 root，请在面板改用高位端口）';
    if (/EADDRINUSE/i.test(e)) return '端口已被占用（其它 Syslog 服务或本软件另一实例）';
    return e || '监听失败';
  }

  async stop() {
    this.running = false;
    if (this.udp) { const s = this.udp; this.udp = null; try { s.close(); } catch (e) { /* ignore */ } }
    if (this.tcp) { const s = this.tcp; this.tcp = null; try { s.close(); } catch (e) { /* ignore */ } }
    for (const st of this.streams.values()) { try { st.end(); } catch (e) { /* ignore */ } }
    this.streams.clear();
  }

  /** 限速 + 解析 + 落盘 + 环形缓冲 */
  _ingest(text, peer) {
    const now = Date.now();
    if (now - this._winStart >= 1000) { this._winStart = now; this._winCount = 0; }
    if (++this._winCount > this.maxPerSec) { this.stats.dropped++; return; }
    const ent = parseSyslogMsg(text, peer);
    ent.ts = ent.ts == null ? now : ent.ts;
    ent.seq = ++this.seq;
    this.stats.rxMsgs++;
    this.ring.push({ seq: ent.seq, ts: ent.ts, host: ent.host, facility: ent.facility, severity: ent.severity, tag: ent.tag, msg: ent.msg });
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    this._writeEntry(ent);
    this.emit('message', ent);
  }

  _writeEntry(ent) {
    const d = new Date(ent.ts);
    const day = fmtDate(d);
    // 过期清理按本机墙上时钟的「天」滚动触发一次：消息时间戳可能因设备时钟错误落在
    // 过去/未来（差出一天即触发），若按消息日期触发会在正常消息后立即清掉刚写入的
    // 「旧日期」文件（设备时钟回拨场景下日志一写就丢）
    const localDay = fmtDate(new Date());
    if (this.lastDay && this.lastDay !== localDay) this._cleanupOld();
    this.lastDay = localDay;
    const hostDir = sanitizeHostDir(ent.host);
    const base = path.resolve(this.baseDir);
    const dir = path.resolve(base, hostDir);
    if (!dir.startsWith(base + path.sep)) return; // 纵深兜底：清洗后仍须在库内
    const key = hostDir + '\x00' + day;
    let st = this.streams.get(key);
    if (!st) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        st = fs.createWriteStream(path.join(dir, day + '.log'), { flags: 'a' });
        st.on('error', () => { this.streams.delete(key); }); // 写失败：丢弃该流，下次重建
        this.streams.set(key, st);
        if (this.streams.size > 64) { // 主机数过多时收敛：关掉最早的一半（防句柄耗尽）
          const keys = [...this.streams.keys()].slice(0, 32);
          for (const k of keys) { const old = this.streams.get(k); this.streams.delete(k); try { old.end(); } catch (e) { /* ignore */ } }
        }
      } catch (e) { return; }
    }
    try { st.write(fmtLogLine(d, ent) + '\n'); } catch (e) { /* ignore */ }
  }

  /** 删除超过 keepDays 天的日期文件（按文件名日期判定） */
  _cleanupOld() {
    try {
      const cutoff = Date.now() - this.keepDays * 86400000;
      for (const host of fs.readdirSync(this.baseDir)) {
        const hd = path.join(this.baseDir, host);
        let st;
        try { st = fs.lstatSync(hd); } catch (e) { continue; }
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        for (const f of fs.readdirSync(hd)) {
          const m = f.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
          if (!m) continue;
          const full = path.join(hd, f);
          let fst;
          try { fst = fs.lstatSync(full); } catch (e) { continue; }
          if (fst.mtimeMs > Date.now() - 3600000) continue; // 近 1 小时内有写入的不清（设备时钟错误也会持续写「旧日期」文件）
          const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
          if (Number.isFinite(t) && t < cutoff) { try { fs.unlinkSync(full); } catch (e) { /* ignore */ } }
        }
      }
    } catch (e) { /* ignore */ }
  }

  /** 环形缓冲增量拉取（seq 之后的条目） */
  tail(sinceSeq) {
    const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
    const msgs = this.ring.filter(m => m.seq > since).slice(-TAIL_MAX);
    return { msgs, last: this.seq, dropped: this.stats.dropped };
  }

  /** 跨文件关键字检索：keyword 必填；host 可选过滤（目录名精确匹配） */
  search(q) {
    const keyword = String((q && q.keyword) || '').trim().slice(0, 200);
    if (!keyword) return { ok: false, error: '关键字为空' };
    const hostFilter = String((q && q.host) || '').trim() ? sanitizeHostDir(String(q.host).trim()) : '';
    const lower = keyword.toLowerCase();
    const items = [];
    let total = 0;
    let hosts = [];
    try { hosts = fs.readdirSync(this.baseDir); } catch (e) { hosts = []; }
    outer:
    for (const host of hosts) {
      if (hostFilter && host !== hostFilter) continue;
      const hd = path.join(this.baseDir, host);
      let st;
      try { st = fs.lstatSync(hd); } catch (e) { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      let files = [];
      try { files = fs.readdirSync(hd).sort().reverse(); } catch (e) { continue; }
      for (const f of files) {
        if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
        const full = path.join(hd, f);
        try { st = fs.lstatSync(full); } catch (e) { continue; }
        if (!st.isFile() || st.isSymbolicLink()) continue;
        let content = '';
        try { content = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
        if (content.length > MAX_LINE_SEARCH) content = content.slice(-MAX_LINE_SEARCH);
        const lines = content.split('\n');
        const matches = [];
        for (let i = 0; i < lines.length; i++) {
          if (total >= 500) break outer;
          if (lines[i] && lines[i].toLowerCase().indexOf(lower) >= 0) {
            matches.push(lines[i].slice(0, 400));
            total++;
          }
        }
        if (matches.length) items.push({ host, date: f.slice(0, 10), matches });
        if (items.length >= 100) break outer;
      }
    }
    return { ok: true, keyword, total, items };
  }

  status() {
    return {
      running: this.running, port: this.port, tcp: !!this.tcp, error: this.lastError,
      rxMsgs: this.stats.rxMsgs, dropped: this.stats.dropped, buffered: this.ring.length
    };
  }
}

module.exports = { SyslogServer, parseSyslogMsg, sanitizeHostDir, SEV_NAMES, FAC_NAMES };
