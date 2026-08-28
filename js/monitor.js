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
const dgram = require('dgram');
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
    if (list.some(c => {
      if (!c) return false;
      if (t === c || t.endsWith(c)) return true; // 输入的命令行（可能带提示符前缀）
      // 命令回显被折行/分片（一条命令显示成很多行）的残片：行是某命令的前缀/后缀/片段。
      // 长度≥4 才处理，避免误杀短的真实输出行（如状态值）。
      return c.length >= 8 && t.length >= 4 && (c.startsWith(t) || c.endsWith(t) || c.includes(t));
    })) continue;
    if (/^[A-Za-z0-9_.\-\[\]()/:<> +]{0,80}[>#\]]$/.test(t)) continue; // 提示符行（含 [SW1] 系统视图形态）
    // 提示符与 Telnet 协商残渣粘连的行（如 <SW1>\uFFFD..x(）：行首即提示符形态、后随噪声、非命令输出，剔除
    if (t.length <= 160 && /^[<\[][A-Za-z0-9_.\-\[\]()/:<> +]{0,80}[>#\]]/.test(t)) continue;
    out.push(raw);
  }
  return out;
}

/** 命令提示符形态（会话就绪判据）：<SW1> / [SW1] / R1> / R1# / Huawei> / 裸 > 等常见形态。
 *  不锚定行尾：真实设备的首包提示符常与 Telnet 协商残渣/回显粘连成一行（如 "R1> <FFFD>..x("），
 *  整行匹配会漏判、导致每轮等满就绪超时（15s）。就绪判定只看行首形态：
 *  误提前只会让命令早发（等价于超时兜底的旧行为），无副作用。 */
const PROMPT_RE = /^[A-Za-z0-9_.\-\[\]()/:<> +]{0,80}[>#\]]/;
/** 会话就绪等待上限：设备登录/初始化（banner）通常数秒内完成，超时兜底照常执行不阻塞 */
const READY_TIMEOUT_MS = 15000;

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

/* ---------------- SNMP v2c 最小客户端（仅 GET，零依赖 dgram + 手写 BER） ---------------- */
const OID_SYSDESCR = '1.3.6.1.2.1.1.1.0';
const OID_SYSOBJECT = '1.3.6.1.2.1.1.2.0';
/* ifTable（MIB-2 interfaces）：接口名/速率/状态/收发字节计数（64 位优先，32 位兜底） */
const OID_IF_DESCR = '1.3.6.1.2.1.2.2.1.2';
const OID_IF_SPEED = '1.3.6.1.2.1.2.2.1.7';
const OID_IF_OPER = '1.3.6.1.2.1.2.2.1.8';
const OID_IF_IN32 = '1.3.6.1.2.1.2.2.1.10';
const OID_IF_OUT32 = '1.3.6.1.2.1.2.2.1.16';
const OID_IF_HCIN = '1.3.6.1.2.1.31.1.1.1.6';
const OID_IF_HCOUT = '1.3.6.1.2.1.31.1.1.1.7';
/* 接口流量历史容量（每次采样一条；默认 60s 间隔约覆盖 2 小时） */
const IF_HIST_MAX = 120;
/** 计算速率（bps）：计数器差值 × 8 / 秒；计数器回绕/重置（负差）返回 null */
function rateBps(curC, prevC, dtSec) {
  if (!Number.isFinite(curC) || !Number.isFinite(prevC) || !(dtSec > 0)) return null;
  const delta = curC - prevC;
  if (delta < 0) return null; // 32 位计数器回绕或设备重启
  return Math.round(delta * 8 / dtSec);
}
function berLen(n) {
  if (n < 128) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}
function berTlv(tag, body) { return Buffer.concat([Buffer.from([tag]), berLen(body.length), body]); }
function berInt(n) {
  const bytes = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v = v >>> 8; } while (v);
  return berTlv(0x02, Buffer.from(bytes));
}
function berOid(oid) {
  const parts = String(oid).split('.').map(Number);
  const body = [parts[0] * 40 + (parts[1] || 0)];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const tmp = [v & 0x7f];
    v >>>= 7;
    while (v) { tmp.unshift((v & 0x7f) | 0x80); v >>>= 7; }
    body.push(...tmp);
  }
  return berTlv(0x06, Buffer.from(body));
}
function decodeOidBody(b) {
  if (!b || !b.length) return '';
  const arr = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = (v << 7) | (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { arr.push(v); v = 0; }
  }
  return arr.join('.');
}
/** 解析 SNMP GET 响应 → [{oid, value}]（OCTET STRING → 文本；OID 值 → 点分串） */
function parseSnmpResponse(buf) {
  const root = tlvWalk(buf, 0);
  if (!root || root.tag !== 0x30) throw new Error('响应格式错误');
  let cur = 0;
  const fields = [];
  while (cur < root.body.length) {
    const t = tlvWalk(root.body, cur);
    if (!t) break;
    fields.push(t);
    cur = t.next;
  }
  const pdu = fields[2];
  if (!pdu || pdu.tag !== 0xa2) throw new Error('非 GET 响应');
  let c = 0;
  const pf = [];
  while (c < pdu.body.length) {
    const t = tlvWalk(pdu.body, c);
    if (!t) break;
    pf.push(t);
    c = t.next;
  }
  const vbs = pf[3];
  if (!vbs || vbs.tag !== 0x30) throw new Error('varbind 列表缺失');
  const out = [];
  let k = 0;
  while (k < vbs.body.length) {
    const vb = tlvWalk(vbs.body, k);
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
    const oid = (oidT && oidT.tag === 0x06) ? decodeOidBody(oidT.body) : '';
    let value = null;
    if (valT && valT.tag === 0x04) value = valT.body.toString('utf8');
    else if (valT && valT.tag === 0x06) value = decodeOidBody(valT.body);
    // 数值类型：Integer / Counter / Gauge / TimeTicks / Counter64（ifTable 64 位计数器）
    else if (valT && [0x02, 0x41, 0x42, 0x43, 0x46].includes(valT.tag) && valT.body.length) {
      value = valT.body.length <= 6
        ? valT.body.readUIntBE(0, valT.body.length)
        : [...valT.body].reduce((a, b) => a * 256 + b, 0); // Counter64 最多 8 字节，reduce 到 2^53 内精确
    }
    out.push({ oid, value });
  }
  return out;
}
function tlvWalk(buf, start) {
  if (start + 2 > buf.length) return null;
  const tag = buf[start];
  let len = buf[start + 1];
  let hs = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 2 || start + 2 + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + 2 + i];
    hs = 2 + n;
  }
  if (start + hs + len > buf.length) return null;
  return { tag, body: buf.subarray(start + hs, start + hs + len), next: start + hs + len };
}
/** SNMP v2c GET：返回 {ok, varbinds:[{oid,value}]} 或 {ok:false, error}；port 供测试注入 mock agent（默认 161） */
function snmpRequest(pduTag, host, community, oids, timeoutMs, port) {
  return new Promise((resolve) => {
    try {
      let rid = (snmpGet._rid = (snmpGet._rid || 0) + 1);
      const varb = oids.map(oid => berTlv(0x30, Buffer.concat([berOid(oid), Buffer.from([0x05, 0x00])])));
      const pdu = Buffer.concat([berInt(rid), berInt(0), berInt(0), berTlv(0x30, Buffer.concat(varb))]);
      const msg = berTlv(0x30, Buffer.concat([berInt(1) /* v2c */, berTlv(0x04, Buffer.from(String(community || 'public'), 'utf8')), berTlv(pduTag, pdu)]));
      const sock = dgram.createSocket('udp4');
      const done = (res) => { clearTimeout(t); try { sock.close(); } catch (e) { /* ignore */ } resolve(res); };
      const t = setTimeout(() => done({ ok: false, error: 'SNMP 响应超时' }), timeoutMs || 3000);
      sock.on('message', (buf) => {
        try { done({ ok: true, varbinds: parseSnmpResponse(buf) }); }
        catch (e) { done({ ok: false, error: 'SNMP 响应解析失败' }); }
      });
      sock.on('error', (e) => done({ ok: false, error: 'SNMP 网络错误' }));
      sock.send(msg, port || 161, host, (err) => { if (err) done({ ok: false, error: 'SNMP 发送失败' }); });
    } catch (e) { resolve({ ok: false, error: 'SNMP 构造失败' }); }
  });
}
function snmpGet(host, community, oids, timeoutMs, port) { return snmpRequest(0xa0, host, community, oids, timeoutMs, port); }
function snmpGetNext(host, community, oid, timeoutMs, port) { return snmpRequest(0xa1, host, community, [oid], timeoutMs, port); }

/** SNMP GETNEXT 子树遍历（GETNEXT 逐个推进，零依赖实现 ifTable 采集）：
 *  返回 {ok, varbinds:[{oid,value}]}；离开 rootOid 子树（表结束）即停止；maxRows 防御超大表。 */
async function snmpWalk(rootOid, host, community, timeoutMs, port, maxRows) {
  maxRows = maxRows || 2048;
  const out = [];
  const prefix = rootOid + '.';
  let next = rootOid;
  while (out.length < maxRows) {
    const r = await snmpGetNext(host, community, next, timeoutMs, port);
    if (!r.ok) return { ok: false, error: r.error, varbinds: out };
    const vb = (r.varbinds || [])[0];
    if (!vb || !vb.oid || (vb.oid !== rootOid && !vb.oid.startsWith(prefix))) break; // 下一跳已离开子树
    out.push(vb);
    next = vb.oid;
  }
  return { ok: true, varbinds: out };
}
/** 从 sysDescr 启发式提取软件版本（华为 VRP / 思科 IOS / 通用 version 串） */
function extractVersion(descr) {
  const d = String(descr || '');
  const m = d.match(/Version\s+([^\s,，;；]+)/i)
    || d.match(/VRP[^,，]*software\s+([^\s,，;；]+)/i)
    || d.match(/\bV(\d{3}[Rr]\d+[A-Za-z0-9]*)\b/)
    || d.match(/version\s+([0-9][0-9.]*)/i);
  return m ? String(m[1]).slice(0, 48) : '';
}

/** 合规规则编译（与 util.js cleanComplianceRules 同口径：白名单 + 不区分大小写正则，主进程侧使用） */
function compileComplianceRules(raw) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(raw) ? raw : [])) {
    if (!r || typeof r !== 'object' || out.length >= 32) break;
    const id = (typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(r.id) && !seen.has(r.id)) ? r.id : '';
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 64) : '';
    const pattern = typeof r.pattern === 'string' ? r.pattern.trim().slice(0, 256) : '';
    if (!id || !name || !pattern) continue;
    let re = null;
    try { re = new RegExp(pattern, 'i'); } catch (e) { continue; }
    seen.add(id);
    out.push({ id, name, pattern, negate: !!r.negate, enabled: r.enabled !== false, re });
  }
  return out;
}
/** 配置文本逐行合规检查（与 util.js checkCompliance 同口径） */
function runCompliance(text, rules) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  const results = [];
  let passed = 0, failed = 0;
  for (const r of rules) {
    if (!r.enabled) continue;
    const hit = [];
    for (const ln of lines) { if (hit.length >= 20) break; if (r.re.test(ln)) hit.push(ln.trim().slice(0, 200)); }
    const pass = r.negate ? hit.length === 0 : hit.length > 0;
    if (pass) passed++; else failed++;
    results.push({ id: r.id, name: r.name, negate: r.negate, pass, lines: hit });
  }
  return { results, passed, failed };
}

/** 在线率采样库（纯 Node 可测）：按任务 key 记录探测结果的 10 分钟桶，保留 7 天，可落盘恢复。
 *  桶内同刻多次探测以后到为准；供监控中心渲染可用率趋势。 */
class UptimeStore {
  /** @param {string} filePath 落盘 JSON 路径（空串则不落盘，仅内存）
   *  @param {object} [opts] {bucketMs=600000, keepMs=7天, maxKeys=200} */
  constructor(filePath, opts) {
    opts = opts || {};
    this.file = typeof filePath === 'string' ? filePath : '';
    this.bucketMs = opts.bucketMs || 10 * 60 * 1000;
    this.keepMs = opts.keepMs || 7 * 24 * 60 * 60 * 1000;
    this.maxKeys = opts.maxKeys || 200;
    this.map = new Map();   // key -> [[bucketTs, 0|1], ...]（按时间升序）
    this._dirty = false;
    this._load();
  }
  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, arr] of Object.entries(raw)) {
          if (!Array.isArray(arr)) continue;
          const clean = arr.filter(e => Array.isArray(e) && e.length === 2 && Number.isFinite(e[0]))
            .map(e => [e[0], e[1] ? 1 : 0]).slice(-1024);
          if (clean.length) this.map.set(String(k).slice(0, 128), clean);
        }
      }
    } catch (e) { /* 无记录/损坏则从空开始 */ }
  }
  record(key, ok, t) {
    key = String(key == null ? '' : key).slice(0, 128);
    if (!key) return;
    const ts = Number.isFinite(t) ? t : Date.now();
    const bucket = Math.floor(ts / this.bucketMs) * this.bucketMs;
    const arr = this.map.get(key) || [];
    const last = arr[arr.length - 1];
    if (last && last[0] === bucket) last[1] = ok ? 1 : 0; // 同桶覆盖：保留该时段最后一次探测结果
    else {
      arr.push([bucket, ok ? 1 : 0]);
      if (arr.length > 1100) arr.splice(0, arr.length - 1024); // 单键上限兜底（7 天 ≈ 1008 桶）
    }
    this.map.set(key, arr);
    this._dirty = true;
    this._prune();
  }
  series(key) { return (this.map.get(String(key)) || []).slice(); }
  snapshot() {
    const out = {};
    for (const [k, arr] of this.map) out[k] = arr;
    return out;
  }
  /** 落盘（tmp+rename 原子写）。有变更才写；返回是否实际写入 */
  flush() {
    if (!this.file || !this._dirty) return false;
    const tmp = this.file + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot()), 'utf8');
      fs.renameSync(tmp, this.file);
      this._dirty = false;
      return true;
    } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ } return false; }
  }
  _prune() {
    const cutoff = Date.now() - this.keepMs;
    for (const [k, arr] of this.map) {
      while (arr.length && arr[0][0] < cutoff) arr.shift();
      if (!arr.length) this.map.delete(k);
    }
    // 键数超限：淘汰最近活动最旧的键
    while (this.map.size > this.maxKeys) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [k, arr] of this.map) {
        const ts = arr.length ? arr[arr.length - 1][0] : 0;
        if (ts < oldestTs) { oldestTs = ts; oldestKey = k; }
      }
      if (oldestKey === null) break;
      this.map.delete(oldestKey);
    }
  }
}

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
    // SSH 公钥认证（可选）：私钥 PEM/OpenSSH 文本 + 私钥口令；两者均可为空（回退密码认证）
    const privateKey = typeof opts.privateKey === 'string' ? opts.privateKey.trim().slice(0, 65536) : '';
    const keyPassphrase = typeof opts.keyPassphrase === 'string' ? opts.keyPassphrase.slice(0, 1024) : '';
    // SSH 跳板机（可选）：经堡垒机转发到目标（仅 SSH 目标生效）
    let jump = null;
    if (opts.jump && typeof opts.jump === 'object' && String(opts.jump.host || '').trim()) {
      let jPort = parseInt(opts.jump.port, 10);
      if (!(jPort > 0)) jPort = 22;
      if (!(jPort <= 65535)) jPort = 22;
      jump = {
        host: String(opts.jump.host).trim().slice(0, 256),
        port: jPort,
        username: String(opts.jump.username || '').trim().slice(0, 128) || username,
        password: String(opts.jump.password || '').slice(0, 1024),
        privateKey: typeof opts.jump.privateKey === 'string' ? opts.jump.privateKey.trim().slice(0, 65536) : '',
        keyPassphrase: typeof opts.jump.keyPassphrase === 'string' ? opts.jump.keyPassphrase.slice(0, 1024) : ''
      };
    }
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
    // 备份后自动合规巡检（可选）：规则快照来自渲染层合规检查（localStorage 单一来源），随任务保存
    const cOpt = bOpt.compliance && typeof bOpt.compliance === 'object' ? bOpt.compliance : {};
    backup.compliance = { enabled: !!cOpt.enabled, rules: compileComplianceRules(cOpt.rules) };
    // ---- SNMP 自动识别（v2c GET sysDescr/sysObjectID，可选；每次会话建立后执行一次） ----
    // ---- SNMP 接口流量采集（ifTable walk，可选；独立于连接的 UDP 定时轮询） ----
    const sOpt = opts.sysinfo && typeof opts.sysinfo === 'object' ? opts.sysinfo : {};
    const sysinfo = { enabled: !!sOpt.enabled, community: (String(sOpt.community || 'public').trim().slice(0, 64)) || 'public', ifTable: !!sOpt.ifTable };
    let snmpIntervalSec = parseFloat(sOpt.intervalSec);
    if (!Number.isFinite(snmpIntervalSec)) snmpIntervalSec = 60;
    sysinfo.intervalSec = Math.max(30, Math.min(3600, snmpIntervalSec));
    // SNMP UDP 端口（默认 161；测试可注入 mock agent 端口）
    let snmpPort = parseInt(sOpt.snmpPort, 10);
    sysinfo.snmpPort = (snmpPort > 0 && snmpPort <= 65535) ? snmpPort : 161;
    return {
      ok: true,
      cfg: { key, deviceId, name, protocol, host, port, username, password, privateKey, keyPassphrase, jump, expectFp, commands, onConnect: onConnectCmds, readOnly, intervalSec, cmdDelayMs, retrySec, initDelayMs, probe, alerts, backup, sysinfo }
    };
  }

  _newJob(cfg) {
    return {
      key: cfg.key, deviceId: cfg.deviceId, name: cfg.name,
      protocol: cfg.protocol, host: cfg.host, port: cfg.port,
      username: cfg.username, password: cfg.password,
      privateKey: cfg.privateKey || '', keyPassphrase: cfg.keyPassphrase || '',
      jump: cfg.jump || null,
      expectFp: cfg.expectFp || '',
      commands: cfg.commands.slice(),
      onConnect: (cfg.onConnect || []).slice(),
      readOnly: !!cfg.readOnly,
      intervalSec: cfg.intervalSec, cmdDelayMs: cfg.cmdDelayMs, retrySec: cfg.retrySec,
      initDelayMs: cfg.initDelayMs,
      probe: Object.assign({ enabled: false, type: 'tcp', intervalSec: 30 }, cfg.probe || {}),
      alerts: (cfg.alerts || []).map(a => ({ pattern: a.pattern, note: a.note, re: a.re })),
      backup: Object.assign({ enabled: false, commands: ['display current-configuration'], mode: 'session', skipIfSame: false, intervalSec: 3600, waitMs: 1000 }, cfg.backup || {}),
      sysinfo: Object.assign({ enabled: false, community: 'public', ifTable: false, intervalSec: 60 }, cfg.sysinfo || {}),
      ifHist: [],       // 接口流量采样历史（[{ts, ifs:[{i,n,oper,in,out,speed}]}]，容量 IF_HIST_MAX）
      ifPrev: null,     // 上次采样的计数器（算速率用）{ts, map: ifIndex -> {inC, outC}}
      ifOperPrev: {},   // 上次采样的接口状态（ifIndex -> up/down/other），状态变化时发事件
      snmpTimer: null, _snmpBusy: false,
      probeOk: null, probeLatency: null, probeFailSince: null, probeTimer: null, _probeBusy: false,
      alerting: false, alertInfo: null, _cycleActive: false, _alertPending: [],
      backupTimer: null, backupRunning: false, backupLast: null, _backupCap: null,
      sid: null, state: 'connecting', statusText: '连接中…',
      enabled: true, stopping: false, fatal: false,
      since: Date.now(), gen: 1, _ready: false,
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
    // SNMP 接口流量采集：独立于 SSH/Telnet 连接的 UDP 定时轮询（任务级，重连不重启）
    if (cfg.sysinfo && cfg.sysinfo.ifTable) this._startIfPoll(job);
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
        backupEnabled: !!job.backup.enabled, backupMode: job.backup.mode,
        compliance: job.complianceLast ? { failed: job.complianceLast.failed, total: job.complianceLast.total, at: job.complianceLast.at } : null,
        ifTable: !!(job.sysinfo && job.sysinfo.ifTable)
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
    if (job.snmpTimer) { clearTimeout(job.snmpTimer); job.snmpTimer = null; }
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
      privateKey: job.privateKey || '',
      keyPassphrase: job.keyPassphrase || '',
      jump: job.jump || null,
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
    if (job.logStream) {
      // 打开/写入异步失败（目录被清理、磁盘满、权限等）静默降级：日志尽力而为，不影响监控主流程
      job.logStream.on('error', () => {
        if (job.logStream) { try { job.logStream.destroy(); } catch (e2) { /* ignore */ } }
        job.logStream = null;
      });
    }
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
    // 会话就绪门槛：TCP/认证完成 ≠ 设备命令行就绪（banner/初始化期间下发的首条命令会被吞）。
    // 发送空行探测，收到设备提示符行后 _ready=true，命令才正式下发；超时兜底照常执行。
    job._ready = false;
    if (job.sid) { try { this.shell.write(job.sid, '\r\n'); } catch (e) { /* ignore */ } }
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
    // SNMP 自动识别：每次会话建立后执行一次（延迟 2s 等设备就绪），结果经 sysinfo 事件回填
    if (job.sysinfo && job.sysinfo.enabled) {
      setTimeout(() => this._fetchSysInfo(job, gen), 2000);
    }
  }

  /** SNMP v2c 识别：GET sysDescr/sysObjectID，启发式提取软件版本后广播 sysinfo 事件 */
  _fetchSysInfo(job, gen) {
    if (!job.enabled || job.stopping || gen !== job.gen || !job.sysinfo || !job.sysinfo.enabled) return;
    snmpGet(job.host, job.sysinfo.community, [OID_SYSDESCR, OID_SYSOBJECT], 3000).then((r) => {
      if (!job.enabled || job.stopping || gen !== job.gen || !r.ok) return;
      const map = {};
      for (const vb of (r.varbinds || [])) if (vb.oid) map[vb.oid] = vb.value;
      const descr = String(map[OID_SYSDESCR] || '');
      const objectId = String(map[OID_SYSOBJECT] || '');
      if (!descr && !objectId) return;
      this._logLine(job, 'SNMP 识别：' + (descr || objectId).slice(0, 160));
      this.emit('sysinfo', {
        key: job.key, deviceId: job.deviceId, name: job.name, host: job.host,
        descr: descr.slice(0, 300), objectId, version: extractVersion(descr)
      });
    }).catch(() => { /* 识别失败静默：不影响监控 */ });
  }

  /* ---------------- SNMP 接口流量采集（ifTable，独立于连接的 UDP 轮询） ---------------- */
  _startIfPoll(job) {
    clearTimeout(job.snmpTimer);
    job.snmpTimer = setTimeout(() => this._pollIfTable(job), 3000);
  }

  async _pollIfTable(job) {
    if (!job.enabled || job.stopping || !job.sysinfo || !job.sysinfo.ifTable) return;
    if (!job._snmpBusy) {
      job._snmpBusy = true;
      try { await this._collectIfTable(job); }
      catch (e) { /* 采集失败静默：不影响监控主流程 */ }
      job._snmpBusy = false;
    }
    if (!job.enabled || job.stopping) return;
    clearTimeout(job.snmpTimer);
    job.snmpTimer = setTimeout(() => this._pollIfTable(job), (job.sysinfo.intervalSec || 60) * 1000);
  }

  async _collectIfTable(job) {
    const host = job.host, community = job.sysinfo.community;
    const port = job.sysinfo.snmpPort || 161;
    // 1. 接口名表（ifDescr walk 拿到全部 ifIndex）
    const descr = await snmpWalk(OID_IF_DESCR, host, community, 3000, port);
    if (!descr.ok || !descr.varbinds.length) return;
    const ifs = new Map(); // ifIndex -> {i, n, oper, speed, inC, outC}
    for (const vb of descr.varbinds) {
      const idx = vb.oid.slice(OID_IF_DESCR.length + 1);
      if (!/^\d+$/.test(idx)) continue;
      ifs.set(idx, { i: parseInt(idx, 10), n: String(vb.value == null ? '' : vb.value).slice(0, 64) });
    }
    if (!ifs.size) return;
    // 2. 状态 / 速率 / 计数器（各列独立 walk，ifIndex 不在_descr 表的行忽略）
    const merge = async (root, fn) => {
      const w = await snmpWalk(root, host, community, 3000, port);
      if (!w.ok) return;
      for (const vb of w.varbinds) {
        const idx = vb.oid.slice(root.length + 1);
        const o = ifs.get(idx);
        if (o) fn(o, vb.value);
      }
    };
    await merge(OID_IF_OPER, (o, v) => { o.oper = v === 1 ? 'up' : (v === 2 ? 'down' : 'other'); });
    await merge(OID_IF_SPEED, (o, v) => { o.speed = Number(v) || 0; });
    // 64 位计数器优先（ifHCIn/OutOctets），设备不支持（走完无数据）时回退 32 位
    let inCol = await snmpWalk(OID_IF_HCIN, host, community, 3000, port);
    let inRoot = OID_IF_HCIN;
    if (!inCol.ok || !inCol.varbinds.length) { inCol = await snmpWalk(OID_IF_IN32, host, community, 3000, port); inRoot = OID_IF_IN32; }
    if (inCol.ok) for (const vb of inCol.varbinds) { const o = ifs.get(vb.oid.slice(inRoot.length + 1)); if (o) o.inC = Number(vb.value); }
    let outCol = await snmpWalk(OID_IF_HCOUT, host, community, 3000, port);
    let outRoot = OID_IF_HCOUT;
    if (!outCol.ok || !outCol.varbinds.length) { outCol = await snmpWalk(OID_IF_OUT32, host, community, 3000, port); outRoot = OID_IF_OUT32; }
    if (outCol.ok) for (const vb of outCol.varbinds) { const o = ifs.get(vb.oid.slice(outRoot.length + 1)); if (o) o.outC = Number(vb.value); }

    // 3. 组装采样并计算速率（与上次计数器差值）
    const now = Date.now();
    const sample = { ts: now, ifs: [] };
    for (const o of ifs.values()) {
      if (!o.n) continue; // 无接口名的行（如内部索引）不进采样
      const s = { i: o.i, n: o.n, oper: o.oper || 'other', speed: o.speed || 0, in: null, out: null };
      if (job.ifPrev) {
        const p = job.ifPrev.map.get(o.i);
        if (p) {
          const dt = (now - job.ifPrev.ts) / 1000;
          s.in = rateBps(o.inC, p.inC, dt);
          s.out = rateBps(o.outC, p.outC, dt);
        }
      }
      sample.ifs.push(s);
    }
    sample.ifs.sort((a, b) => a.i - b.i);
    job.ifPrev = {
      ts: now,
      map: new Map([...ifs.values()].filter(o => o.inC != null || o.outC != null).map(o => [o.i, { inC: o.inC, outC: o.outC }]))
    };
    job.ifHist.push(sample);
    if (job.ifHist.length > IF_HIST_MAX) job.ifHist.shift();
    // 4. 接口状态变化事件（up/down 跳变；首次采样只记录基线不报事件）
    const changes = [];
    for (const s of sample.ifs) {
      if (s.oper !== 'up' && s.oper !== 'down') continue;
      const po = job.ifOperPrev[s.i];
      if (po && po !== s.oper) changes.push({ name: s.n, from: po, to: s.oper });
      job.ifOperPrev[s.i] = s.oper;
    }
    this._logLine(job, 'SNMP 接口采集：' + sample.ifs.length + ' 个接口' + (changes.length ? '，状态变化 ' + changes.length + ' 个' : ''));
    this.emit('iftraffic', {
      key: job.key, deviceId: job.deviceId, name: job.name, host: job.host,
      ts: sample.ts, ifs: sample.ifs.slice(0, 512)
    });
    if (changes.length) {
      this.emit('ifstatus', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, changes });
    }
  }

  /** 接口流量历史（渲染层监控中心按需拉取）：{ok, hist, intervalSec} 或 {ok:false} */
  ifHistory(key) {
    const job = this.jobs.get(String(key || '').trim());
    if (!job) return { ok: false, error: '任务不存在或已停止' };
    return { ok: true, hist: job.ifHist, intervalSec: job.sysinfo.intervalSec, ifTable: !!job.sysinfo.ifTable };
  }

  /** 等待会话就绪（收到设备命令提示符行）。设备登录/初始化未完成时下发的命令会被吞；
   *  超时（READY_TIMEOUT_MS）后照常执行，不让监控/备份被长时间阻塞。
   *  另探测 lineBuf 残段：设备提示符常不带换行结尾（如首包 "…\r\n> " 截止于提示符），
   *  若只等完整行会白等满超时。 */
  async _waitReady(job, gen, timeoutMs) {
    if (job._ready) return true;
    const t0 = Date.now();
    while (job.enabled && !job.stopping && gen === job.gen && !job._ready && (Date.now() - t0) < timeoutMs) {
      if (job.lineBuf && PROMPT_RE.test(job.lineBuf.trim())) { job._ready = true; break; }
      await sleep(200);
    }
    return !!job._ready;
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
      await this._waitReady(job, gen, READY_TIMEOUT_MS); // 会话就绪后再下发首条命令（防被设备初始化期吞掉）
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
      await this._waitReady(job, gen, READY_TIMEOUT_MS); // 连接时命令同样等会话就绪
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
        if (!job._ready && PROMPT_RE.test(t.trim())) job._ready = true; // 会话就绪：收到命令提示符行（banner 期拼接的底层报文不触发）
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
    // 事件携带的 host 优先：经跳板连接时目标与跳板各自独立确认，按归属主机放行/记录
    const host = String((info && info.host) || job.host);
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
    await this._waitReady(job, gen, READY_TIMEOUT_MS); // 复用监控会话：等会话就绪再下发首条备份命令
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

  /** 备份方式 B：每次备份单独建立连接执行命令（不干扰监控会话，输出独立收集）。
   *  Promise 在【命令执行 + 备份保存完成】后才 resolve——runBackupNow 需在其后读到真实 _bkResult，
   *  否则会在连接刚建立时误读为「未产生新文件」（文件稍后才落盘）。 */
  _runBackupOwn(job, gen) {
    return new Promise((resolve) => {
      const r = this.shell.connect({
        protocol: job.protocol, host: job.host, port: job.port,
        username: job.username, password: job.password,
        privateKey: job.privateKey || '', keyPassphrase: job.keyPassphrase || '',
        jump: job.jump || null,
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
          // 命令执行与保存全部完成后才 resolve（含 _bkResult 就绪）
          this._runBackupOwnCmds(job, gen, sid).then(settle, settle);
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

  /** 独立备份会话：写命令序列并收集输出（不进监控日志）。
   *  返回 Promise：命令执行 + 过滤 + 保存全部完成后 resolve。 */
  _runBackupOwnCmds(job, gen, sid) {
    return new Promise((resolveCmds) => {
      const lines = [];
      let ownReady = false; // 独立新会话的就绪标志（与监控会话 _ready 互不干扰）
      const eol = job.protocol === 'telnet' ? '\r\n' : '\n';
      const onOut = (sid2, data) => {
        if (sid2 !== sid) return;
        let text = String(data || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b[()][0-9A-B]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        for (const ln of text.split('\n')) {
          const t = ln.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
          if (!ownReady && PROMPT_RE.test(t.trim())) ownReady = true; // 独立会话就绪判据
          if (t) lines.push(t);
        }
      };
      this.shell.on('output', onOut);
      (async () => {
        try { this.shell.write(sid, '\r\n'); } catch (e) { /* ignore */ } // 空行探测提示符
        const t0 = Date.now();
        while (!ownReady && !job.stopping && gen === job.gen && (Date.now() - t0) < READY_TIMEOUT_MS) {
          await sleep(200);
        }
        for (const cmd of job.backup.commands) {
          if (!job.enabled || job.stopping || gen !== job.gen) break;
          try { this.shell.write(sid, cmd + eol); } catch (e) { /* ignore */ }
          await sleep(job.backup.waitMs);
        }
        await sleep(400); // 尾部输出缓冲
        this.shell.removeListener('output', onOut);
        try { this.shell.close(sid); } catch (e) { /* ignore */ }
        if (!job.enabled || job.stopping || gen !== job.gen) { resolveCmds(); return; }
        // 过滤命令回显（含提示符前缀整行）与提示符行：只保留命令执行后的输出内容
        this._saveBackup(job, gen, cleanBackupLines(lines, job.backup.commands).join('\n'));
        resolveCmds();
      })().catch(() => resolveCmds());
    });
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
    this._runCompliance(job, gen, content);
  }
  /** 备份内容自动合规巡检（job.backup.compliance.enabled 时）：违规写入事件时间线并广播 */
  _runCompliance(job, gen, content) {
    const c = job.backup && job.backup.compliance;
    if (!c || !c.enabled) return;
    const rep = runCompliance(content, c.rules || []);
    job.complianceLast = { at: Date.now(), failed: rep.failed, total: rep.passed + rep.failed };
    const items = rep.results.filter(r => !r.pass).slice(0, 8)
      .map(r => ({ name: r.name, negate: r.negate, line: (r.lines && r.lines[0]) || (r.negate ? '' : '未找到匹配行') }));
    this.emit('compliance', {
      key: job.key, deviceId: job.deviceId, name: job.name, host: job.host,
      ok: rep.failed === 0, failed: rep.failed, total: rep.passed + rep.failed, items
    });
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

module.exports = { MonitorManager, UptimeStore, sanitizeFilename, cleanBackupLines, compileComplianceRules, runCompliance, snmpGet, snmpGetNext, snmpWalk, parseSnmpResponse, extractVersion, rateBps, OID_SYSDESCR, OID_SYSOBJECT, OID_IF_DESCR, OID_IF_SPEED, OID_IF_OPER, OID_IF_IN32, OID_IF_OUT32, OID_IF_HCIN, OID_IF_HCOUT };

