/* NetTopo 纯逻辑测试（Node 环境） */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const sandbox = { console, Uint8Array, TextEncoder, TextDecoder, structuredClone, Map, Set, Promise, Math, requestAnimationFrame: (fn) => setTimeout(fn, 0), localStorage: { getItem: () => null, setItem: () => {} } };
vm.createContext(sandbox);

for (const f of ['js/util.js', 'js/model.js', 'js/layout.js', 'js/visio.js']) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  vm.runInContext(code, sandbox, { filename: f });
}
const U = sandbox.TopoUtil, M = sandbox.TopoModel, Layout = sandbox.TopoLayout, V = sandbox.TopoVisio;

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
};
const eq = (a, b, name) => ok(a === b, `${name}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

console.log('== util ==');
eq(U.escXml('a<b&c"d'), 'a&lt;b&amp;c&quot;d', 'XML 转义');
eq(U.escXml('多\n行'), '多&#10;行', 'XML 换行转义');
eq(U.truncate('12345678901234567890', 10), '123456789…', '截断');
eq(U.anchorPoint(0, 0, 50, 30, 100, 0).x, 50, '锚点：水平交点');
eq(U.anchorPoint(0, 0, 50, 30, 0, 100).y, 30, '锚点：垂直交点');
ok(U.pointSegDist(3, 5, 0, 0, 0, 10) === 3, '点到线段距离');
eq(U.typeOf('核心路由器R1'), 'router', '类型推断-路由');
eq(U.typeOf('核心交换机SW1'), 'switch', '类型推断-交换');
eq(U.typeOf('防火墙FW1'), 'firewall', '类型推断-防火墙');
eq(U.typeOf('文件服务器FS1'), 'server', '类型推断-服务器');
eq(U.typeOf('办公PC1'), 'pc', '类型推断-终端');
eq(U.typeOf('互联网出口Cloud'), 'cloud', '类型推断-云');

console.log('== CSV 解析 ==');
const csv = 'a,b,c\n"1,2",3,"he said ""hi"""\n4,5,6';
const rows = U.parseCSV(csv);
eq(rows.length, 3, 'CSV 行数');
eq(rows[1][0], '1,2', 'CSV 引号内逗号');
eq(rows[1][2], 'he said "hi"', 'CSV 双引号转义');
ok(U.parseCSV('x\tb\n1\t2')[0][1] === 'b', '制表符分隔检测');
const rt = U.buildCSV([['a', 'b,c'], ['d', 'e"f']]);
ok(rt.includes('"b,c"') && rt.includes('"e""f"'), 'CSV 构建转义');
ok(rt.charCodeAt(0) === 0xFEFF, 'CSV 带 BOM');

console.log('== 表头映射 ==');
eq(M.mapHeader('源设备'), 'sa', '中文-源设备');
eq(M.mapHeader('目标设备'), 'sb', '中文-目标设备');
eq(M.mapHeader('源接口'), 'si', '中文-源接口');
eq(M.mapHeader('目标接口'), 'sii', '中文-目标接口');
eq(M.mapHeader('源IP'), 'sip', '中文-源IP');
eq(M.mapHeader('目标IP'), 'sib', '中文-目标IP');
eq(M.mapHeader('IP地址B'), 'sib', '中文-IP地址B');
eq(M.mapHeader('带宽'), 'bw', '中文-带宽');
eq(M.mapHeader('备注'), 'note', '中文-备注');
eq(M.mapHeader('设备A'), 'sa', '中文-设备A');
eq(M.mapHeader('设备2'), 'sb', '中文-设备2');
eq(M.mapHeader('Source Device'), 'sa', '英文-Source Device');
eq(M.mapHeader('source_ip'), 'sip', '英文-source_ip');
eq(M.mapHeader('B端设备'), 'sb', '中文-B端设备');
eq(M.mapHeader('对端'), 'sb', '中文-对端');
eq(M.mapHeader('IP_A'), 'sip', '英文-IP_A');

console.log('== 表格→图 ==');
const g1 = M.textToGraph(M.SAMPLE_CSV);
eq(g1.nodes.length, 9, '示例节点数 9');
eq(g1.links.length, 10, '示例连线数 10');
eq(g1.nodes.find(n => n.name === '核心路由器R1').type, 'router', 'R1 类型');
eq(g1.nodes.find(n => n.name === '防火墙FW1').type, 'firewall', 'FW1 类型');
const sw2 = g1.nodes.find(n => n.name === '接入交换机SW2');
eq(g1.links.filter(l => l.a === sw2.id || l.b === sw2.id).length, 6, 'SW2 连线数 6');
ok(g1.links.every(l => l.aIf && l.bIf), '示例链路均带接口');
ok(g1.links.every(l => l.aIp && l.bIp), '示例链路均带 IP');
eq(g1.nodes.find(n => n.name === '核心路由器R1').mgmt, '10.255.0.1', '示例 R1 管理地址');
eq(g1.nodes.find(n => n.name === '核心交换机SW1').mgmt, '10.255.0.2', '示例 SW1 管理地址');
ok(!g1.nodes.find(n => n.name === '办公PC1').mgmt, '示例 PC1 无管理地址');
eq(U.nodeHeightFor(g1.nodes.find(n => n.name === '核心路由器R1')), 72, '有管理地址节点加高');
eq(U.nodeHeightFor(g1.nodes.find(n => n.name === '办公PC1')), 56, '无管理地址节点默认高');

console.log('== 图→表格 回环 ==');
const table = M.graphToTableRows(g1.nodes, g1.links);
eq(table.length, 11, '导出行数（含表头）');
eq(table[0][0], '源设备', '导出表头');
ok(table[0].includes('管理地址'), '导出表头含管理地址列');
ok(table[1][7] === '10.255.0.1', '导出行含管理地址值');
const g2 = M.textToGraph(U.buildCSV(table));
eq(g2.nodes.length, g1.nodes.length, '回环节点数一致');
eq(g2.links.length, g1.links.length, '回环连线数一致');
const l1 = g1.links[0], l2 = g2.links[0];
const nameOf = (g, id) => g.nodes.find(n => n.id === id).name;
ok(nameOf(g1, l1.a) === nameOf(g2, l2.a) && nameOf(g1, l1.b) === nameOf(g2, l2.b)
  && l1.aIf === l2.aIf && l1.aIp === l2.aIp && l1.bIf === l2.bIf && l1.bIp === l2.bIp
  && l1.bw === l2.bw && l1.note === l2.note, '回环字段一致（含带宽/备注）');

console.log('== 管理地址回环（导出→再导入不丢失/不错挂） ==');
{
  const mb = (g, name) => g.nodes.find(n => n.name === name).mgmt;
  // 场景1：目标端 C 获得管理地址，且 C 只作为目标出现
  const csvA = [
    '源设备,源接口,源IP,目标设备,目标接口,目标IP,管理地址,备注',
    'A,eth0,10.0.0.1,B,eth1,10.0.0.2,10.255.0.1,',
    'A,eth2,10.0.1.1,C,eth3,10.0.1.2,10.255.0.2,'
  ].join('\r\n');
  const ga = M.textToGraph(csvA);
  eq(mb(ga, 'C'), '10.255.0.2', '目标端 C 获得管理地址');
  const ga2 = M.textToGraph(U.buildCSV(M.graphToTableRows(ga.nodes, ga.links)));
  eq(mb(ga2, 'A'), '10.255.0.1', '回环后 A 管理地址');
  eq(mb(ga2, 'C'), '10.255.0.2', '回环后目标端 C 管理地址不丢失');
  // 场景2：源端 A 在第二条链路无管理地址，C 不应被“传染”
  const csvB = [
    '源设备,源接口,源IP,目标设备,目标接口,目标IP,管理地址,备注',
    'A,eth0,10.0.0.1,B,eth1,10.0.0.2,10.255.0.1,',
    'A,eth2,10.0.1.1,C,eth3,10.0.1.2,,'
  ].join('\r\n');
  const gb = M.textToGraph(csvB);
  const gb2 = M.textToGraph(U.buildCSV(M.graphToTableRows(gb.nodes, gb.links)));
  ok(!mb(gb2, 'C'), '回环后 C 不被源端管理地址传染');
}

console.log('== ID 计数器恢复（刷新后新增不冲突） ==');
{
  const g = M.textToGraph('A,B\nC,D\nE,F');
  U.seedCounters(g.nodes, g.links);
  const nid = U.uid('n');
  ok(!g.nodes.some(n => n.id === nid), 'seedCounters 后新设备 ID 不与恢复节点冲突');
  const lid = U.uid('l');
  ok(!g.links.some(l => l.id === lid), 'seedCounters 后新连线 ID 不冲突');
}

console.log('== 无表头按位置推断 ==');
const g3 = M.textToGraph('R1,SW1,GE0/0/1,10.0.0.1,GE1/0/1,10.0.0.2\nR2,SW2,GE0/0/1,10.0.1.1,GE1/0/1,10.0.1.2');
eq(g3.nodes.length, 4, '无表头节点数');
eq(g3.links.length, 2, '无表头连线数');
eq(g3.links[0].aIf, 'GE0/0/1', '无表头接口列识别');

console.log('== GBK 编码 CSV（国内 Excel 导出场景） ==');
{
  const srcTxt = path.join(root, 'test', '_gbk_src.txt');
  const tmpGbk = path.join(root, 'test', '_gbk.csv');
  fs.writeFileSync(srcTxt, M.SAMPLE_CSV.replace(/\r\n/g, '\n'), 'utf8');
  execSync('python -c "open(r\'' + tmpGbk + '\',\'wb\').write(open(r\'' + srcTxt + '\',encoding=\'utf-8\').read().encode(\'gbk\'))"');
  const buf = fs.readFileSync(tmpGbk);
  const text = U.decodeBytes(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const gg = M.textToGraph(text);
  eq(gg.nodes.length, 9, 'GBK CSV 解析节点数');
  eq(gg.nodes.find(n => n.name === '核心路由器R1').type, 'router', 'GBK 中文设备名');
  fs.unlinkSync(tmpGbk); fs.unlinkSync(srcTxt);
}

console.log('== XLSX 导入（SheetJS 真实解析） ==');
{
  vm.runInContext(fs.readFileSync(path.join(root, 'lib', 'xlsx.full.min.js'), 'utf8'), sandbox, { filename: 'xlsx.full.min.js' });
  const X = sandbox.XLSX;
  const aoa = M.graphToTableRows(g1.nodes, g1.links);
  const ws = X.utils.aoa_to_sheet(aoa);
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, '连线');
  const arr = X.write(wb, { type: 'array', bookType: 'xlsx' });
  const ab = new Uint8Array(arr).buffer; // SheetJS array → ArrayBuffer
  const gx = M.xlsxToGraph(ab);
  eq(gx.nodes.length, 9, 'XLSX 导入节点数');
  eq(gx.links.length, 10, 'XLSX 导入连线数');
  ok(gx.links[0].aIf === g1.links[0].aIf && gx.links[0].bIp === g1.links[0].bIp, 'XLSX 字段一致');
}

console.log('== 自定义类型 / 名称宽度 ==');
{
  const before = U.customTypes.length;
  U.addCustomType('核心存储', '');
  const t = U.customTypes[U.customTypes.length - 1];
  ok(t.key === 'ct' + (before + 1), '自定义类型 key');
  ok(U.getType(t.key).label === '核心存储', 'getType 返回自定义类型');
  ok(U.getType('router').label === '路由器', 'getType 返回内置类型');
  ok(U.typeList().length === U.TYPE_ORDER.length + 1, 'typeList 含自定义类型');
  const before2 = U.customTypes.length;
  U.removeCustomType(t.key);
  ok(U.customTypes.length === before2 - 1, '删除自定义类型');
  ok(U.getType('不存在的类型').key === 'other', '未知类型回退 other');
}
eq(U.nodeWidthForName('SW1'), 160, '短名称保持最小宽度');
eq(U.nodeWidthForName('核心交换机SW1'), 172, '中等名称按实际宽度（172）');
const longW = U.nodeWidthForName('这是一个非常非常长的设备名称用于测试宽度自适应显示效果');
ok(longW > 200 && longW <= 320, '长名称宽度自适应（' + longW + '）');
ok(U.measureText('中文A', 13.5) > U.measureText('AA', 13.5), 'CJK 测量宽于 ASCII');

console.log('== 类型覆盖（颜色/图片） ==');
{
  // 内置类型：改颜色 + 传图片
  U.setTypeColor('router', '#ff0000');
  const rt = U.getType('router');
  ok(rt.c1 === '#ff0000', '内置类型改颜色生效');
  ok(rt.label === '路由器', '内置类型标签不变');
  ok(rt.stroke && rt.stroke !== '#ff0000', '描边自动加深');
  U.setTypeImage('router', 'data:image/png;base64,AAA');
  ok(U.getType('router').img === 'data:image/png;base64,AAA', '内置类型传图片生效');
  U.setTypeImage('router', '');
  ok(!U.getType('router').img, '清除内置类型图片');
  delete U.typeOverrides['router'];
  ok(U.getType('router').c1 === '#4338ca', '清除覆盖后回退默认颜色');
  // 自定义类型：改颜色
  U.addCustomType('测试类型B', '');
  const key = U.customTypes[U.customTypes.length - 1].key;
  U.setTypeColor(key, '#00ff00');
  ok(U.getType(key).c1 === '#00ff00', '自定义类型改颜色生效');
  U.removeCustomType(key);
  ok(U.getType('不存在的类型').key === 'other', '未知类型回退 other');
}

console.log('== 布局 ==');
const posBefore = g1.nodes.map(n => [n.x, n.y]);
Layout.layoutNow(g1.nodes, g1.links, 200);
const posAfter = g1.nodes.map(n => [n.x, n.y]);
ok(posAfter.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), '布局坐标有限');
const maxMove = Math.max(...g1.nodes.map((n, i) => Math.hypot(n.x - posBefore[i][0], n.y - posBefore[i][1])));
ok(maxMove > 10, '布局产生移动（' + maxMove.toFixed(1) + 'px）');
let minPair = Infinity;
for (let i = 0; i < g1.nodes.length; i++)
  for (let j = i + 1; j < g1.nodes.length; j++)
    minPair = Math.min(minPair, Math.hypot(g1.nodes[i].x - g1.nodes[j].x, g1.nodes[i].y - g1.nodes[j].y));
ok(minPair > 100, '布局后节点无重叠（最近 ' + minPair.toFixed(0) + 'px）');
// 矩形零遮挡：任意两节点矩形不相交
let overlap = 0;
for (let i = 0; i < g1.nodes.length; i++)
  for (let j = i + 1; j < g1.nodes.length; j++) {
    const a = g1.nodes[i], b = g1.nodes[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlap++;
  }
ok(overlap === 0, '布局后矩形零遮挡（碰撞对=' + overlap + '）');
// 大图（50 节点随机链）同样零重叠
const big = { nodes: [], links: [] };
for (let i = 0; i < 50; i++) {
  big.nodes.push({ id: 'n' + i, name: '设备' + i + '号', type: 'switch', x: 0, y: 0, w: 160 + (i % 3) * 30, h: 56 });
  if (i > 0) big.links.push({ id: 'l' + i, a: 'n' + (i - 1), b: 'n' + i, aIf: '', aIp: '', bIf: '', bIp: '', bw: '', note: '' });
}
Layout.layoutNow(big.nodes, big.links, 400);
let bigOverlap = 0;
for (let i = 0; i < 50; i++)
  for (let j = i + 1; j < 50; j++) {
    const a = big.nodes[i], b = big.nodes[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bigOverlap++;
  }
ok(bigOverlap === 0, '50 节点布局零遮挡（碰撞对=' + bigOverlap + '）');

console.log('== linkGeom（平行链路偏移） ==');
const nodes2 = [
  { id: 'n1', name: 'A', type: 'router', x: 0, y: 0, w: 160, h: 56 },
  { id: 'n2', name: 'B', type: 'switch', x: 400, y: 0, w: 160, h: 56 }
];
const links2 = [
  { id: 'l1', a: 'n1', b: 'n2', aIf: 'G0', aIp: '1.1.1.1', bIf: 'G1', bIp: '1.1.1.2', bw: '', note: '' },
  { id: 'l2', a: 'n1', b: 'n2', aIf: 'G2', aIp: '1.1.1.3', bIf: 'G3', bIp: '1.1.1.4', bw: '', note: '' }
];
const geom = U.linkGeom(nodes2, links2);
ok(Math.abs(geom.l1.y1 - geom.l2.y1) >= 14, '平行链路垂直偏移');
ok(geom.l1.labelA.text.includes('G0') && geom.l1.labelA.text.includes('1.1.1.1'), '标签含接口与 IP');
ok(geom.l1.labelA.anchor === 'start' && geom.l1.labelB.anchor === 'end', '标签锚点方向');
const lx = geom.l1.x1, rx = geom.l1.x2;
ok(lx > 158 && lx < 162, 'A 端锚点在边框上（x=' + lx + '）');

console.log('== Visio VSDX 导出（2012 格式） ==');
{
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'vsdx.js'), 'utf8'), sandbox, { filename: 'vsdx.js' });
  const V2 = sandbox.TopoVsdx;
  const buf = V2.buildVSDX({ nodes: nodes2, links: links2 }, {});
  ok(buf instanceof Uint8Array && buf.length > 3000, 'VSDX 返回二进制包（' + buf.length + ' bytes）');
  ok(buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04, 'VSDX 为 ZIP 格式（PK 签名）');
  const s = Buffer.from(buf).toString('latin1');
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml',
    'visio/document.xml', 'visio/_rels/document.xml.rels', 'visio/pages/pages.xml',
    'visio/pages/_rels/pages.xml.rels', 'visio/pages/page1.xml', 'visio/windows.xml']) {
    ok(s.includes(part), 'VSDX 包含部件 ' + part);
  }
  ok(s.includes('schemas.microsoft.com/office/visio/2012/main'), 'VSDX 2012 命名空间');
  ok(s.includes("<Cell N='PinX' V='"), 'VSDX 扁平 Cell 形式');
  ok(s.includes('RelMoveTo') && s.includes('RelLineTo'), 'VSDX 相对几何');
  ok(s.includes('<Text>') && s.includes("<cp IX='0'/><pp IX='0'/>"), 'VSDX 文本混合内容 + cp/pp 运行标记');
  ok(!s.includes('&#10;'), 'VSDX 文本不使用 &#10;（&#10; 会让 Visio 多行文字重叠）');
  {
    // 带管理地址的节点：用原始 CRLF 换行（参考 Visio 官方输出；&#10;/<pp> 单独用会重叠或不断行）
    const gM = M.textToGraph('源设备,源接口,源IP,目标设备,目标接口,目标IP,带宽,管理地址,备注\nR1,G0,10.0.0.1,SW1,G1,10.0.0.2,,10.255.0.1,');
    const bufM = V2.buildVSDX(gM, {});
    const sM = Buffer.from(bufM).toString('latin1');
    ok(sM.includes('R1\r\n') && !sM.includes('R1<pp'), 'VSDX 节点名称与管理地址用原始 CRLF 换行');
  }
  ok(s.includes('Label10002') || s.includes('NameU=\'Label'), 'VSDX 独立水平文本框');
  ok(s.includes("<Cell N='Angle' V='") && s.includes('LineColor'), 'VSDX 连线 Angle/线色（2-D 直线）');
  // 双链路平行偏移：同一对设备的两条连线 PinY 必须不同（与画布显示一致）
  {
    const pinY = [...s.matchAll(/<Cell N='PinY' V='([^']+)'/g)].map(m => parseFloat(m[1]));
    ok(pinY.length >= 4 && Math.abs(pinY[2] - pinY[3]) > 0.05,
      'VSDX 双链路平行偏移（PinY=' + pinY[2] + '/' + pinY[3] + '）');
  }
  ok(!/Connects/.test(s), 'VSDX 不粘到设备中心（线端点落在边框，避免遮挡文字）');
  ok(!/<t>/.test(s), 'VSDX 无 <t> 元素');
  // 回归：VSDX 标注文本框（ID≥10000）不得与设备矩形重叠（Visio 打开后文字不压节点）
  {
    const gS = M.textToGraph(M.SAMPLE_CSV);
    for (const n of gS.nodes) {
      n.w = U.nodeWidthForName(n.name);
      n.h = U.nodeHeightFor(n);
      n.x = 0; n.y = 0;
    }
    Layout.layoutNow(gS.nodes, gS.links, 320);
    const bufS = V2.buildVSDX({ nodes: gS.nodes, links: gS.links }, {});
    const sS = Buffer.from(bufS).toString('latin1');
    const shapes = [...sS.matchAll(/<Shape ID='(\d+)'[\s\S]*?<\/Shape>/g)].map(m => {
      const body = m[0];
      const cell = (n) => { const mm = body.match(new RegExp("<Cell N='" + n + "' V='([^']+)'")); return mm ? parseFloat(mm[1]) : NaN; };
      return { id: +m[1], px: cell('PinX'), py: cell('PinY'), w: cell('Width'), h: cell('Height') };
    });
    const labs = shapes.filter(x => x.id >= 10000);
    const nboxes = shapes.filter(x => x.id < 10000 && x.h > 0.1);
    let ov = 0;
    for (const a of labs) for (const b of nboxes) {
      if (Math.abs(a.px - b.px) < (a.w + b.w) / 2 && Math.abs(a.py - b.py) < (a.h + b.h) / 2) ov++;
    }
    ok(ov === 0, 'VSDX 标注不压设备（重叠对=' + ov + '）');
  }
  // 写入文件 + python-vsdx 解析验证（有 python 时）
  try {
    const tmp = path.join(root, 'test', '_test.vsdx');
    fs.writeFileSync(tmp, buf);
    const out = execSync('python -c "import vsdx; v=vsdx.VisioFile(r\'' + tmp + '\'); print(len(v.get_page(0).child_shapes)); v.close_vsdx()"', { encoding: 'utf8' });
    fs.unlinkSync(tmp);
    ok(Number(out.trim()) === 6, 'VSDX 可被 python-vsdx 解析（6 形状 = 2 设备 + 2 连线 + 2 文本框）');
  } catch (e) {
    ok(false, 'VSDX 可被 python-vsdx 解析：' + String(e.stderr || e.message).slice(0, 150));
  }
}

console.log('== PDF 导出 ==');
{
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'pdf.js'), 'utf8'), sandbox, { filename: 'pdf.js' });
  const P = sandbox.TopoPdf;
  const svg = P.buildSvgImage({ nodes: nodes2, links: links2 }, {});
  ok(svg.includes('<svg') && svg.includes('</svg>'), 'PDF 源 SVG 生成');
  ok(svg.includes('<rect') && (svg.match(/<rect/g) || []).length === 3, 'SVG 含节点与背景（2 节点 + 1 背景）');
  ok(svg.includes('<line'), 'SVG 含连线');
  ok(svg.includes('1.1.1.1') && svg.includes('G0'), 'SVG 标注含接口与 IP');
  ok(svg.includes('font-size="13"'), 'SVG 标注字号');
  // 坐标一致性：布局偏离原点时，线端点仍须落在节点边框上（回归测试）
  {
    const gn = U.clone(nodes2);
    gn[0].x += 800; gn[0].y += 300; gn[1].x += 800; gn[1].y += 300;
    const svg2 = P.buildSvgImage({ nodes: gn, links: links2 }, {});
    const rects = [...svg2.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="12"/g)].map(m => m.slice(1, 5).map(Number));
    const lns = [...svg2.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)].map(m => m.slice(1, 5).map(Number));
    const hit = (px, py) => rects.some(([rx, ry, rw, rh]) => px >= rx - 2 && px <= rx + rw + 2 && py >= ry - 2 && py <= ry + rh + 2);
    const allHit = lns.every(([x1, y1, x2, y2]) => hit(x1, y1) && hit(x2, y2));
    ok(allHit, '布局偏离原点时线端点仍连接节点（坐标归一化）');
  }
  // 标注防碰撞：构造两个重叠标注，验证被推开
  const labels = [{ x: 100, y: 100, w: 80, h: 30 }, { x: 110, y: 105, w: 80, h: 30 }];
  U.resolveLabelCollisions(labels, { pad: 4 });
  const dx = Math.abs(labels[0].x - labels[1].x), dy = Math.abs(labels[0].y - labels[1].y);
  ok(!(dx < 80 + 4 && dy < 30 + 4), '防碰撞推开重叠标注');
  // 防碰撞：标注必须避开节点（障碍物为左上角矩形；旧实现会因符号翻转把标注推进节点）
  {
    const labels = [{ x: 140, y: 120, w: 80, h: 30 }]; // 位于节点矩形右下区域内
    U.resolveLabelCollisions(labels, { pad: 4, obstacles: [{ x: 60, y: 70, w: 100, h: 60 }] });
    const ocx = 60 + 50, ocy = 70 + 30; // 节点中心
    const dx = Math.abs(labels[0].x - ocx), dy = Math.abs(labels[0].y - ocy);
    ok(!(dx < (80 + 100) / 2 + 4 && dy < (30 + 60) / 2 + 4), '防碰撞把标注推离节点（不压节点文字）');
  }
  // 生成小 JPEG + PDF
  try {
    const tmp = path.join(root, 'test', '_pdf_tmp');
    fs.writeFileSync(tmp + '.py', 'from PIL import Image\nImage.new("RGB", (300, 200), (200, 100, 50)).save(r"' + tmp + '.jpg", quality=85)\n');
    execSync('python ' + tmp + '.py');
    const jpg = fs.readFileSync(tmp + '.jpg');
    const pdf = P.buildImagePDF(jpg, 300, 200, {});
    const ps = Buffer.from(pdf).toString('latin1');
    ok(ps.startsWith('%PDF-1.4') && ps.includes('%%EOF'), 'PDF 头尾完整');
    ok(ps.includes('DCTDecode') && ps.includes('DeviceRGB'), 'PDF 嵌入 JPEG');
    const pdfPath = tmp + '.pdf';
    fs.writeFileSync(pdfPath, pdf);
    const out = execSync('python -c "import pymupdf; d=pymupdf.open(r\'' + pdfPath + '\'); print(len(d[0].get_images()), d.page_count)"', { encoding: 'utf8' });
    ok(out.trim() === '1 1', 'PDF 可被 PyMuPDF 解析（1 页 1 图）');
    fs.unlinkSync(tmp + '.py'); fs.unlinkSync(tmp + '.jpg'); fs.unlinkSync(pdfPath);
  } catch (e) {
    ok(false, 'PDF 二进制验证：' + String(e.stderr || e.message).slice(0, 120));
  }
}

console.log('== Visio VDX 导出（2003 格式，备用） ==');
const xml = V.buildVDX({ nodes: nodes2, links: links2 }, {});
ok(xml.startsWith('<?xml'), 'VDX XML 声明');
ok(xml.includes('VisioDocument') && xml.includes('http://schemas.microsoft.com/visio/2003/core'), 'VDX 根元素与 2003 命名空间');
ok(!/<t>/.test(xml), 'VDX 不使用 <t> 元素（文本为混合内容）');
ok(xml.includes('MoveTo') && xml.includes('LineTo'), 'VDX 连线几何');
ok((xml.match(/<Geom IX=/g) || []).length === 6, 'VDX 几何节（2 设备 + 2 连线 + 2 文本框）');
ok((xml.match(/NameU='Label/g) || []).length === 2, 'VDX 独立水平文本框（2 个）');
ok(!/<TextXForm>/.test(xml.slice(xml.indexOf('<XForm1D>'), xml.lastIndexOf('</Shape>'))), 'VDX 连线不再依赖 TextXForm（文本用 2D 形状）');
ok(xml.includes("<pp IX='1'/>"), 'VDX 文本段落间用 <pp> 换行');
ok(xml.includes('<XForm>') && /<PinX[^>]*>[^<]+<\/PinX>/.test(xml), 'VDX cell 为文本内容形式（Visio 兼容关键）');
ok(!/<PinX V=/.test(xml), 'VDX 无 V 属性形式 cell（会被 Visio 忽略）');
ok(xml.includes('FaceName') && !xml.includes('FontEntry'), 'VDX 字体使用 FaceNames');
ok(xml.includes("F='Width*0.5'"), 'VDX 公式型 XForm（LocPinX）');
ok(xml.includes('SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)'), 'VDX 1-D 形状公式宽度');
ok(xml.includes('<Connects>') && (xml.match(/<Connect /g) || []).length === 4, 'VDX 两端粘合（2 链路 × 2 端点）');
ok(xml.includes('<Prop Name='), 'VDX 属性（Shape Data）');
ok(xml.includes('GE0/0/1') === false, 'VDX 文本转义（无原始字符）');
ok(xml.includes('G0') && xml.includes('1.1.1.1'), 'VDX 连线文本内容');
ok(xml.includes('<pp IX=') && xml.indexOf('<pp ') < xml.indexOf('<cp '), 'VDX 文本 pp 在 cp 前');
ok(xml.includes("<pp IX='1'/>"), 'VDX 文本段落间用 <pp> 换行');
ok(xml.includes('Microsoft YaHei'), 'VDX 中文字体');
ok(xml.includes('<Desc>') && !xml.includes('<Description>'), 'VDX 属性名 Desc');
const wmatch = xml.match(/<PageWidth[^>]*>([^<]+)</);
ok(wmatch && parseFloat(wmatch[1]) > 5, 'VDX 页面宽度合理（' + (wmatch && wmatch[1]) + ' 英寸）');

// 官方 2003 schema 校验（需要 python + lxml，不可用则跳过）
try {
  const tmp = path.join(root, 'test', '_test.vdx');
  fs.writeFileSync(tmp, xml, 'utf8');
  const out = execSync('python test/validate_vdx.py ' + tmp, { cwd: root, encoding: 'utf8' });
  fs.unlinkSync(tmp);
  ok(out.includes('PASS'), 'VDX 通过官方 visio2003.xsd 校验');
} catch (e) {
  ok(false, 'VDX 通过官方 visio2003.xsd 校验：' + String(e.stderr || e.message).slice(0, 120));
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
