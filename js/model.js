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

function mapHeader(raw) {
  const h = normHeader(raw);
  if (!h) return null;
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
    const rec = { _row: ri + 2, sa: '', si: '', sip: '', sb: '', sii: '', sib: '', bw: '', note: '', mgmt: '' };
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

  const getNode = (name) => {
    const n = String(name || '').trim();
    if (!n) return null;
    if (nodeMap.has(n)) return nodeMap.get(n);
    const node = {
      id: U.uid('n'),
      name: n,
      type: U.typeOf(n),
      x: 0, y: 0,
      w: U.nodeWidthForName(n), h: U.NODE_H,
      note: '',
      mgmt: ''
    };
    nodeMap.set(n, node);
    nodes.push(node);
    return node;
  };

  for (const r of records) {
    const a = getNode(r.sa), b = getNode(r.sb);
    if (!a || !b) continue;
    if (a === b) continue; // 自环忽略
    const link = {
      id: U.uid('l'),
      a: a.id, b: b.id,
      aIf: r.si, aIp: r.sip,
      bIf: r.sii, bIp: r.sib,
      bw: r.bw, note: r.note
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
const EXPORT_HEAD = ['源设备', '源接口', '源IP', '目标设备', '目标接口', '目标IP', '带宽', '管理地址', '备注'];
const EXPORT_KEYS = ['sa', 'si', 'sip', 'sb', 'sii', 'sib', 'bw', 'mgmt', 'note'];

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
      note: l.note
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
  '核心路由器R1,GE0/0/0,203.0.113.1,互联网出口Cloud,eth0,203.0.113.254,万兆,10.255.0.1,上联运营商',
  '核心路由器R1,GE0/0/1,10.0.0.1,核心交换机SW1,GE1/0/1,10.0.0.2,万兆,10.255.0.2,核心互联',
  '核心路由器R1,GE0/0/2,10.0.0.9,防火墙FW1,eth0,10.0.0.10,万兆,10.255.0.254,安全出口',
  '防火墙FW1,eth1,172.16.0.1,核心交换机SW1,GE1/0/2,172.16.0.2,万兆,,业务区入口',
  '核心交换机SW1,GE1/0/24,192.168.1.1,接入交换机SW2,GE0/0/24,192.168.1.2,千兆,10.255.0.3,办公区A',
  '核心交换机SW1,GE1/0/23,192.168.2.1,接入交换机SW2,GE0/0/23,192.168.2.2,千兆,,办公区B',
  '接入交换机SW2,GE0/0/1,192.168.1.10,文件服务器FS1,eth0,192.168.1.10,千兆,,文件服务',
  '接入交换机SW2,GE0/0/2,192.168.1.20,数据库服务器DB1,eth0,192.168.1.20,千兆,,数据库',
  '接入交换机SW2,GE0/0/3,192.168.1.30,办公PC1,eth0,192.168.1.30,百兆,,行政部',
  '接入交换机SW2,GE0/0/4,192.168.1.31,办公PC2,eth0,192.168.1.31,百兆,,财务部'
].join('\r\n');

const Model = {
  mapHeader,
  parseRows,
  recordsToGraph,
  graphToRecords,
  graphToTableRows,
  textToGraph,
  xlsxToGraph,
  SAMPLE_CSV,
  EXPORT_HEAD,
  EXPORT_KEYS
};
global.TopoModel = Model;
})(typeof globalThis !== 'undefined' ? globalThis : this);
