/* ============================================================
 * NetTopo model.js —— 数据模型：表格解析 / 表头映射 / 图构建 / 导出
 * ============================================================ */
(function (global) {
'use strict';
const U = global.TopoUtil;

/* ---------- 表头角色 ----------
 * sa=源设备 si=源接口 sip=源IP sb=目标设备 sii=目标接口 sib=目标IP
 * bw=带宽 note=备注
 */
const ROLE_SETS = {
  sa:  ['源设备', '设备a', '设备1', '主机a', '主机1', 'a设备', 'a端设备', 'a端', '源', '源主机',
        'sourcedevice', 'sourcedev', 'source', 'srchost', 'devicea', 'dev_a', 'dev1', 'nodea', 'namea', 'a_device', 'srca', 'a'],
  si:  ['源接口', '接口a', '接口1', 'a接口', '源端口', '端口a',
        'sourceinterface', 'sourceif', 'srcif', 'srcintf', 'if_a', 'ifacea', 'porta', 'sourceport', 'srcport'],
  sip: ['源ip', 'ip地址a', 'ipa', '源ip地址', 'ip_a', 'ip_a地址',
        'sourceip', 'srcip', 'sip', 'ip_a', 'ipaddressa'],
  sb:  ['目标设备', '目的设备', '对端设备', '设备b', '设备2', '主机b', '主机2', 'b设备', 'b端设备', 'b端',
        '目标', '目的', '对端', '目标主机', '目的主机',
        'targetdevice', 'destdevice', 'target', 'destination', 'dest', 'dsthost', 'deviceb', 'dev_b', 'dev2', 'nodeb', 'nameb', 'b_device', 'dstb', 'b'],
  sii: ['目标接口', '目的接口', '对端接口', '接口b', '接口2', 'b接口', '目标端口', '端口b', '对端端口',
        'targetinterface', 'targetif', 'dstif', 'dstintf', 'if_b', 'ifaceb', 'portb', 'destport', 'dstport'],
  sib: ['目标ip', '目的ip', 'ip地址b', 'ipb', '目标ip地址', 'ip_b', 'ip_b地址',
        'targetip', 'dstip', 'dip', 'ip_b', 'ipaddressb'],
  bw:  ['带宽', '速率', '链路带宽', '带宽gbps', '带宽mbps',
        'bandwidth', 'bw', 'speed', 'rate'],
  note:['备注', '说明', '注释', '描述', '备注说明',
        'note', 'remark', 'comment', 'desc', 'description'],
  mgmt:['管理地址', '管理ip', '管理ip地址', '管理', '设备管理地址',
        'mgmtip', 'mgmt', 'manageip', 'manage_ip', 'management']
};

const RE_ROLES = [
  [/^(源|src|a)(设备|主机|节点|device|node|host)?$/i, 'sa'],
  [/^(目标|目的|对端|dst|dest|target|b)(设备|主机|节点|device|node|host)?$/i, 'sb'],
  [/^(源|src|a)?(接口|端口|port|interface|intf|iface|if)$/i, 'si'],
  [/^(目标|目的|对端|dst|dest|target|b)?(接口|端口|port|interface|intf|iface|if)$/i, 'sii'],
  [/^(源|src|a)?(ip地址|ipaddress|ip|地址|address)$/i, 'sip'],
  [/^(目标|目的|对端|dst|dest|target|b)?(ip地址|ipaddress|ip|地址|address)$/i, 'sib'],
  [/^接口[ab一二]?$/, 'si'], [/^端口[ab]?$/, 'si'],
  [/^(ip|ip地址)[ab一二]?$/, 'sip'],
  [/^设备[12一二]$/, 'sa'], [/^主机[12一二]$/, 'sa'],
  [/^设备[34三四]$/, 'sb'], [/^主机[34三四]$/, 'sb']
];

function normHeader(h) {
  return String(h == null ? '' : h).replace(/[\s_\-／/\\（）()【】\[\]·.：:]/g, '').toLowerCase();
}

const RE_COORD = [
  [/^(源设备|设备a|设备1)x$/i, 'sax'], [/^(源设备|设备a|设备1)y$/i, 'say'],
  [/^(目标设备|设备b|设备2)x$/i, 'sbx'], [/^(目标设备|设备b|设备2)y$/i, 'sby']
];
function mapHeader(raw) {
  const h = normHeader(raw);
  if (!h) return null;
  for (const [re, role] of RE_COORD) if (re.test(h)) return role;
  for (const [role, arr] of Object.entries(ROLE_SETS)) {
    if (arr.includes(h)) return role;
  }
  for (const [re, role] of RE_ROLES) {
    if (re.test(h)) return role;
  }
  return null;
}

/* ---------- 表格 → 记录列表 ----------
 * rows: string[][]（含或不含表头）
 */
function parseRows(rows) {
  // 是否第一行是表头
  const head = rows[0] || [];
  const headRoles = head.map(mapHeader);
  const headHits = headRoles.filter(Boolean).length;
  const hasHeader = headHits >= 2 && headRoles.some(r => r === 'sa' || r === 'sb');

  let roles;
  let data;
  if (hasHeader) {
    roles = headRoles;
    data = rows.slice(1);
  } else {
    // 无表头：按位置推断 [设备A, 设备B, 接口A, IP A, 接口B, IP B, 带宽, 备注]
    const pos = ['sa', 'sb', 'si', 'sip', 'sii', 'sib', 'bw', 'note'];
    roles = head.map((_, i) => pos[i] || null);
    data = rows;
  }

  const records = [];
  data.forEach((cells, ri) => {
    if (!cells || !cells.some(c => String(c).trim() !== '')) return;
    const rec = { _row: ri + 2, sa: '', si: '', sip: '', sb: '', sii: '', sib: '', bw: '', note: '', mgmt: '', sax: '', say: '', sbx: '', sby: '' };
    cells.forEach((c, ci) => {
      const role = roles[ci];
      if (role && rec[role] !== undefined) rec[role] = String(c).trim();
    });
    if (rec.sa || rec.sb) records.push(rec);
  });
  return records;
}

/* ---------- 记录 → 图 ---------- */
function recordsToGraph(records) {
  const nodes = [];
  const links = [];
  const nodeMap = new Map(); // name -> node

  const getNode = (name, x, y) => {
    const n = String(name || '').trim();
    if (!n) return null;
    if (nodeMap.has(n)) return nodeMap.get(n);
    const node = {
      id: U.uid('n'),
      name: n,
      type: U.typeOf(n),
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      w: U.nodeWidthForName(n), h: U.NODE_H,
      note: '',
      mgmt: ''
    };
    nodeMap.set(n, node);
    nodes.push(node);
    return node;
  };

  const num = (v) => { const f = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return Number.isFinite(f) ? f : NaN; };

  for (const r of records) {
    const a = getNode(r.sa, num(r.sax), num(r.say)), b = getNode(r.sb, num(r.sbx), num(r.sby));
    if (!a || !b) continue;
    if (a === b) continue; // 自环忽略
    const link = {
      id: U.uid('l'),
      a: a.id, b: b.id,
      aIf: r.si, aIp: r.sip,
      bIf: r.sii, bIp: r.sib,
      bw: U.normalizeBw(r.bw), note: r.note
    };
    if (r.mgmt) {
      if (!a.mgmt) { a.mgmt = r.mgmt; a.h = U.nodeHeightFor(a); }
      else if (!b.mgmt) { b.mgmt = r.mgmt; b.h = U.nodeHeightFor(b); }
    }
    links.push(link);
    if (r.note) {
      if (!a.note) a.note = r.note;
      else if (!b.note) b.note = r.note;
    }
  }
  return { nodes, links };
}

/* ---------- 图 → 表格行 ---------- */
const EXPORT_HEAD = ['源设备', '源接口', '源IP', '目标设备', '目标接口', '目标IP', '带宽', '管理地址', '备注', '源设备X', '源设备Y', '目标设备X', '目标设备Y'];
const EXPORT_KEYS = ['sa', 'si', 'sip', 'sb', 'sii', 'sib', 'bw', 'mgmt', 'note', 'sax', 'say', 'sbx', 'sby'];

function graphToRecords(nodes, links) {
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  // 管理地址按「导入时源优先、目标其次」的规则逆推：
  // 每个节点的 mgmt 只在它第一次被该规则命中的那条链路上导出一次，
  // 避免重复/串行导致再导入时数据丢失或错挂到其他设备。
  const emitted = new Set();
  return links.map(l => {
    const a = byId[l.a], b = byId[l.b];
    let mgmt = '';
    if (a && !emitted.has(a.id)) { mgmt = a.mgmt || ''; emitted.add(a.id); }
    else if (b && !emitted.has(b.id)) { mgmt = b.mgmt || ''; emitted.add(b.id); }
    return {
      sa: a ? a.name : '', si: l.aIf, sip: l.aIp,
      sb: b ? b.name : '', sii: l.bIf, sib: l.bIp,
      bw: l.bw,
      mgmt,
      note: l.note,
      sax: a ? Math.round(a.x * 10) / 10 : '', say: a ? Math.round(a.y * 10) / 10 : '',
      sbx: b ? Math.round(b.x * 10) / 10 : '', sby: b ? Math.round(b.y * 10) / 10 : ''
    };
  });
}

function graphToTableRows(nodes, links) {
  const recs = graphToRecords(nodes, links);
  return [EXPORT_HEAD].concat(recs.map(r => EXPORT_KEYS.map(k => r[k] == null ? '' : String(r[k]))));
}

/* ---------- 文本（CSV）→ 图 ---------- */
function textToGraph(text) {
  const rows = U.parseCSV(text);
  return recordsToGraph(parseRows(rows));
}

/* ---------- XLSX（SheetJS）→ 图 ---------- */
function xlsxToGraph(buffer) {
  const wb = global.XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = global.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const rows2 = rows.map(r => Array.isArray(r) ? r.map(v => v == null ? '' : String(v)) : []);
  return recordsToGraph(parseRows(rows2));
}

/* ---------- 示例数据 ---------- */
const SAMPLE_CSV = [
  '源设备,源接口,源IP,目标设备,目标接口,目标IP,带宽,管理地址,备注',
  '核心路由器R1,GE0/0/0,203.0.113.1,互联网出口Cloud,eth0,203.0.113.254,10000,10.255.0.1,上联运营商',
  '核心路由器R1,GE0/0/1,10.0.0.1,核心交换机SW1,GE1/0/1,10.0.0.2,10000,10.255.0.2,核心互联',
  '核心路由器R1,GE0/0/2,10.0.0.9,防火墙FW1,eth0,10.0.0.10,10000,10.255.0.254,安全出口',
  '防火墙FW1,eth1,172.16.0.1,核心交换机SW1,GE1/0/2,172.16.0.2,10000,,业务区入口',
  '核心交换机SW1,GE1/0/24,192.168.1.1,接入交换机SW2,GE0/0/24,192.168.1.2,1000,10.255.0.3,办公区A',
  '核心交换机SW1,GE1/0/23,192.168.2.1,接入交换机SW2,GE0/0/23,192.168.2.2,1000,,办公区B',
  '接入交换机SW2,GE0/0/1,192.168.1.10,文件服务器FS1,eth0,192.168.1.10,1000,,文件服务',
  '接入交换机SW2,GE0/0/2,192.168.1.20,数据库服务器DB1,eth0,192.168.1.20,1000,,数据库',
  '接入交换机SW2,GE0/0/3,192.168.1.30,办公PC1,eth0,192.168.1.30,100,,行政部',
  '接入交换机SW2,GE0/0/4,192.168.1.31,办公PC2,eth0,192.168.1.31,100,,财务部'
].join('\r\n');


/* ================= 拓扑校验 =================
 * 返回问题列表，每项 { level: error|warning|info, kind, msg, nodeIds?, linkIds? }
 */
function validateTopology(nodes, links) {
  nodes = nodes || []; links = links || [];
  const issues = [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const nameOf = (id) => { const n = byId.get(id); return n ? n.name : id; };

  // 1. 设备名重复
  const nameMap = new Map();
  for (const n of nodes) {
    const k = (n.name || '').trim();
    if (!k) continue;
    if (!nameMap.has(k)) nameMap.set(k, []);
    nameMap.get(k).push(n);
  }
  for (const [name, list] of nameMap) {
    if (list.length > 1) issues.push({
      level: 'error', kind: 'dup-name', nodeIds: list.map(n => n.id),
      msg: `设备名重复：${name}（${list.length} 台）`
    });
  }

  // 2. 管理地址重复
  const mgmtMap = new Map();
  for (const n of nodes) {
    const ip = (n.mgmt || '').trim();
    if (!ip) continue;
    if (!mgmtMap.has(ip)) mgmtMap.set(ip, []);
    mgmtMap.get(ip).push(n);
  }
  for (const [ip, list] of mgmtMap) {
    if (list.length > 1) issues.push({
      level: 'error', kind: 'dup-mgmt', nodeIds: list.map(n => n.id),
      msg: `管理地址重复：${ip}（${list.map(n => n.name).join('、')}）`
    });
  }

  // 3. 同一设备同一接口被多条链路使用
  const ifMap = new Map();
  for (const l of links) {
    for (const side of ['a', 'b']) {
      const ifn = (l[side + 'If'] || '').trim();
      if (!ifn) continue;
      const k = l[side] + '|' + ifn;
      if (!ifMap.has(k)) ifMap.set(k, []);
      ifMap.get(k).push(l.id);
    }
  }
  for (const [k, lids] of ifMap) {
    if (lids.length > 1) {
      const sep = k.indexOf('|');
      const nid = k.slice(0, sep), ifn = k.slice(sep + 1);
      issues.push({
        level: 'error', kind: 'dup-if', nodeIds: [nid], linkIds: lids,
        msg: `设备「${nameOf(nid)}」接口重复：${ifn}（${lids.length} 条链路）`
      });
    }
  }

  // 4. 链路 IP 全局重复（同一 IP 出现在多条链路）
  const ipOwner = new Map();
  for (const l of links) {
    for (const side of ['a', 'b']) {
      const ip = (l[side + 'Ip'] || '').trim();
      if (!ip) continue;
      const owner = ipOwner.get(ip);
      if (owner) {
        issues.push({
          level: 'error', kind: 'dup-ip', linkIds: [owner.linkId, l.id],
          nodeIds: [owner.nodeId, l[side]],
          msg: `IP 重复：${ip}（${owner.nodeName}/${owner.ifName} 与 ${nameOf(l[side])}/${l[side + 'If'] || ''}）`
        });
      } else {
        ipOwner.set(ip, { linkId: l.id, nodeId: l[side], nodeName: nameOf(l[side]), ifName: l[side + 'If'] || '' });
      }
    }
  }

  // 5. 孤立设备
  const linked = new Set();
  for (const l of links) { linked.add(l.a); linked.add(l.b); }
  for (const n of nodes) {
    if (!linked.has(n.id)) issues.push({
      level: 'warning', kind: 'isolated', nodeIds: [n.id],
      msg: `孤立设备：${n.name}（没有连线）`
    });
  }

  // 6. 环路检测（无向图存在环）
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, []);
  for (const l of links) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
  const visited = new Set();
  let hasCycle = false;
  const dfs = (u, parent) => {
    visited.add(u);
    for (const v of adj.get(u) || []) {
      if (v === parent) continue;
      if (visited.has(v)) hasCycle = true;
      else dfs(v, u);
    }
  };
  for (const n of nodes) if (!visited.has(n.id)) dfs(n.id, null);
  if (hasCycle && nodes.length) issues.push({
    level: 'info', kind: 'cycle', nodeIds: [],
    msg: '检测到环路（可能存在冗余链路，允许但请注意）'
  });

  // 7. 平行链路
  const pairCount = new Map();
  for (const l of links) {
    const k = l.a < l.b ? l.a + '|' + l.b : l.b + '|' + l.a;
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }
  for (const [k, c] of pairCount) {
    if (c > 1) {
      const sep = k.indexOf('|');
      const a = k.slice(0, sep), b = k.slice(sep + 1);
      issues.push({
        level: 'info', kind: 'multi', nodeIds: [a, b],
        msg: `「${nameOf(a)}」与「${nameOf(b)}」之间有 ${c} 条平行链路`
      });
    }
  }

  // 8. 链路两端 IP 不同网段（按 /24 判断）
  const netOf = (ip) => { const p = String(ip).split('.'); return p.length >= 3 ? p[0] + '.' + p[1] + '.' + p[2] : null; };
  for (const l of links) {
    const aip = (l.aIp || '').trim(), bip = (l.bIp || '').trim();
    if (aip && bip && aip !== bip) {
      const an = netOf(aip), bn = netOf(bip);
      if (an && bn && an !== bn) issues.push({
        level: 'warning', kind: 'net-mismatch', linkIds: [l.id],
        msg: `链路 ${nameOf(l.a)}⇄${nameOf(l.b)} 两端 IP 不在同一网段（${aip} / ${bip}）`
      });
    }
  }

  const rank = { error: 0, warning: 1, info: 2 };
  issues.sort((x, y) => rank[x.level] - rank[y.level] || x.msg.localeCompare(y.msg, 'zh'));
  return issues;
}

const Model = {
  mapHeader,
  parseRows,
  recordsToGraph,
  graphToRecords,
  graphToTableRows,
  textToGraph,
  xlsxToGraph,
  validateTopology,
  SAMPLE_CSV,
  EXPORT_HEAD,
  EXPORT_KEYS
};
global.TopoModel = Model;
})(typeof globalThis !== 'undefined' ? globalThis : this);
