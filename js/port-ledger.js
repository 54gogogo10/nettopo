/* NetTopo 端口/线缆台账与 VLAN 一致性 —— 纯逻辑（渲染层经 globalThis.TopoPortLedger 使用，Node 测试直接 require）
 *
 * 数据来源：设备配置备份（description / link-type / access VLAN / trunk allowed VLAN / IP / shutdown）
 * + SNMP ifTable 最新采样（oper / speed / 速率 / 错包）+ 拓扑连线（对端设备与接口）。
 * 输出一张「端口资产表」，并做三类可证伪的 VLAN 检查：
 *   ① access 口用了本机未创建的 VLAN（仅在能解析到 VLAN 定义时判定，避免配置没抓全就误报）；
 *   ② 同一对链路两端都是 trunk 时，allowed VLAN 不一致（列出各自缺少哪些）；
 *   ③ 拓扑连线上登记的 VLAN 与设备配置里的 access VLAN 不一致（规划 vs 实际）。
 *
 * 口径：只解析配置文本，不猜测命令缩写；识别不了的接口/行如实跳过并计数，不编造。
 */
'use strict';
(function (global) {
'use strict';

/** VLAN 列表解析：'10 20 30-32' / '10,20,30' / '10 to 20' / 'add 30' / 'all'。
 *  返回 {list:[...], all:boolean, text}；空/非数字 token 忽略并计入 invalid。 */
function parseVlanList(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const out = new Set();
  let all = false, invalid = 0;
  // '10 to 12' 先折叠成区间，避免被空格切成三个 token（Cisco 的 interface range 也常用这种写法）
  let s = text.replace(/(\d+)\s+to\s+(\d+)/gi, '$1-$2').replace(/\b(add|remove|except|only)\b/gi, ' ').trim();
  if (/^all$/i.test(s)) return { list: [], all: true, text, invalid: 0 };
  for (const token of s.split(/[\s,]+/)) {
    if (!token) continue;
    let m = /^(\d+)-(\d+)$/.exec(token) || /^(\d+)\s+to\s+(\d+)$/i.exec(token);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (!(a >= 1 && b >= 1 && b >= a && b <= 4094)) { invalid++; continue; }
      for (let v = a; v <= b && out.size < 4094; v++) out.add(v);
      continue;
    }
    m = /^(\d+)$/.exec(token);
    if (m) {
      const v = Number(m[1]);
      if (v >= 1 && v <= 4094) out.add(v); else invalid++;
      continue;
    }
    invalid++;
  }
  return { list: [...out].sort((a, b) => a - b), all, text, invalid };
}

const IF_RE = /^interface\s+(.+?)\s*$/i;
const VLAN_DEF_RE = /^vlan\s+(?:batch\s+)?(.+?)\s*$/i;
/** 判断一行是否「顶层」（不在接口块里）：配置备份里子命令都带缩进；空行/注释不断块。 */
function isTopLevel(line) {
  return line.length > 0 && !/^\s/.test(line) && !/^[!#]/.test(line);
}

/** 解析一份设备配置：返回 {ok, interfaces, vlans, stats}。
 *  interfaces: [{name, desc, mode:'access'|'trunk'|'hybrid'|'routed'|'', accessVlan, trunkVlans, trunkAll,
 *                nativeVlan, ip, mask, shutdown, rawLines}] */
function parseConfig(text, vendor) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const interfaces = [];
  const vlans = new Set();
  const stats = { interfaces: 0, lines: lines.length, ignoredVlanTokens: 0, vlanDefs: 0, l2: 0, l3: 0, shutdown: 0 };
  let cur = null;
  const push = () => { if (cur) { interfaces.push(cur); stats.interfaces++; if (cur.shutdown) stats.shutdown++; if (cur.ip) stats.l3++; else if (cur.mode) stats.l2++; cur = null; } };
  const isVendor = String(vendor || '').toLowerCase();

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^\s*[!#]/.test(line)) continue;
    const top = isTopLevel(line);

    if (top) {
      const mi = IF_RE.exec(line);
      if (mi) {
        push();
        const name = mi[1].trim();
        cur = { name, desc: '', mode: '', accessVlan: null, trunkVlans: [], trunkAll: false, nativeVlan: null, ip: '', mask: '', shutdown: false, rawLines: 0 };
        if (/^vlan-?if/i.test(name) || /^vlan\s*\d+/i.test(name)) cur.mode = 'routed';
        continue;
      }
      const mv = VLAN_DEF_RE.exec(line);
      if (mv) {
        const parsed = parseVlanList(mv[1]);
        stats.vlanDefs++;
        stats.ignoredVlanTokens += parsed.invalid;
        for (const v of parsed.list) vlans.add(v);
        // vlan 10 / vlan batch 10 20 之后通常跟 name 子行；不需要在这里结束接口块
        push();
        continue;
      }
      // 其它顶层命令结束接口块
      push();
      continue;
    }

    if (!cur) continue;
    cur.rawLines++;
    const t = line.trim();
    let m;
    if ((m = /^description\s+(.+)$/i.exec(t)) || (m = /^alias\s+(.+)$/i.exec(t))) { cur.desc = m[1].trim().slice(0, 200); continue; }
    if ((m = /^port\s+link-type\s+(access|trunk|hybrid)$/i.exec(t))) { cur.mode = m[1].toLowerCase(); continue; }
    if ((m = /^port\s+default\s+vlan\s+(\d+)$/i.exec(t)) || (m = /^port\s+access\s+vlan\s+(\d+)$/i.exec(t))) {
      cur.accessVlan = Number(m[1]); if (!cur.mode) cur.mode = 'access'; continue;
    }
    if ((m = /^port\s+trunk\s+(?:allow-pass|permit)\s+vlan\s+(.+)$/i.exec(t))) {
      const p = parseVlanList(m[1]); cur.trunkAll = cur.trunkAll || p.all;
      for (const v of p.list) if (cur.trunkVlans.indexOf(v) < 0) cur.trunkVlans.push(v);
      stats.ignoredVlanTokens += p.invalid; if (!cur.mode) cur.mode = 'trunk'; continue;
    }
    if ((m = /^port\s+trunk\s+pvid\s+vlan\s+(\d+)$/i.exec(t))) { cur.nativeVlan = Number(m[1]); continue; }
    if ((m = /^port\s+hybrid\s+vlan\s+(.+)$/i.exec(t))) {
      const p = parseVlanList(m[1]); cur.trunkAll = cur.trunkAll || p.all;
      for (const v of p.list) if (cur.trunkVlans.indexOf(v) < 0) cur.trunkVlans.push(v);
      if (!cur.mode) cur.mode = 'hybrid'; continue;
    }
    if ((m = /^switchport\s+mode\s+(access|trunk)$/i.exec(t))) { cur.mode = m[1].toLowerCase(); continue; }
    if ((m = /^switchport\s+access\s+vlan\s+(\d+)$/i.exec(t))) { cur.accessVlan = Number(m[1]); if (!cur.mode) cur.mode = 'access'; continue; }
    if ((m = /^switchport\s+trunk\s+allowed\s+vlan\s+(.+)$/i.exec(t))) {
      const p = parseVlanList(m[1]); cur.trunkAll = cur.trunkAll || p.all;
      if (!/\badd\b/i.test(t)) cur.trunkVlans = [];
      for (const v of p.list) if (cur.trunkVlans.indexOf(v) < 0) cur.trunkVlans.push(v);
      stats.ignoredVlanTokens += p.invalid; if (!cur.mode) cur.mode = 'trunk'; continue;
    }
    if ((m = /^switchport\s+trunk\s+native\s+vlan\s+(\d+)$/i.exec(t))) { cur.nativeVlan = Number(m[1]); continue; }
    if (/^no\s+switchport$/i.test(t)) { cur.mode = 'routed'; continue; }
    if (/^portswitch$/i.test(t) && !cur.mode) { cur.mode = 'access'; continue; }
    if ((m = /^ip\s+address\s+(\S+)(?:\s+(\S+))?$/i.exec(t))) {
      cur.ip = m[1];
      if (cur.ip.indexOf('/') >= 0) { const p = cur.ip.split('/'); cur.ip = p[0]; cur.mask = p[1]; }
      else if (m[2] && /^\d{1,3}(\.\d{1,3}){3}$/.test(m[2])) cur.mask = m[2];
      continue;
    }
    if (/^(shutdown|disable)$/i.test(t)) { cur.shutdown = true; continue; }
    if (/^(undo\s+shutdown|no\s+shutdown)$/i.test(t)) { cur.shutdown = false; continue; }
  }
  push();
  interfaces.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const it of interfaces) it.trunkVlans.sort((a, b) => a - b);
  return { ok: true, vendor: isVendor, interfaces, vlans: [...vlans].sort((a, b) => a - b), stats };
}

/** 接口名规范化（与 U.canonIfname 同口径的轻量版；模块不依赖 util，避免 Node 测试载入 DOM 依赖） */
function canon(name) {
  const t = String(name == null ? '' : name).trim().toLowerCase().replace(/[\s_]/g, '');
  const M = [
    [/^tengigabitethernet/, 'xge'], [/^xgigabitethernet/, 'xge'], [/^10gigabitethernet/, 'xge'], [/^xge/, 'xge'], [/^te(?=\d)/, 'xge'],
    [/^fortygigabitethernet/, 'fge'], [/^40ge(?=\d)/, 'fge'], [/^fo(?=\d)/, 'fge'],
    [/^hundredgigabitethernet/, 'hge'], [/^100ge(?=\d)/, 'hge'], [/^hu(?=\d)/, 'hge'],
    [/^twentyfivegige/, 'tge'], [/^25ge(?=\d)/, 'tge'],
    [/^gigabitethernet/, 'ge'], [/^gigabiteth/, 'ge'], [/^gi(?=\d)/, 'ge'], [/^ge(?=\d)/, 'ge'],
    [/^eth-trunk/, 'lag'], [/^port-channel/, 'lag'], [/^portchannel/, 'lag'], [/^po(?=\d)/, 'lag'], [/^lag/, 'lag'],
    [/^managementethernet/, 'meth'], [/^management(?=\d)/, 'meth'], [/^meth(?=\d)/, 'meth'],
    [/^vlan-interface/, 'vlanif'], [/^vlanif(?=\d)/, 'vlanif'], [/^vlan(?=\d)/, 'vlan'],
    [/^loopback/, 'lo'], [/^lo(?=\d)/, 'lo'],
    [/^tunnel/, 'tun'], [/^tu(?=\d)/, 'tun'],
    [/^null(?=\d)/, 'null'],
    [/^fastethernet/, 'fe'], [/^fa(?=\d)/, 'fe'],
    [/^ethernet/, 'eth'], [/^eth(?=\d)/, 'eth'],
    [/^serial/, 'ser'], [/^se(?=\d)/, 'ser']
  ];
  for (const [re, pre] of M) { const m = re.exec(t); if (m) return pre + t.slice(m[0].length); }
  return t;
}

/** VLAN 一致性检查。devices: [{name, host, vendor, vlans:[], interfaces:[]}]；links: [{id, aDevice, aIf, bDevice, bIf, aVlan, bVlan}]
 *  返回 {ok, issues, summary}。issues: [{kind, severity:'warn'|'info', device, peer, ifName, detail}] */
function checkVlans(devices, links) {
  const list = Array.isArray(devices) ? devices : [];
  const ls = Array.isArray(links) ? links : [];
  const byName = new Map();
  for (const d of list) byName.set(String(d.name), d);
  const issues = [];
  const add = (o) => issues.push(Object.assign({ severity: 'warn' }, o));
  for (const d of list) {
    const defs = Array.isArray(d.vlans) ? d.vlans : [];
    const hasDefs = defs.length > 0;
    for (const it of (d.interfaces || [])) {
      if (!hasDefs) break; // 配置没解析到 VLAN 定义时不做「未创建」判定
      if (it.mode === 'access' && it.accessVlan && defs.indexOf(it.accessVlan) < 0) {
        add({ kind: 'access-undef', device: d.name, ifName: it.name, detail: 'access 口使用 VLAN ' + it.accessVlan + '，本机配置里没有该 VLAN 定义' });
      }
      if ((it.mode === 'trunk' || it.mode === 'hybrid') && !it.trunkAll && it.trunkVlans.length) {
        const missing = it.trunkVlans.filter(v => defs.indexOf(v) < 0);
        if (missing.length) add({ kind: 'trunk-undef', device: d.name, ifName: it.name, detail: 'trunk 允许的 VLAN 未在本机创建：' + missing.slice(0, 10).join('、') + (missing.length > 10 ? ' 等 ' + missing.length + ' 个' : '') });
      }
    }
  }
  for (const link of ls) {
    const A = byName.get(String(link.aDevice)), B = byName.get(String(link.bDevice));
    if (!A || !B) continue;
    const ai = (A.interfaces || []).find(x => canon(x.name) === canon(link.aIf));
    const bi = (B.interfaces || []).find(x => canon(x.name) === canon(link.bIf));
    if (!ai || !bi) continue;
    // ② 两端 trunk allowed VLAN 不一致
    if ((ai.mode === 'trunk' || ai.mode === 'hybrid') && (bi.mode === 'trunk' || bi.mode === 'hybrid')) {
      if (!ai.trunkAll && !bi.trunkAll && (ai.trunkVlans.length || bi.trunkVlans.length)) {
        const missA = bi.trunkVlans.filter(v => ai.trunkVlans.indexOf(v) < 0);
        const missB = ai.trunkVlans.filter(v => bi.trunkVlans.indexOf(v) < 0);
        if (missA.length || missB.length) {
          add({ kind: 'trunk-mismatch', device: A.name, peer: B.name, ifName: ai.name, detail: A.name + ' ' + ai.name + ' 缺少 ' + (missA.length ? missA.slice(0, 10).join('、') : '无') + '；' + B.name + ' ' + bi.name + ' 缺少 ' + (missB.length ? missB.slice(0, 10).join('、') : '无') });
        }
      }
    }
    // ③ 拓扑登记 VLAN vs 配置 access VLAN
    if (link.aVlan && ai.accessVlan && String(link.aVlan) !== String(ai.accessVlan)) {
      add({ kind: 'topo-vlan', device: A.name, peer: B.name, ifName: ai.name, detail: '拓扑登记 VLAN ' + link.aVlan + '，设备配置为 access VLAN ' + ai.accessVlan });
    }
    if (link.bVlan && bi.accessVlan && String(link.bVlan) !== String(bi.accessVlan)) {
      add({ kind: 'topo-vlan', device: B.name, peer: A.name, ifName: bi.name, detail: '拓扑登记 VLAN ' + link.bVlan + '，设备配置为 access VLAN ' + bi.accessVlan });
    }
    // access 一侧的 VLAN 必须在 trunk 一侧放行
    if (ai.accessVlan && (bi.mode === 'trunk' || bi.mode === 'hybrid') && !bi.trunkAll && bi.trunkVlans.length && bi.trunkVlans.indexOf(ai.accessVlan) < 0) {
      add({ kind: 'access-not-allowed', device: B.name, peer: A.name, ifName: bi.name, detail: '对端 ' + A.name + ' ' + ai.name + ' 的 access VLAN ' + ai.accessVlan + ' 不在本端口 trunk 放行列表里' });
    }
    if (bi.accessVlan && (ai.mode === 'trunk' || ai.mode === 'hybrid') && !ai.trunkAll && ai.trunkVlans.length && ai.trunkVlans.indexOf(bi.accessVlan) < 0) {
      add({ kind: 'access-not-allowed', device: A.name, peer: B.name, ifName: ai.name, detail: '对端 ' + B.name + ' ' + bi.name + ' 的 access VLAN ' + bi.accessVlan + ' 不在本端口 trunk 放行列表里' });
    }
  }
  const summary = { total: issues.length, accessUndef: 0, trunkUndef: 0, mismatch: 0, topo: 0, accessNotAllowed: 0 };
  for (const it of issues) {
    if (it.kind === 'access-undef') summary.accessUndef++;
    else if (it.kind === 'trunk-undef') summary.trunkUndef++;
    else if (it.kind === 'trunk-mismatch') summary.mismatch++;
    else if (it.kind === 'topo-vlan') summary.topo++;
    else if (it.kind === 'access-not-allowed') summary.accessNotAllowed++;
  }
  return { ok: true, issues, summary };
}

/** 规划核对：把「规划中」的设备/链路与设备配置事实逐项比对（只读配置备份，不登录设备）。
 *  plan: {nodes:[{name, mgmt}], links:[{id, aDevice,aIf,aIp,aVlan,aMode,bDevice,bIf,bIp,bVlan,bMode}]}
 *  devices: [{name, text, interfaces:[{name, ip, mask, mode, accessVlan, trunkVlans, trunkAll}]}]
 *  返回 {ok, issues, summary}。issues: [{kind, level:'warn'|'info', device, linkId, ifName, detail}] */
function checkPlan(plan, devices) {
  const p = plan || {};
  const list = Array.isArray(devices) ? devices : [];
  const byName = new Map();
  for (const d of list) byName.set(String(d.name), d);
  const issues = [];
  const add = (o) => issues.push(Object.assign({ level: 'warn' }, o));
  for (const n of (Array.isArray(p.nodes) ? p.nodes : [])) {
    const d = byName.get(String(n.name));
    if (!d) { add({ kind: 'no-config', device: n.name, detail: '规划设备没有配置备份：无法核对是否已实施' }); continue; }
    if (n.mgmt && String(d.text || '').indexOf(String(n.mgmt)) < 0) {
      add({ kind: 'mgmt-missing', level: 'info', device: n.name, detail: '配置文本里没找到规划的管理地址 ' + n.mgmt + '（可能只存在于带外/未备份段落）' });
    }
  }
  const findIf = (d, name) => (d && Array.isArray(d.interfaces)) ? d.interfaces.find(x => canon(x.name) === canon(name)) : null;
  for (const l of (Array.isArray(p.links) ? p.links : [])) {
    const sides = [
      { device: l.aDevice, ifName: l.aIf, ip: l.aIp, vlan: l.aVlan, mode: l.aMode },
      { device: l.bDevice, ifName: l.bIf, ip: l.bIp, vlan: l.bVlan, mode: l.bMode }
    ];
    for (const s of sides) {
      if (!s.device || !s.ifName) continue;
      const d = byName.get(String(s.device));
      if (!d) { add({ kind: 'no-config', device: s.device, linkId: l.id, ifName: s.ifName, detail: '规划链路 ' + s.device + ' 侧没有配置备份：无法核对' }); continue; }
      const it = findIf(d, s.ifName);
      if (!it) { add({ kind: 'if-missing', device: s.device, linkId: l.id, ifName: s.ifName, detail: '配置里没有接口 ' + s.ifName + '（规划未实施或接口名不一致）' }); continue; }
      if (s.ip && String(it.ip || '') !== String(s.ip)) {
        add({ kind: 'ip-mismatch', device: s.device, linkId: l.id, ifName: s.ifName, detail: '规划 IP ' + s.ip + '，配置为 ' + (it.ip || '（无 IP）') });
      }
      if (s.vlan && it.mode === 'access' && String(it.accessVlan || '') !== String(s.vlan)) {
        add({ kind: 'vlan-mismatch', device: s.device, linkId: l.id, ifName: s.ifName, detail: '规划 VLAN ' + s.vlan + '，配置 access VLAN ' + (it.accessVlan == null ? '（未配置）' : it.accessVlan) });
      }
      if (s.mode && it.mode && String(it.mode) !== String(s.mode)) {
        add({ kind: 'mode-mismatch', level: 'info', device: s.device, linkId: l.id, ifName: s.ifName, detail: '规划模式 ' + s.mode + '，配置为 ' + it.mode });
      }
    }
  }
  const summary = { total: issues.length, noConfig: 0, missing: 0, mismatch: 0, info: 0 };
  for (const it of issues) {
    if (it.kind === 'no-config') summary.noConfig++;
    else if (it.kind === 'if-missing') summary.missing++;
    else if (it.kind === 'mgmt-missing' || it.kind === 'mode-mismatch') summary.info++;
    else summary.mismatch++;
  }
  return { ok: true, issues, summary };
}

const API = { parseVlanList, parseConfig, checkVlans, checkPlan, canon };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.TopoPortLedger = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
