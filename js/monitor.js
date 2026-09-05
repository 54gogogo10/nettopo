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
const { RegexLab } = require('./regex-lab.js');

/** 文件名/目录名安全化：去掉 Windows 与常见控制字符，去空白、限长。
 *  注意：正则必须独立匹配字符类（不得写成 "/字符类"——那要求字面 / 前缀，永不匹配），
 *  并额外剔除路径穿越成分（..）与首尾点号/空白（防日志目录逃逸 + Windows 命名限制）。 */
function sanitizeFilename(s) {
  let out = String(s == null ? '' : s);
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  out = out.replace(/\.\./g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!out) out = 'device';
  // Windows 保留设备名（CON/NUL/COM1…）：判定看首个圆点前的词干（con.a.b 同样保留），
  // 写入会静默失败，前缀下划线规避（与 backup-store 口径一致）
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = '_' + out;
  if (out.length > 60) out = out.slice(0, 60);
  return out;
}

/** 清理备份捕获行：只保留命令执行后的输出内容。
 *  - 输入的命令行（或其终端回显，可能带「提示符+命令」前缀，如 Switch#display current-configuration）一律不保留
 *  - 命令回显被折行/分片（TCP 分包、Telnet 协商字节穿插、终端重打）的残片不保留：
 *    匹配前先剥行首提示符（R1#displ… → displ…，Cisco 形态提示符无 <>/[] 包裹，旧版漏剔）
 *    与行尾残渣（空白/控制符/UTF-8 误码 U+FFFD——Telnet 协商字节混入回显的产物，会让整行尾部匹配失配）；
 *    残片锚定命令首/尾时最短 2 字符、居中片段 4 字符，避免误杀短的真实输出行（如状态值）
 *  - 提示符行（Switch# / R1> / [SW1] 等含系统视图形态）不保留
 *  - 分页提示行（华为/H3C「  ---- More ----」/思科「--More--」：未关分页时插在输出流中）不保留
 *  返回：过滤后的行数组（保留原始行文本） */
function cleanBackupLines(lines, cmds) {
  const out = [];
  const list = (Array.isArray(cmds) ? cmds : []).map(c => String(c == null ? '' : c).trim()).filter(Boolean);
  for (const raw of (Array.isArray(lines) ? lines : [])) {
    const t = String(raw == null ? '' : raw).replace(/[\s\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uFFFD]+$/, '');
    if (!t) continue;
    if (/^[A-Za-z0-9_.\-\[\]()/:<> +]{0,80}[>#\]]$/.test(t)) continue; // 提示符行（含 [SW1] 系统视图形态）
    // 提示符与 Telnet 协商残渣粘连的行（如 <SW1>\uFFFD..x(）：行首即提示符形态、后随噪声、非命令输出，剔除
    if (t.length <= 160 && /^[<\[][A-Za-z0-9_.\-\[\]()/:<> +]{0,80}[>#\]]/.test(t)) continue;
    // 分页提示行（仅由连字符/空白组成 + More 字样）
    if (/^[\s-]*more[\s-]*$/i.test(t)) continue;
    // 行首提示符剥除后的行内容：残片匹配对「提示符+残片」「残片+残渣」两种粘连形态生效
    const m = t.match(/^[A-Za-z0-9_.\-\[\]()/:<> +]{0,80}[>#\]][ :]?/);
    const body = (m && m[0].length < t.length) ? t.slice(m[0].length) : t;
    if (list.some(c => t.endsWith(c) || body.endsWith(c) // 整条命令回显（可能带提示符/杂前缀）
      || (c.length >= 8 && (
        (body.length >= 2 && (c.startsWith(body) || c.endsWith(body)))  // 锚定命令首/尾的残片（≥2 字符）
        || (body.length >= 4 && c.includes(body)))))) continue;          // 居中片段（≥4 字符）
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
const OID_SYSUPTIME = '1.3.6.1.2.1.1.3.0'; // TimeTicks（1/100 秒），骤减即设备重启
/* ifTable（MIB-2 interfaces）：接口名/速率/状态/收发字节计数（64 位优先，32 位兜底） */
const OID_IF_DESCR = '1.3.6.1.2.1.2.2.1.2';
const OID_IF_SPEED = '1.3.6.1.2.1.2.2.1.5'; // ifSpeed（bps）；.7 是 ifAdminStatus（1/2/3 枚举），勿混用
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
/** 解析 SNMP 响应的 message/PDU 字段结构（version, community, PDU{request-id, errStatus, errIndex, varbinds}） */
function snmpPduFields(buf) {
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
  return { fields, pf };
}

/** 提取响应的 request-id 与 community：与请求不符的响应包一律丢弃（防同网段伪造抢答污染监控数据） */
function snmpResponseMeta(buf) {
  try {
    const { fields, pf } = snmpPduFields(buf);
    const commT = fields[1], ridT = pf[0];
    if (!commT || commT.tag !== 0x04 || !ridT || ridT.tag !== 0x02 || !ridT.body.length || ridT.body.length > 6) return null;
    return { community: commT.body.toString('utf8'), rid: ridT.body.readUIntBE(0, ridT.body.length) };
  } catch (e) { return null; }
}

/** 解析 SNMP GET 响应 → [{oid, value}]（OCTET STRING → 文本；OID 值 → 点分串） */
function parseSnmpResponse(buf) {
  const { pf } = snmpPduFields(buf);
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
/** SNMP v2c GET：返回 {ok, varbinds:[{oid,value}]} 或 {ok:false, error}；port 供测试注入 mock agent（默认 161）
 *  rid 混入进程级随机盐（纯顺序递增可被同网段盲猜抢答）；响应校验来源地址（IP 直连目标时）。 */
function snmpRequest(pduTag, host, community, oids, timeoutMs, port) {
  return new Promise((resolve) => {
    try {
      const seq = (snmpGet._rid = (snmpGet._rid || 0) + 1) & 0x7fff;
      if (snmpGet._salt == null) snmpGet._salt = Math.floor(Math.random() * 0x8000);
      const rid = ((snmpGet._salt << 15) | seq) & 0x7fffffff;
      const varb = oids.map(oid => berTlv(0x30, Buffer.concat([berOid(oid), Buffer.from([0x05, 0x00])])));
      const pdu = Buffer.concat([berInt(rid), berInt(0), berInt(0), berTlv(0x30, Buffer.concat(varb))]);
      const msg = berTlv(0x30, Buffer.concat([berInt(1) /* v2c */, berTlv(0x04, Buffer.from(String(community || 'public'), 'utf8')), berTlv(pduTag, pdu)]));
      const sock = dgram.createSocket('udp4');
      // host 为点分 IPv4 时校验响应来源：伪造抢答包必须来自目标 IP 才可能通过后续 rid/community 校验
      const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(host || ''));
      const done = (res) => { clearTimeout(t); try { sock.close(); } catch (e) { /* ignore */ } resolve(res); };
      const t = setTimeout(() => done({ ok: false, error: 'SNMP 响应超时' }), timeoutMs || 3000);
      sock.on('message', (buf, rinfo) => {
        try {
          // 来源不符的响应包直接丢弃（继续等待真实响应直至超时）
          if (isIpLiteral && rinfo && rinfo.address !== host) return;
          // 再校验 request-id 与 community：不匹配的抢答包同样丢弃
          const meta = snmpResponseMeta(buf);
          if (!meta || meta.rid !== rid || meta.community !== String(community || 'public')) return;
          done({ ok: true, varbinds: parseSnmpResponse(buf) });
        }
        catch (e) { done({ ok: false, error: 'SNMP 响应解析失败' }); }
      });
      sock.on('error', (e) => done({ ok: false, error: 'SNMP 网络错误' }));
      sock.send(msg, port || 161, host, (err) => { if (err) done({ ok: false, error: 'SNMP 发送失败' }); });
    } catch (e) { resolve({ ok: false, error: 'SNMP 构造失败' }); }
  });
}
function snmpGet(host, community, oids, timeoutMs, port) { return snmpRequest(0xa0, host, community, oids, timeoutMs, port); }
function snmpGetNext(host, community, oid, timeoutMs, port) { return snmpRequest(0xa1, host, community, [oid], timeoutMs, port); }

/** SNMP 取单个 OID 的值：先 GET；未命中（表型 OID 无实例）回退 GETNEXT 取子树内第一个实例。
 *  返回 {ok, value, oid} 或 {ok:false, error} */
async function snmpGetValue(host, community, oid, timeoutMs, port) {
  const r = await snmpGet(host, community, [oid], timeoutMs, port);
  if (r.ok) {
    const vb = (r.varbinds || [])[0];
    if (vb && vb.oid === oid && vb.value != null) return { ok: true, value: vb.value, oid: vb.oid };
  }
  const n = await snmpGetNext(host, community, oid, timeoutMs, port);
  if (n.ok) {
    const vb = (n.varbinds || [])[0];
    if (vb && vb.oid && (vb.oid === oid || vb.oid.startsWith(oid + '.')) && vb.value != null) {
      return { ok: true, value: vb.value, oid: vb.oid };
    }
  }
  return { ok: false, error: (r && r.error) || (n && n.error) || 'SNMP 无数据' };
}

/** TimeTicks（1/100 秒）→ 运行时长文本：如 12天3小时 / 5小时20分 */
function fmtUptimeTicks(ticks) {
  const s = Math.floor(Number(ticks) / 100);
  if (!Number.isFinite(s) || s < 0) return '';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + '天' + h + '小时';
  if (h > 0) return h + '小时' + m + '分';
  return m + '分' + (s % 60) + '秒';
}

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

/* ---------------- SSH 指标采集解析（Linux 服务器 df / free / loadavg，纯函数可测） ---------------- */
/** 解析 df 输出（df -P / df -h 通用，均为 6 列）：返回 [{mount, pct}]。
 *  排除无容量的伪文件系统（tmpfs/udev/cgroup 系等，第一列命中名单即跳过；/dev/* 真实设备全保留，
 *  overlay 保留——容器根分区）。表头行、列数不足、Use% 解析失败的行跳过。 */
function parseLinuxDf(text) {
  const skipFs = /^(tmpfs|devtmpfs|udev|shm|none|cgroup2?|proc|sysfs|devpts|securityfs|pstore|bpf|debugfs|tracefs|configfs|fusectl|hugetlbfs|mqueue|nsfs|squashfs|iso9660)/i;
  const out = [];
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const t = raw.trim();
    if (!t || /^Filesystem/i.test(t)) continue;
    const cols = t.split(/\s+/);
    if (cols.length < 6) continue;
    if (skipFs.test(cols[0])) continue;
    const pm = String(cols[4]).match(/^(\d+)%$/);
    if (!pm) continue;
    const blocks = Number(cols[1]);
    if (Number.isFinite(blocks) && blocks <= 0) continue; // 0 容量的伪挂载点不进指标
    out.push({ mount: cols.slice(5).join(' ').slice(0, 64), pct: Math.min(100, Math.max(0, parseInt(pm[1], 10))) });
  }
  return out;
}
/** 解析 free 输出（free -m / -g / -k 通用）：返回 {mem, swap}（百分比，1 位小数）。
 *  新版 procps 有 available 列（按 (total-available)/total，含 buff/cache 归还）；旧版无 available
 *  按 (total-free-buffers-cached)/total 估算。Mem 行的上一行为表头，据此区分。 */
function parseLinuxFree(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const nums = (l) => (String(l).match(/\d+/g) || []).map(Number);
  const r1 = (v) => Math.max(0, Math.min(100, Math.round(v * 10) / 10));
  let memIdx = -1;
  for (let i = 0; i < lines.length; i++) { if (/^\s*Mem[:\s]/.test(lines[i])) { memIdx = i; break; } }
  if (memIdx < 0) return { mem: null, swap: null };
  const m = nums(lines[memIdx]);
  const hasAvail = memIdx > 0 && /available/i.test(lines[memIdx - 1]);
  let mem = null;
  if (m.length >= 6 && m[0] > 0) {
    mem = hasAvail ? r1((m[0] - m[5]) / m[0] * 100)
                   : r1((m[0] - m[2] - (m[4] || 0) - (m[5] || 0)) / m[0] * 100);
  } else if (m.length >= 3 && m[0] > 0) {
    mem = r1((m[0] - m[2]) / m[0] * 100);
  }
  let swap = null;
  for (const l of lines) {
    if (!/^\s*Swap[:\s]/.test(l)) continue;
    const s = nums(l);
    if (s.length >= 3) swap = s[0] > 0 ? r1(s[1] / s[0] * 100) : 0;
    break;
  }
  return { mem, swap };
}
/** 解析负载：/proc/loadavg（0.52 0.58 0.59 1/234 12345）或 uptime（load average: 0.52, 0.58, 0.59）→ {l1, l5, l15} */
function parseLinuxLoadavg(text) {
  const t = String(text == null ? '' : text);
  let m = t.match(/^\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+\d+\/\d+\s+\d+\s*$/m);
  if (!m) m = t.match(/load average[s]?:\s*([\d.]+),?\s+([\d.]+),?\s+([\d.]+)/i);
  if (!m) return { l1: null, l5: null, l15: null };
  return { l1: Number(m[1]), l5: Number(m[2]), l15: Number(m[3]) };
}
/** 指标阈值级别判定（纯函数）：pct ≥ crit → 'crit'，≥ warn → 'warn'，否则 null。
 *  磁盘多挂载点取最高级别，detail 列出超阈值的「挂载点 百分比」清单。 */
function metricLevels(sample, th) {
  th = th || {};
  const lv = (pct, warn, crit) => (pct == null || !Number.isFinite(Number(pct))) ? null
    : (pct >= crit ? 'crit' : pct >= warn ? 'warn' : null);
  let disk = null;
  const bad = [];
  for (const d of ((sample && sample.disks) || [])) {
    const l = lv(d.pct, th.diskWarn, th.diskCrit);
    if (l) { bad.push((d.mount || '?') + ' ' + d.pct + '%'); if (l === 'crit') disk = 'crit'; else if (!disk) disk = 'warn'; }
  }
  return { disk, mem: lv(sample && sample.mem, th.memWarn, th.memCrit), detail: bad.join('、') };
}

/* ---------------- HTTP 健康探测 / SSL 证书到期（独立于 SSH 会话，纯函数可测） ---------------- */
/** 证书剩余整天数：validTo 为证书 valid_to 文本（如 'Dec 31 23:59:59 2027 GMT'，Date 可解析即可）；
 *  已过期返回负数；不可解析返回 null。 */
function certDaysLeft(validTo, now) {
  const t = Date.parse(String(validTo == null ? '' : validTo));
  if (!Number.isFinite(t)) return null;
  const ref = Number.isFinite(now) ? now : Date.now();
  return Math.floor((t - ref) / 86400000);
}
/** 单次 HTTP/HTTPS 健康探测：状态码 2xx/3xx 且（可选）包含关键字判定在线；
 *  HTTPS 附带证书剩余天数（rejectUnauthorized=false——内网自签名同样可测，不校验链只取有效期）。
 *  响应体仅缓存前 256KB（关键字判定够用，防大响应撑内存）。 */
function httpCheck(probe, cb) {
  let u = null;
  try { u = new URL(String((probe && probe.url) || '')); } catch (e) { cb({ ok: false, error: 'URL 无效' }); return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { cb({ ok: false, error: 'URL 仅支持 http/https' }); return; }
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  const t0 = Date.now();
  let settled = false;
  let req = null;
  const finish = (res) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    try { if (req) req.destroy(); } catch (e) { /* ignore */ }
    cb(res);
  };
  const timeout = setTimeout(() => finish({ ok: false, error: '请求超时' }), Math.max(2000, Math.min(30000, (probe && probe.timeoutMs) || 8000)));
  try {
    req = mod.get(u, { rejectUnauthorized: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 256 * 1024) chunks.push(c); });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        const kw = String((probe && probe.keyword) || '');
        const kwHit = kw ? body.indexOf(kw) >= 0 : null;
        let certDays = null, certExpire = '';
        if (u.protocol === 'https:') {
          try {
            const cert = res.socket && res.socket.getPeerCertificate && res.socket.getPeerCertificate();
            if (cert && cert.valid_to) { certExpire = String(cert.valid_to); certDays = certDaysLeft(certExpire); }
          } catch (e) { /* 证书信息缺失不阻断探测 */ }
        }
        const ok = status >= 200 && status < 400 && (kw ? kwHit : true);
        finish({
          ok, status, latencyMs: Date.now() - t0, certDays, certExpire,
          keywordHit: kw ? kwHit : null,
          error: ok ? null : (kw && !kwHit ? '响应未包含关键字「' + kw + '」' : (status ? 'HTTP ' + status : '连接失败'))
        });
      });
      res.on('error', () => finish({ ok: false, error: '响应读取失败' }));
    });
    req.on('error', (e) => finish({ ok: false, error: '连接失败：' + ((e && e.message) || e) }));
    req.on('timeout', () => finish({ ok: false, error: '请求超时' }));
  } catch (e) { finish({ ok: false, error: '请求构造失败：' + ((e && e.message) || e) }); }
}

/** 合规规则编译（与 util.js cleanComplianceRules 同口径：白名单 + 不区分大小写正则，主进程侧使用） */function compileComplianceRules(raw) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(raw) ? raw : [])) {
    if (!r || typeof r !== 'object' || out.length >= 32) break;
    const id = (typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(r.id) && !seen.has(r.id)) ? r.id : '';
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 64) : '';
    const pattern = typeof r.pattern === 'string' ? r.pattern.trim().slice(0, 256) : '';
    if (!id || !name || !pattern) continue;
    // 启发式拒绝嵌套量词（如 (a+)+ / (a?)+ / (a|aa)*）：主进程侧另有 RegexLab 工作线程超时兜底，
    // 此处静态过滤是第一道廉价防线（组内含量词/分支的「被量词化的组」是指数回溯的高发形态）
    if (/\([^()]*[+*?{|][^()]*\)[+*{]/.test(pattern)) continue;
    let re = null;
    try { re = new RegExp(pattern, 'i'); } catch (e) { continue; }
    seen.add(id);
    out.push({ id, name, pattern, negate: !!r.negate, enabled: r.enabled !== false, re });
  }
  return out;
}
/** 配置文本逐行合规检查（与 util.js checkCompliance 同口径） */
function runCompliance(text, rules) {
  // 单行限长：防超大行（压缩/粘贴异常）拖慢逐行正则扫描
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n')
    .map(l => l.length > 10000 ? l.slice(0, 10000) : l);
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
/** 告警待检缓冲字节上限：恶意设备高速灌输出时按字节丢最旧行，防 join/内存被撑爆
 *  （行数 20000 上限挡不住「行数少但单行极长」的组合） */
const MAX_ALERT_PENDING_CHARS = 1024 * 1024;
/** 备份捕获内容字节上限（与 config-backup 的 8MB 单份上限对齐，超出丢弃后续行并标记截断） */
const MAX_BACKUP_CAPTURE_CHARS = 8 * 1024 * 1024;
/** 单设备单日日志滚动文件数上限：高输出设备按 32MB 滚动一天可写数百个文件，超限删最旧 */
const MAX_LOG_FILES_PER_DAY = 24;

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
    this.regexLab = new RegexLab({ timeoutMs: 5000 }); // 用户正则的工作线程超时执行器（防灾难性回溯挂死主进程）
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
    // host/username 会写进日志头与审计日志（shell.js）：剔除控制字符，防内嵌换行注入伪造审计行
    const host = String(opts.host || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!host || host.length > 256) return { ok: false, error: '请填写主机地址' };
    let port = parseInt(opts.port, 10);
    if (!(port > 0)) port = protocol === 'telnet' ? DEFAULTS.telnetPort : DEFAULTS.port;
    if (port < 1 || port > 65535) return { ok: false, error: '端口无效' };
    const username = String(opts.username || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) || DEFAULTS.username;
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
        host: String(opts.jump.host).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256),
        port: jPort,
        username: String(opts.jump.username || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) || username,
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
      // 启发式拒绝嵌套量词（如 (a+)+ / (a?)+ / (a|aa)*）：执行期另有 RegexLab 工作线程超时兜底（非完备防线）
      if (/\([^()]*[+*?{|][^()]*\)[+*{]/.test(pattern)) continue;
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
    // ---- SNMP 接口流量采集（ifTable walk）/ 重启检测（sysUpTime 骤减）/ CPU·内存采集（可配置 OID），独立于连接的 UDP 定时轮询 ----
    const sOpt = opts.sysinfo && typeof opts.sysinfo === 'object' ? opts.sysinfo : {};
    const sysinfo = { enabled: !!sOpt.enabled, community: (String(sOpt.community || 'public').trim().slice(0, 64)) || 'public', ifTable: !!sOpt.ifTable };
    let snmpIntervalSec = parseFloat(sOpt.intervalSec);
    if (!Number.isFinite(snmpIntervalSec)) snmpIntervalSec = 60;
    sysinfo.intervalSec = Math.max(30, Math.min(3600, snmpIntervalSec));
    // SNMP UDP 端口（默认 161；测试可注入 mock agent 端口）
    let snmpPort = parseInt(sOpt.snmpPort, 10);
    sysinfo.snmpPort = (snmpPort > 0 && snmpPort <= 65535) ? snmpPort : 161;
    sysinfo.sysUpTime = !!sOpt.sysUpTime; // 重启检测：定时 GET sysUpTime，数值骤减 → reboot 事件
    // CPU/内存采集 OID（点分十进制白名单；GET 失败自动 GETNEXT 兜底表型 OID）。
    // memFreeOid 留空 = memUsedOid 的值直接是百分比（华为/华三 entity-ext）；填写 = 按 used/(used+free) 计算（思科字节型）。
    const pfOpt = sOpt.perf && typeof sOpt.perf === 'object' ? sOpt.perf : {};
    const cleanOid = (v) => {
      // OID 白名单：点分十进制（最多 20 段——企业 MIB 常见 12~15 段），总长 64 上限
      const s = String(v == null ? '' : v).trim();
      return (/^\d{1,10}(?:\.\d{1,10}){1,19}$/.test(s) && s.length <= 64) ? s : '';
    };
    sysinfo.perf = {
      enabled: !!pfOpt.enabled,
      cpuOid: cleanOid(pfOpt.cpuOid),
      memUsedOid: cleanOid(pfOpt.memUsedOid),
      memFreeOid: cleanOid(pfOpt.memFreeOid)
    };
    // ---- 服务器指标采集（SSH，可选）：复用监控会话执行 df/free 等命令并解析数值，
    //      磁盘/内存超阈值告警（仅读取模式下禁用——与「只记录不写命令」语义冲突） ----
    const mtOpt = opts.metrics && typeof opts.metrics === 'object' ? opts.metrics : {};
    const metrics = { enabled: false, commands: [], intervalSec: 300, diskWarn: 80, diskCrit: 90, memWarn: 80, memCrit: 90 };
    metrics.enabled = !!mtOpt.enabled && !readOnly;
    {
      const mtRaw = Array.isArray(mtOpt.command) ? mtOpt.command : String(mtOpt.command == null ? '' : mtOpt.command).split(/\r?\n/);
      for (const c of mtRaw) {
        const s = String(c == null ? '' : c).trim();
        if (!s) continue;
        if (metrics.commands.length >= 8) break;
        metrics.commands.push(s.length > 256 ? s.slice(0, 256) : s);
      }
      if (metrics.enabled && !metrics.commands.length) metrics.commands = ['df -P', 'free -m', 'cat /proc/loadavg'];
    }
    let mtInt = parseFloat(mtOpt.intervalSec);
    if (!Number.isFinite(mtInt)) mtInt = 300;
    metrics.intervalSec = Math.max(60, Math.min(86400, mtInt));
    const clampTh = (v, def) => {
      const n = parseFloat(v);
      const x = Number.isFinite(n) ? Math.round(n) : def;
      return Math.max(1, Math.min(100, x));
    };
    metrics.diskWarn = clampTh(mtOpt.diskWarn, 80);
    metrics.diskCrit = Math.max(metrics.diskWarn, clampTh(mtOpt.diskCrit, 90));
    metrics.memWarn = clampTh(mtOpt.memWarn, 80);
    metrics.memCrit = Math.max(metrics.memWarn, clampTh(mtOpt.memCrit, 90));
    // ---- HTTP 健康探测 / 证书到期（可选，独立于 SSH/Telnet 连接，从本机直接发起） ----
    const hpOpt = opts.httpProbe && typeof opts.httpProbe === 'object' ? opts.httpProbe : {};
    const httpProbe = { enabled: false, url: '', intervalSec: 300, alertDays: 14, keyword: '', timeoutMs: 8000 };
    const hUrl = String(hpOpt.url || '').trim().slice(0, 2048);
    if (/^https?:\/\//i.test(hUrl)) httpProbe.url = hUrl;
    let hpInt = parseFloat(hpOpt.intervalSec);
    if (!Number.isFinite(hpInt)) hpInt = 300;
    httpProbe.intervalSec = Math.max(30, Math.min(86400, hpInt));
    let hDays = parseFloat(hpOpt.alertDays);
    if (!Number.isFinite(hDays)) hDays = 14;
    httpProbe.alertDays = Math.max(0, Math.min(365, Math.round(hDays)));
    httpProbe.keyword = String(hpOpt.keyword == null ? '' : hpOpt.keyword).trim().slice(0, 256);
    httpProbe.enabled = !!hpOpt.enabled && !!httpProbe.url;
    return {
      ok: true,
      cfg: { key, deviceId, name, protocol, host, port, username, password, privateKey, keyPassphrase, jump, expectFp, commands, onConnect: onConnectCmds, readOnly, intervalSec, cmdDelayMs, retrySec, initDelayMs, probe, alerts, backup, sysinfo, metrics, httpProbe }
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
      sysinfo: Object.assign({ enabled: false, community: 'public', ifTable: false, intervalSec: 60, sysUpTime: false, perf: { enabled: false, cpuOid: '', memUsedOid: '', memFreeOid: '' } }, cfg.sysinfo || {}),
      metrics: Object.assign({ enabled: false, commands: [], intervalSec: 300, diskWarn: 80, diskCrit: 90, memWarn: 80, memCrit: 90 }, cfg.metrics || {}),
      metricHist: [],   // SSH 指标采样历史（[{ts, disks:[{mount,pct}], mem, swap, load}]，容量 IF_HIST_MAX）
      metricAlert: { disk: null, mem: null }, // 上次阈值级别（变化沿产生告警事件）
      metricTimer: null, _metricBusy: false,
      httpProbe: Object.assign({ enabled: false, url: '', intervalSec: 300, alertDays: 14, keyword: '', timeoutMs: 8000 }, cfg.httpProbe || {}),
      httpHist: [],     // HTTP 探测历史（[{ts, ok, status, latency, certDays}]，容量 IF_HIST_MAX）
      httpOk: null,     // 上次探测结果（在线状态沿判定在 electron-main）
      certAlerted: null, // 上次证书到期告警状态（变化沿产生事件）
      httpTimer: null,
      ifHist: [],       // 接口流量采样历史（[{ts, ifs:[{i,n,oper,in,out,speed}]}]，容量 IF_HIST_MAX）
      ifPrev: null,     // 上次采样的计数器（算速率用）{ts, map: ifIndex -> {inC, outC}}
      ifOperPrev: {},   // 上次采样的接口状态（ifIndex -> up/down/other），状态变化时发事件
      upPrev: null,     // 上次 sysUpTime 采样（TimeTicks，1/100 秒；骤减 → 重启事件）
      perfHist: [],     // CPU/内存/sysUpTime 采样历史（[{ts, up, cpu, mem}]，容量 IF_HIST_MAX）
      snmpTimer: null, _snmpBusy: false,
      probeOk: null, probeLatency: null, probeFailSince: null, probeTimer: null, _probeBusy: false,
      alerting: false, alertInfo: null, _cycleActive: false, _alertPending: [], _alertPendingChars: 0, _alertChecking: false,
      // 凭据掩码（日志防回显泄密）：密码/私钥口令/跳板密码出现在设备输出时写日志前打码
      pwMasks: [cfg.password, cfg.keyPassphrase, cfg.jump && cfg.jump.password]
        .filter(s => typeof s === 'string' && s.length >= 3),
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
    // SNMP 轮询（接口流量 / 重启检测 / CPU·内存）：独立于 SSH/Telnet 连接的 UDP 定时轮询（任务级，重连不重启）
    const si = cfg.sysinfo || {};
    if (si.ifTable || si.sysUpTime || (si.perf && si.perf.enabled)) this._startSnmpPoll(job);
    // HTTP 健康探测 / 证书到期：独立于 SSH/Telnet 会话的本机定时探测（任务级，重连不重启）
    if (cfg.httpProbe && cfg.httpProbe.enabled) {
      clearTimeout(job.httpTimer);
      job.httpTimer = setTimeout(() => this._httpProbeOnce(job), 2000);
    }
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
        ifTable: !!(job.sysinfo && job.sysinfo.ifTable),
        perf: !!(job.sysinfo && job.sysinfo.perf && job.sysinfo.perf.enabled),
        upCheck: !!(job.sysinfo && job.sysinfo.sysUpTime),
        metrics: !!(job.metrics && job.metrics.enabled),
        lastMetric: job.metricHist.length ? job.metricHist[job.metricHist.length - 1] : null,
        httpProbe: !!(job.httpProbe && job.httpProbe.enabled),
        httpOk: job.httpOk,
        certDays: job.httpHist.length ? job.httpHist[job.httpHist.length - 1].certDays : null,
        lastPerf: job.perfHist.length ? { ts: job.perfHist[job.perfHist.length - 1].ts, cpu: job.perfHist[job.perfHist.length - 1].cpu, mem: job.perfHist[job.perfHist.length - 1].mem, up: job.perfHist[job.perfHist.length - 1].up } : null
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

  /** 已信任主机指纹列表（TOFU 信任库，供界面查看/撤销） */
  trustList() {
    const items = [];
    for (const [host, fp] of this.trusted) items.push({ host, fp });
    items.sort((a, b) => (a.host < b.host ? -1 : 1));
    return { ok: true, items };
  }

  /** 撤销某主机的信任指纹：后续连接按「首次连接」重新走 TOFU 信任流程 */
  trustRevoke(host) {
    host = String(host || '');
    const removed = this.trusted.delete(host);
    if (removed) this._saveTrust();
    return { ok: true, removed };
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
    if (job.metricTimer) { clearTimeout(job.metricTimer); job.metricTimer = null; }
    if (job.httpTimer) { clearTimeout(job.httpTimer); job.httpTimer = null; }
    job._backupCap = null;
    job._cycleActive = false;
    job._alertPending = [];
    job._alertPendingChars = 0;
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
      autoLogin: job.protocol === 'telnet', // Telnet 无传输层认证：由 shell 层自动应答 Username:/Password: 登录提示（SSH 不受影响）
      expectFp: job.expectFp || '',
      owner: 'monitor' // 标记归属：Web Shell 窗口关闭时 closeAll('monitor') 不会误杀监控连接
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
    const devDir = this._deviceDir(job);
    // 纵深：设备目录若已被同机攻击者替换为符号链接，跟随写入会把日志写到任意位置——拒绝写日志
    try { if (fs.lstatSync(devDir).isSymbolicLink()) { job.logStream = null; return; } } catch (e) { /* 不存在则照常创建 */ }
    const dir = path.join(devDir, date);
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
      // 滚动文件数封顶：恶意设备持续触发滚动时一天可产生数百个 32MB 文件，超限删最旧
      this._pruneLogFiles(dir, MAX_LOG_FILES_PER_DAY);
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
  /** 滚动文件数封顶：目录内 .log 按 mtime 保留最新 keep 个，其余删除（lstat 拒符号链接） */
  _pruneLogFiles(dir, keep) {
    try {
      const files = fs.readdirSync(dir)
        .map(n => {
          let st = null;
          try { st = fs.lstatSync(path.join(dir, n)); } catch (e) { return null; }
          return (st && st.isFile() && !st.isSymbolicLink() && n.endsWith('.log')) ? { n, t: st.mtimeMs } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.t - a.t);
      for (const f of files.slice(keep)) { try { fs.unlinkSync(path.join(dir, f.n)); } catch (e) { /* ignore */ } }
    } catch (e) { /* ignore */ }
  }
  _closeLog(job) {
    if (job.logStream) { try { job.logStream.end(); } catch (e) { /* ignore */ } job.logStream = null; }
  }
  _rollLogIfNeeded(job) {
    if (fmtDateDir() !== job.logDate) this._openLog(job);
  }
  /** 凭据打码：设备回显密码/私钥口令时（恶意服务端可故意回显），写日志前替换，防凭据落入日志文件 */
  _maskSecrets(job, text) {
    let out = String(text == null ? '' : text);
    const masks = job && job.pwMasks;
    if (masks && masks.length) {
      for (const p of masks) { if (out.indexOf(p) >= 0) out = out.split(p).join('******'); }
    }
    return out;
  }
  _logLine(job, text) {
    // 写入前自查跨天滚动：仅读取/仅探测任务没有命令轮次（_runCycle/_runBackupShared 才调
    // _rollLogIfNeeded），不自查会一直往昨天的日期目录里追加
    if (!job.logStream || fmtDateDir() !== job.logDate) this._openLog(job);
    if (!job.logStream) return;
    // 单文件超过大小上限即滚动新文件（防高输出设备占满磁盘）
    if (job.logStream.bytesWritten > MAX_LOG_BYTES) this._openLog(job, true);
    if (!job.logStream) return;
    try { job.logStream.write('[' + fmtTimestamp() + '] ' + this._maskSecrets(job, text) + '\n'); } catch (e) { /* ignore */ }
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
    // Telnet 自动登录进行中不发空行探测：空行落在 Username:/Password: 提示上会引发提示重印，干扰登录应答
    if (job.sid && !(job.protocol === 'telnet' && job.password)) { try { this.shell.write(job.sid, '\r\n'); } catch (e) { /* ignore */ } }
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
    // SSH 指标采集：会话建立后启动定时轮询（复用监控会话执行指标命令）
    if (job.metrics && job.metrics.enabled && !job.readOnly) {
      this._startMetrics(job);
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

  /* ---------------- SSH 指标采集（复用监控会话执行 df/free/loadavg，超阈值告警） ---------------- */
  _startMetrics(job) {
    clearTimeout(job.metricTimer);
    job.metricTimer = setTimeout(() => this._runMetrics(job), Math.max(job.initDelayMs, 1000) + 2000);
  }
  async _runMetrics(job) {
    if (!job.enabled || job.stopping || !job.metrics || !job.metrics.enabled || job.readOnly) return;
    const gen = job.gen;
    // 会话在线且命令循环/备份空闲时采集；忙则跳过本轮（下个间隔再试），不与备份/命令循环抢会话
    if (job.state === 'monitoring' && job.sid && !job._cycleActive && !job.backupRunning && !job._metricBusy) {
      job._metricBusy = true;
      try { await this._collectMetrics(job, gen); } catch (e) { /* 采集失败静默：下轮再试 */ }
      job._metricBusy = false;
    }
    if (!job.enabled || job.stopping || gen !== job.gen) return;
    clearTimeout(job.metricTimer);
    job.metricTimer = setTimeout(() => this._runMetrics(job), (job.metrics.intervalSec || 300) * 1000);
  }
  /** 逐条执行指标命令（捕获窗口复用备份通道：与备份/命令循环已互斥，cleanBackupLines 过滤命令回显），
   *  按命令内容匹配解析器（df → 磁盘，free → 内存，loadavg/uptime → 负载），样本入历史并评估阈值。 */
  async _collectMetrics(job, gen) {
    const m = job.metrics || {};
    const cmds = (m.commands || []).slice();
    if (!cmds.length || !job.sid) return;
    this._rollLogIfNeeded(job);
    const disks = [];
    let mem = null, swap = null, load = null;
    // 占用命令循环互斥位：指标命令与周期命令/备份共享同一会话，交叉写入会互相污染捕获窗口
    job._cycleActive = true;
    try {
      for (const cmd of cmds) {
        if (!job.enabled || job.stopping || gen !== job.gen || !job.sid) return;
        await this._drainForBackup(job, gen, 2000); // 排空上一条命令的输出尾部，防混入指标解析
        this._logCmd(job, cmd + '（指标采集）');
        job._backupCap = { commands: cmds.concat(job.commands || [], job.onConnect || []), lines: [], chars: 0, truncated: false, startedAt: Date.now() };
        const eol = job.protocol === 'telnet' ? '\r\n' : '\n';
        try { this.shell.write(job.sid, cmd + eol); } catch (e) { job._backupCap = null; return; }
        await sleep(1200);      // 命令输出等待（磁盘/内存类命令输出快，固定短窗口）
        await sleep(300);       // 尾部缓冲
        const cap = job._backupCap;
        job._backupCap = null;
        if (!cap) return;
        const text = cleanBackupLines(cap.lines, cap.commands).join('\n');
        if (/\bdf\b/.test(cmd)) { for (const d of parseLinuxDf(text)) disks.push(d); }
        else if (/\bfree\b/.test(cmd)) { const r = parseLinuxFree(text); if (r.mem != null) mem = r.mem; if (r.swap != null) swap = r.swap; }
        else if (/loadavg|uptime/.test(cmd)) { const r = parseLinuxLoadavg(text); if (r.l1 != null) load = r; }
      }
    } finally {
      job._cycleActive = false; // 中途退出（会话断开/停止）也必须释放，避免命令循环/备份永久等待
    }
    if (!disks.length && mem == null && load == null) return;
    const sample = { ts: Date.now(), disks: disks.slice(0, 32), mem, swap, load: load || null };
    job.metricHist.push(sample);
    if (job.metricHist.length > IF_HIST_MAX) job.metricHist.shift();
    const lv = metricLevels(sample, m);
    const prev = job.metricAlert || { disk: null, mem: null };
    const changed = lv.disk !== prev.disk || lv.mem !== prev.mem;
    job.metricAlert = { disk: lv.disk, mem: lv.mem };
    this._logLine(job, '指标采集：' + [
      disks.length ? '磁盘 ' + sample.disks.map(d => d.mount + ' ' + d.pct + '%').join('，') : '',
      mem != null ? '内存 ' + mem + '%' : '',
      load ? '负载 ' + load.l1 + '/' + load.l5 + '/' + load.l15 : ''
    ].filter(Boolean).join('，'));
    this.emit('metric', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, ts: sample.ts, sample, levels: { disk: lv.disk, mem: lv.mem } });
    if (changed) {
      const parts = [];
      if (lv.disk !== prev.disk) parts.push('磁盘' + (lv.disk ? '超阈值（' + lv.disk + '）：' + lv.detail : '告警解除'));
      if (lv.mem !== prev.mem) parts.push('内存' + (lv.mem ? '超阈值（' + lv.mem + '）：' + sample.mem + '%' : '告警解除'));
      this._logLine(job, '【指标' + ((lv.disk || lv.mem) ? '告警】' : '解除】') + parts.join('；'));
      this.emit('metric-alert', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, ts: sample.ts, alerting: !!(lv.disk || lv.mem), disk: lv.disk, mem: lv.mem, detail: parts.join('；') });
    }
  }

  /** SSH 指标采样历史（监控中心「性能」页按需拉取） */
  metricHistory(key) {
    const job = this.jobs.get(String(key || '').trim());
    if (!job) return { ok: false, error: '任务不存在或已停止' };
    return { ok: true, hist: job.metricHist, intervalSec: job.metrics ? job.metrics.intervalSec : 300, metrics: !!(job.metrics && job.metrics.enabled) };
  }

  /* ---------------- HTTP 健康探测 / SSL 证书到期（本机直连目标 URL，独立于 SSH 会话） ---------------- */
  _httpProbeOnce(job) {
    if (!job.enabled || job.stopping || !job.httpProbe || !job.httpProbe.enabled) return;
    const gen = job.gen;
    const done = () => {
      if (!job.enabled || job.stopping || gen !== job.gen) return;
      clearTimeout(job.httpTimer);
      job.httpTimer = setTimeout(() => this._httpProbeOnce(job), (job.httpProbe.intervalSec || 300) * 1000);
    };
    httpCheck(job.httpProbe, (res) => {
      if (!job.enabled || job.stopping || gen !== job.gen) return;
      const sample = { ts: Date.now(), ok: !!res.ok, status: res.status == null ? null : res.status, latency: res.latencyMs == null ? null : res.latencyMs, certDays: res.certDays == null ? null : res.certDays, error: res.ok ? null : (res.error || '失败') };
      job.httpHist.push(sample);
      if (job.httpHist.length > IF_HIST_MAX) job.httpHist.shift();
      const changed = job.httpOk !== sample.ok;
      job.httpOk = sample.ok;
      this._logLine(job, 'HTTP 探测：' + job.httpProbe.url + ' → ' + (sample.ok
        ? 'HTTP ' + sample.status + '（' + sample.latency + 'ms）' + (sample.certDays != null ? '，证书剩余 ' + sample.certDays + ' 天' : '')
        : '失败：' + (sample.error || '未知')));
      this.emit('http', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, url: job.httpProbe.url, ts: sample.ts, ok: sample.ok, status: sample.status, latency: sample.latency, certDays: sample.certDays, error: sample.error });
      // 证书到期阈值（变化沿：首次低于阈值或续期恢复时各产生一次事件）
      const alerted = sample.certDays != null && sample.certDays <= job.httpProbe.alertDays;
      if (alerted !== job.certAlerted) {
        job.certAlerted = alerted;
        this._logLine(job, alerted
          ? '【证书告警】' + job.httpProbe.url + ' 证书剩余 ' + sample.certDays + ' 天（阈值 ' + job.httpProbe.alertDays + ' 天），到期时间 ' + (res.certExpire || '未知')
          : '【证书恢复】' + job.httpProbe.url + ' 证书剩余 ' + sample.certDays + ' 天，已高于告警阈值');
        this.emit('cert-alert', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, url: job.httpProbe.url, alerting: alerted, days: sample.certDays, expire: res.certExpire || '', threshold: job.httpProbe.alertDays });
      }
      done();
    });
  }

  /** HTTP 探测 / 证书到期历史（监控中心「性能」页按需拉取） */
  httpHistory(key) {
    const job = this.jobs.get(String(key || '').trim());
    if (!job) return { ok: false, error: '任务不存在或已停止' };
    return { ok: true, hist: job.httpHist, intervalSec: job.httpProbe ? job.httpProbe.intervalSec : 300, enabled: !!(job.httpProbe && job.httpProbe.enabled), url: job.httpProbe ? job.httpProbe.url : '', alertDays: job.httpProbe ? job.httpProbe.alertDays : 14 };
  }

  /* ---------------- SNMP 轮询（接口流量 ifTable / 重启检测 sysUpTime / CPU·内存，独立于连接的 UDP 采集） ---------------- */
  _startSnmpPoll(job) {
    clearTimeout(job.snmpTimer);
    job.snmpTimer = setTimeout(() => this._pollSnmp(job), 3000);
  }

  async _pollSnmp(job) {
    if (!job.enabled || job.stopping || !job.sysinfo) return;
    const wantIf = !!job.sysinfo.ifTable;
    const wantPerf = !!job.sysinfo.sysUpTime || !!(job.sysinfo.perf && job.sysinfo.perf.enabled);
    if (wantIf || wantPerf) {
      if (!job._snmpBusy) {
        job._snmpBusy = true;
        try {
          if (wantIf) await this._collectIfTable(job);
          if (wantPerf) await this._collectPerf(job);
        } catch (e) { /* 采集失败静默：不影响监控主流程 */ }
        job._snmpBusy = false;
      }
    } else {
      return; // 未开启任何 SNMP 轮询项：停止调度
    }
    if (!job.enabled || job.stopping) return;
    clearTimeout(job.snmpTimer);
    job.snmpTimer = setTimeout(() => this._pollSnmp(job), (job.sysinfo.intervalSec || 60) * 1000);
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

  /** CPU/内存/sysUpTime 采样历史（监控中心「性能」页按需拉取） */
  perfHistory(key) {
    const job = this.jobs.get(String(key || '').trim());
    if (!job) return { ok: false, error: '任务不存在或已停止' };
    return {
      ok: true, hist: job.perfHist, intervalSec: job.sysinfo.intervalSec,
      perf: !!(job.sysinfo.perf && job.sysinfo.perf.enabled), sysUpTime: !!job.sysinfo.sysUpTime
    };
  }

  /** SNMP 性能采集：sysUpTime（重启检测：数值骤减 5 分钟以上判为重启）+ CPU/内存（可配置 OID） */
  async _collectPerf(job) {
    const host = job.host, community = job.sysinfo.community, port = job.sysinfo.snmpPort || 161;
    const perf = job.sysinfo.perf || {};
    const now = Date.now();
    const sample = { ts: now, up: null, cpu: null, mem: null };
    // sysUpTime（TimeTicks，1/100 秒）：骤减超过 5 分钟刻度视为设备重启（容忍采样抖动）
    if (job.sysinfo.sysUpTime) {
      const r = await snmpGetValue(host, community, OID_SYSUPTIME, 3000, port);
      if (r.ok && Number.isFinite(Number(r.value))) {
        const up = Number(r.value);
        sample.up = up;
        const prev = job.upPrev;
        if (prev != null && up < prev - 5 * 60 * 100) {
          this._logLine(job, '【重启】sysUpTime 骤降：' + fmtUptimeTicks(prev) + ' → ' + fmtUptimeTicks(up) + '，设备可能已重启');
          this.emit('reboot', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, prev, cur: up });
        }
        job.upPrev = up;
      }
    }
    const clampPct = (v) => Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 10) / 10)) : null;
    // CPU 利用率（%）
    if (perf.enabled && perf.cpuOid) {
      const r = await snmpGetValue(host, community, perf.cpuOid, 3000, port);
      if (r.ok) sample.cpu = clampPct(Number(r.value));
    }
    // 内存占用：memFreeOid 已配置 → used/(used+free)（思科字节型）；未配置 → memUsedOid 值即百分比（华为/华三）
    if (perf.enabled && perf.memUsedOid) {
      const ru = await snmpGetValue(host, community, perf.memUsedOid, 3000, port);
      if (ru.ok) {
        const used = Number(ru.value);
        if (Number.isFinite(used)) {
          if (perf.memFreeOid) {
            const rf = await snmpGetValue(host, community, perf.memFreeOid, 3000, port);
            const free = rf.ok ? Number(rf.value) : NaN;
            sample.mem = (Number.isFinite(free) && used + free > 0)
              ? Math.round(used / (used + free) * 1000) / 10
              : null;
          } else {
            sample.mem = clampPct(used);
          }
        }
      }
    }
    if (sample.up == null && sample.cpu == null && sample.mem == null) return;
    job.perfHist.push(sample);
    if (job.perfHist.length > IF_HIST_MAX) job.perfHist.shift();
    this._logLine(job, 'SNMP 性能采集：' + [
      sample.cpu != null ? 'CPU ' + sample.cpu + '%' : '',
      sample.mem != null ? '内存 ' + sample.mem + '%' : '',
      sample.up != null ? '运行 ' + fmtUptimeTicks(sample.up) : ''
    ].filter(Boolean).join('，'));
    this.emit('perf', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, ts: sample.ts, cpu: sample.cpu, mem: sample.mem, up: sample.up });
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

  /** 备份开捕获窗口前排空上一条命令的输出：等输出静默（行缓冲 ≥400ms 无新增）且残段为提示符形态
   *  （提示符重现 = 上一条命令输出完毕），再把残段刷进监控日志并重置组包缓冲。
   *  命令循环只保证命令「已写完」即释放互斥位，慢设备的输出尾部可能仍在流动——不排空则
   *  上一轮监控输出的行/迟到的命令回显会混进备份文件（SSH 与 Telnet 共用此路径）。
   *  超时（2s）后照常执行不阻塞备份；届时迟到的命令回显由捕获过滤名单兜底剔除。 */
  async _drainForBackup(job, gen, timeoutMs) {
    const t0 = Date.now();
    let lastLen = -1, quietMs = 0;
    while (job.enabled && !job.stopping && gen === job.gen && (Date.now() - t0) < timeoutMs) {
      const len = job.lineBuf ? job.lineBuf.length : 0;
      quietMs = (len === lastLen) ? quietMs + 100 : 0;
      lastLen = len;
      if (quietMs >= 400 && PROMPT_RE.test(String(job.lineBuf || '').trim())) break;
      await sleep(100);
    }
    const rest = String(job.lineBuf || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (rest.trim()) this._logLine(job, rest); // 残段（通常是提示符）如实入监控日志，不凭空丢字
    job.lineBuf = '';
  }

  async _runCycle(job, gen) {
    if (!job.enabled || job.state !== 'monitoring' || gen !== job.gen || job.readOnly) return;
    // 配置备份捕获期间暂停命令循环（避免输出互相污染），1 秒后再试
    if (job._cycleActive) {
      clearTimeout(job.loopTimer);
      job.loopTimer = setTimeout(() => this._runCycle(job, gen), 1000);
      return;
    }
    const cycleStart = Date.now();
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
    this._checkAlerts(job).catch(() => { /* 告警检查失败不中断监控 */ });
    // 下一轮按「本轮开始时刻 + 间隔」调度：等命令全部执行完才计时会让实际周期持续
    // 正漂移（周期 = intervalSec + 每轮执行耗时），多命令大延迟任务采集间隔明显变长
    const nextDelay = Math.max(1000, job.intervalSec * 1000 - (Date.now() - cycleStart));
    job.loopTimer = setTimeout(() => this._runCycle(job, job.gen), nextDelay);
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
    // 不能因 logStream 降级为 null 就整体退出：就绪判定/告警匹配/备份捕获都在本函数里，
    // 日志 I/O 失败只该丢日志（_logLine 内部自愈重开），仅读取任务的输出处理不能跟着停摆
    if (!job) return;
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
      let t = ln.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      if (t) {
        // 凭据打码先行：日志、告警缓冲、备份捕获共用该行文本，恶意设备回显密码不得落到任何一处
        t = this._maskSecrets(job, t);
        this._logLine(job, t);
        if (!job._ready && PROMPT_RE.test(t.trim())) job._ready = true; // 会话就绪：收到命令提示符行（banner 期拼接的底层报文不触发）
        // 告警缓冲：周期循环、连接时执行命令、仅读取模式的设备主动输出，全部纳入关键字告警匹配。
        // 字节上限 + 丢最旧：行数上限挡不住「行数少但单行极长」的组合，join 前内存必须有界
        if (job.alerts.length && job._alertPending) {
          job._alertPending.push(t);
          job._alertPendingChars += t.length + 1;
          while ((job._alertPending.length > 20000 || job._alertPendingChars > MAX_ALERT_PENDING_CHARS) && job._alertPending.length > 1) {
            job._alertPendingChars -= job._alertPending[0].length + 1;
            job._alertPending.shift();
          }
        }
        // 备份捕获窗口内的行先入暂存（下面统一过滤命令回显）；字节封顶防撑爆内存
        if (job._backupCap) captured.push(t);
      }
    }
    // 仅读取模式：不跑周期循环，输出到达后去抖检查告警（避免高频输出逐行触发正则）
    if (job.readOnly && job.alerts.length && job._alertPending && job._alertPending.length && !job._alertTimer && !job._alertChecking) {
      job._alertTimer = setTimeout(() => {
        job._alertTimer = null;
        if (job.enabled && !job.stopping) this._checkAlerts(job).catch(() => { /* 告警检查失败不中断监控 */ });
      }, 500);
    }
    // 备份捕获：过滤命令回显（多条命令集合，含「提示符+命令」整行）与提示符行
    if (job._backupCap && captured.length) {
      const cap = job._backupCap;
      for (const t of cleanBackupLines(captured, cap.commands)) {
        if (cap.chars + t.length + 1 > MAX_BACKUP_CAPTURE_CHARS) { cap.truncated = true; break; }
        cap.lines.push(t);
        cap.chars += t.length + 1;
      }
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
  /** 告警匹配经 RegexLab 工作线程执行：用户可配置正则 + 不可信设备输出，灾难性回溯在线程内
   *  超时处决并拉黑该模式，主进程事件循环永不阻塞。异步执行 + _alertChecking 防重入。 */
  async _checkAlerts(job) {
    if (!job.alerts.length || !job._alertPending || job._alertChecking) return;
    job._alertChecking = true;
    try {
      const lines = job._alertPending;
      job._alertPending = [];
      job._alertPendingChars = 0;
      // 字节预算内从尾部保留（新输出更值得关注）：join 结果 ≤ MAX_ALERT_TEXT_CHARS，先算后拼
      let total = 0, start = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        total += lines[i].length + 1;
        if (total > MAX_ALERT_TEXT_CHARS) { start = i + 1; break; }
      }
      const kept = start > 0 ? lines.slice(start) : lines;
      const text = kept.join('\n');
      // 本轮命中的全部关键字（按配置顺序）；告警解除需所有关键字同时不再命中
      const hit = [];
      let firstLineByPattern = [];
      if (text) {
        const items = job.alerts.map(a => ({ pattern: a.pattern, flags: 'i', op: 'test', text, lines: kept }));
        const results = await this.regexLab.run(items);
        results.forEach((r, i) => {
          if (!r) return;
          if (r.blocked && !job._blockedAlertWarned) {
            job._blockedAlertWarned = true;
            this._logLine(job, '警告：告警关键字「' + job.alerts[i].pattern + '」执行超时已禁用（疑似灾难性回溯），请修改为无嵌套量词的线性模式');
          }
          if (r.ok && r.hit) { hit.push(job.alerts[i]); firstLineByPattern[i] = r.line || ''; }
        });
      }
      const nowAlerting = hit.length > 0;
      const patternJoined = hit.map(h => h.pattern).join('、');
      // 状态翻转，或命中集合变化（多告警增/减）时更新状态与事件
      const changed = nowAlerting !== job.alerting || (nowAlerting && (!job.alertInfo || job.alertInfo.pattern !== patternJoined));
      if (changed) {
        // 匹配到的具体行内容（首个命中关键字的首个命中行，供事件时间线 / 系统通知展示）
        let matchedText = '';
        if (nowAlerting) {
          for (const h of hit) {
            const i = job.alerts.indexOf(h);
            if (firstLineByPattern[i]) { matchedText = firstLineByPattern[i]; break; }
          }
        }
        job.alerting = nowAlerting;
        job.alertInfo = nowAlerting ? { pattern: patternJoined, note: hit.map(h => h.note).join('、'), at: Date.now(), matchedText, patterns: hit.map(h => h.pattern) } : null;
        this._logLine(job, nowAlerting ? '【告警】输出匹配关键字「' + patternJoined + '」' + (matchedText ? '：' + matchedText : '') : '【告警解除】输出不再匹配任何告警关键字');
        this.emit('alert', { key: job.key, deviceId: job.deviceId, name: job.name, host: job.host, matched: nowAlerting, pattern: nowAlerting ? patternJoined : null, note: nowAlerting ? job.alertInfo.note : null, matchedText: nowAlerting ? matchedText : null, patterns: nowAlerting ? job.alertInfo.patterns : null });
        this._emit(job);
      }
    } finally {
      job._alertChecking = false;
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
    await this._drainForBackup(job, gen, 2000);        // 排空上一条监控命令的输出尾部，防混入备份
    // 过滤名单并入监控/连接时命令：排空超时的退化场景下，迟到的监控命令回显行同样不得混入备份
    job._backupCap = { commands: job.backup.commands.concat(job.commands || [], job.onConnect || []), lines: [], chars: 0, truncated: false, startedAt: Date.now() };
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
    if (cap.truncated) this._logLine(job, '警告：备份输出超出 ' + Math.floor(MAX_BACKUP_CAPTURE_CHARS / 1024 / 1024) + 'MB 上限，超出部分已丢弃');
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
        cols: 120, rows: 40,
        autoLogin: job.protocol === 'telnet', // 与监控会话同口径：独立备份会话也要过 Telnet 登录提示
        expectFp: job.expectFp || '',
        owner: 'monitor'
      });
      if (!r.ok) { this._finishBackup(job, gen, { ok: false, error: r.error || '备份连接失败' }); resolve(); return; }
      const sid = r.id;
      let settled = false;
      const settle = (res) => { if (settled) return; settled = true; resolve(res); };
      const fail = (err) => {
        // 连接超时/出错/指纹拒连时连接可能仍在建：主动关闭，防慢设备稍后连上时留下无人认领的会话
        try { this.shell.close(sid); } catch (e) { /* ignore */ }
        settle();
        this._finishBackup(job, gen, { ok: false, error: err });
      };
      // 独立会话指纹处理（与监控会话相同的信任语义）
      const onStatus = (sid2, info) => {
        if (sid2 !== sid) return;
        if (info.state === 'connected') {
          clearTimeout(connTimer);
          this.shell.removeListener('status', onStatus);
          // 命令执行与保存全部完成后才 resolve（含 _bkResult 就绪）
          this._runBackupOwnCmds(job, gen, sid).then(settle, settle);
        } else if (info.state === 'fingerprint') {
          // 经跳板连接时跳板与目标各自独立确认：host 取指纹事件自带的目标（info.host），
          // 否则跳板先到时其指纹会被记到目标主机名下，后续连接全部「指纹变化」误拒
          const host = String((info && info.host) || job.host);
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
   *  输出按行缓冲组包（与 _onOutput 同口径）：Telnet 的回显/输出会被 TCP 分包与协商字节
   *  任意切碎，按事件直接拆行会把一条命令回显炸成多段残片漏进备份文件。
   *  只采集首条命令下发之后的输出：连接横幅、登录提示、用户名回显不属于配置内容。
   *  返回 Promise：命令执行 + 过滤 + 保存全部完成后 resolve。 */
  _runBackupOwnCmds(job, gen, sid) {
    return new Promise((resolveCmds) => {
      const lines = [];
      let lineBuf = '';
      let lineChars = 0; // 独立备份输出字节上限：恶意服务端灌输出时按字节丢后续行（与 8MB 单份上限对齐）
      let ownReady = false; // 独立新会话的就绪标志（与监控会话 _ready 互不干扰）
      const eol = job.protocol === 'telnet' ? '\r\n' : '\n';
      const onOut = (sid2, data) => {
        if (sid2 !== sid) return;
        let text = String(data || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b[()][0-9A-B]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        lineBuf += text;
        const parts = lineBuf.split('\n');
        lineBuf = parts.pop(); // 半行留缓冲，等下个事件续拼成整行
        for (const ln of parts) {
          let t = ln.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
          if (!ownReady && PROMPT_RE.test(t.trim())) ownReady = true; // 独立会话就绪判据
          if (t) t = this._maskSecrets(job, t); // 凭据打码：恶意服务端回显密码不得落入备份文件
          if (t && lineChars + t.length + 1 <= MAX_BACKUP_CAPTURE_CHARS) { lines.push(t); lineChars += t.length + 1; }
        }
      };
      this.shell.on('output', onOut);
      (async () => {
        // 空行探测提示符（Telnet 自动登录中跳过，防空行落在登录提示上引发重印干扰应答）
        if (!(job.protocol === 'telnet' && job.password)) { try { this.shell.write(sid, '\r\n'); } catch (e) { /* ignore */ } }
        const t0 = Date.now();
        // 提示符常不带换行结尾（…\r\n> 截止于提示符）：半行残段同样参与就绪判定，否则白等满超时
        while (!ownReady && !job.stopping && gen === job.gen && (Date.now() - t0) < READY_TIMEOUT_MS) {
          if (lineBuf && PROMPT_RE.test(lineBuf.trim())) { ownReady = true; break; }
          await sleep(200);
        }
        // 命令下发前的输出（登录横幅/提示/用户名回显）不属于配置内容：丢弃并重置组包缓冲，
        // 让首条命令回显从新行开始（残留在缓冲里的尾部提示符不会拼进回显行）
        lines.length = 0;
        lineChars = 0;
        lineBuf = '';
        for (const cmd of job.backup.commands) {
          if (!job.enabled || job.stopping || gen !== job.gen) break;
          try { this.shell.write(sid, cmd + eol); } catch (e) { /* ignore */ }
          await sleep(job.backup.waitMs);
        }
        await sleep(400); // 尾部输出缓冲
        // 尾部半行（末行无换行/收尾提示符）冲进结果（提示符行由 cleanBackupLines 剔除）
        const tail = lineBuf.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
        if (tail.trim()) lines.push(tail);
        this.shell.removeListener('output', onOut);
        try { this.shell.close(sid); } catch (e) { /* ignore */ }
        if (!job.enabled || job.stopping || gen !== job.gen) { resolveCmds(); return; }
        // 过滤命令回显（含提示符前缀整行/残片）与提示符行：只保留命令执行后的输出内容
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
    this._runCompliance(job, gen, content).catch(() => { /* 合规巡检失败不中断备份 */ });
  }
  /** 备份内容自动合规巡检（job.backup.compliance.enabled 时）：违规写入事件时间线并广播。
   *  规则在 RegexLab 工作线程内逐行扫描（8MB 备份 × 用户正则，超时处决防回溯挂死主进程）。 */
  async _runCompliance(job, gen, content) {
    const c = job.backup && job.backup.compliance;
    if (!c || !c.enabled || job.stopping || !job.enabled) return;
    const lines = String(content == null ? '' : content).replace(/\r\n/g, '\n').split('\n')
      .map(l => l.length > 10000 ? l.slice(0, 10000) : l);
    const rules = (c.rules || []).filter(r => r && r.enabled);
    const results = await this.regexLab.run(rules.map(r => ({ pattern: r.pattern, flags: 'i', op: 'scan', lines, maxHits: 20 })), 15000);
    if (job.stopping || !job.enabled || gen !== job.gen) return;
    const rep = { results: [], passed: 0, failed: 0 };
    let blockedWarned = false;
    rules.forEach((r, i) => {
      const res = results[i];
      if (!res || !res.ok) {
        // 被超时拉黑/执行失败的规则按「无法评估」处理：不误报违规，仅告警提示修改
        if (res && res.blocked && !blockedWarned) {
          blockedWarned = true;
          this._logLine(job, '警告：合规规则「' + r.name + '」执行超时已禁用（疑似灾难性回溯），请修改为无嵌套量词的线性模式');
        }
        rep.passed++;
        rep.results.push({ id: r.id, name: r.name, negate: r.negate, pass: true, lines: [] });
        return;
      }
      const hitLines = (res.hits || []).map(l => String(lines[l] || '').trim().slice(0, 200));
      const pass = r.negate ? hitLines.length === 0 : hitLines.length > 0;
      if (pass) rep.passed++; else rep.failed++;
      rep.results.push({ id: r.id, name: r.name, negate: r.negate, pass, lines: hitLines });
    });
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

module.exports = { MonitorManager, UptimeStore, sanitizeFilename, cleanBackupLines, compileComplianceRules, runCompliance, snmpGet, snmpGetNext, snmpGetValue, snmpWalk, parseSnmpResponse, snmpResponseMeta, extractVersion, rateBps, fmtUptimeTicks, parseLinuxDf, parseLinuxFree, parseLinuxLoadavg, metricLevels, httpCheck, certDaysLeft, OID_SYSDESCR, OID_SYSOBJECT, OID_SYSUPTIME, OID_IF_DESCR, OID_IF_SPEED, OID_IF_OPER, OID_IF_IN32, OID_IF_OUT32, OID_IF_HCIN, OID_IF_HCOUT };

