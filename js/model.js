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
  si:  ['源接口', '接口a', '接口1', 'a接口', '源端口', '端口a', '端口1',
        'sourceinterface', 'sourceif', 'srcif', 'srcintf', 'if_a', 'ifacea', 'porta', 'sourceport', 'srcport'],
  sip: ['源ip', 'ip地址a', 'ipa', '源ip地址', 'ip_a', 'ip_a地址', 'ip1',
        'sourceip', 'srcip', 'sip', 'ip_a', 'ipaddressa'],
  sb:  ['目标设备', '目的设备', '对端设备', '设备b', '设备2', '主机b', '主机2', 'b设备', 'b端设备', 'b端',
        '目标', '目的', '对端', '目标主机', '目的主机',
        'targetdevice', 'destdevice', 'target', 'destination', 'dest', 'dsthost', 'deviceb', 'dev_b', 'dev2', 'nodeb', 'nameb', 'b_device', 'dstb', 'b'],
  sii: ['目标接口', '目的接口', '对端接口', '接口b', '接口2', 'b接口', '目标端口', '端口b', '对端端口', '端口2',
        'targetinterface', 'targetif', 'dstif', 'dstintf', 'if_b', 'ifaceb', 'portb', 'destport', 'dstport'],
  sib: ['目标ip', '目的ip', 'ip地址b', 'ipb', '目标ip地址', 'ip_b', 'ip_b地址', 'ip2',
        'targetip', 'dstip', 'dip', 'ip_b', 'ipaddressb'],
  bw:  ['带宽', '速率', '链路带宽', '带宽gbps', '带宽mbps',
        'bandwidth', 'bw', 'speed', 'rate'],
  note:['备注', '说明', '注释', '描述', '备注说明',
        'note', 'remark', 'comment', 'desc', 'description'],
  mgmt:['管理地址', '管理ip', '管理ip地址', '管理', '设备管理地址',
        'mgmtip', 'mgmt', 'manageip', 'manage_ip', 'management'],
  a2l:  ['源二层', '源二层接口', 'a二层', 'a端二层', '二层a',
        'srcl2', 'a_l2', 'al2', 'a_l2flag'],
  avlan:['源vlan', '源vlan值', '源vlan编号', 'a端vlan', 'a vlan',
        'srcvlan', 'a_vlan', 'avlan'],
  avm:  ['源vlan模式', '源vlan类型', 'a端vlan模式',
        'srcvlanmode', 'a_vlanmode', 'avlanmode'],
  b2l:  ['目标二层', '目标二层接口', 'b二层', 'b端二层', '二层b',
        'dstl2', 'b_l2', 'bl2', 'b_l2flag'],
  bvlan:['目标vlan', '目标vlan值', '目标vlan编号', 'b端vlan', 'b vlan',
        'dstvlan', 'b_vlan', 'bvlan'],
  bvm:  ['目标vlan模式', '目标vlan类型', 'b端vlan模式',
        'dstvlanmode', 'b_vlanmode', 'bvlanmode'],
  amask:['源掩码', '源掩码位', '源掩码长度', 'a端掩码',
        'srcmask', 'a_mask', 'amask', 'srcnetmask'],
  bmask:['目标掩码', '目标掩码位', '目标掩码长度', 'b端掩码',
        'dstmask', 'b_mask', 'bmask', 'dstnetmask'],
  agg: ['聚合组', '链路聚合', '聚合', '聚合名称', '链路聚合组',
        'agg', 'aggregate', 'lag', 'ethtrunk', 'eth_trunk', 'eth-trunk', 'portchannel', 'port-channel', 'trunkgroup'],
  // 三层 VLAN 接口（SVI）：导出列「VLAN接口」的回读角色——缺了这一项整列导出后无法再导入
  vlans: ['vlan接口', '三层vlan接口', '三层vlan', 'vlaninterface', 'svi', 'vlan']
};

const RE_ROLES = [
  [/^(源|src|a)(设备|主机|节点|device|node|host)?$/i, 'sa'],
  [/^(目标|目的|对端|dst|dest|target|b)(设备|主机|节点|device|node|host)?$/i, 'sb'],
  [/^(源|src|a)?(接口|端口|port|interface|intf|iface|if)$/i, 'si'],
  [/^(目标|目的|对端|dst|dest|target|b)?(接口|端口|port|interface|intf|iface|if)$/i, 'sii'],
  [/^(源|src|a)?(ip地址|ipaddress|ip|地址|address)$/i, 'sip'],
  [/^(目标|目的|对端|dst|dest|target|b)?(ip地址|ipaddress|ip|地址|address)$/i, 'sib'],
  [/^接口[ab一二12]?$/, 'si'], [/^端口[ab12]?$/, 'si'],
  // IP 列的序号后缀：2/二/B 归目标端，1/一/A 与无后缀归源端（此前正则把 ip1/ip2 一律算源端）
  [/^(ip|ip地址)(b|2|二)$/, 'sib'],
  [/^(ip|ip地址)(a|1|一)?$/, 'sip'],
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
  // 回读剥掉导出时 sanitizeCell 为防公式注入加的 ' 前缀（与坐标列 num() 同规则）——
  // 不剥的话设备名 '-SW1' 往返后变 ''-SW1，导出→导入不幂等
  const stripFormulaQuote = (s) => {
    const t = String(s == null ? '' : s).trim();
    return /^'[=+\-@]/.test(t) ? t.slice(1) : t;
  };
  data.forEach((cells, ri) => {
    if (!cells || !cells.some(c => String(c).trim() !== '')) return;
    const rec = { _row: ri + 2, sa: '', si: '', sip: '', sb: '', sii: '', sib: '', bw: '', note: '', mgmt: '', vlans: '', sax: '', say: '', sbx: '', sby: '', a2l: '', avlan: '', avm: '', b2l: '', bvlan: '', bvm: '', amask: '', bmask: '', agg: '' };
    cells.forEach((c, ci) => {
      const role = roles[ci];
      if (role && rec[role] !== undefined) rec[role] = stripFormulaQuote(c);
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

  // 数字前缀解析：先去掉 sanitizeCell 为防公式注入加的 ' 前缀（负坐标导出回读时带前缀），
  // 再按 parseFloat 解析；不再剔除非数字字符拼接，避免 "1e5"→15、"1 200"→1200 之类误解析
  const num = (v) => {
    let s = String(v == null ? '' : v).trim();
    if (/^'[=+\-@]/.test(s)) s = s.slice(1);
    const f = parseFloat(s);
    return Number.isFinite(f) ? f : NaN;
  };

  for (const r of records) {
    const a = getNode(r.sa, num(r.sax), num(r.say)), b = getNode(r.sb, num(r.sbx), num(r.sby));
    if (!a || !b) continue;
    if (a === b) continue; // 自环忽略
    const link = {
      id: U.uid('l'),
      a: a.id, b: b.id,
      aIf: r.si, aIp: r.sip,
      bIf: r.sii, bIp: r.sib,
      bw: U.normalizeBw(r.bw), note: r.note,
      agg: String(r.agg || '').trim().slice(0, 32),
      aL2: /^(是|y|yes|1|true|二层)$/i.test(r.a2l), bL2: /^(是|y|yes|1|true|二层)$/i.test(r.b2l),
      aVlan: r.avlan, aVlanMode: (r.avm === 'trunk' || r.avm === 'hybrid') ? r.avm : (r.avlan ? 'access' : ''),
      bVlan: r.bvlan, bVlanMode: (r.bvm === 'trunk' || r.bvm === 'hybrid') ? r.bvm : (r.bvlan ? 'access' : ''),
      aMask: parseInt(r.amask, 10) > 0 && parseInt(r.amask, 10) <= 32 ? parseInt(r.amask, 10) : 24,
      bMask: parseInt(r.bmask, 10) > 0 && parseInt(r.bmask, 10) <= 32 ? parseInt(r.bmask, 10) : 24
    };
    if (r.mgmt) {
      const ms = U.splitMgmts(r.mgmt);
      if (ms.length) {
        if (!U.nodeMgmts(a).length) { U.setNodeMgmts(a, ms); a.h = U.nodeHeightFor(a); }
        else if (!U.nodeMgmts(b).length) { U.setNodeMgmts(b, ms); b.h = U.nodeHeightFor(b); }
      }
    }
    // 三层 VLAN 接口（格式：10:192.168.10.1/26;20:192.168.20.1，源端优先，同 mgmt 规则；掩码可省略=24）
    if (r.vlans) {
      const vs = String(r.vlans).split(/[;；]+/).map(s => s.trim()).filter(Boolean)
        .map(s => {
          const i = s.indexOf(':');
          if (i <= 0) return null;
          let ip = s.slice(i + 1).trim();
          let mask = 24;
          const j = ip.indexOf('/');
          if (j > 0) {
            const m = parseInt(ip.slice(j + 1), 10);
            if (m > 0 && m <= 32) mask = m;
            ip = ip.slice(0, j).trim();
          }
          return { id: s.slice(0, i).trim(), ip, mask };
        })
        .filter(v => v && v.id && v.ip);
      if (vs.length) {
        const target = !(a.vlans && a.vlans.length) ? a : (!(b.vlans && b.vlans.length) ? b : null);
        if (target) target.vlans = vs;
      }
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
const EXPORT_HEAD = ['源设备', '源接口', '源IP', '源掩码', '目标设备', '目标接口', '目标IP', '目标掩码', '带宽', '聚合组', '管理地址', 'VLAN接口', '备注', '源二层', '源VLAN', '源VLAN模式', '目标二层', '目标VLAN', '目标VLAN模式', '源设备X', '源设备Y', '目标设备X', '目标设备Y'];
const EXPORT_KEYS = ['sa', 'si', 'sip', 'amask', 'sb', 'sii', 'sib', 'bmask', 'bw', 'agg', 'mgmt', 'vlans', 'note', 'a2l', 'avlan', 'avm', 'b2l', 'bvlan', 'bvm', 'sax', 'say', 'sbx', 'sby'];

function graphToRecords(nodes, links) {
  const byId = {};
  for (const n of nodes) byId[n.id] = n;
  // 管理地址按「导入时源优先、目标其次」的规则逆推：
  // 每个节点的 mgmt 只在它第一次被该规则命中的那条链路上导出一次，
  // 避免重复/串行导致再导入时数据丢失或错挂到其他设备。
  const emitted = new Set();
  return links.map(l => {
    const a = byId[l.a], b = byId[l.b];
    let mgmt = ''; let vlans = '';
    // SVI 掩码非默认 24 时随导出串带上（id:ip/mask），回读不再退化为 /24
    const vlanStr = (n) => (n.vlans || []).map(v => v.id + ':' + v.ip + (v.mask && v.mask !== 24 ? '/' + v.mask : '')).join(';');
    if (a && !emitted.has(a.id)) { mgmt = U.nodeMgmts(a).join(','); vlans = vlanStr(a); emitted.add(a.id); }
    else if (b && !emitted.has(b.id)) { mgmt = U.nodeMgmts(b).join(','); vlans = vlanStr(b); emitted.add(b.id); }
    return {
      sa: a ? a.name : '', si: l.aIf, sip: l.aIp,
      sb: b ? b.name : '', sii: l.bIf, sib: l.bIp,
      bw: l.bw,
      agg: l.agg || '',
      mgmt,
      vlans,
      note: l.note,
      amask: l.aMask || 24, bmask: l.bMask || 24,
      a2l: l.aL2 ? '是' : '', avlan: l.aVlan || '', avm: l.aVlanMode || '',
      b2l: l.bL2 ? '是' : '', bvlan: l.bVlan || '', bvm: l.bVlanMode || '',
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
    for (const ip of U.nodeMgmts(n)) {
      if (!mgmtMap.has(ip)) mgmtMap.set(ip, []);
      mgmtMap.get(ip).push(n);
    }
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
  // 悬空链路引用（手工编辑的工程 JSON 可能出现）跳过：adj.get(undefined).push 会直接抛错炸掉整个校验
  for (const l of links) {
    if (!adj.has(l.a) || !adj.has(l.b)) continue;
    adj.get(l.a).push(l.b); adj.get(l.b).push(l.a);
  }
  const visited = new Set();
  let hasCycle = false;
  // 迭代版 DFS（避免大图递归栈溢出）；语义与递归版一致：节点首次处理时检查邻接已访问节点
  const dfs = (start) => {
    const stack = [[start, null]];
    while (stack.length) {
      const [u, parent] = stack.pop();
      if (visited.has(u)) continue;
      visited.add(u);
      for (const v of adj.get(u) || []) {
        if (v === parent) continue;
        if (visited.has(v)) hasCycle = true;
        else stack.push([v, u]);
      }
    }
  };
  for (const n of nodes) if (!visited.has(n.id)) dfs(n.id);
  if (hasCycle && nodes.length) issues.push({
    level: 'info', kind: 'cycle', nodeIds: [],
    msg: '检测到环路（可能存在冗余链路，允许但请注意）'
  });

  // 7. 平行链路（同一对设备间同名聚合组的链路属正常链路聚合组网，不再提示）
  const pairCount = new Map();
  const pairLinks = new Map();
  for (const l of links) {
    const k = l.a < l.b ? l.a + '|' + l.b : l.b + '|' + l.a;
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
    if (!pairLinks.has(k)) pairLinks.set(k, []);
    pairLinks.get(k).push(l);
  }
  for (const [k, c] of pairCount) {
    if (c > 1) {
      const members = pairLinks.get(k) || [];
      const aggs = members.map(l => String(l.agg || '').trim());
      if (aggs.every(a => a) && new Set(aggs).size === 1) continue; // 全部成员同名聚合组：链路聚合
      const sep = k.indexOf('|');
      const a = k.slice(0, sep), b = k.slice(sep + 1);
      issues.push({
        level: 'info', kind: 'multi', nodeIds: [a, b],
        msg: `「${nameOf(a)}」与「${nameOf(b)}」之间有 ${c} 条平行链路`
          + (aggs.some(a => a) ? '（部分标记了聚合组，若为链路聚合请统一聚合组名）' : '')
      });
    }
  }

  // 8. 链路两端 IP 不同网段（两端掩码一致且合法时按掩码计算网段——/23 等大掩码互联是合法配置；
  //    掩码缺失或两端不一致时按 /24 兜底，与 checkConfigs 的掩码口径对齐）
  const netOf = (ip, mask) => {
    const net = U.subnetOf(ip, mask);
    if (net) return net;
    const p = String(ip).split('.');
    return p.length >= 3 ? p[0] + '.' + p[1] + '.' + p[2] : null;
  };
  for (const l of links) {
    const aip = (l.aIp || '').trim(), bip = (l.bIp || '').trim();
    if (aip && bip && aip !== bip) {
      const mk = (l.aMask > 0 && l.aMask <= 32 && l.aMask === l.bMask) ? l.aMask : 24;
      const an = netOf(aip, mk), bn = netOf(bip, mk);
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
