/* NetTopo 大型模拟拓扑生成器 —— 生成全套用于「显示验证」的测试文件
 *
 * 产出（默认写入 test/fixtures/，目录不存在自动创建）：
 *   大型拓扑-<N>节点.csv     连线关系表（UTF-8 带 BOM，Excel 双击不乱码）——验证「导入生成拓扑」路径
 *   大型拓扑-<N>节点.xlsx    同内容的 Excel 版——验证 xlsx 导入路径
 *   大型拓扑-<N>节点.nettopo 工程文件（分层布局/区域框/多图纸/故障标记/规划态/文本标注）
 *                            ——验证「打开工程」后的完整显示
 *
 * 拓扑形态（企业园区典型分层，全部确定性生成，同 seed 可复现）：
 *   互联网 → 出口路由器×2 → 防火墙×2(HA) → 核心交换机×2(CSS 集群) → 汇聚交换机×N
 *   → 接入交换机×N（各带 无线AP / 办公终端 若干）；服务器区挂核心；DMZ 挂防火墙；
 *   另含 1 台「规划中」汇聚（琥珀虚线）与若干故障链路（红线）用于验证特殊显示态。
 *
 * 用法：
 *   node test/gen-bigtopo.js                    # 默认 500 节点
 *   node test/gen-bigtopo.js --nodes 1000       # 1000 节点压力档
 *   node test/gen-bigtopo.js --nodes 200 --seed 7 --out test/fixtures
 *
 * 生成后自动做三轮自检：CSV 走 model.textToGraph 回读（节点/连线数一致）；
 * 工程数据走 U.sanitizeGraph 清洗（字段不丢）；节点包围盒两两不重叠。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

/* ---- 以 run-tests 同款 vm 沙箱加载 util/model：与渲染层同口径的 uid/宽度/类型推断 ---- */
const sandbox = { console, Uint8Array, TextEncoder, TextDecoder, structuredClone, Map, Set, Promise, Math, requestAnimationFrame: (fn) => setTimeout(fn, 0), localStorage: { getItem: () => null, setItem: () => {} }, crypto: require('crypto').webcrypto };
vm.createContext(sandbox);
for (const f of ['js/util.js', 'js/model.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
const U = sandbox.TopoUtil, M = sandbox.TopoModel;

/* ---- CLI ---- */
function parseArgv(argv) {
  const out = { nodes: 500, seed: 20261024, outDir: path.join(root, 'test', 'fixtures') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--nodes') out.nodes = parseInt(argv[++i], 10);
    else if (argv[i] === '--seed') out.seed = parseInt(argv[++i], 10);
    else if (argv[i] === '--out') out.outDir = argv[++i];
  }
  if (!(out.nodes >= 30 && out.nodes <= 2000)) { console.error('--nodes 取值范围 30~2000（画布/布局对超大图有钳制）'); process.exit(1); }
  return out;
}
const CFG = parseArgv(process.argv.slice(2));

/* ---- 确定性随机（mulberry32）：同 seed 产出完全一致的拓扑 ---- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(CFG.seed);

/* ================= 拓扑构造 ================= */
let nSeq = 0, lSeq = 0;
const nid = () => 'n' + String(++nSeq).padStart(4, '0');
const lid = () => 'l' + String(++lSeq).padStart(4, '0');
const nodes = [], links = [], texts = [], regions = [];
const byName = new Map();
/** 网络设备的管理地址段按层分配：10.0.<层>.<序> */
let mgmtSeq = { er: 0, fw: 0, cs: 0, agg: 0, acc: 0 };
const mgmtOf = (tier, idx) => '10.0.' + { er: 1, fw: 2, cs: 3, agg: 4, acc: 5 }[tier] + '.' + (idx) + '/24';
/** 三层互联 /30 段：10.255.<hi>.<lo>，hi/lo 由游标递增 */
let p2pHi = 0, p2pLo = 1;
const p2pNext = () => {
  p2pLo += 2; if (p2pLo > 254) { p2pLo = 1; p2pHi++; }
  return '10.255.' + p2pHi + '.' + p2pLo;
};

function addNode(name, type, o) {
  o = o || {};
  if (byName.has(name)) return byName.get(name);
  const n = {
    id: nid(), name, type,
    x: 0, y: 0, w: U.nodeWidthForName(name), h: U.NODE_H,
    mgmt: o.mgmt || '', note: o.note || '',
    model: o.model || '', osver: o.osver || '', vendor: o.vendor || ''
  };
  if (o.vlans && o.vlans.length) n.vlans = o.vlans;
  if (o.plan) n.plan = true;
  nodes.push(n); byName.set(name, n);
  return n;
}
/** 每台设备的接口号游标（同设备接口不重复） */
const ifSeq = new Map();
const nextIf = (name, prefix) => {
  const k = prefix + '@' + name;
  const i = (ifSeq.get(k) || 0) + 1;
  ifSeq.set(k, i);
  return prefix + '0/0/' + i;
};
function addLink(aName, bName, o) {
  o = o || {};
  const a = byName.get(aName), b = byName.get(bName);
  const l = {
    id: lid(), a: a.id, b: b.id,
    aIf: o.aIf || nextIf(aName, o.aIfPfx || 'GE'), bIf: o.bIf || nextIf(bName, o.bIfPfx || 'GE'),
    aIp: o.aIp || '', bIp: o.bIp || '', bw: o.bw || '1000M',
    note: o.note || '', agg: o.agg || ''
  };
  if (o.vlan) { l.aVlan = String(o.vlan); l.bVlan = String(o.vlan); l.aVlanMode = 'access'; l.bVlanMode = 'access'; l.aL2 = true; l.bL2 = true; }
  if (o.plan) l.plan = true;
  links.push(l);
  return l;
}

/* ---- 1) 骨干层：互联网 → 出口 → 防火墙 → 核心 ---- */
addNode('互联网', 'cloud', { note: '双运营商出口' });
const erNames = [], fwNames = [], csNames = [];
['电信出口', '联通出口'].forEach((isp, i) => {
  const nm = '出口路由器-ER-0' + (i + 1);
  erNames.push(nm);
  addNode(nm, 'router', { mgmt: mgmtOf('er', ++mgmtSeq.er), model: 'NE40E-M2K', osver: 'V800R021C00', vendor: 'huawei', note: isp + ' 上联' });
  addLink('互联网', nm, { aIf: '', bIf: nextIf(nm, 'GE'), bw: '10G', note: isp + ' 出口链路' });
});
for (let i = 1; i <= 2; i++) {
  const nm = '防火墙-FW-0' + i;
  fwNames.push(nm);
  addNode(nm, 'firewall', { mgmt: mgmtOf('fw', ++mgmtSeq.fw), model: 'USG6320', osver: 'V500R005C20', vendor: 'huawei', note: i === 1 ? '主墙（HA Active）' : '备墙（HA Standby）' });
}
addLink(fwNames[0], fwNames[1], { bw: '10G', note: 'HA 心跳' }); // 接口自动编完两侧
for (let i = 1; i <= 2; i++) {
  const nm = '核心交换机-CS-0' + i;
  csNames.push(nm);
  addNode(nm, 'switch', { mgmt: mgmtOf('cs', ++mgmtSeq.cs), model: 'CE12804', osver: 'V200R022C00', vendor: 'huawei', note: '双核心 CSS 集群成员' });
  erNames.forEach((er) => addLink(er, nm, { aIfPfx: 'XGE', bIfPfx: 'XGE', aIp: p2pNext(), bIp: p2pNext().replace(/\.\d+$/, '.' + (p2pLo + 1)), bw: '10G', note: '出口互联' }));
  fwNames.forEach((fw) => addLink(fw, nm, { aIfPfx: 'XGE', bIfPfx: 'XGE', aIp: p2pNext(), bIp: p2pNext().replace(/\.\d+$/, '.' + (p2pLo + 1)), bw: '10G', note: '防火墙透明串接' }));
}
addLink(csNames[0], csNames[1], { aIfPfx: 'XGE', bIfPfx: 'XGE', bw: '2×40G', agg: 'Eth-Trunk1', note: 'CSS 集群互联' });

/* ---- 2) 汇聚/接入骨架（按目标节点数缩放），叶子（AP/终端）数量随后精确补齐 ---- */
const AGG_MIN = 2, ACC_PER_AGG = 6;
const fixedCount = nodes.length;                       // 骨干 + 云
const SRV_COUNT = Math.max(8, Math.round(CFG.nodes * 0.08));
const planAggCount = 1;                                // 规划态汇聚（不计入目标数）
const remaining = CFG.nodes - fixedCount - SRV_COUNT;  // 汇聚+接入+叶子 需要的名额
// 每汇聚单元 ≈ 1 汇聚 + 6 接入 + 约 6×3 个叶子（先按 3 估，余量用终端补齐）
const aggCount = Math.max(AGG_MIN, Math.round(remaining / (1 + ACC_PER_AGG * (1 + 3))));
const aggs = [];
const ZONE = 'ABCDEFGHIJKL';
for (let i = 1; i <= aggCount; i++) {
  const zone = ZONE[(i - 1) % ZONE.length] + (i > ZONE.length ? String(Math.ceil(i / ZONE.length)) : '');
  const nm = '汇聚交换机-AGG-' + String(i).padStart(2, '0');
  aggs.push({ name: nm, zone, accs: [] });
  addNode(nm, 'switch', { mgmt: mgmtOf('agg', ++mgmtSeq.agg), model: 'S6730-H24X6C', osver: 'V600R024C00', vendor: 'huawei', vlans: [{ id: String(100 + i * 10), ip: '192.168.' + (i * 16) + '.1', mask: 24 }] });
  csNames.forEach((cs) => addLink(nm, cs, { aIfPfx: 'XGE', bIfPfx: 'XGE', aIp: p2pNext(), bIp: p2pNext().replace(/\.\d+$/, '.' + (p2pLo + 1)), bw: '10G', note: zone + ' 区上联' }));
  for (let j = 1; j <= ACC_PER_AGG; j++) {
    const accNm = '接入交换机-ACC-' + zone + '-' + String(j).padStart(2, '0');
    aggs[i - 1].accs.push({ name: accNm, zone, leaves: [] });
    addNode(accNm, 'switch', { mgmt: mgmtOf('acc', ++mgmtSeq.acc), model: 'S5720-28X-SI', osver: 'V200R019C00', vendor: 'huawei' });
    // 双上联同一汇聚（主备），第二条走不同接口对
    addLink(accNm, nm, { aIfPfx: 'XGE', bIfPfx: 'XGE', bw: '10G', note: '上联主' });
    addLink(accNm, nm, { aIfPfx: 'XGE', bIfPfx: 'XGE', bw: '10G', note: '上联备' });
  }
}
/* 服务器区（挂核心）与 DMZ（挂防火墙）——先建节点占位，链接在布局前补 */
const srvNames = [], dmzNames = [];
const SRV_KINDS = [['核心数据库-SRV-DB', 'DB 主'], ['应用服务器-SRV-APP', 'APP'], ['虚拟化宿主-SRV-ESX', '计算'], ['WEB服务器-SRV-WEB', 'Web']];
for (let i = 0; i < SRV_COUNT; i++) {
  const [pfx, tag] = SRV_KINDS[i % SRV_KINDS.length];
  const nm = pfx + String(Math.floor(i / SRV_KINDS.length) + 1).padStart(2, '0');
  srvNames.push(nm);
  addNode(nm, 'server', { mgmt: '172.16.' + (10 + Math.floor(i / 40)) + '.' + (i % 40 + 2) + '/24', model: 'RH5885 V3', osver: 'EuLinux 22.03', note: tag + ' 资源池' });
}
const DMZ_COUNT = Math.max(3, Math.round(SRV_COUNT * 0.15));
for (let i = 1; i <= DMZ_COUNT; i++) {
  const nm = 'DMZ服务器-DMZ-WEB-' + String(i).padStart(2, '0');
  dmzNames.push(nm);
  addNode(nm, 'server', { mgmt: '172.17.10.' + (i + 1) + '/24', model: '2288H V5', note: '互联网发布区' });
}
/* 叶子：每接入先按 50% 概率挂 1 台无线 AP，再用办公终端补齐到目标节点数 */
const accAll = aggs.flatMap((g) => g.accs);
let pcSeq = 0;
function addLeaf(acc, kind) {
  const leaf = kind === 'ap'
    ? '无线AP-AP-' + acc.zone + '-' + String(ifSeq.get('ap@' + acc.zone) ? ifSeq.get('ap@' + acc.zone) + 1 : 1).padStart(2, '0')
    : '办公终端-PC-' + acc.zone + '-' + String(++pcSeq).padStart(3, '0');
  acc.leaves.push(leaf);
  const vlan = 100 + (aggs.findIndex((g) => g.accs.includes(acc)) + 1) * 10;
  addNode(leaf, kind === 'ap' ? 'other' : 'pc', { note: kind === 'ap' ? 'Wi-Fi 6 放装' : '', mgmt: kind === 'ap' ? '' : '192.168.' + vlan + '.' + (acc.leaves.length % 200 + 10) + '/24' });
  addLink(acc.name, leaf, { vlan, bw: '1000M' });
}
for (const acc of accAll) if (rnd() < 0.5) addLeaf(acc, 'ap');
while (nodes.length < CFG.nodes - 1) {   // 预留 1 个名额给规划态汇聚，最终恰好 N 台
  // 轮询补终端：优先当前叶子最少的接入，视觉均衡
  accAll.sort((a, b) => a.leaves.length - b.leaves.length);
  addLeaf(accAll[0], 'pc');
}
if (nodes.length !== CFG.nodes - 1) { console.error('节点数未对齐：' + nodes.length + ' ≠ ' + (CFG.nodes - 1) + '（预留规划态 1 台）'); process.exit(1); }
/* 服务器/DMZ 链路（目标数已满，服务器在骨架阶段已占位） */
srvNames.forEach((s, i) => addLink(s, csNames[i % 2], { vlan: 200, bw: '10G', note: i % 2 ? 'Bond-A' : 'Bond-B' }));
dmzNames.forEach((s) => addLink(s, fwNames[0], { vlan: 300, bw: '1000M', note: 'DMZ 发布' }));

/* ---- 3) 规划态（未实施）：1 台汇聚 + 2 条上联，验证琥珀虚线显示 ---- */
const planAgg = '汇聚交换机-AGG-' + String(aggCount + 1).padStart(2, '0') + '（规划）';
addNode(planAgg, 'switch', { mgmt: mgmtOf('agg', ++mgmtSeq.agg), model: 'S6730-H24X6C', vendor: 'huawei', note: '下季度扩容' , plan: true });
csNames.forEach((cs) => addLink(planAgg, cs, { aIfPfx: 'XGE', bIfPfx: 'XGE', bw: '10G', plan: true, note: '规划中' }));

/* ---- 4) 布局：分层列 + 每汇聚一个纵向块（接入与其叶子对齐成子块） ---- */
const X = { cloud: 0, er: 620, fw: 1240, cs: 1900, agg: 2760, acc: 3480, leaf: 4260 };
const leafSpan = 110, accSpan = 150;
// 每接入子块高 = max(接入行距, 叶子数×叶子行距)
const accBlocks = accAll.map((acc) => ({ acc, h: Math.max(accSpan, acc.leaves.length * leafSpan) }));
const aggBand = aggs.map((g, i) => {
  const blocks = accBlocks.filter((b) => g.accs.includes(b.acc));
  const h = Math.max(blocks.reduce((s, b) => s + b.h, 0) + (blocks.length - 1) * 40, 560);
  return { g, blocks, h };
});
const bandH = aggBand.reduce((s, x) => s + x.h + 80, 0);
let y = -bandH / 2;
for (const { g, blocks, h } of aggBand) {
  const cyAgg = y + h / 2;
  const aggNode = byName.get(g.name);
  aggNode.x = X.agg; aggNode.y = cyAgg;
  let by = y;
  for (const b of blocks) {
    b.accNodeX = X.acc;
    b.cy = by + b.h / 2;
    const accNode = byName.get(b.acc.name);
    accNode.x = X.acc; accNode.y = b.cy;
    // 叶子在该接入子块内纵向展开
    const lh = b.acc.leaves.length * leafSpan;
    b.acc.leaves.forEach((leafNm, k) => {
      const ln = byName.get(leafNm);
      ln.x = X.leaf; ln.y = b.cy - lh / 2 + leafSpan / 2 + k * leafSpan;
    });
    by += b.h + 40;
  }
  y += h + 80;
}
/* 服务器区：核心列下方独立网格（4 列）；DMZ 再往下独立一段，两区不重叠 */
const srvCols = 4, srvGapX = 300, srvGapY = 120;
const srvTop = bandH / 2 + 520;
srvNames.forEach((s, i) => {
  const n = byName.get(s);
  const cols = Math.min(srvCols, srvNames.length);
  n.x = (X.cs + X.fw) / 2 + ((i % cols) - (cols - 1) / 2) * srvGapX;
  n.y = srvTop + Math.floor(i / cols) * srvGapY;
});
const dmzTop = srvTop + Math.ceil(srvNames.length / srvCols) * srvGapY + 260;
dmzNames.forEach((s, i) => {
  const n = byName.get(s);
  n.x = X.fw + (i % 2) * 320;
  n.y = dmzTop + Math.floor(i / 2) * srvGapY;
});
byName.get('互联网').x = X.cloud; byName.get('互联网').y = 0;
erNames.forEach((nm, i) => { const n = byName.get(nm); n.x = X.er; n.y = (i - 0.5) * 220; });
fwNames.forEach((nm, i) => { const n = byName.get(nm); n.x = X.fw; n.y = (i - 0.5) * 220; });
csNames.forEach((nm, i) => { const n = byName.get(nm); n.x = X.cs; n.y = (i - 0.5) * 260; });
{ // 规划汇聚放汇聚列底部
  const n = byName.get(planAgg);
  n.x = X.agg; n.y = bandH / 2 + 360;
}

/* ---- 5) 区域框（按成员包围盒 + 边距）与文本标注 ---- */
function regionOf(name, memberNames, color) {
  const ms = memberNames.map((nm) => byName.get(nm)).filter(Boolean);
  if (!ms.length) return null;
  const x1 = Math.min(...ms.map((n) => n.x - n.w / 2)) - 48, x2 = Math.max(...ms.map((n) => n.x + n.w / 2)) + 48;
  const y1 = Math.min(...ms.map((n) => n.y - n.h / 2)) - 44, y2 = Math.max(...ms.map((n) => n.y + n.h / 2)) + 44;
  const r = { id: 'r' + (regions.length + 1), name, x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  if (color) r.color = color;
  regions.push(r);
  return r;
}
regionOf('出口区', ['互联网', ...erNames, ...fwNames]);
regionOf('核心区', csNames);
aggs.forEach((g) => regionOf('接入区-' + g.zone, g.accs.map((a) => a.name)));
aggs.forEach((g) => { /* 汇聚单独细框会与接入区重叠太碎，只画一个总框 */ });
regionOf('汇聚区', [...aggs.map((g) => g.name), planAgg]);
regionOf('服务器区', srvNames);
regionOf('DMZ', dmzNames);
let tSeq = 0;
const addText = (x, y, txt) => texts.push({ id: 't' + (++tSeq), x, y, w: 220, h: 40, text: txt });
addText(X.cs, -bandH / 2 - 260, '双核心 CSS 集群');
addText(X.agg, bandH / 2 + 200, '★ 规划扩容区（未实施）');
addText(X.er, -bandH / 2 - 260, '双运营商出口');

/* ---- 6) 故障标记（验证红线/图例计数）：1 条接入上联、1 条服务器链路（确定性选取） ---- */
const downIds = [];
{
  const target = byName.get(aggs[2].accs[0].name);
  const up = links.filter((l) => /^上联/.test(l.note || '') && (l.a === target.id || l.b === target.id));
  if (up[1]) downIds.push(up[1].id);   // 「上联备」中断：主链路仍在，显示上呈现局部故障
  const srvLink = links.find((l) => l.note === 'Bond-A');
  if (srvLink) downIds.push(srvLink.id);
}

/* ---- 7) 多图纸：全网总览 / 出口·核心·服务器 / 接入区明细 ---- */
function sheetOf(name, memberNames, linkFilter, regionNames, txts) {
  const idSet = new Set(memberNames.map((nm) => byName.get(nm).id));
  const sn = memberNames.map((nm) => byName.get(nm));
  const sl = links.filter((l) => idSet.has(l.a) && idSet.has(l.b) && (!linkFilter || linkFilter(l)));
  return {
    id: 'p' + (sheets.length + 1), name,
    nodes: sn, links: sl, texts: txts || [],
    regions: regions.filter((r) => regionNames.includes(r.name)),
    underlay: null, pan: null, zoom: null
  };
}
const sheets = [];
sheets.push({ id: 'p1', name: '全网总览', nodes, links, texts, regions, underlay: null, pan: null, zoom: null });
{
  const coreMembers = ['互联网', ...erNames, ...fwNames, ...csNames, ...srvNames, ...dmzNames];
  const coreSheet = sheetOf('出口·核心·服务器区', coreMembers, null, ['出口区', '核心区', '服务器区', 'DMZ'],
    [texts[0], texts[2]]);
  coreSheet.id = 'p2';
  sheets.push(coreSheet);
}
{
  const g = aggs[0];
  const detail = sheetOf('接入区-' + g.zone + ' 明细', [g.name, ...g.accs.map((a) => a.name), ...g.accs.flatMap((a) => a.leaves)],
    null, ['接入区-' + g.zone], []);
  detail.id = 'p3';
  sheets.push(detail);
}

/* ================= 输出文件 ================= */
const OUT = CFG.outDir;
fs.mkdirSync(OUT, { recursive: true });
const baseName = '大型拓扑-' + CFG.nodes + '节点';

/* CSV：全部连线 + 各端管理地址/备注/VLAN 接口（导入后即还原大部分属性） */
const vlanIfOf = (n) => (n.vlans && n.vlans.length) ? n.vlans.map((v) => v.id + ':' + v.ip + '/' + (v.mask || 24)).join(';') : '';
const rows = [['源设备', '源接口', '源IP', '目标设备', '目标接口', '目标IP', '带宽', '源管理地址', '目标管理地址', '源设备备注', '目标设备备注', '聚合组', '源VLAN接口', '目标VLAN接口', '备注']];
for (const l of links) {
  const a = nodes.find((n) => n.id === l.a), b = nodes.find((n) => n.id === l.b);
  rows.push([a.name, l.aIf, l.aIp, b.name, l.bIf, l.bIp, l.bw, a.mgmt.split('/')[0], b.mgmt.split('/')[0], a.note, b.note, l.agg, vlanIfOf(a), vlanIfOf(b), l.note]);
}
const csvEsc = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csvText = '\ufeff' + rows.map((r) => r.map(csvEsc).join(',')).join('\r\n');
fs.writeFileSync(path.join(OUT, baseName + '.csv'), csvText, 'utf8');

/* XLSX：同一份表内容（lib 内置离线库，与界面导出同源） */
try {
  const XLSX = require(path.join(root, 'lib', 'xlsx.full.min.js'));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '连线关系');
  // 浏览器版打包的 xlsx.full.min 在 Node 下 writeFile 探测 fs 不可靠：统一走 buffer + 自写文件
  fs.writeFileSync(path.join(OUT, baseName + '.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
} catch (e) { console.error('xlsx 生成失败（不影响其余产物）：' + e.message); }

/* .nettopo 工程文件（与 buildProjectData 同构的 v3 格式） */
const project = {
  app: 'NetTopo', version: 3, savedAt: new Date().toISOString(),
  nodes, links, texts, regions, underlay: null,
  pan: null, zoom: null,                       // 空 → 打开后自动 fit
  sheets, sheetIdx: 0,
  orthoLinks: false, customTypes: [], typeOverrides: {},
  showLabels: true, showSubnets: false, subnetNames: {},
  downLinks: downIds
};
fs.writeFileSync(path.join(OUT, baseName + '.nettopo'), JSON.stringify(project), 'utf8');

/* ================= 自检 ================= */
console.log('== 生成完成 ==');
const typeCount = {};
for (const n of nodes) typeCount[n.type] = (typeCount[n.type] || 0) + 1;
console.log('节点 ' + nodes.length + '（' + Object.keys(typeCount).map((k) => k + '×' + typeCount[k]).join(' · ') + '）　连线 ' + links.length + '　区域框 ' + regions.length + '　图纸 ' + sheets.length + ' 页　故障链路 ' + downIds.length + ' 条');

/* 1) CSV 回读：与生成侧计数一致 */
{
  const g = M.textToGraph(csvText.replace(/^\ufeff/, ''));
  const csvOk = g.nodes.length === nodes.length && g.links.length === links.length;
  console.log('CSV 回读: ' + (csvOk ? 'OK' : 'FAIL') + '（nodes ' + g.nodes.length + '/' + nodes.length + ' · links ' + g.links.length + '/' + links.length + '）');
  if (!csvOk) process.exit(1);
  const wrongType = g.nodes.filter((n) => n.type === 'other' && !/AP|互联网/.test(n.name));
  console.log('CSV 类型推断: ' + (wrongType.length ? '注意：' + wrongType.length + ' 台落入 other（' + wrongType.slice(0, 3).map((n) => n.name).join('、') + '…）' : 'OK（除 AP/云 外全部精确）'));
}
/* 2) 工程清洗：节点/连线不丢、区域框保留 */
{
  const c = U.sanitizeGraph(project.nodes, project.links, project.texts);
  const rg = U.sanitizeRegions(project.regions);
  const ok = c.nodes.length === nodes.length && c.links.length === links.length && rg.length === regions.length;
  console.log('工程清洗: ' + (ok ? 'OK' : 'FAIL') + '（nodes ' + c.nodes.length + ' · links ' + c.links.length + ' · regions ' + rg.length + '）');
  if (!ok) process.exit(1);
}
/* 3) 布局不重叠：节点包围盒两两不相交（2px 容差；n≤2000 时 O(n²) 可接受） */
{
  let bad = 0;
  for (let i = 0; i < nodes.length && bad < 5; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 2) {
        bad++;
        if (bad <= 3) console.log('  重叠: ' + a.name + ' ⇄ ' + b.name);
      }
    }
  }
  console.log('布局重叠: ' + (bad ? bad + ' 处（FAIL）' : 'OK'));
  if (bad) process.exit(1);
}
for (const f of [baseName + '.csv', baseName + '.xlsx', baseName + '.nettopo']) {
  try { console.log('  ' + f + '　' + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1) + ' KB'); } catch (e) { /* xlsx 失败已另行提示 */ }
}
console.log('用途：CSV/XLSX 走「导入连线表格」验证自动布局；.nettopo 走「打开工程」验证区域框/多图纸/故障与规划态显示。');
