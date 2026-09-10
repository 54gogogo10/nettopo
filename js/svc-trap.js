/* NetTopo 内置 SNMP Trap 接收器 —— 主进程纯 Node 模块（不依赖 Electron）
 * 用途：局域网设备配置 trap 目标指向本机（华为/H3C snmp-agent target-host、思科 snmp-server host）后，
 *       接收设备主动上报的告警（接口 Down/Up、冷/热启动、认证失败、企业私有 Trap）：
 *       - 协议：SNMPv1 Trap（PDU 0xa4）与 SNMPv2c Trap（PDU 0xa7）；InformRequest（0xa6）按协议回 GetResponse 应答
 *       - 解析：手写 BER/ASN.1（零依赖）；标准 Trap OID 映射中文名；Varbind 值按类型解码（OID/整数/字符串/IP/TimeTicks/Counter64）
 *       - 存储：<baseDir>/<来源IP>/<YYYY-MM-DD>.log，行格式「时间 版本 团体名 trap=名称(OID) uptime=N varbind…」
 *       - 防洪限速（每秒 maxPerSec 包，超出丢弃并计数）、环形缓冲供界面实时查看、按天归档、过期清理（keepDays）
 *       - 目录/文件名白名单清洗 + 最终路径必须仍在 baseDir 内，杜绝穿越；畸形包一律丢弃不抛错
 * 可在 Node 测试中直接使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { normalizeV3User, parseV3Message } = require('./snmp-v3.js');

const MAX_RING = 1000;               // 环形缓冲条数
const TAIL_MAX = 300;                // 单次返回条数上限
const MAX_VARBINS = 64;              // 单包解析 varbind 数上限（防畸形包撑爆内存）
const MAX_TEXT = 300;                // 单值/汇总文本长度上限
const MAX_OID_LEN = 256;             // OID 文本上限（正常 OID 远小于此；超长 body 不得放大为巨串）
const MAX_OID_ARCS = 128;            // OID 子标识符个数上限
const MAX_SUMMARY = 800;             // 单条汇总 varbind 文本上限
const MAX_HOST_DIRS = 1024;          // 来源目录数上限（来源 IP 可伪造，防 UDP 洪泛撑爆目录项；与 syslog 同口径）
const MAX_NEW_DIRS_PER_MIN = 60;     // 每分钟新建来源目录数上限（名额可 LRU 回收后仍需限住目录洪流速率）
const WRITE_BACKLOG_LIMIT = 8 * 1024 * 1024; // 单写流积压上限（慢盘下防用户态缓冲无界增长）
const UPTIME_OID = '1.3.6.1.2.1.1.3.0';        // sysUpTime.0
const TRAPOID_OID = '1.3.6.1.6.3.1.1.4.1.0';   // snmpTrapOID.0（v2c 首 varbind 约定）
const TRAP_BASE = '1.3.6.1.6.3.1.1.5.';        // 标准 Trap 前缀（.1 coldStart … .6 egpNeighborLoss）

/** 标准 Trap OID → 中文名 */
const STANDARD_TRAPS = {
  '1': 'coldStart（冷启动）',
  '2': 'warmStart（热启动）',
  '3': 'linkDown（接口断开）',
  '4': 'linkUp（接口恢复）',
  '5': 'authenticationFailure（认证失败）',
  '6': 'egpNeighborLoss（EGP 邻居丢失）'
};

/** 解析 TLV（与 monitor.js 同款）：返回 {tag, body, next}；越界/长度异常返回 null */
function tlvWalk(buf, start) {
  if (start + 2 > buf.length) return null;
  const tag = buf[start];
  let len = buf[start + 1];
  let hs = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4 || start + 2 + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + 2 + i];
    hs = 2 + n;
  }
  if (start + hs + len > buf.length) return null;
  return { tag, body: buf.subarray(start + hs, start + hs + len), next: start + hs + len };
}

function decodeOid(b) {
  if (!b || !b.length) return '';
  const arr = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = (v << 7) | (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { arr.push(v); v = 0; if (arr.length >= MAX_OID_ARCS) break; }
  }
  let s = arr.join('.');
  if (s.length > MAX_OID_LEN) s = s.slice(0, MAX_OID_LEN) + '…';
  return s;
}

function readUInt(b) {
  if (!b || !b.length || b.length > 8) return null;
  return [...b].reduce((a, x) => a * 256 + x, 0);
}

function cleanText(s) {
  let t = String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\r\n]+/g, ' ')   // 值内嵌换行会伪造归档行，折为空格（与 syslog 同口径）
    .trim();
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + '…';
  return t;
}

/** varbind 列表 → 单行汇总文本（限量 8 条 + 总长截断，防超长 OID/值在环形缓冲与归档中放大） */
function summarize(vbs) {
  const s = (vbs || []).slice(0, 8).map(v => v.oid + '=' + v.value).join(' ');
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY) + '…' : s;
}

/** 按 ASN.1 应用类型解码 varbind 值 → 可读文本 */
function decodeValue(tag, body) {
  switch (tag) {
    case 0x02: { const n = readUInt(body); return n == null ? '' : String(n); }          // INTEGER
    case 0x04: return cleanText(body.toString('utf8'));                                   // OCTET STRING
    case 0x05: return '';                                                                 // NULL
    case 0x06: return decodeOid(body);                                                    // OID
    case 0x40: return body && body.length === 4 ? [...body].join('.') : '';               // IpAddress
    case 0x41: case 0x42: case 0x43: { const n = readUInt(body); return n == null ? '' : String(n); } // Counter/Gauge/TimeTicks
    case 0x46: { const n = readUInt(body); return n == null ? '' : String(n); }           // Counter64
    case 0x0c: return cleanText(body.toString('utf8'));                                   // OctetString(位串变体)
    default: { try { return body.toString('hex').slice(0, 64) || ''; } catch (e) { return ''; } } // 其它按 hex
  }
}

/** 标准/企业 Trap OID → { name, standard, specific }。oid 为 snmpTrapOID.0 的值 */
function trapNameOf(oid) {
  const s = String(oid || '');
  if (s.startsWith(TRAP_BASE)) {
    const rest = s.slice(TRAP_BASE.length);
    const m = rest.match(/^(\d+)(?:\.(.*))?$/);
    if (m) {
      const n = m[1];
      if (n === '6' && m[2]) return { name: 'enterpriseSpecific（企业自定义 #' + m[2] + '）', standard: false, specific: m[2] };
      if (STANDARD_TRAPS[n]) return { name: STANDARD_TRAPS[n], standard: true, specific: null };
    }
  }
  return { name: s ? 'enterprise（' + s + '）' : 'unknown', standard: false, specific: null };
}

/** 解析 SNMPv1/v2c Trap 包 →
 *  { ok:true, version:'v1'|'v2c', community, agent, trapOid, trapName, standard, generic, specific, uptimeTicks, varbinds:[{oid,value}] }
 *  非 Trap 包 / 畸形包 / v3 返回 { ok:false, reason }。纯函数可测。 */
function parseTrapPacket(buf) {
  if (!Buffer.isBuffer(buf)) return { ok: false, reason: '非 Buffer' };
  if (buf.length < 8 || buf.length > 64 * 1024) return { ok: false, reason: '包长异常' };
  const root = tlvWalk(buf, 0);
  if (!root || root.tag !== 0x30) return { ok: false, reason: '非 SEQUENCE' };
  let cur = 0;
  const fields = [];
  while (cur < root.body.length) {
    const t = tlvWalk(root.body, cur);
    if (!t) return { ok: false, reason: '字段截断' };
    fields.push(t);
    cur = t.next;
  }
  if (fields.length < 3) return { ok: false, reason: '字段不足' };
  const verT = fields[0];
  const ver = verT.tag === 0x02 ? readUInt(verT.body) : null;
  if (ver === 3) return { ok: false, isV3: true, reason: 'SNMP v3（走 USM 通道）' };
  if (ver !== 0 && ver !== 1) return { ok: false, reason: '不支持的 SNMP 版本（仅 v1/v2c/v3）' };
  const commT = fields[1];
  const community = cleanText(commT && commT.tag === 0x04 ? commT.body.toString('utf8') : '');
  const pdu = fields[2];
  if (ver === 0) {
    // SNMPv1 Trap（0xa4）：企业OID, 代理地址(0x40), generic, specific, TimeTicks, varbinds
    if (pdu.tag !== 0xa4) return { ok: false, reason: 'v1 包非 Trap PDU' };
    const pf = [];
    let k = 0;
    while (k < pdu.body.length) {
      const t = tlvWalk(pdu.body, k);
      if (!t) return { ok: false, reason: 'PDU 截断' };
      pf.push(t);
      k = t.next;
    }
    if (pf.length < 6) return { ok: false, reason: 'v1 Trap 字段不足' };
    const enterprise = decodeOid(pf[0].body);
    const agent = pf[1].tag === 0x40 && pf[1].body.length === 4 ? [...pf[1].body].join('.') : '';
    const generic = readUInt(pf[2].body);
    const specific = readUInt(pf[3].body);
    const uptimeTicks = readUInt(pf[4].body);
    const varbinds = parseVarbinds(pf[5]);
    // v1 generic 0~5 对应标准 Trap；6 为 enterpriseSpecific(specific)
    let oid, name;
    if (generic != null && generic >= 0 && generic <= 5) {
      oid = TRAP_BASE + (generic + 1);
      name = STANDARD_TRAPS[String(generic + 1)];
    } else if (generic === 6) {
      oid = enterprise + '.' + (specific != null ? specific : '0');
      name = 'enterpriseSpecific（企业自定义 #' + (specific != null ? specific : '0') + '）';
    } else {
      oid = enterprise;
      name = 'enterprise（' + enterprise + '）';
    }
    return {
      ok: true, version: 'v1', community, agent, enterprise,
      trapOid: oid, trapName: name, standard: generic != null && generic <= 5,
      generic: generic == null ? -1 : generic, specific: specific == null ? 0 : specific,
      uptimeTicks: uptimeTicks == null ? null : uptimeTicks, varbinds
    };
  }
  // SNMPv2c Trap（0xa7）/ InformRequest（0xa6）：request-id, error, errIndex, varbinds
  if (pdu.tag !== 0xa7 && pdu.tag !== 0xa6) return { ok: false, reason: 'v2c 包非 Trap/Inform PDU' };
  const pf = [];
  let k = 0;
  while (k < pdu.body.length) {
    const t = tlvWalk(pdu.body, k);
    if (!t) return { ok: false, reason: 'PDU 截断' };
    pf.push(t);
    k = t.next;
  }
  if (pf.length < 4) return { ok: false, reason: 'v2c Trap 字段不足' };
  const varbinds = parseVarbinds(pf[3]);
  let trapOid = '';
  let uptimeTicks = null;
  const rest = [];
  for (const vb of varbinds) {
    if (vb.oid === TRAPOID_OID) trapOid = vb.value;
    else if (vb.oid === UPTIME_OID) uptimeTicks = Number(vb.value) || null;
    else rest.push(vb);
  }
  const tn = trapNameOf(trapOid);
  return {
    ok: true, version: 'v2c', community, agent: '',
    trapOid: tn.name === 'unknown' ? '' : trapOid, trapName: tn.name, standard: tn.standard,
    generic: -1, specific: tn.specific || 0,
    uptimeTicks, varbinds: rest,
    inform: pdu.tag === 0xa6,
    pduRaw: pdu // inform 应答需要原 varbind 区（TrapServer 内部使用，测试可忽略）
  };
}

/** 解析 varbind 序列（SEQUENCE of {OID, value}）；畸形行跳过，数量封顶 */
function parseVarbinds(seqT) {
  const out = [];
  if (!seqT || seqT.tag !== 0x30) return out;
  let k = 0;
  while (k < seqT.body.length && out.length < MAX_VARBINS) {
    const vb = tlvWalk(seqT.body, k);
    if (!vb) break;
    k = vb.next;
    let j = 0;
    const parts = [];
    while (j < vb.body.length) {
      const t = tlvWalk(vb.body, j);
      if (!t) break;
      parts.push(t);
      j = t.next;
    }
    const oidT = parts[0], valT = parts[1];
    if (!oidT || oidT.tag !== 0x06) continue;
    out.push({ oid: decodeOid(oidT.body), value: valT ? decodeValue(valT.tag, valT.body) : '' });
  }
  return out;
}

/** 主机名/来源 IP → 目录名（与 syslog 同款白名单清洗） */
function sanitizeHostDir(s) {
  let out = String(s == null ? '' : s).trim();
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_');
  out = out.replace(/\.\./g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!out) out = 'unknown';
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = '_' + out;
  if (out.length > 60) out = out.slice(0, 60);
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');
function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

/** TimeTicks（1/100 秒）→ 可读时长（空值返回空串） */
function fmtUptime(ticks) {
  const s = Math.floor(Number(ticks) / 100);
  if (!Number.isFinite(s) || s < 0) return '';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd' + h + 'h';
  if (h > 0) return h + 'h' + m + 'm';
  return m + 'm' + (s % 60) + 's';
}

class TrapServer extends EventEmitter {
  /** @param opts { baseDir, keepDays=90, maxPerSec=100, ringMax=1000 } */
  constructor(opts) {
    super();
    opts = opts || {};
    this.baseDir = opts.baseDir;
    this.keepDays = Math.max(1, Math.floor(Number(opts.keepDays) || 90));
    this.maxPerSec = Math.max(5, Math.floor(Number(opts.maxPerSec) || 100));
    // SNMP v3 USM 接收用户（最多 8 个）：v3 Trap 按包内用户名匹配后验签/解密，未匹配或验签失败丢弃计数
    this.v3Users = (Array.isArray(opts.v3Users) ? opts.v3Users : []).map(x => normalizeV3User(x)).filter(Boolean).slice(0, 8);
    // v1/v2c 团体字白名单（可选，逗号分隔）：非空时 community 不符即丢弃。
    // v1/v2c 无源认证，任意 LAN 主机可伪造 linkDown 等告警并冒充真实设备——配置白名单可挡（空=收全部，兼容既有部署）
    this.communities = (Array.isArray(opts.communities) ? opts.communities : String(opts.communities || '').split(','))
      .map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 16);
    this.ringMax = Math.max(50, Math.floor(Number(opts.ringMax) || MAX_RING));
    this.udp = null;
    this.port = 0;
    this.running = false;
    this.lastError = '';
    this.ring = [];
    this.seq = 0;
    this.streams = new Map();  // 'ip\x00date' -> WriteStream
    // 已落盘来源目录名缓存（Set，**插入序即 LRU 序**；null=惰性，首条落盘时从磁盘初始化）；
    // 满员时逐出队首而非永久丢弃——见 _writeEntry 的双闸说明
    this.hostDirs = null;
    this._newDirWinStart = 0;
    this._newDirWinCount = 0;
    // 目录回收静默期（与 syslog 同口径）：名额满时回收「无活跃写流且已静默」的来源目录，
    // 使目录总量在伪造源 IP 洪流下有界；回收计数进 stats.dirsRecycled，不做无声删除
    this.hostDirReclaimMs = Math.max(60000, Math.floor(Number(opts.hostDirReclaimMs) || 30 * 60000));
    this.lastDay = '';
    this.stats = { rxPackets: 0, malformed: 0, dropped: 0, v3Unknown: 0, v3AuthFail: 0, communityReject: 0, diskDropped: 0, dirsRecycled: 0, hostsOverCap: 0 };
    this._winStart = 0;
    this._winCount = 0;
    try { fs.mkdirSync(this.baseDir, { recursive: true }); } catch (e) { /* start 时再报 */ }
    this._cleanupOld();
  }

  start(port) {
    if (this.running) return Promise.resolve({ ok: true, port: this.port });
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
        settled = true;
        this.udp = udp;
        this.port = udp.address().port;
        this.running = true;
        this.lastError = '';
        udp.on('message', (buf, rinfo) => this._ingest(buf, rinfo && rinfo.address, rinfo && rinfo.port));
        udp.on('error', (err) => { this.lastError = String(err && err.message || err); this.stop(); });
        udp.on('close', () => { this.running = false; });
        resolve({ ok: true, port: this.port });
      });
    });
  }

  _bindHint(err) {
    const e = String(err || '');
    if (/EACCES|permission/i.test(e)) return '监听端口被系统拒绝（162 等特权端口需 root，请在面板改用高位端口）';
    if (/EADDRINUSE/i.test(e)) return '端口已被占用（其它 Trap 接收器或本软件另一实例）';
    return e || '监听失败';
  }

  async stop() {
    this.running = false;
    if (this.udp) { const s = this.udp; this.udp = null; try { s.close(); } catch (e) { /* ignore */ } }
    for (const st of this.streams.values()) { try { st.end(); } catch (e) { /* ignore */ } }
    this.streams.clear();
  }

  _ingest(buf, peer, peerPort) {
    const now = Date.now();
    if (now - this._winStart >= 1000) { this._winStart = now; this._winCount = 0; }
    if (++this._winCount > this.maxPerSec) { this.stats.dropped++; return; }
    this.stats.rxPackets++;
    const r = parseTrapPacket(buf);
    if (!r.ok) {
      if (r.isV3) { this._ingestV3(buf, peer); return; }
      this.stats.malformed++; return;
    }
    // v1/v2c 团体字白名单：配置后 community 不符即丢弃（无认证协议的唯一源过滤手段）
    if (this.communities.length && !this.communities.includes(r.community)) { this.stats.communityReject++; return; }
    if (r.inform) { r._peerAddr = String(peer || '').replace(/^::ffff:/, ''); r._peerPort = peerPort; this._answerInform(r); }
    const summary = summarize(r.varbinds);
    const ent = {
      seq: ++this.seq,
      ts: now,
      host: String(peer || '').replace(/^::ffff:/, '') || 'unknown',
      version: r.version,
      community: r.community,
      trap: r.trapName,
      oid: r.trapOid,
      standard: !!r.standard,
      agent: r.agent,
      uptimeTicks: r.uptimeTicks,
      uptime: fmtUptime(r.uptimeTicks),
      msg: summary
    };
    this.ring.push(ent);
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    this._writeEntry(ent);
    this.emit('trap', ent);
  }

  /** SNMP v3 Trap 接收：按包内用户名匹配本端 v3 用户 → 先验签后解密（parseV3Message 内固定顺序）→ 提取 Trap。
   *  未知用户 / 验签失败分别计数丢弃（不出环形缓冲，防噪音）；time 窗不校验（Trap 无会话语义）。 */
  _ingestV3(buf, peer) {
    // v3 包的 userName 在签名保护内：逐个本端用户尝试验签/解密（用户数封顶 8）
    let full = null;
    let matched = null;
    let lastReason = '';
    for (const u of this.v3Users) {
      const r = parseV3Message(buf, { user: u });
      if (r.ok) { full = r; matched = u; break; }
      lastReason = r.reason || '';
    }
    if (!full) {
      // 从失败原因提取包内用户名做分类：「用户不匹配（X）」（本端无此用户；明文/noAuth 包的
      // userName 校验走此路径）与「用户 X 未配置认证密钥」（级别不符）都携带用户名；捕获不能
      // 排除字母 s（旧正则 [^s）] 会让含 s 用户名误入 v3AuthFail 而非 v3Unknown）
      const mm = /用户不匹配（(.+?)）/.exec(lastReason) || /用户 (.+?) 未配置/.exec(lastReason);
      if (mm && !this.v3Users.some(x => x.user === mm[1])) this.stats.v3Unknown++; // 包内用户未在本端配置
      else this.stats.v3AuthFail++;                                              // 已配置用户但验签/解密失败
      return;
    }
    // 安全级别以本端配置为准，不信包内自报：parseV3Message 的是否认证由发送方 flags 决定，
    // 伪造 flags=0 的 noAuth 包可原样通过明文解析——本端用户要求认证（auth/authPriv）时，
    // 未认证包一律按验签失败丢弃，否则局域网任意主机可注入 linkDown 等伪造告警
    //（本端用户显式配置为 noAuth 空口令时照常接收，等价于 v2c 的无认证语义）
    if (matched.level !== 'noAuth' && !full.authenticated) { this.stats.v3AuthFail++; return; }
    // priv 档同样强制：本端配置 authPriv 而收到「已认证但明文」的降级包（flags 无 priv、
    // msgData 非 OCTET STRING）也拒收——持认证凭据但无隐私密钥方不得以明文注入告警
    if (matched.level === 'authPriv' && !full.decrypted) { this.stats.v3AuthFail++; return; }
    if (full.pduTag !== 0xa7) { this.stats.malformed++; return; } // 仅收 Trap（inform 应答不在 v3 接收范围）
    let trapOid = '';
    let uptimeTicks = null;
    const rest = [];
    for (const vb of (full.varbinds || [])) {
      if (vb.oid === TRAPOID_OID) trapOid = vb.value;
      else if (vb.oid === UPTIME_OID) uptimeTicks = Number(vb.value) || null;
      else rest.push(vb);
    }
    const tn = trapNameOf(trapOid);
    const summary = summarize(rest);
    const ent = {
      seq: ++this.seq,
      ts: Date.now(),
      host: String(peer || '').replace(/^::ffff:/, '') || 'unknown',
      version: 'v3',
      community: '',
      trap: tn.name,
      oid: tn.name === 'unknown' ? '' : trapOid,
      standard: !!tn.standard,
      agent: '',
      uptimeTicks,
      uptime: fmtUptime(uptimeTicks),
      msg: summary
    };
    this.ring.push(ent);
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    this._writeEntry(ent);
    this.emit('trap', ent);
  }

  /** InformRequest 协议要求回 GetResponse（同 request-id + 原 varbind 区），否则设备会反复重发。
   *  UDP 无连接：按触发包的来源地址/端口回源（_ingest 已挂在 r 上）。 */
  _answerInform(r) {
    try {
      if (!this.udp || !r.pduRaw || !r._peerAddr) return;
      const pf = r.pduRaw;
      // PDU body：request-id, error-status, error-index, varbinds —— 取 rid，varbinds 从第 4 个 TLV 起原样回显
      const ridT = tlvWalk(pf.body, 0);
      if (!ridT) return;
      let off = ridT.next;
      for (let i = 0; i < 2; i++) {
        const t = tlvWalk(pf.body, off);
        if (!t) return;
        off = t.next;
      }
      const varb = Buffer.from(pf.body.subarray(off));
      // INTEGER/长度均按最小补码编码：正数首字节高位为 1 时补前导 0；长度 ≥256 需 0x82 两字节
      // （企业 inform 的 varbind 区常超 255 字节，此前 0x81 截断为低 8 位产出坏包，设备重发不止）
      const uintBytes = (n) => { const b = []; let v = n >>> 0; do { b.unshift(v & 0xff); v = v >>> 8; } while (v); if (b[0] & 0x80) b.unshift(0); return b; };
      const berLen = (n) => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]) : n < 16777216 ? Buffer.from([0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]) : Buffer.from([0x84, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
      const berTlv = (tag, body) => Buffer.concat([Buffer.from([tag]), berLen(body.length), body]);
      const rid = readUInt(ridT.body) || 0;
      const pdu = Buffer.concat([berTlv(0x02, Buffer.from(uintBytes(rid))), berTlv(0x02, Buffer.from([0])), berTlv(0x02, Buffer.from([0])), varb]);
      const body = Buffer.concat([Buffer.from([0x02, 0x01, 0x01]), berTlv(0x04, Buffer.from(String(r.community || ''), 'utf8'))]);
      const msg = berTlv(0x30, Buffer.concat([body, berTlv(0xa2, pdu)]));
      this.udp.send(msg, r._peerPort, r._peerAddr, () => {});
    } catch (e) { /* 应答失败不阻断 */ }
  }

  _writeEntry(ent) {
    const d = new Date(ent.ts);
    const day = fmtDate(d);
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
      // 来源目录数封顶：来源 IP 可伪造，UDP 洪泛下每条换一个伪 IP 会持续新建目录耗尽目录项。
      // 与 syslog 同口径的「LRU 名额 + 新建限速」双闸：满员逐出最久未写的来源（只回收内存名额、
      // 不删日志），保证真实来源永远拿得到名额；新目录单独限速以防名额回收后仍被目录洪流打满。
      if (this.hostDirs === null) {
        this.hostDirs = new Set();
        try {
          for (const h of fs.readdirSync(base)) {
            try { if (fs.lstatSync(path.join(base, h)).isDirectory()) this.hostDirs.add(h); } catch (e2) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }
      }
      const known = this.hostDirs.has(hostDir);
      if (known || this.hostDirs.size < MAX_HOST_DIRS) {
        if (known) {
          this.hostDirs.delete(hostDir); this.hostDirs.add(hostDir); // 命中即移到队尾（LRU）
        } else {
          const nowMs = Date.now();
          if (nowMs - this._newDirWinStart >= 60000) { this._newDirWinStart = nowMs; this._newDirWinCount = 0; }
          if (++this._newDirWinCount > MAX_NEW_DIRS_PER_MIN) { this.stats.diskDropped++; return; }
          this.hostDirs.add(hostDir);
        }
      } else {
        // 满员：回收「最久未写且已静默」的来源目录（攻击者自造的目录会被自己的洪流优先回收）；
        // 找不到可回收目标时仍放行写入，绝不永久饿死新来源，并计入 hostsOverCap
        if (!this._reclaimHostDir(base)) this.stats.hostsOverCap++;
        this.hostDirs.add(hostDir);
      }
      try {
        try { if (fs.lstatSync(dir).isSymbolicLink()) { this.stats.diskDropped++; return; } } catch (e2) { /* 不存在则照常创建 */ }
        fs.mkdirSync(dir, { recursive: true });
        st = fs.createWriteStream(path.join(dir, day + '.log'), { flags: 'a' });
        st.on('error', () => { this.streams.delete(key); });
        this.streams.set(key, st);
        if (this.streams.size > 64) {
          const keys = [...this.streams.keys()].slice(0, 32);
          for (const k of keys) { const old = this.streams.get(k); this.streams.delete(k); try { old.end(); } catch (e) { /* ignore */ } }
        }
      } catch (e) { this.stats.diskDropped++; return; }
    }
    const line = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + pad3(d.getMilliseconds())
      + ' [' + ent.version + '] community=' + (ent.community || '-') + ' uptime=' + (ent.uptime || '-')
      + ' trap=' + ent.trap + ' oid=' + (ent.oid || '-')
      + (ent.msg ? ' ' + ent.msg : '');
    // 写流背压：写不动时丢弃本条并计数（环形缓冲与实时推送不受影响），积压过高直接重建该流
    try {
      if (!st.write(line + '\n')) {
        this.stats.diskDropped++;
        if (st.writableLength > WRITE_BACKLOG_LIMIT) { this.streams.delete(key); try { st.destroy(); } catch (e) { /* ignore */ } }
      }
    } catch (e) { this.stats.diskDropped++; }
  }

  /** 名额满时回收一个「已静默」的来源目录（按 LRU 序尝试；条件与 syslog 同口径）：
   *  无活跃写流 + 目录内无符号链接 + 最新文件 mtime 早于 hostDirReclaimMs。成功返回目录名。 */
  _reclaimHostDir(base) {
    if (!this.hostDirs) return null;
    const nowMs = Date.now();
    for (const h of this.hostDirs) {
      let active = false;
      for (const k of this.streams.keys()) { if (k.slice(0, k.indexOf('\x00')) === h) { active = true; break; } }
      if (active) continue;
      const hd = path.join(base, h);
      if (!hd.startsWith(base + path.sep)) continue; // 纵深：只动库内目录
      let newest = 0, ok = true;
      try {
        for (const f of fs.readdirSync(hd)) {
          const fst = fs.lstatSync(path.join(hd, f));
          if (fst.isSymbolicLink()) { ok = false; break; }
          if (fst.mtimeMs > newest) newest = fst.mtimeMs;
        }
      } catch (e) { ok = false; }
      if (!ok) continue;
      if (nowMs - newest < this.hostDirReclaimMs) continue;
      try { fs.rmSync(hd, { recursive: true, force: true }); } catch (e) { continue; }
      this.hostDirs.delete(h);
      this.stats.dirsRecycled++;
      return h;
    }
    return null;
  }

  /** 删除超过 keepDays 天的日期文件（按文件名日期判定，与 syslog 同口径） */
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
          if (fst.mtimeMs > Date.now() - 3600000) continue;
          const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
          if (Number.isFinite(t) && t < cutoff) { try { fs.unlinkSync(full); } catch (e) { /* ignore */ } }
        }
        // 清理过期日志后顺手删掉空来源目录（rmdir 仅在目录为空时成功）；有活跃写流的来源跳过
        let streaming = false;
        for (const k of this.streams.keys()) { if (k.slice(0, k.indexOf('\x00')) === host) { streaming = true; break; } }
        if (!streaming) {
          try { fs.rmdirSync(hd); if (this.hostDirs) this.hostDirs.delete(host); } catch (e) { /* 非空：忽略 */ }
        }
        // 目录已在外部被删除时同步剔除内存名额，否则名额被幽灵条目永久占用
        try { if (!fs.existsSync(hd) && this.hostDirs) this.hostDirs.delete(host); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  /** 环形缓冲增量拉取（seq 之后的条目） */
  tail(sinceSeq) {
    const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
    const msgs = this.ring.filter(m => m.seq > since).slice(-TAIL_MAX);
    return { msgs, last: this.seq, dropped: this.stats.dropped, malformed: this.stats.malformed };
  }

  status() {
    return {
      running: this.running, port: this.port, error: this.lastError,
      rxPackets: this.stats.rxPackets, malformed: this.stats.malformed, dropped: this.stats.dropped,
      diskDropped: this.stats.diskDropped, dirsRecycled: this.stats.dirsRecycled,
      hostsOverCap: this.stats.hostsOverCap, hosts: this.hostDirs ? this.hostDirs.size : 0, buffered: this.ring.length,
      v3Users: this.v3Users.length, v3Unknown: this.stats.v3Unknown, v3AuthFail: this.stats.v3AuthFail,
      communityGuard: this.communities.length > 0, communityReject: this.stats.communityReject
    };
  }
}

module.exports = { TrapServer, parseTrapPacket, trapNameOf, sanitizeHostDir, STANDARD_TRAPS, UPTIME_OID, TRAPOID_OID };
