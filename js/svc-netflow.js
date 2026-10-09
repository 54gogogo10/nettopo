/* NetTopo 内置 NetFlow / IPFIX 收集器 —— 主进程纯 Node 模块（不依赖 Electron）
 * 用途：局域网设备配置 netflow 导出目标指向本机（华为/H3C ip netstream export、思科 ip flow-export
 *       destination、Linux softflowd/fprobe）后，接收流量记录回答「这条链路上的流量到底是谁发给谁」——
 *       现有「接口流量」采集只有接口级速率（ifTable），没有会话级视图。
 *       - 协议：NetFlow v5（固定 48 字节记录）、NetFlow v9（模板流 + 数据流）、IPFIX（v10，模板机制与 v9 同构）
 *       - 解析：零依赖手写字节布局；v9/IPFIX 模板按「来源 IP + sourceId + 模板Id」缓存，模板先于数据到达才可解
 *       - 存储：明细环形缓冲（界面实时查看，tail 增量拉取与 Trap/Syslog 同口径）+ 五元组会话聚合表（TopN 视图）
 *       - 防洪限速（默认 500 包/秒，超出丢弃并计数）、聚合会话数与模板数上限（畸形包/恶意源不撑爆内存）
 *       - 畸形包一律丢弃不抛错（长度对不上的 FlowSet 跳过并计数）
 * 可在 Node 测试中直接使用。
 */
'use strict';
const dgram = require('dgram');
const { EventEmitter } = require('events');

const MAX_RING = 5000;              // 明细环形缓冲条数
const TAIL_MAX = 300;               // 单次返回条数上限
const MAX_FLOWS_PER_PKT = 200;      // 单包流记录条数上限（v5 count 可被伪造成 65535）
const MAX_SESSIONS = 65536;         // 五元组聚合会话上限（超限整表清最旧 1/4，宁可丢历史不撑爆内存）
const MAX_TEMPLATES = 512;          // 模板缓存上限（每源每模板一条；伪造源可膨胀，超限清最旧）
const MAX_TPL_PER_PKT = 64;         // 单包可接受的模板数上限（一包可塞上千个 0 字段模板冲掉缓存）
const MAX_TPL_PER_EXPORTER = 256;   // 每个 exporter 的模板上限（分桶：外部源不得挤掉真实设备的模板）
const MAX_PKT = 65535;              // UDP 包长度上限
const DEFAULT_MAX_PPS = 500;        // 防洪：每秒包数上限

/** IP 协议号 → 名称（展示用；未列的显示编号） */
const IP_PROTO = { 1: 'ICMP', 2: 'IGMP', 6: 'TCP', 17: 'UDP', 41: 'IPv6隧道', 47: 'GRE', 50: 'ESP', 51: 'AH', 89: 'OSPF', 103: 'PIM', 132: 'SCTP' };
const protoName = (p) => IP_PROTO[p] || String(p);

/** v9/IPFIX 信息元素（字段类型）→ 记录槽位。核心字段两版编号一致；未映射的类型跳过其长度。
 *  v9: 8=IPV4_SRC_ADDR 12=IPV4_DST_ADDR 7=L4_SRC_PORT 11=L4_DST_PORT 1=IN_BYTES 2=IN_PKTS 6=TCP_FLAGS
 *  IPFIX 同号沿用；27/28 为 IPv6 源/目的地址。21/22（LAST/FIRST_SWITCHED）是 sysUpTime 时刻，
 *  不能当差值映射（见 TS_FIRST/TS_LAST），故不进本表。 */
const FIELD_MAP = {
  1: 'bytes', 2: 'pkts', 4: 'proto', 6: 'tcpFlags',
  7: 'sport', 8: 'src', 11: 'dport', 12: 'dst',
  10: 'inIf', 14: 'outIf', 27: 'src', 28: 'dst'
};
const TS_FIRST = 22, TS_LAST = 21; // v9 sysUpTime 毫秒时刻：durMs = last − first

function ipv4Str(b, off) {
  return b[off] + '.' + b[off + 1] + '.' + b[off + 2] + '.' + b[off + 3];
}
function ipv6Str(b, off) {
  const g = [];
  for (let i = 0; i < 8; i++) g.push(((b[off + i * 2] << 8) | b[off + i * 2 + 1]).toString(16));
  return g.join(':');
}
function readUint(b, off, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[off + i];
  return v;
}

/* ---------------- NetFlow v5（固定布局） ---------------- */
/** 解析 v5 包：头 24 字节 + 每记录 48 字节；count 与实际长度不符按可解析条数如实返回 */
function parseV5(buf, out) {
  const count = buf.readUInt16BE(2);
  const n = Math.min(count, MAX_FLOWS_PER_PKT, Math.floor((buf.length - 24) / 48));
  for (let i = 0; i < n; i++) {
    const o = 24 + i * 48;
    const first = readUint(buf, o + 24, 4), last = readUint(buf, o + 28, 4);
    out.push({
      src: ipv4Str(buf, o), dst: ipv4Str(buf, o + 4),
      inIf: buf.readUInt16BE(o + 12) || 0, outIf: buf.readUInt16BE(o + 14) || 0,
      pkts: readUint(buf, o + 16, 4), bytes: readUint(buf, o + 20, 4),
      durMs: (last >= first) ? (last - first) : 0,
      sport: buf.readUInt16BE(o + 32), dport: buf.readUInt16BE(o + 34),
      tcpFlags: buf[o + 37], proto: buf[o + 38]
    });
  }
  return { records: n, headerCount: count };
}

/* ---------------- NetFlow v9 / IPFIX（模板机制） ---------------- */
/** 解析模板 FlowSet（v9 id=0 数据模板 / id=1 选项模板；IPFIX id=2 / id=3）：返回新增/更新的模板数组 */
function parseTemplates(fsBody, isIpfix) {
  const tpls = [];
  let p = 0;
  while (p + 4 <= fsBody.length) {
    const tplId = readUint(fsBody, p, 2);
    if (tplId < 256) break;                       // 模板 Id 从 256 起，读到非法值即止（剩余为 padding）
    let fields = [];
    if (isIpfix) {
      const fc = readUint(fsBody, p + 2, 2);
      p += 4;
      for (let i = 0; i < fc && p + 4 <= fsBody.length; i++, p += 4) {
        fields.push({ type: readUint(fsBody, p, 2), len: readUint(fsBody, p + 2, 2) });
      }
    } else {
      // v9：数据模板 fieldCount 对；选项模板 scopeLength+optionLength（都是字节长度，内含 (type,len) 对）
      const fc = readUint(fsBody, p + 2, 2);
      p += 4;
      for (let i = 0; i < fc && p + 4 <= fsBody.length; i++, p += 4) {
        fields.push({ type: readUint(fsBody, p, 2), len: readUint(fsBody, p + 2, 2) });
      }
    }
    tpls.push({ id: tplId, fields });
  }
  return tpls;
}

/** 模板缓存淘汰：prefix 非空时只淘汰该前缀（单个 exporter）名下的最旧条目，直到不超过 limit；
 *  prefix 传 null 时对整表做兜底淘汰。按 Map 插入序（= 最近更新序）删最旧的一半。
 *  分桶淘汰的意义：任何单个来源（含伪造源）都只能挤掉**自己**的模板，不会连累真实设备的解析。 */
function evictTemplates(tmpl, prefix, limit) {
  const keys = [];
  for (const k of tmpl.keys()) { if (!prefix || k.indexOf(prefix) === 0) keys.push(k); }
  const over = keys.length - limit;
  if (over <= 0) return;
  for (const k of keys.slice(0, over)) tmpl.delete(k);   // 按插入序删最旧，只在本桶内删
}

/** 解析一个 UDP 包。tmpl 为调用方持有的模板缓存（Map: "exporter|sourceId|tplId" → {fields, totalLen}），
 *  模板随包更新。返回 {ok, version, records, templates, dropped, error}——纯函数可单测。 */
function parseNetflowPacket(buf, exporter, tmpl) {
  const out = [];
  if (!Buffer.isBuffer(buf) || buf.length < 8) return { ok: false, error: '包过短', records: out, templates: [], dropped: 0 };
  const version = buf.readUInt16BE(0);
  if (version !== 5 && version !== 9 && version !== 10) return { ok: false, error: '不支持的版本 ' + version, records: out, templates: [], dropped: 0 };
  // 按版本的最小头长：v5=24、v9=20、IPFIX=16。短包在此如实丢弃——否则下方 readUInt32BE(12/16)
  // 抛 RangeError，违反「畸形包一律丢弃不抛错」的模块契约（虽有 _onPacket 兜底 try/catch）
  const minHdr = version === 5 ? 24 : (version === 10 ? 16 : 20);
  if (buf.length < minHdr) return { ok: false, error: '包过短', records: out, templates: [], dropped: 0 };
  if (version === 5) {
    const r = parseV5(buf, out);
    return { ok: true, version: 5, records: out, templates: [], headerCount: r.headerCount, dropped: 0 };
  }
  const isIpfix = version === 10;
  // 头：v9 = version,count,sysUpTime,unix_secs,sequence,source_id（20B）；IPFIX = version,count,unix_secs,sequence,observationDomain（16B）
  const count = buf.readUInt16BE(2);
  const sourceId = isIpfix ? buf.readUInt32BE(12) : buf.readUInt32BE(16);
  const hdrLen = isIpfix ? 16 : 20;
  let p = hdrLen;
  let dropped = 0;
  const newTpls = [];
  let parsed = 0;
  while (p + 4 <= buf.length && parsed < count && parsed < MAX_FLOWS_PER_PKT) {
    const fsId = readUint(buf, p, 2);
    const fsLen = readUint(buf, p + 2, 2);
    if (fsLen < 4 || p + fsLen > buf.length) break;          // 长度异常：余下内容不可信，整段丢弃
    const body = buf.subarray(p + 4, p + fsLen);
    if (fsId === 0 || fsId === 2 || fsId === 1 || fsId === 3) {
      // 模板 / 选项模板 FlowSet：解析并缓存（同 Id 重复声明以最新为准——设备重启换布局）
      const tpls = parseTemplates(body, isIpfix);
      for (const t of tpls) {
        if (newTpls.length >= MAX_TPL_PER_PKT) break;          // 单包模板数封顶：一包不得冲掉整个缓存
        const totalLen = t.fields.reduce((a, f) => a + (f.len === 65535 ? 1 : f.len), 0); // 可变长字段按 1 字节计（展开时再跳）
        const key = exporter + '|' + sourceId + '|' + t.id;
        if (tmpl.has(key)) tmpl.delete(key);                   // 先删后插：保持插入序 = 最近更新序
        tmpl.set(key, { fields: t.fields, totalLen });
        newTpls.push(t);
        // 分桶淘汰：只在本 exporter 自己的模板里淘汰最旧的，**别的来源（真实设备）不受影响**
        // （旧实现全局删最旧一半，一个伪造包就能把真实设备模板冲掉 → 流量视图静默空白）
        evictTemplates(tmpl, exporter + '|', MAX_TPL_PER_EXPORTER);
        evictTemplates(tmpl, null, MAX_TEMPLATES);
      }
    } else if (fsId >= 256) {
      // 数据 FlowSet：按模板逐条展开；模板未到（设备先发数据后发模板 / 换了模板 Id）整段记 dropped
      const t = tmpl.get(exporter + '|' + sourceId + '|' + fsId);
      if (!t) { dropped++; p += fsLen; continue; }
      // 模板字段总长为 0（fieldCount=0 的模板，或字段长度全为 0）时内层循环没有任何步进：
      // fOff 不变 → q 不变、parsed 只在解出 src/dst 时自增 → while 条件恒真，主进程被
      // 一个 32 字节的 UDP 包占死（NetFlow 端口默认开放，同网段任意主机可发）。
      // 这类模板无信息可用，整段按丢弃处理。
      if (!(t.totalLen > 0)) { dropped++; p += fsLen; continue; }
      let q = 0;
      while (q + t.totalLen <= body.length && parsed < MAX_FLOWS_PER_PKT) {
        let fOff = q;
        const rec = { src: '', dst: '', sport: 0, dport: 0, proto: 0, bytes: null, pkts: null, tcpFlags: null, inIf: null, outIf: null, durMs: null };
        let first = null, last = null;
        for (const f of t.fields) {
          if (f.len === 65535) {                               // IPFIX 可变长：1 字节长度（255 时 3 字节）
            let vl = body[fOff];
            if (vl === 255) {
              // 长度域自身越界：本条记录余下不可信，交由统一的越界出口按 dropped 计
              if (fOff + 3 > body.length) { fOff = body.length + 1; break; }
              vl = body.readUInt16BE(fOff + 1); fOff += 3;
            } else fOff += 1;
            fOff += vl;
            continue;
          }
          if (fOff + f.len > body.length) { fOff = body.length + 1; break; }
          const slot = FIELD_MAP[f.type];
          if (slot === 'src' && f.len === 4) rec.src = ipv4Str(body, fOff);
          else if (slot === 'src' && f.len === 16) rec.src = ipv6Str(body, fOff);
          else if (slot === 'dst' && f.len === 4) rec.dst = ipv4Str(body, fOff);
          else if (slot === 'dst' && f.len === 16) rec.dst = ipv6Str(body, fOff);
          else if (slot && f.len <= 8 && f.len > 0) {
            const v = readUint(body, fOff, f.len);
            if (slot === 'bytes') rec.bytes = v;
            else if (slot === 'pkts') rec.pkts = v;
            else if (slot === 'proto') rec.proto = v;
            else if (slot === 'tcpFlags') rec.tcpFlags = v;
            else if (slot === 'sport') rec.sport = v;
            else if (slot === 'dport') rec.dport = v;
            else if (slot === 'inIf') rec.inIf = v;
            else if (slot === 'outIf') rec.outIf = v;
          }
          if (f.type === TS_FIRST) first = readUint(body, fOff, f.len);
          if (f.type === TS_LAST) last = readUint(body, fOff, f.len);
          fOff += f.len;
        }
        if (fOff > body.length) { dropped++; break; }          // 字段越界：本 FlowSet 剩余不可信
        if (rec.src || rec.dst) {
          if (rec.durMs == null && first != null && last != null && last >= first) rec.durMs = last - first;
          out.push(rec);
          parsed++;
        } else dropped++;
        q = fOff > q ? fOff : q + 1;   // 无条件推进：即便字段布局异常也不允许零步进（纵深，防死循环）
      }
    }
    // 未知 FlowSet Id（1~255 间的保留值）：按长度跳过
    p += fsLen;
  }
  return { ok: true, version, records: out, templates: newTpls, dropped };
}

/* ---------------- 收集器服务器 ---------------- */
/** NetFlow / IPFIX 收集器：UDP 接收 + 明细环形缓冲 + 五元组聚合（TopN） */
class NetflowServer extends EventEmitter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.maxPps = Math.max(1, Math.floor(Number(opts.maxPps) || DEFAULT_MAX_PPS));
    this.sock = null;
    this.port = 0;
    this.tmpl = new Map();           // "exporter|sourceId|tplId" → {fields, totalLen}
    this.ring = [];                  // 明细：{seq, ts, exporter, version, ...record}
    this.seq = 0;
    this.agg = new Map();            // "src>dst proto sport>dport" → {bytes, pkts, flows, first, last, exporter}
    this.stats = { pkts: 0, flows: 0, droppedFlows: 0, rateLimited: 0, badPkts: 0, templates: 0, exporters: 0 };
    this._winStart = 0; this._winCount = 0;
  }

  async start(port) {
    if (this.sock) return { ok: true, port: this.port };
    // 0 为合法 bind 端口（系统随机分配，测试用）：不能用 || 兜底（0 会被误当缺省换成 9995）
    const n = Math.floor(Number(port));
    const p = (Number.isInteger(n) && n >= 0 && n <= 65535) ? n : 9995;
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      sock.on('error', (e) => {
        try { sock.close(); } catch (err) { /* ignore */ }
        this.sock = null;
        done({ ok: false, error: String((e && e.message) || e) });
      });
      sock.on('message', (msg, rinfo) => this._onPacket(msg, rinfo));
      sock.bind(p, () => {
        this.sock = sock;
        this.port = sock.address().port;
        done({ ok: true, port: this.port });
      });
    });
  }

  async stop() {
    if (!this.sock) return { ok: true };
    const s = this.sock;
    this.sock = null;
    return new Promise((resolve) => {
      try { s.close(() => resolve({ ok: true })); } catch (e) { resolve({ ok: true }); }
    });
  }

  status() {
    return {
      running: !!this.sock, port: this.port, maxPps: this.maxPps,
      stats: Object.assign({}, this.stats, { templates: this.tmpl.size, buffered: this.ring.length, sessions: this.agg.size })
    };
  }

  _onPacket(msg, rinfo) {
    if (!this.sock || !msg || msg.length > MAX_PKT) return;
    // 简单滑窗限速：1 秒窗口内超过 maxPps 的包丢弃并计数
    const now = Date.now();
    if (now - this._winStart >= 1000) { this._winStart = now; this._winCount = 0; }
    if (++this._winCount > this.maxPps) { this.stats.rateLimited++; return; }
    const exporter = String((rinfo && rinfo.address) || '');
    let r;
    try { r = parseNetflowPacket(msg, exporter, this.tmpl); } catch (e) { this.stats.badPkts++; return; }
    if (!r.ok) { this.stats.badPkts++; return; }
    this.stats.pkts++;
    if (r.templates.length) this.stats.templates = this.tmpl.size;
    this.stats.droppedFlows += r.dropped || 0;
    if (!r.records.length) return;
    const exporters = new Set();
    for (const rec of r.records) {
      this.seq++;
      const item = Object.assign({ seq: this.seq, ts: now, exporter, version: r.version }, rec);
      this.ring.push(item);
      if (this.ring.length > MAX_RING) this.ring.splice(0, this.ring.length - MAX_RING);
      // 五元组聚合（会话视图 / TopN）
      const key = rec.src + '>' + rec.dst + ' ' + protoName(rec.proto) + ' ' + (rec.sport || 0) + '>' + (rec.dport || 0);
      const cur = this.agg.get(key) || { src: rec.src, dst: rec.dst, proto: protoName(rec.proto), sport: rec.sport || 0, dport: rec.dport || 0, bytes: 0, pkts: 0, flows: 0, first: now, last: now, exporter };
      cur.bytes += Number(rec.bytes) || 0;
      cur.pkts += Number(rec.pkts) || 0;
      cur.flows++;
      cur.last = now;
      this.agg.set(key, cur);
      exporters.add(exporter);
    }
    if (this.agg.size > MAX_SESSIONS) {
      // 超限清最旧 1/4（按 last 升序淘汰）：丢历史不丢语义
      const entries = [...this.agg.entries()].sort((a, b) => a[1].last - b[1].last);
      for (let i = 0; i < Math.floor(entries.length / 4); i++) this.agg.delete(entries[i][0]);
    }
    this.stats.flows += r.records.length;
    this.stats.exporters = new Set(this.ring.map(x => x.exporter)).size;
    this.emit('flows', { exporter, version: r.version, count: r.records.length, dropped: r.dropped || 0 });
  }

  /** 明细增量拉取（与 Trap/Syslog 同口径）：{items, next} */
  tail(sinceSeq) {
    const s = Number(sinceSeq) || 0;
    const items = this.ring.filter(x => x.seq > s).slice(-TAIL_MAX);
    return { ok: true, items, next: items.length ? items[items.length - 1].seq : s };
  }

  /** 会话聚合 TopN（按字节数降序）：{items, total} */
  sessions(topN) {
    const n = Math.max(1, Math.min(200, Math.floor(Number(topN) || 50)));
    const items = [...this.agg.values()].sort((a, b) => b.bytes - a.bytes).slice(0, n);
    return { ok: true, items, total: this.agg.size };
  }

  /** 明细查询（界面过滤）：kw 命中 src/dst/port/proto/exporter 任一 */
  flows(filter) {
    const f = filter || {};
    const kw = String(f.kw || '').trim().toLowerCase();
    let items = this.ring;
    if (f.sinceTs) items = items.filter(x => x.ts >= f.sinceTs);
    if (kw) items = items.filter(x => (x.src + ' ' + x.dst + ' ' + x.sport + ' ' + x.dport + ' ' + protoName(x.proto) + ' ' + x.exporter).toLowerCase().includes(kw));
    return { ok: true, items: items.slice(-TAIL_MAX) };
  }

  clear() {
    this.ring = [];
    this.agg.clear();
    this.tmpl.clear();
    this.stats = { pkts: 0, flows: 0, droppedFlows: 0, rateLimited: 0, badPkts: 0, templates: 0, exporters: 0 };
    return { ok: true };
  }
}

module.exports = { NetflowServer, parseNetflowPacket, ipv4Str, ipv6Str, protoName, IP_PROTO, DEFAULT_MAX_PPS };
