/* NetTopo 本机网络诊断工具箱 —— 主进程纯 Node 模块（不依赖 Electron）
 * 提供 Ping / 路由跟踪 / TCP 端口批量探测 / DNS 解析四类诊断：
 *   - ping：spawn 系统 ping（Windows -n / Linux -c），解析收发包与 rt 统计
 *   - trace：Windows tracert / Linux traceroute（缺省回退 tracepath）
 *   - tcp：net.connect 批量端口探测（并发上限 + 单口超时）
 *   - dns：dns.promises lookup（A 记录）+ reverse（PTR）
 * 输出解析为纯函数（可在 Node 测试中直接使用）；外部命令仅以受控参数列表 spawn，
 * 不经 shell 拼接，主机地址以白名单字符校验。
 */
'use strict';
const net = require('net');
const dnsPromises = require('dns').promises;
const { spawn } = require('child_process');

/** 主机地址白名单：IPv4 / IPv6 / 主机名（字母数字点连下划线冒号），供外部命令与探测共用 */
function isValidDiagHost(host) {
  const s = String(host == null ? '' : host).trim();
  return s.length > 0 && s.length <= 253 && /^[A-Za-z0-9_.:-]+$/.test(s);
}

/** 端口列表解析：'22, 80, 8000-8002' → [22,80,8000,8001,8002]；去重升序，总量封顶 256 */
function parsePortList(text) {
  const out = new Set();
  for (const part of String(text == null ? '' : text).split(/[,，\s;；]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d{1,5})-(\d{1,5})$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (!(a >= 1 && a <= 65535)) continue;
      b = Math.min(b, 65535); // 区间上越界钳到端口上限（1-99999 → 1~65535 再按总量截断）
      if (b < a) continue;
      if (b - a > 255) b = a + 255;
      for (let p = a; p <= b && out.size < 256; p++) out.add(p);
      continue;
    }
    const p = parseInt(part, 10);
    if (p >= 1 && p <= 65535) out.add(p);
    if (out.size >= 256) break;
  }
  return [...out].sort((x, y) => x - y);
}

/** 解析 ping 输出统计（Windows 中文/英文、Linux iputils 三种格式）：
 *  返回 {sent, received, lostPct, min, avg, max}（rtt 缺失项为 null），无法解析返回 null */
function parsePingStats(output) {
  const t = String(output == null ? '' : output);
  const out = { sent: null, received: null, lostPct: null, min: null, avg: null, max: null };
  // 包计数：Linux「4 packets transmitted, 4 received, 0% packet loss」/ Win「已发送 = 4，已接收 = 4，丢失 = 0 (0% 丢失)」
  let m = t.match(/(\d+)\s*(?:packets\s+)?transmitted,\s*(\d+)\s*(?:packets\s+)?received,\s*([\d.]+)%\s*packet loss/i)
      || t.match(/已发送\s*=\s*(\d+)\s*[，,]\s*已接收\s*=\s*(\d+)\s*[，,]\s*丢失\s*=\s*(\d+)\s*[（(]\s*([\d.]+)%/)
      || t.match(/Sent\s*=\s*(\d+)\s*[，,]\s*Received\s*=\s*(\d+)\s*[，,]\s*Lost\s*=\s*(\d+)\s*[(（]\s*([\d.]+)%/i);
  if (m) {
    // Linux 格式 3 个分组（第 3 组即丢包百分比）；Windows 中英文 4 个分组（第 4 组为百分比）
    if (m.length >= 5) { out.sent = parseInt(m[1], 10); out.received = parseInt(m[2], 10); out.lostPct = parseFloat(m[4]); }
    else { out.sent = parseInt(m[1], 10); out.received = parseInt(m[2], 10); out.lostPct = parseFloat(m[3]); }
  }
  // rtt：Linux「rtt min/avg/max/mdev = 0.045/0.050/0.058/0.005 ms」/ Win「最短 = 1ms，最长 = 2ms，平均 = 1ms」
  const r = t.match(/min\/avg\/max(?:\/\w+)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/i)
      || t.match(/(?:最短|Minimum)\s*=\s*([\d.]+)\s*ms[\s\S]*?(?:最长|Maximum)\s*=\s*([\d.]+)\s*ms[\s\S]*?(?:平均|Average)\s*=\s*([\d.]+)\s*ms/i);
  if (r) {
    if (t.match(/min\/avg\/max/i)) { out.min = parseFloat(r[1]); out.avg = parseFloat(r[2]); out.max = parseFloat(r[3]); }
    else { out.min = parseFloat(r[1]); out.max = parseFloat(r[2]); out.avg = parseFloat(r[3]); }
  }
  return (out.sent == null && out.avg == null) ? null : out;
}

/** 单项 TCP 探测：{port, open, ms}；超时/拒绝 = 关闭 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const fin = (open) => { if (!done) { done = true; resolve({ port, open, ms: Date.now() - t0 }); } };
    const sock = net.connect({ host, port });
    sock.setTimeout(Math.max(200, Math.min(10000, timeoutMs || 2000)));
    sock.once('connect', () => { sock.destroy(); fin(true); });
    sock.once('timeout', () => { sock.destroy(); fin(false); });
    sock.once('error', () => { sock.destroy(); fin(false); });
  });
}

/** TCP 端口批量探测：并发上限 16，按端口升序返回 [{port, open, ms}] */
async function scanPorts(host, ports, timeoutMs) {
  const list = (Array.isArray(ports) ? ports : []).map(Number).filter(p => p >= 1 && p <= 65535);
  const results = [];
  const CONC = 16;
  for (let i = 0; i < list.length; i += CONC) {
    const batch = list.slice(i, i + CONC);
    results.push(...await Promise.all(batch.map(p => tcpProbe(host, p, timeoutMs))));
  }
  return results;
}

/** DNS 解析：A 记录（lookup all）+ 首个 IPv4 的 PTR 反查；单项失败不影响整体 */
async function dnsLookup(host) {
  const out = { host, addresses: [], cname: null, reverse: [], error: null };
  try {
    const all = await dnsPromises.lookup(host, { all: true, verbatim: true });
    out.addresses = (all || []).map(a => a.address).slice(0, 16);
    for (const a of all || []) { if (a && a.type === 'CNAME' && !out.cname) out.cname = a.address; }
  } catch (e) { out.error = '解析失败：' + ((e && (e.message || e.code)) || e); return out; }
  const v4 = out.addresses.find(a => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(a));
  if (v4) {
    try { out.reverse = (await dnsPromises.reverse(v4)).slice(0, 8); } catch (e) { /* 无 PTR 属正常 */ }
  }
  return out;
}

/** 外部命令输出解码：先按 UTF-8；出现替换符（U+FFFD，典型为中文 Windows 的 GBK/OEM 输出）时
 *  尝试 GBK 解码，取替换符更少的结果。纯 ASCII（英文系统）不受影响。 */
function decodeCmdOutput(buf) {
  const utf = buf.toString('utf8');
  if (utf.indexOf('\uFFFD') < 0) return utf;
  try {
    const gb = new TextDecoder('gbk').decode(buf);
    if (gb.indexOf('\uFFFD') < 0) return gb;
    return (gb.split('\uFFFD').length <= utf.split('\uFFFD').length) ? gb : utf;
  } catch (e) { return utf; } // small-icu 无 gbk：保留 utf8 结果
}

/** spawn 包装：拒绝 shell 拼接（参数列表直传），结果收集为 {ok, output, error} */
function runCommand(cmd, args, timeoutMs, maxChars) {
  return new Promise((resolve) => {
    let child = null;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ ok: false, output: '', error: '无法启动 ' + cmd + '：' + ((e && e.message) || e) }); return; }
    const chunks = [];
    let bytes = 0;
    const cap = 256 * 1024;
    let settled = false;
    const fin = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child && !child.killed) child.kill(); } catch (e) { /* ignore */ }
      resolve({ ok, output: decodeCmdOutput(Buffer.concat(chunks)).slice(0, maxChars || 64 * 1024), error: error || null });
    };
    const timer = setTimeout(() => fin(false, cmd + ' 执行超时'), Math.max(2000, Math.min(120000, timeoutMs || 30000)));
    child.stdout.on('data', (d) => { if (bytes < cap) { bytes += d.length; chunks.push(d); } });
    child.stderr.on('data', (d) => { if (bytes < cap) { bytes += d.length; chunks.push(d); } });
    child.on('error', (e) => fin(false, (e && e.code) === 'ENOENT' ? '本机未找到 ' + cmd + ' 命令' : (cmd + ' 执行失败：' + ((e && e.message) || e))));
    child.on('close', (code) => fin(code === 0, code === 0 ? null : (cmd + ' 退出码 ' + code)));
  });
}

/** Ping：count 钳制 1~10；返回 {ok, output, stats}（stats 为 parsePingStats 结果，可能为 null） */
async function ping(host, count) {
  const h = String(host == null ? '' : host).trim();
  if (!isValidDiagHost(h)) return { ok: false, output: '', stats: null, error: '主机地址无效' };
  const n = Math.max(1, Math.min(10, parseInt(count, 10) || 4));
  const args = process.platform === 'win32' ? ['-n', String(n), '-w', '2000', h] : ['-c', String(n), '-W', '2', h];
  const r = await runCommand('ping', args, 30000);
  return { ok: !!r.ok, output: r.output, stats: parsePingStats(r.output), error: r.error };
}

/** 路由跟踪：Windows tracert / Linux traceroute（未安装时回退 tracepath）；hop 上限 12 */
async function trace(host) {
  const h = String(host == null ? '' : host).trim();
  if (!isValidDiagHost(h)) return { ok: false, output: '', error: '主机地址无效' };
  let r;
  if (process.platform === 'win32') {
    r = await runCommand('tracert', ['-d', '-w', '900', '-h', '12', h], 60000);
  } else {
    r = await runCommand('traceroute', ['-n', '-w', '2', '-m', '12', h], 60000);
    if (!r.ok && r.error && r.error.indexOf('未找到') >= 0) {
      r = await runCommand('tracepath', ['-n', '-m', '12', h], 60000);
    }
  }
  return { ok: !!r.ok, output: r.output, error: r.error };
}

module.exports = { isValidDiagHost, parsePortList, parsePingStats, scanPorts, tcpProbe, dnsLookup, ping, trace };
