/* NetTopo 纯逻辑测试（Node 环境） */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const sandbox = { console, Uint8Array, TextEncoder, TextDecoder, structuredClone, Map, Set, Promise, Math, requestAnimationFrame: (fn) => setTimeout(fn, 0), localStorage: { getItem: () => null, setItem: () => {} }, crypto: require('crypto').webcrypto, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), atob: (s) => Buffer.from(s, 'base64').toString('binary') };
vm.createContext(sandbox);

for (const f of ['js/util.js', 'js/model.js', 'js/layout.js', 'js/visio.js', 'js/pdf.js']) {
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
ok(U.escXml("a'b<c&d\"e") === 'a&#39;b&lt;c&amp;d&quot;e', 'XML 转义含单引号');
ok(U.escXml('a\x00b\x1Fc') === 'abc', 'XML 非法控制字符剔除');
// 公式注入防护：以 = + - @ 开头的单元格加 ' 前缀
const fi = U.buildCSV([['=1+1', '+x', '-y', '@z', 'normal', 123]]);
ok(fi.includes("'=1+1") && fi.includes("'+x") && fi.includes("'-y") && fi.includes("'@z"), 'CSV 公式注入加前缀');
ok(fi.includes(',normal,') && fi.includes(',123'), 'CSV 普通单元格不受影响');
ok(U.sanitizeCell('=SUM(1)') === "'=SUM(1)" && U.sanitizeCell('hello') === 'hello', 'sanitizeCell 公式注入防护');
ok(U.sanitizeCell(' =1+1') === "' =1+1" && U.sanitizeCell('\t@x') === "'\t@x" && U.sanitizeCell(' ok') === ' ok', 'sanitizeCell 前导空白绕过修复');
// 回归：零宽空格绕过（\s 不含 \u200B，Excel trim 会处理）
ok(U.sanitizeCell('\u200B=1+1') === "'\u200B=1+1" && U.sanitizeCell('\u200Bok') === '\u200Bok', 'sanitizeCell 零宽空格绕过修复');
// 回归：ZIP 条目名穿越过滤（zip-slip 生成面）
{
  const zSafe = U.zipFiles([{ name: 'huawei/R1.txt', content: 'a' }]);
  ok(zSafe.length > 22, 'ZIP 正常条目保留');
  const zBad = U.zipFiles([
    { name: 'huawei/..\\..\\evil.txt', content: 'a' },
    { name: 'x/../y.txt', content: 'b' },
    { name: '/abs.txt', content: 'c' },
    { name: 'C:\\x.txt', content: 'd' }
  ]);
  ok(zBad.length === 22, 'ZIP 危险条目（..\\、绝对路径、盘符）被过滤');
}
// 回归：自定义配置模板加载键白名单（防 Object.assign 原型污染 CWE-1321）
{
  const savedLS = sandbox.localStorage;
  sandbox.localStorage = {
    getItem: (k) => k === 'nettopo.cfgTemplates' ? '{"__proto__":{"polluted":1},"constructor":{"y":1},"huawei":{"x":1}}' : null,
    setItem: () => {}
  };
  vm.runInContext('TopoUtil.loadCustomCfgTemplates()', sandbox);
  sandbox.localStorage = savedLS;
  ok(!Object.prototype.hasOwnProperty.call(U.customCfgTemplates, '__proto__')
    && !Object.prototype.hasOwnProperty.call(U.customCfgTemplates, 'constructor')
    && !Object.prototype.hasOwnProperty.call(U.customCfgTemplates, 'prototype')
    && !!U.customCfgTemplates.huawei, '模板加载键白名单（拒 __proto__/constructor/prototype）');
  const merged = U.cfgTemplates();
  ok(merged.polluted === undefined && ({}).polluted === undefined, '模板合并无原型污染');
  U.customCfgTemplates = {}; // 恢复初始态，避免影响后续配置生成测试
}
// 回归：子网自定义名称安全化（仅保留 CIDR 键 + 字符串值）
{
  const sn = U.sanitizeSubnetNames({ '10.0.0.0/24': '核心区', '__proto__': { x: 1 }, 'not-a-cidr': 'x', '10.1.0.0/16': 123 });
  ok(sn['10.0.0.0/24'] === '核心区' && !Object.prototype.hasOwnProperty.call(sn, '__proto__') && Object.keys(sn).length === 1, 'sanitizeSubnetNames 仅保留 CIDR+字符串键');
}
// 回归：工程恢复自定义配置模板（白名单合并，工程覆盖本机同名）
{
  U.customCfgTemplates = {};
  const n = U.mergeCustomCfgTemplates({ 'huawei': { x: 1 }, 'ok-tpl': { k: 1 }, '__proto__': { p: 2 }, 'constructor': { c: 3 }, 'bad key': { z: 1 } });
  ok(n === 2 && !!U.customCfgTemplates['ok-tpl'] && !!U.customCfgTemplates.huawei
    && !Object.prototype.hasOwnProperty.call(U.customCfgTemplates, '__proto__')
    && !Object.prototype.hasOwnProperty.call(U.customCfgTemplates, 'constructor')
    && !('bad key' in U.customCfgTemplates), 'mergeCustomCfgTemplates 白名单合并（工程模板）');
  U.customCfgTemplates = {}; // 恢复初始态
}

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
const mgmtCol = table[0].indexOf('管理地址');
ok(mgmtCol >= 0 && table[1][mgmtCol] === '10.255.0.1', '导出行含管理地址值');
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
  const gt = [{ id: 't1' }, { id: 't7' }];
  U.seedCounters(g.nodes, g.links, gt);
  const tid = U.uid('t');
  ok(!gt.some(t => t.id === tid), 'seedCounters 后新文本框 ID 不与恢复文本框冲突（' + tid + '）');
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

console.log('== 类型数据安全清洗 ==');
{
  const bad = U.sanitizeTypeData(
    { router: { c1: '" onload="x', img: '"><svg onload=alert(1)>' } },
    [{ key: 'ct1', label: '坏类型', c1: 'red" onerror="x', img: 'javascript:alert(1)' }]
  );
  ok(Object.keys(bad.overrides).length === 0, '清洗非法类型颜色/图片（overrides 清空）');
  ok(bad.customTypes.length === 1 && /^#[0-9a-f]{6}$/i.test(bad.customTypes[0].c1) && bad.customTypes[0].img === '', '清洗自定义类型非法字段（颜色回退、图片清空）');
  const good = U.sanitizeTypeData({ router: { c1: '#ff0000', img: 'data:image/png;base64,AAA' } }, []);
  ok(good.overrides.router && good.overrides.router.c1 === '#ff0000' && good.overrides.router.img === 'data:image/png;base64,AAA', '合法颜色/图片保留');
  ok(U.isValidColor('#aBcDeF') && !U.isValidColor('red') && !U.isValidColor('#12345'), '颜色校验只接受 #rrggbb');
}

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

console.log('== 带宽单位解析 / 工程数据清洗 ==');
{
  ok(U.normalizeBw('2g') === 2000 && U.normalizeBw('2.5g') === 2500 && U.normalizeBw('500m') === 500 && U.normalizeBw('800mbps') === 800, '带宽通用单位解析（2g/2.5g/500m/800mbps）');
  ok(U.formatBw(40000) === '40G' && U.formatBw(50000) === '50G' && U.formatBw(2500) === '2.5G', '带宽格式化（40G/50G/2.5G）');
  const sg = U.sanitizeGraph(
    [{ id: 'n1' }, { id: 'n2', name: 'R1', x: 'abc', y: 10, w: 0, h: 0, type: 123, mgmt: null, note: 5 }],
    [{ id: 'l1', a: 'n1', b: 'n2', aIf: 1, aIp: null }],
    [{ id: 't1', x: 'x', size: 0, color: 'red', bg: '#fff', align: 'up', text: 42 }]
  );
  ok(sg.nodes.length === 2 && sg.nodes[1].x === 0 && sg.nodes[1].w >= 40 && sg.nodes[1].type === 'other' && sg.nodes[1].name === 'R1' && sg.nodes[1].mgmt === '', '清洗节点缺失/畸形字段（坐标回退、宽度下限、类型回退）');
  ok(sg.links.length === 1 && sg.links[0].aIf === '1' && sg.links[0].aIp === '', '清洗连线字段为字符串');
  ok(sg.texts.length === 1 && sg.texts[0].x === 0 && sg.texts[0].size === 8 && sg.texts[0].color === '#1e293b' && sg.texts[0].bg === '' && sg.texts[0].align === 'left' && sg.texts[0].text === '42', '清洗文本框字段（颜色/对齐/字号回退）');
}

console.log('== 多管理地址 ==');
{
  const n = { id: 'n1', name: 'R1', mgmt: '10.0.0.1', mgmts: ['10.0.0.2', '10.0.0.1', ''] };
  ok(U.nodeMgmts(n).join(',') === '10.0.0.1,10.0.0.2', 'nodeMgmts 去重保序返回全部管理地址');
  U.setNodeMgmts(n, ['10.1.1.1', '10.1.1.2', '10.1.1.2']);
  ok(n.mgmt === '10.1.1.1' && n.mgmts.join(',') === '10.1.1.2', 'setNodeMgmts 主地址+附加地址去重');
  ok(U.splitMgmts('10.0.0.1, 10.0.0.2；10.0.0.3\n10.0.0.4').length === 4, 'splitMgmts 支持逗号/分号/换行');
  ok(U.nodeHeightFor({ mgmt: '1.1.1.1', mgmts: ['1.1.1.2'] }) === 88, '两个管理口节点高度 88');
  ok(U.nodeHeightFor({ mgmt: '1.1.1.1', mgmts: ['1.1.1.2', '1.1.1.3', '1.1.1.4'] }) === 104, '三个及以上管理口高度封顶 104');
  const sg = U.sanitizeGraph([{ id: 'n2', name: 'SW', mgmt: '2.2.2.1', mgmts: ['2.2.2.2', 5, ''], web: 'http://10.0.0.1' }], [], []);
  ok(sg.nodes[0].mgmts.join(',') === '2.2.2.2,5', 'sanitizeGraph 清洗 mgmts 为字符串数组');
  ok(sg.nodes[0].web === 'http://10.0.0.1', 'sanitizeGraph 保留管理 Web 页 URL');
  const ip = U.ipPlan([{ id: 'n3', name: 'FW', type: 'firewall', mgmt: '3.3.3.1', mgmts: ['3.3.3.2'] }], []);
  ok(ip.rows.length === 2 && ip.rows[0].接口 === '管理' && ip.rows[1].接口 === '管理2' && ip.rows[1].IP === '3.3.3.2', 'IP 规划每个管理口一行');
  const v = M.validateTopology([{ id: 'a', name: 'A', mgmt: '9.9.9.9' }, { id: 'b', name: 'B', mgmt: '', mgmts: ['9.9.9.9'] }], []);
  ok(v.some(i => i.kind === 'dup-mgmt'), '附加管理地址参与重复校验');
  const cfg = U.generateConfigs([{ id: 'a', name: 'A', type: 'router', mgmt: '8.8.8.1', mgmts: ['8.8.8.2'] }], [], 'huawei', {});
  ok(cfg.includes('管理: 8.8.8.1, 8.8.8.2'), '配置生成含全部管理地址');
  const gM = M.textToGraph(M.SAMPLE_CSV);
  gM.nodes[0].mgmt = '5.5.5.1'; gM.nodes[0].mgmts = ['5.5.5.2'];
  const csv = U.buildCSV(M.graphToTableRows(gM.nodes, gM.links));
  const gM2 = M.textToGraph(csv);
  const nm = gM2.nodes.find(x => x.name === gM.nodes[0].name);
  ok(U.nodeMgmts(nm).join(',') === '5.5.5.1,5.5.5.2', '多管理口 CSV 导出→导入回环');
  // M1：非法/重复 id 与 type 清洗
  const bad = U.sanitizeGraph(
    [{ id: 'n" onload="x', name: 'A', type: 'r" onload="x' }, { id: 'n1', name: 'B' }, { id: 'n1', name: 'C' }],
    [{ id: 'l1', a: 'n" onload="x', b: 'n1' }],
    [{ id: 't" onload="x', text: 'x' }]
  );
  ok(bad.nodes.length === 3 && new Set(bad.nodes.map(n => n.id)).size === 3, '非法/重复节点 id 被替换且无重复');
  ok(bad.nodes.every(n => /^[A-Za-z0-9_-]{1,64}$/.test(n.id) && /^[A-Za-z0-9_-]{1,64}$/.test(n.type)), '节点 id/type 均为安全字符');
  ok(bad.links.length === 1 && bad.nodes.some(n => n.name === 'A' && n.id === bad.links[0].a) && bad.nodes.some(n => n.name === 'B' && n.id === bad.links[0].b), '连线端点随 id 重映射');
  ok(bad.texts.length === 1 && /^[A-Za-z0-9_-]{1,64}$/.test(bad.texts[0].id), '文本框非法 id 被替换');
  const td = U.sanitizeTypeData(
    { 'bad" key': { c1: '#ff0000' }, router: { c1: '#00ff00' } },
    [{ key: 'x" onclick="x', label: '坏' }, { key: 'router', label: '冲突' }, { key: 'ct1', label: '好' }]
  );
  ok(!td.overrides['bad" key'] && td.overrides.router && td.overrides.router.c1 === '#00ff00', '非法 override key 丢弃，合法保留');
  ok(td.customTypes.length === 3 && td.customTypes.every(t => /^[A-Za-z0-9_-]{1,64}$/.test(t.key)) && !td.customTypes.some(t => t.key === 'router') && td.customTypes.some(t => t.label === '好' && t.key === 'ct1'), '自定义类型 key 安全化且不与内置冲突');
}

console.log('== Web 地址规范化 ==');
{
  ok(U.normalizeWebUrl('10.255.0.1') === 'http://10.255.0.1', '无协议自动补 http');
  ok(U.normalizeWebUrl('https://x.com') === 'https://x.com' && U.normalizeWebUrl('http://x.com/path') === 'http://x.com/path', 'http(s) 原样保留');
  ok(U.normalizeWebUrl('javascript:alert(1)') === null && U.normalizeWebUrl('file:///C:/x') === null && U.normalizeWebUrl('') === null && U.normalizeWebUrl('  ') === null, '拒绝非 http(s) 协议与空值');
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


console.log('== 拓扑校验 ==');
{
  const nodes = [
    { id: 'n1', name: 'R1', mgmt: '10.255.0.1', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n2', name: 'R1', mgmt: '10.255.0.1', x: 0, y: 0, w: 160, h: 56 }, // 名/管理重复
    { id: 'n3', name: 'SW1', mgmt: '10.255.0.3', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n4', name: '孤岛', mgmt: '', x: 0, y: 0, w: 160, h: 56 }            // 孤立
  ];
  const links = [
    { id: 'l1', a: 'n1', b: 'n3', aIf: 'G0', aIp: '10.0.0.1', bIf: 'G1', bIp: '10.0.0.2' },
    { id: 'l2', a: 'n2', b: 'n3', aIf: 'G0', aIp: '10.0.0.1', bIf: 'G1', bIp: '10.0.0.2' }, // 接口/IP 重复
    { id: 'l3', a: 'n1', b: 'n2', aIf: 'G2', aIp: '172.16.0.1', bIf: 'G3', bIp: '172.16.0.2' }, // 平行链路 + 环路
    { id: 'l4', a: 'n3', b: 'n1', aIf: 'G9', aIp: '192.168.1.1', bIf: 'G8', bIp: '10.99.99.1' }  // 不同网段
  ];
  const issues = M.validateTopology(nodes, links);
  const has = (kind, level) => issues.some(i => i.kind === kind && i.level === level);
  ok(has('dup-name', 'error'), '校验：设备名重复');
  ok(has('dup-mgmt', 'error'), '校验：管理地址重复');
  ok(has('dup-if', 'error'), '校验：接口重复');
  ok(has('dup-ip', 'error'), '校验：链路 IP 重复');
  ok(has('isolated', 'warning'), '校验：孤立设备');
  ok(has('cycle', 'info'), '校验：环路提示');
  ok(has('multi', 'info'), '校验：平行链路提示');
  ok(has('net-mismatch', 'warning'), '校验：不同网段警告');
  ok(M.validateTopology([], []).length === 0, '校验：空图无问题');
}


console.log('== 最短路径 ==');
{
  const ns = [
    { id: 'n1', name: 'A', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n2', name: 'B', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n3', name: 'C', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n4', name: 'D', x: 0, y: 0, w: 160, h: 56 }
  ];
  const ls = [
    { id: 'l1', a: 'n1', b: 'n2', aIf: 'G0', bIf: 'G1' },
    { id: 'l2', a: 'n2', b: 'n3', aIf: 'G2', bIf: 'G3' },
    { id: 'l3', a: 'n1', b: 'n3', aIf: 'G4', bIf: 'G5' }
  ];
  const p1 = U.shortestPath(ns, ls, 'n1', 'n3');
  ok(p1 && p1.nodeIds.length === 2 && p1.linkIds.length === 1, '最短路径：直达优先');
  const p2 = U.shortestPath(ns, ls, 'n1', 'n4');
  ok(p2 === null, '最短路径：不可达返回 null');
  const p3 = U.shortestPath(ns, ls, 'n2', 'n2');
  ok(p3 && p3.nodeIds.length === 1 && p3.linkIds.length === 0, '最短路径：同节点');
}


console.log('== 带宽数值化 / 最宽路径 ==');
{
  eq(U.normalizeBw('万兆'), 10000, '带宽：万兆→10000');
  eq(U.normalizeBw('千兆'), 1000, '带宽：千兆→1000');
  eq(U.normalizeBw('百兆'), 100, '带宽：百兆→100');
  eq(U.normalizeBw('10Gbps'), 10000, '带宽：10Gbps→10000');
  eq(U.normalizeBw('100'), 100, '带宽：纯数字 100');
  eq(U.normalizeBw(''), '', '带宽：空值');
  eq(U.formatBw(10000), '10G', '带宽格式化：10000→10G');
  eq(U.formatBw(1000), '1G', '带宽格式化：1000→1G');
  eq(U.formatBw(100), '100M', '带宽格式化：100→100M');
  eq(U.bwColor(10000), '#8b5cf6', '带宽颜色：10G');
  eq(U.bwColor(1000), '#0ea5e9', '带宽颜色：1G');
  // 最宽路径：A-B-C 是 10G，A-D-C 是 1G，应选 A-B-C
  const ns = [
    { id: 'n1', name: 'A', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n2', name: 'B', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n3', name: 'C', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n4', name: 'D', x: 0, y: 0, w: 160, h: 56 }
  ];
  const ls = [
    { id: 'l1', a: 'n1', b: 'n2', aIf: 'G0', bIf: 'G1', bw: 10000 },
    { id: 'l2', a: 'n2', b: 'n3', aIf: 'G2', bIf: 'G3', bw: 10000 },
    { id: 'l3', a: 'n1', b: 'n4', aIf: 'G4', bIf: 'G5', bw: 1000 },
    { id: 'l4', a: 'n4', b: 'n3', aIf: 'G6', bIf: 'G7', bw: 1000 }
  ];
  const bp = U.bestPath(ns, ls, 'n1', 'n3');
  ok(bp && bp.nodeIds.join(',') === 'n1,n2,n3' && bp.bottleneck === 10000, '最宽路径按带宽优选（瓶颈 10G）');
  ok(U.bestPath(ns, ls, 'n1', 'n1').bottleneck === Infinity, '最宽路径：同节点');
  ok(U.bestPath([{ id: 'x', name: 'X', x: 0, y: 0, w: 160, h: 56 }], [], 'x', 'y') === null, '最宽路径：不可达');
}

console.log('== 链路聚合标记 ==');
{
  // 标注第三行携带聚合组名（画布/PDF/VSDX 共用 labelLines）
  const aggLines = U.labelLines({ aIf: 'G0', aIp: '10.0.0.1', bIf: 'G1', bIp: '10.0.0.2', agg: 'Eth-Trunk1' });
  eq(aggLines.length, 3, '聚合链路标注 3 行');
  ok(aggLines[2].includes('Eth-Trunk1'), '标注第三行为聚合组名');
  eq(U.labelLines({}).length, 0, '无接口无聚合不产生标注行');
  eq(U.labelLines({ aIf: 'G0', bIf: 'G1' }).length, 2, '仅有接口时标注 2 行');
  // 工程清洗保留聚合组（限长 32）
  const sg = U.sanitizeGraph(
    [{ id: 'n1', name: 'A', x: 0, y: 0, w: 160, h: 56 }, { id: 'n2', name: 'B', x: 0, y: 0, w: 160, h: 56 }],
    [{ id: 'l1', a: 'n1', b: 'n2', agg: '  Eth-Trunk1  ' },
     { id: 'l2', a: 'n1', b: 'n2', agg: 'x'.repeat(40) }]);
  eq(sg.links[0].agg, 'Eth-Trunk1', 'sanitizeGraph 保留聚合组名');
  eq(sg.links[1].agg.length, 32, '聚合组名限长 32');
  // CSV 回环：聚合组列导出后可再导入
  const rt = M.textToGraph(U.buildCSV(M.graphToTableRows(
    [{ id: 'n1', name: 'A', x: 0, y: 0, w: 160, h: 56 }, { id: 'n2', name: 'B', x: 0, y: 0, w: 160, h: 56 }],
    [{ id: 'l1', a: 'n1', b: 'n2', aIf: 'G0', bIf: 'G1', agg: 'Eth-Trunk1', bw: 1000 }])));
  eq(rt.links.length, 1, '聚合回环：链路数不变');
  eq(rt.links[0].agg, 'Eth-Trunk1', '聚合组经 CSV 导出再导入不丢失');
  // 表头映射：聚合组列
  eq(M.mapHeader('聚合组'), 'agg', '表头映射：聚合组');
  eq(M.mapHeader('Eth-Trunk'), 'agg', '表头映射：Eth-Trunk');
  // 校验：同名聚合组的平行链路不再提示；部分标记仍提示
  const vNodes = [
    { id: 'n1', name: 'A', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n2', name: 'B', x: 0, y: 0, w: 160, h: 56 }
  ];
  const mkL = (id, agg) => ({ id, a: 'n1', b: 'n2', aIf: 'G' + id, bIf: 'H' + id, agg });
  const okAgg = M.validateTopology(vNodes, [mkL('l1', 'Eth-Trunk1'), mkL('l2', 'Eth-Trunk1')]);
  ok(!okAgg.some(i => i.kind === 'multi'), '同名聚合组平行链路不提示');
  const partAgg = M.validateTopology(vNodes, [mkL('l1', 'Eth-Trunk1'), mkL('l2', '')]);
  ok(partAgg.some(i => i.kind === 'multi') && partAgg.find(i => i.kind === 'multi').msg.includes('统一聚合组名'), '部分标记聚合仍提示（附提示语）');
  const diffAgg = M.validateTopology(vNodes, [mkL('l1', 'Eth-Trunk1'), mkL('l2', 'Eth-Trunk2')]);
  ok(diffAgg.some(i => i.kind === 'multi'), '不同聚合组名的平行链路仍提示');
  // 最宽路径：聚合成员带宽相加
  const pNodes = [
    { id: 'n1', name: 'A', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n2', name: 'B', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n3', name: 'C', x: 0, y: 0, w: 160, h: 56 }
  ];
  const aggLs = [
    { id: 'l1', a: 'n1', b: 'n2', bw: 1000, agg: 'AGG1' },
    { id: 'l2', a: 'n1', b: 'n2', bw: 1000, agg: 'AGG1' },
    { id: 'l3', a: 'n1', b: 'n2', bw: 10000 },            // 未标记聚合：独立参与
    { id: 'l4', a: 'n2', b: 'n3', bw: 2000, agg: 'AGG2' },
    { id: 'l5', a: 'n2', b: 'n3', bw: 2000, agg: 'AGG2' }
  ];
  const bp1 = U.bestPath(pNodes, aggLs, 'n1', 'n3');
  ok(bp1 && bp1.bottleneck === 4000, '聚合带宽相加（2×2G=4G 瓶颈）');
  ok(bp1 && bp1.linkIds.sort().join(',') === 'l3,l4,l5', '路径高亮含独立链路与全部聚合成员');
  // 成员标记故障：聚合容量减去故障成员（AGG2 是 n2→n3 唯一路径）
  const bp2 = U.bestPath(pNodes, aggLs, 'n2', 'n3');
  ok(bp2 && bp2.bottleneck === 4000, '聚合两条成员时瓶颈 4G');
  const bp3 = U.bestPath(pNodes, aggLs, 'n2', 'n3', { exclude: new Set(['l4']) });
  ok(bp3 && bp3.bottleneck === 2000 && bp3.linkIds.join(',') === 'l5', '聚合成员故障后容量降为剩余成员（2G）');
  const bp4 = U.bestPath(pNodes, aggLs, 'n2', 'n3', { exclude: new Set(['l4', 'l5']) });
  ok(bp4 === null, '聚合成员全部故障则该链路不可用');
  // 未标记聚合的平行链路不合并（旧行为）：n1→n2 直连瓶颈 = max(AGG1 2G, 独立 10G)
  const bp5 = U.bestPath(pNodes, aggLs, 'n1', 'n2');
  ok(bp5 && bp5.bottleneck === 10000, '平行独立链路不与聚合组合并（取最大瓶颈）');
}

console.log('== 布局预设 ==');
{
  const ns = [
    { id: 'n1', name: 'R1', type: 'router', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n2', name: 'SW1', type: 'switch', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n3', name: 'FW1', type: 'firewall', x: 0, y: 0, w: 160, h: 56 },
    { id: 'n4', name: 'PC1', type: 'pc', x: 0, y: 0, w: 160, h: 56 }
  ];
  Layout.ringLayout(ns, { cx: 0, cy: 0 });
  ok(ns.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), '环形布局坐标有限');
  const ringR = ns.map(n => Math.hypot(n.x + n.w / 2, n.y + n.h / 2));
  ok(Math.max(...ringR) - Math.min(...ringR) < 1, '环形布局半径一致');
  Layout.gridLayout(ns, { cx: 0, cy: 0 });
  ok(ns.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), '网格布局坐标有限');
  Layout.layerLayout(ns, { cx: 0, cy: 0 });
  ok(ns.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), '分层布局坐标有限');
  const r = ns.find(n => n.name === 'R1'), pc = ns.find(n => n.name === 'PC1');
  ok(r && pc && pc.y > r.y, '分层布局按类型分行（终端在路由器下方）');
}

console.log('== 表格坐标回环 ==');
{
  const g = M.textToGraph(M.SAMPLE_CSV);
  for (const n of g.nodes) { n.x = Math.round((Math.random() * 2000 - 1000) * 10) / 10; n.y = Math.round((Math.random() * 1000 - 500) * 10) / 10; }
  const table = M.graphToTableRows(g.nodes, g.links);
  ok(table[0].includes('源设备X') && table[0].includes('目标设备Y'), '导出表头含坐标列');
  const g2 = M.textToGraph(U.buildCSV(table));
  const nameOf = (gg, id) => gg.nodes.find(n => n.id === id).name;
  const posOk = g2.nodes.every(n2 => {
    const n1 = g.nodes.find(x => x.name === n2.name);
    return n1 && Math.abs(n1.x - n2.x) < 0.5 && Math.abs(n1.y - n2.y) < 0.5;
  });
  ok(posOk, '导入后坐标还原');
  // 回归：坐标解析不得剔除非数字字符后拼接（"1e2" 曾误解析为 12）
  const gSci = M.textToGraph('源设备,目标设备,源设备X,源设备Y,目标设备X,目标设备Y\nR1,SW1,1e2,5,3,4');
  const nSci = gSci.nodes.find(n => n.name === 'R1');
  ok(nSci && nSci.x === 100, '科学计数法坐标解析（1e2=100）');
}

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

console.log('== 标注行按设备上下方位排序（orderLabelLines） ==');
{
  const upA = { id: 'A', x: 0, y: 0, w: 160, h: 56 };   // A 在上
  const downB = { id: 'B', x: 0, y: 300, w: 160, h: 56 }; // B 在下
  const lines = ['G0  1.1.1.1', 'G1  1.1.1.2'];          // [a端行, b端行]；渲染 index0 在下
  // A 在上、B 在下：A 行排上方、B 行排下方（swap）
  const ab = U.orderLabelLines(lines, upA, downB);
  ok(ab[0] === 'G1  1.1.1.2' && ab[1] === 'G0  1.1.1.1', 'A 在上：A 行在上、B 行在下方（' + ab.join(' | ') + '）');
  // A 在下、B 在上：A 行排下方（保持默认，a 行在 index0）
  const ba = U.orderLabelLines(lines, downB, upA);
  ok(ba[0] === 'G0  1.1.1.1' && ba[1] === 'G1  1.1.1.2', 'A 在下：A 行在下方、B 行在上方（' + ba.join(' | ') + '）');
  // 水平等高（y 相同）：不交换
  const levelA = { id: 'A', x: 0, y: 100, w: 160, h: 56 };
  const levelB = { id: 'B', x: 400, y: 100, w: 160, h: 56 };
  ok(U.orderLabelLines(lines, levelA, levelB)[0] === lines[0], '水平等高：保持默认顺序');
  // 单行 / 缺节点：原样返回
  ok(U.orderLabelLines(['only'], upA, downB)[0] === 'only', '单行标注不排序');
  ok(U.orderLabelLines(lines, null, downB) === lines && U.orderLabelLines(lines, upA, undefined) === lines, '缺节点不排序');
}

console.log('== 子网分组 ==');
{
  eq(U.subnetOf('10.255.0.1'), '10.255.0.0/24', '子网计算 /24');
  eq(U.subnetOf('10.255.0.1', 16), '10.255.0.0/16', '子网计算 /16');
  ok(U.subnetOf('not-an-ip') === null && U.ipv4ToInt('999.1.1.1') === null, '非法 IP 返回 null');
  const gS = M.textToGraph(M.SAMPLE_CSV);
  for (const n of gS.nodes) {
    n.w = U.nodeWidthForName(n.name);
    n.h = U.nodeHeightFor(n);
    n.x = 0; n.y = 0;
  }
  // 手工摆位，避免布局随机性影响分组结果（分组只依赖 IP）
  gS.nodes.forEach((n, i) => { n.x = i * 200; n.y = i * 150; });
  const grps = U.subnetGroups(gS.nodes, gS.links, {});
  const keys = grps.map(g => g.key).sort();
  ok(keys.length === 3 && keys[0] === '10.0.0.0/24' && keys[1] === '192.168.1.0/24' && keys[2] === '203.0.113.0/24',
    '示例拓扑按接口 IP 归为 3 个网段（' + keys.join(',') + '）');
  const core = grps.find(g => g.key === '10.0.0.0/24');
  const access = grps.find(g => g.key === '192.168.1.0/24');
  ok(core && core.nodeIds.length === 3, '核心网段 3 台设备（R1/SW1/FW1）');
  ok(access && access.nodeIds.length === 5, '接入网段 5 台设备（SW2/FS1/DB1/PC1/PC2）');
  ok(core && typeof core.x === 'number' && core.w > 0 && core.h > 0 && core.color, '分组含可绘制区域与配色');
  const named = U.subnetGroups(gS.nodes, gS.links, { '10.0.0.0/24': '核心区' });
  ok(named.find(g => g.key === '10.0.0.0/24').name.includes('核心区'), '子网分组支持自定义命名');
  // 无 IP 设备不归组
  const iso = { nodes: [{ id: 'x', name: 'X', x: 0, y: 0, w: 100, h: 50 }], links: [] };
  ok(U.subnetGroups(iso.nodes, iso.links, {}).length === 0, '无 IP 设备不产生分组');
}

console.log('== 设备配置生成 / IP 规划 ==');
{
  const gC = M.textToGraph('源设备,源接口,源IP,目标设备,目标接口,目标IP,带宽\nR1,GE0/0/1,10.0.0.1,SW1,GE1/0/1,10.0.0.2,1000');
  for (const n of gC.nodes) { n.w = U.nodeWidthForName(n.name); n.h = U.nodeHeightFor(n); n.x = 0; n.y = 0; }
  const hw = U.generateConfigs(gC.nodes, gC.links, 'huawei');
  ok(hw.includes('interface GE0/0/1') && hw.includes('ip address 10.0.0.1 255.255.255.0') && hw.includes('description -> SW1:GE1/0/1'), '华为配置含接口/IP/对端描述');
  const cisco = U.generateConfigs(gC.nodes, gC.links, 'cisco');
  ok(cisco.includes('!') && cisco.includes('no shutdown') && !hw.includes('no shutdown'), '思科配置含 ! 与 no shutdown，华为不含');
  // 设备子集：仅生成选中设备，且对端名从全量解析
  {
    const subset = new Set(gC.nodes.filter(n => n.name === 'R1').map(n => n.id));
    const cs = U.generateConfigs(gC.nodes, gC.links, 'huawei', { only: subset });
    ok(cs.includes('interface GE0/0/1') && cs.includes('description -> SW1:GE1/0/1'), '配置生成：设备子集含对端引用（' + cs.split('\n').filter(l => l.includes('description')).join(';') + '）');
    ok(!cs.includes('interface GE1/0/1'), '配置生成：子集不含未选设备的接口');
    const empty = U.generateConfigs(gC.nodes, gC.links, 'huawei', { only: new Set() });
    ok(empty === '', '配置生成：空子集返回空');
  }
  // 设备级厂家：n.vendor 覆盖全局 vendor（在「编辑设备」中设置）
  {
    const gV = M.textToGraph('源设备,源接口,源IP,目标设备,目标接口,目标IP\nR1,GE0/0/1,10.0.0.1,SW1,GE1/0/1,10.0.0.2');
    for (const n of gV.nodes) { n.w = U.nodeWidthForName(n.name); n.h = U.nodeHeightFor(n); n.x = 0; n.y = 0; }
    gV.nodes.find(n => n.name === 'R1').vendor = 'cisco';
    const cv = U.generateConfigs(gV.nodes, gV.links, 'huawei');
    const r1Idx = cv.indexOf('! R1'), sw1Idx = cv.indexOf('# SW1');
    const r1sec = r1Idx >= 0 && sw1Idx > r1Idx ? cv.slice(r1Idx, sw1Idx) : '';
    const sw1sec = sw1Idx >= 0 ? cv.slice(sw1Idx) : '';
    ok(r1sec.includes('no shutdown'), '设备级厂家：R1 用思科风格（no shutdown）');
    ok(sw1sec.includes('interface GE1/0/1') && !sw1sec.includes('no shutdown'), '设备级厂家：SW1 无 vendor 时用全局华为风格');
    gV.nodes.find(n => n.name === 'R1').vendor = 'not-exist';
    const cv2 = U.generateConfigs(gV.nodes, gV.links, 'huawei');
    const r1b = cv2.indexOf('# R1');
    ok(r1b >= 0 && !cv2.slice(r1b).includes('no shutdown'), '设备级厂家：无效 key 回退全局风格');
  }
  const plan = U.ipPlan(gC.nodes, gC.links);
  ok(plan.rows.length >= 2 && plan.rows.some(r => r.IP === '10.0.0.1' && r.网段 === '10.0.0.0/24'), 'IP 规划含接口行与网段');
  ok(plan.rows.some(r => r.IP === '10.0.0.1' && r.对端IP === '10.0.0.2'), 'IP 规划含对端接口 IP');
  ok(plan.rows.every(r => '对端IP' in r), 'IP 规划每行都有对端IP 字段（管理行为空）');
  ok(plan.subnets.length >= 1 && plan.subnets[0].cidr === '10.0.0.0/24', 'IP 规划子网统计');
  // 按设备分组：同一设备的行必须连续（Excel 合并设备名列的前提）
  {
    const gD = M.textToGraph('源设备,源接口,源IP,目标设备,目标接口,目标IP\nR1,GE0/0/1,10.0.0.1,SW1,GE1/0/1,10.0.0.2\nR1,GE0/0/2,10.0.0.9,FW1,eth0,10.0.0.10\nSW1,GE1/0/2,172.16.0.1,FW1,eth1,172.16.0.2');
    const pD = U.ipPlan(gD.nodes, gD.links);
    const names = pD.rows.map(r => r.设备);
    const seen = new Set();
    let prev = null;
    let grouped = true;
    for (const nm of names) {
      if (nm !== prev) { // 新的一组开始
        if (seen.has(nm)) { grouped = false; break; } // 该设备之前已出现过 => 未连续分组
        seen.add(nm);
        prev = nm;
      }
    }
    ok(grouped, 'IP 规划按设备分组（' + names.join(',') + '）');
    const merges = U.deviceMergeRanges(pD.rows);
    const single = merges.filter(m => (m.e.r - m.s.r + 1) === 1);
    ok(merges.length >= 1 && single.length === 0, '设备名列合并区间正确（' + JSON.stringify(merges) + '）');
  }
}
console.log('== 故障链路 / 三层布局 ==');
{
  // 故障链路：双链路全排除后不可达
  const pOK = U.bestPath(nodes2, links2, 'n1', 'n2', {});
  ok(pOK && pOK.linkIds.length >= 1, '双链路可达');
  const pDown = U.bestPath(nodes2, links2, 'n1', 'n2', { exclude: new Set(['l1', 'l2']) });
  ok(pDown === null, '全部链路故障后不可达（bestPath 排除故障链路）');
  // 三层布局：核心行在最上（y 最小），接入行在最下
  const gT = M.textToGraph(M.SAMPLE_CSV);
  for (const n of gT.nodes) { n.w = U.nodeWidthForName(n.name); n.h = U.nodeHeightFor(n); n.x = 0; n.y = 0; }
  Layout.tierLayout(gT.nodes, { cx: 0, cy: 0 });
  const byName = {};
  for (const n of gT.nodes) byName[n.name] = n;
  ok(byName['核心路由器R1'].y < byName['核心交换机SW1'].y, '三层布局：核心层在汇聚层上方');
  ok(byName['核心交换机SW1'].y < byName['办公PC1'].y, '三层布局：汇聚层在接入层上方');
  const ys = new Set(gT.nodes.map(n => Math.round(n.y)));
  ok(ys.size <= 3, '三层布局最多 3 行（实际 ' + ys.size + '）');
}

console.log('== IP 改段 / 对齐 / 设计报告 ==');
{
  eq(U.renumberIp('192.168.1.5', '192.168.1.0/24', '172.20.1.0/24'), '172.20.1.5', 'IP 改段保留主机位');
  eq(U.renumberIp('192.168.2.9', '192.168.1.0/24', '172.20.1.0/24'), '192.168.2.9', '不在原网段的 IP 不变');
  eq(U.renumberIp('10.0.0.1', '10.0.0.0/24', '10.255.0.0/24'), '10.255.0.1', '管理网段改段');
  ok(U.cidrInfo('bad') === null && U.cidrInfo('1.2.3.4/33') === null, '非法 CIDR 返回 null');
  // 对齐
  const ns = [
    { id: 'a', x: 0, y: 10, w: 100, h: 50 },
    { id: 'b', x: 200, y: 10, w: 120, h: 50 },
    { id: 'c', x: 400, y: 10, w: 80, h: 50 }
  ];
  U.alignNodes(ns, 'left');
  ok(ns.every(n => n.x === 0), '左对齐后 x 相同');
  ns[0].x = 0; ns[1].x = 200; ns[2].x = 400; // 还原初始位置再测等距
  U.alignNodes(ns, 'hdist');
  ok(ns[0].x === 0 && ns[1].x === 190 && ns[2].x === 400, '水平等距（0/190/400，间隔 90）');
  // 设计报告（不含设备配置片段）
  const gR = M.textToGraph(M.SAMPLE_CSV);
  for (const n of gR.nodes) { n.w = U.nodeWidthForName(n.name); n.h = U.nodeHeightFor(n); n.x = 0; n.y = 0; }
  const rep = U.buildReportHtml(gR.nodes, gR.links);
  ok(rep.includes('设备清单') && rep.includes('IP 规划') && rep.includes('子网统计') && rep.includes('链路明细'), '设计报告含核心章节');
  ok(rep.includes('rowspan='), '设计报告 IP 规划设备名列合并（rowspan）');
  ok(!rep.includes('设备配置') && !rep.includes('<pre>'), '设计报告不再附加设备配置内容');
  ok(rep.startsWith('<!DOCTYPE html>') && rep.includes('</html>'), '设计报告为完整 HTML');
}

console.log('== 自定义配置模板 / 对比 / 重命名 ==');
{
  // 自定义模板：占位符替换
  const gT2 = M.textToGraph('源设备,源接口,源IP,目标设备,目标接口,目标IP,带宽,管理地址\n核心路由器R1,GE0/0/1,10.0.0.1,核心交换机SW1,GE1/0/1,10.0.0.2,1000,10.255.0.1\n核心交换机SW1,GE1/0/2,192.168.1.1,办公PC1,eth0,192.168.1.10,,10.255.0.2');
  for (const n of gT2.nodes) { n.w = U.nodeWidthForName(n.name); n.h = U.nodeHeightFor(n); n.x = 0; n.y = 0; }
  const custom = { key: 'h3c', label: 'H3C', comment: '#', deviceHeader: '{comment} {name} ({type})', noIface: '# none', interface: ['interface {iface}', ' ip address {ip} 24', ' description to {peer}'], switchAccess: null, vlanLine: null, route: null };
  const c1 = U.generateConfigs(gT2.nodes, gT2.links, custom);
  ok(c1.includes('interface GE0/0/1') && c1.includes('ip address 10.0.0.1 24') && c1.includes('description to 核心交换机SW1'), '自定义模板按占位符生成');
  // 占位符覆盖核对：{peerIf} {comment} {name} {mask} {bw} 在接口行均可替换
  const cph = U.generateConfigs(gT2.nodes, gT2.links, {
    key: 'ph', label: 'PH', comment: 'C', deviceHeader: '{comment} {name} {mgmt} {type}',
    noIface: 'C none', interface: ['interface {iface}', ' peer={peerIf} mask={mask} bw={bw} c={comment} me={name}'],
    switchAccess: null, vlanLine: null, route: null
  });
  const ph = cph.split('\n');
  ok(ph.some(l => l === ' peer=GE1/0/1 mask=255.255.255.0 bw=1G c=C me=核心路由器R1'), '接口级占位符全部替换（peerIf/mask/bw/comment/name）');
  ok(ph.some(l => l === 'C 核心路由器R1 10.255.0.1 路由器'), '设备级占位符替换（comment/name/mgmt/type）');
  // 未知占位符原样保留
  const cunk = U.generateConfigs(gT2.nodes, gT2.links, { key: 'u', label: 'U', comment: '#', deviceHeader: '{unknown} {name}', noIface: '# n', interface: ['{foo}'], switchAccess: null, vlanLine: null, route: null });
  ok(cunk.includes('{unknown}') && cunk.includes('{foo}'), '未知占位符原样保留不报错');
  // 自定义模板注册表（内置不可覆盖，自定义可读取）
  U.customCfgTemplates = { h3c: Object.assign({}, custom, { label: 'H3C 自定义' }) };
  const c2 = U.generateConfigs(gT2.nodes, gT2.links, 'h3c');
  ok(c2.includes('H3C') === false && c2.includes('ip address 10.0.0.1 24'), '注册的自定义模板可被 key 引用');
  // 静态路由 + VLAN
  const c3 = U.generateConfigs(gT2.nodes, gT2.links, 'huawei', { routes: true, vlan: true });
  ok(c3.includes('ip route-static 192.168.1.0 255.255.255.0 10.0.0.2'), '华为配置含自动推导静态路由（经 SW1 到 192.168.1.0/24）');
  ok((c3.match(/静态路由（自动推导）/g) || []).length === 1, '静态路由仅路由器等生成（交换机/终端不生成）');
  ok(!c3.includes('port link-type access') && !c3.includes('port default vlan'), '未显式配置 VLAN 时不生成 VLAN 命令');
  // VLAN 仅来自显式配置（源二层/源VLAN 字段），不做按网段自动分配
  const gV = M.textToGraph('源设备,源接口,源IP,源掩码,目标设备,目标接口,目标IP,目标掩码,带宽,管理地址,源二层,源VLAN,源VLAN模式,目标二层,目标VLAN,目标VLAN模式\n核心交换机SW1,GE1/0/2,192.168.1.1,24,办公PC1,eth0,192.168.1.10,24,1000,10.255.0.2,是,10,access,是,10,access');
  for (const n of gV.nodes) { n.w = U.nodeWidthForName(n.name); n.h = U.nodeHeightFor(n); n.x = 0; n.y = 0; }
  const cV = U.generateConfigs(gV.nodes, gV.links, 'huawei', { routes: false, vlan: true });
  ok(cV.includes('port link-type access') && cV.includes('port default vlan 10'), '华为交换机接入端口按显式 VLAN 生成');
  ok(cV.includes('vlan 10'), '华为配置含 VLAN 定义');
  // 对比
  const gA = M.textToGraph('源设备,源接口,源IP,目标设备,目标接口,目标IP\nR1,G0,10.0.0.1,SW1,G1,10.0.0.2');
  const gB = M.textToGraph('源设备,源接口,源IP,目标设备,目标接口,目标IP\nR1,G0,10.0.0.1,SW1,G1,10.0.0.2\nR1,G2,10.0.0.9,FW1,G3,10.0.0.10');
  gA.nodes[0].mgmt = '10.255.0.1'; gB.nodes[0].mgmt = '10.255.0.99';
  const d2 = U.diffProjects({ nodes: gA.nodes, links: gA.links }, { nodes: gB.nodes, links: gB.links });
  ok(d2.addedNodes.length === 1 && d2.removedNodes.length === 0, '对比识别新增设备');
  ok(d2.changedNodes.some(c => c.name === 'R1'), '对比识别变更设备（管理地址）');
  ok(d2.addedLinks.length >= 1, '对比识别新增链路');
  // 重命名
  const rn2 = [{ name: 'SW1' }, { name: 'SW2' }, { name: 'FW1' }];
  U.renameNodes(rn2, { mode: 'number', prefix: 'SW-', start: 1, pad: 2 });
  ok(rn2.every(n => /^SW-\d{2}$/.test(n.name)), '批量序号重命名（SW-01/02/03）');
  const rn3 = [{ name: 'X' }, { name: 'Y' }];
  U.renameNodes(rn3, { mode: 'keep', prefix: '核心-', suffix: '-主' });
  ok(rn3[0].name === '核心-X-主' && rn3[1].name === '核心-Y-主', '批量前缀/后缀重命名');
}

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
  {
    const bufN = V2.buildVSDX({ nodes: nodes2, links: links2 }, { showLabels: false });
    const sN = Buffer.from(bufN).toString('latin1');
    ok(!sN.includes('NameU=\'Label') && !sN.includes('Label10002'), 'VSDX showLabels=false 不生成标注文本框');
  }
  {
    const texts = [{ id: 't1', x: 100, y: 80, w: 200, h: 60, text: '核心区说明\n第二行', font: 'Microsoft YaHei', size: 16, color: '#dc2626', bold: true, italic: false, align: 'center', bg: '#fff7ed' }];
    const bufT = V2.buildVSDX({ nodes: nodes2, links: links2, texts }, {});
    const sT = Buffer.from(bufT).toString('utf8'); // 中文需按 UTF-8 解码
    ok(sT.includes('核心区说明') && sT.includes('第二行'), 'VSDX 导出文本框内容（多行）');
    ok(sT.includes('ID=\'50000') && sT.includes("<Cell N='Color' V='#dc2626'") && sT.includes("<Cell N='Style' V='1'") && sT.includes("<Cell N='Para.HorzAlign' V='1'"), 'VSDX 文本框字体样式（颜色/粗体/居中）');
  }
  ok(s.includes("<Cell N='Angle' V='") && s.includes('LineColor'), 'VSDX 连线 Angle/线色（2-D 直线）');
  // 设备保持色块 + 白字（已回退图标替换改动）：内置类型不嵌入图片，默认色块；自定义图片仍嵌入
  {
    const bufN = V2.buildVSDX({ nodes: nodes2, links: links2 }, {});
    const sN = Buffer.from(bufN).toString('latin1');
    ok(sN.includes("N='FillPattern' V='1'") && sN.includes("Color' V='#FFFFFF'"), 'VSDX 设备色块 + 白字');
    ok(!sN.includes('visio/media/') || sN.indexOf('visio/media/') === -1, 'VSDX 内置类型不嵌入图片（无 media 部件）');
    ok(!sN.includes("N='TxtWidth'"), 'VSDX 设备不使用右侧文字框（居中）');
  }
  // 双链路平行偏移：同一对设备的两条连线 PinY 必须不同（与画布显示一致）
  {
    const pinY = [...s.matchAll(/<Cell N='PinY' V='([^']+)'/g)].map(m => parseFloat(m[1]));
    ok(pinY.length >= 4 && Math.abs(pinY[2] - pinY[3]) > 0.05,
      'VSDX 双链路平行偏移（PinY=' + pinY[2] + '/' + pinY[3] + '）');
  }
  ok(s.includes('MoveTo') && s.includes('LineTo'), 'VSDX 连线直线几何（MoveTo/LineTo）');
  ok(s.includes("<Cell N='BeginArrow' V='0'") && s.includes("<Cell N='EndArrow' V='0'"), 'VSDX 连线无箭头');
  ok(!s.includes('_WALKGLUE') && !s.includes('_XFTRIGGER'), 'VSDX 不使用动态连接线公式（2-D 直线渲染更可靠）');
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
      const nameu = (body.match(/NameU='([^']*)'/) || [])[1] || '';
      return { id: +m[1], nameu, px: cell('PinX'), py: cell('PinY'), w: cell('Width'), h: cell('Height') };
    });
    // 只统计连线标注文本框（NameU=Label*）；图例/图片等不属于标注
    const labs = shapes.filter(x => x.nameu.indexOf('Label') === 0);
    const nboxes = shapes.filter(x => x.id < 10000 && x.h > 0.1 && !x.nameu); // exclude Dynamic connector / legend
    let ov = 0;
    for (const a of labs) for (const b of nboxes) {
      if (Math.abs(a.px - b.px) < (a.w + b.w) / 2 && Math.abs(a.py - b.py) < (a.h + b.h) / 2) ov++;
    }
    ok(ov === 0, 'VSDX 标注不压设备（重叠对=' + ov + '）');
  // 自定义类型图片嵌入（media 部件 + ForeignData）
  {
    const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const PNG1x1b = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
    const hadR = U.typeOverrides['router'];
    const hadS = U.typeOverrides['switch'];
    U.typeOverrides['router'] = Object.assign({}, hadR, { img: PNG1x1 });
    U.typeOverrides['switch'] = Object.assign({}, hadS, { img: PNG1x1b });
    const bufI = V2.buildVSDX({ nodes: nodes2, links: links2 }, {});
    const sI = Buffer.from(bufI).toString('latin1');
    ok(sI.includes('visio/media/image1.png') && sI.includes('visio/media/image2.png') && sI.includes('<ForeignData'), 'VSDX 嵌入自定义类型图片（多张）');
    const ctPng = (sI.match(/<Default Extension="png" ContentType="image\/png"\/>/g) || []).length;
    ok(ctPng === 1, 'VSDX Content_Types 中 png Default 仅声明一次（多张同类型图片不重复）');
    ok((sI.match(/Id="rIdImg1"/g) || []).length === 1 && (sI.match(/Id="rIdImg2"/g) || []).length === 1, 'VSDX 两张图片各自有独立关系 ID');
    if (hadR) U.typeOverrides['router'] = hadR; else delete U.typeOverrides['router'];
    if (hadS) U.typeOverrides['switch'] = hadS; else delete U.typeOverrides['switch'];
  }

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
  {
    const svgN = P.buildSvgImage({ nodes: nodes2, links: links2 }, { showLabels: false });
    ok(!svgN.includes('G0') && !svgN.includes('1.1.1.1'), 'PDF showLabels=false 不生成链路标注');
  }
  {
    const svgT = P.buildSvgImage({ nodes: nodes2, links: links2, texts: [{ id: 't1', x: 50, y: 60, w: 200, h: 50, text: '备注说明', font: 'SimHei', size: 18, color: '#0f766e', bold: true, italic: true, align: 'right', bg: '#fef9c3' }] }, {});
    ok(svgT.includes('备注说明') && svgT.includes('font-family="SimHei"') && svgT.includes('font-size="18"') && svgT.includes('font-weight="700"') && svgT.includes('font-style="italic"') && svgT.includes('text-anchor="end"') && svgT.includes('fill="#fef9c3"'), 'PDF/SVG 导出文本框字体样式');
  }
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

console.log('== 力导向布局（原样） / 拓扑分层布局（最少交叉） ==');
{
  const gX = M.textToGraph(M.SAMPLE_CSV);
  for (const n of gX.nodes) { n.w = U.nodeWidthForName(n.name); n.h = U.nodeHeightFor(n); n.x = 0; n.y = 0; }
  Layout.layoutNow(gX.nodes, gX.links, 320); // 纯力导向（不自动套分层）
  ok(gX.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), '力导向布局坐标有效');
  const cForce = U.countCrossings(gX.nodes, gX.links);
  ok(typeof cForce === 'number' && cForce >= 0, '连线交叉计数可用（力导向 ' + cForce + '）');
  // 手动拓扑分层布局：交叉数应不高于力导向，且接近 0
  Layout.layerTopoLayout(gX.nodes, gX.links, {});
  ok(gX.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), '拓扑分层布局坐标有效');
  const cLayered = U.countCrossings(gX.nodes, gX.links);
  ok(cLayered <= cForce && cLayered <= 2, '拓扑分层布局交叉数 ≤ 力导向（' + cForce + ' → ' + cLayered + '）');
  // 大型拓扑
  const gBig = M.textToGraph('源设备,源接口,源IP,目标设备,目标接口,目标IP\n' +
    Array.from({ length: 30 }, (_, i) => `R${i % 5},G0,10.0.0.${i + 1},S${i % 10},G1,10.0.1.${i + 1}`).join('\n'));
  for (const n of gBig.nodes) { n.w = U.nodeWidthForName(n.name); n.h = U.nodeHeightFor(n); n.x = 0; n.y = 0; }
  Layout.layoutNow(gBig.nodes, gBig.links, 200);
  const cfBig = U.countCrossings(gBig.nodes, gBig.links);
  Layout.layerTopoLayout(gBig.nodes, gBig.links, {});
  const clBig = U.countCrossings(gBig.nodes, gBig.links);
  ok(clBig <= cfBig && clBig <= 40, '大拓扑分层布局交叉数不增（' + cfBig + ' → ' + clBig + '，边数 ' + gBig.links.length + '）');
}

console.log('== 性能：复杂拓扑（核心-汇聚-接入-终端 分层网络） ==');
{
  const ms = (fn) => { const s = Date.now(); const r = fn(); return [Date.now() - s, r]; };
  // 生成拓扑：4 核心路由 + 16 汇聚交换 + 64 接入交换 + 320 终端
  const nodes = [];
  const links = [];
  let seq = 0;
  const ip = (base, k) => { const p = base.split('.'); p[3] = String((Number(p[3]) + k) % 250 + 1); return p.join('.'); };
  const addNode = (name, type, mgmt) => { const n = { id: 'n' + (++seq), name, type, mgmt, note: '', x: 0, y: 0, w: 160, h: 56 }; nodes.push(n); return n; };
  const addLink = (a, b, i, sub) => {
    links.push({ id: 'l' + links.length, a: a.id, b: b.id,
      aIf: 'GE0/0/' + (i % 8), aIp: ip(sub, i), bIf: 'GE1/0/' + (i % 8), bIp: ip(sub, i + 1),
      bw: [100, 1000, 10000][i % 3], note: '' });
  };
  const cores = [];
  for (let i = 1; i <= 4; i++) cores.push(addNode('核心路由器R' + i, 'router', '10.255.0.' + i));
  for (let i = 0; i < cores.length; i++) for (let j = i + 1; j < cores.length; j++) addLink(cores[i], cores[j], i * 10 + j, '10.0.0.0');
  const dists = [];
  for (let i = 1; i <= 16; i++) dists.push(addNode('汇聚交换机DS' + i, 'switch', '10.255.0.' + (i + 10)));
  for (let i = 0; i < dists.length; i++) { addLink(dists[i], cores[i % cores.length], i, '10.1.' + i + '.0'); addLink(dists[i], cores[(i + 1) % cores.length], i + 100, '10.1.' + i + '.0'); }
  const accs = [];
  for (let i = 1; i <= 64; i++) accs.push(addNode('接入交换机AS' + i, 'switch', '10.255.0.' + (i + 30)));
  for (let i = 0; i < accs.length; i++) { addLink(accs[i], dists[i % dists.length], i, '10.2.' + i + '.0'); addLink(accs[i], dists[(i + 3) % dists.length], i + 200, '10.2.' + i + '.0'); }
  for (let i = 1; i <= 320; i++) { const pc = addNode('办公PC' + i, 'pc', ''); addLink(pc, accs[(i - 1) % accs.length], i, '192.168.' + ((i - 1) % accs.length) + '.0'); }
  for (const n of nodes) { n.w = U.nodeWidthForName(n.name); n.h = U.nodeHeightFor(n); }
  ok(nodes.length >= 300 && links.length >= 400, '复杂拓扑生成（' + nodes.length + ' 设备 / ' + links.length + ' 链路）');

  let t, r;
  const report = [];
  const measure = (label, fn, minOk, okLabel, budget) => {
    const s = Date.now();
    let val;
    try { val = fn(); } catch (e) { ok(false, label + ' 执行异常：' + e.message); return; }
    const cost = Date.now() - s;
    report.push(label + ' ' + cost + 'ms');
    ok(minOk(val), label + ' 结果有效（' + cost + 'ms）');
    if (budget != null) ok(cost < budget, label + ' 耗时 < ' + budget + 'ms（实际 ' + cost + 'ms）');
  };

  measure('子网分组', () => U.subnetGroups(nodes, links, {}), (v) => Array.isArray(v) && v.length >= 60, null, 5000);
  measure('拓扑校验', () => M.validateTopology(nodes, links), (v) => Array.isArray(v), null, 10000);
  measure('路径分析(最宽路径)', () => U.bestPath(nodes, links, nodes[0].id, nodes[nodes.length - 1].id), (v) => v && v.nodeIds.length >= 5, null, 3000);
  measure('IP 规划', () => U.ipPlan(nodes, links), (v) => v && v.rows.length >= 900, null, 5000);
  measure('配置生成(路由+VLAN)', () => U.generateConfigs(nodes, links, 'huawei', { routes: true, vlan: true }), (v) => typeof v === 'string' && v.length > 10000, null, 5000);
  measure('连线几何', () => U.linkGeom(nodes, links), (v) => !!v && !!v[links[0].id], null, 5000);
  measure('力导向布局(80步)', () => Layout.layoutNow(nodes, links, 80), (v) => nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)), null, 12000);
  measure('VSDX 导出', () => sandbox.TopoVsdx.buildVSDX({ nodes, links }, {}), (v) => v instanceof Uint8Array && v.length > 100000, null, 6000);
  measure('PDF/SVG 导出', () => sandbox.TopoPdf.buildSvgImage({ nodes, links }, {}), (v) => typeof v === 'string' && v.includes('</svg>'), null, 6000);

  console.log('性能耗时明细：' + report.join(' | '));
}

console.log('== 回归：大图布局钳制（>2500 节点跳过 O(n²) 斥力/碰撞分离） ==');
{
  // 10000 节点：修复前单步斥力约 5000 万次运算会明显卡顿；修复后 O(n)，单步应在毫秒级
  const big = [];
  for (let i = 0; i < 10000; i++) big.push({ id: 'n' + i, name: 'N' + i, x: 0, y: 0, w: 60, h: 40 });
  const sim = Layout.simulate(big, [], { steps: 10 });
  ok(!!sim, '大图 simulate 正常创建');
  const t0 = Date.now();
  let e = 0;
  for (let k = 0; k < 10; k++) e = sim.step();
  const dt = Date.now() - t0;
  ok(Number.isFinite(e) && dt < 500, '大图单步 10 次 < 500ms（实际 ' + dt + 'ms，跳过 O(n²) 斥力）');
  // 常规小图不受影响：布局仍正常收敛
  const small = [
    { id: 'n1', name: 'A', x: 0, y: 0, w: 60, h: 40 },
    { id: 'n2', name: 'B', x: 0, y: 0, w: 60, h: 40 },
    { id: 'n3', name: 'C', x: 0, y: 0, w: 60, h: 40 }
  ];
  const sim2 = Layout.simulate(small, [{ id: 'l1', a: 'n1', b: 'n2' }], { steps: 50 });
  const p0 = sim2.step();
  ok(Number.isFinite(p0), '小图步进正常');
}

console.log('== 打包配置 ==');
{
  const yml = fs.readFileSync(path.join(root, 'build', 'electron-builder.yml'), 'utf8');
  ok(yml.includes('- preload.js'), 'electron-builder 打包清单包含 preload.js（Web Shell IPC 桥）');
  ok(yml.includes('- js/**/*'), 'electron-builder 打包清单包含 js/**/*');
}

console.log('== 备份管理（本地备份库） ==');
{
  const os = require('os');
  const { BackupStore } = require(path.join(root, 'js', 'backup-store.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-bk-'));
  const B = new BackupStore(tmp);
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } };

  ok(BackupStore.validName('自动备份_20260813_151020.nettopo'), '文件名白名单：合法中文名');
  ok(BackupStore.validName('备份_20260813_151020_1.nettopo'), '文件名白名单：同秒序号后缀');
  ok(BackupStore.validName('a-b_c.d.nettopo'), '文件名白名单：英文点横线');
  ok(!BackupStore.validName('../evil.nettopo'), '文件名白名单：拒绝 ../ 路径穿越');
  ok(!BackupStore.validName('..\\evil.nettopo'), '文件名白名单：拒绝 ..\\ 路径穿越');
  ok(!BackupStore.validName('a/b.nettopo'), '文件名白名单：拒绝正斜杠');
  ok(!BackupStore.validName('a\\b.nettopo'), '文件名白名单：拒绝反斜杠');
  ok(!BackupStore.validName('a..b.nettopo'), '文件名白名单：拒绝连续点');
  ok(!BackupStore.validName('x.txt'), '文件名白名单：拒绝非 .nettopo');
  ok(!BackupStore.validName(''), '文件名白名单：拒绝空名');
  ok(!BackupStore.validName('NUL.nettopo'), '文件名白名单：拒绝 Windows 设备名 NUL');
  ok(!BackupStore.validName('CON.nettopo'), '文件名白名单：拒绝 Windows 设备名 CON');
  ok(!BackupStore.validName('COM1.nettopo'), '文件名白名单：拒绝 Windows 设备名 COM1');

  ok(!B.save('', 'manual', 30).ok, '空内容拒绝保存');
  ok(!B.save('   ', 'manual', 30).ok, '空白内容拒绝保存');
  const small = new BackupStore(tmp + '-small', { maxBytes: 64 });
  ok(!small.save('x'.repeat(100), 'manual', 30).ok, '超限内容拒绝保存');

  const r1 = B.save('{"a":1}', 'auto', 30);
  ok(r1.ok && /^自动备份_\d{8}_\d{6}\.nettopo$/.test(r1.name), '自动备份文件名格式（label=auto）');
  ok(r1.count === 1, '保存后返回当前份数');
  const r2 = B.save('{"a":2}', 'manual', 30);
  ok(r2.ok && /^备份_\d{8}_\d{6}\.nettopo$/.test(r2.name), '手动备份文件名格式（label=manual）');
  const r2b = B.save('{"a":2b}', 'manual', 30);
  ok(r2b.ok && r2b.name !== r2.name, '同秒多次备份自动追加序号不覆盖');

  const list = B.list();
  ok(list.ok && list.items.length === 3, '列表返回全部 3 份');
  ok(list.items[0].time >= list.items[list.items.length - 1].time, '列表按时间倒序');
  ok(list.items.every(it => typeof it.size === 'number' && it.size > 0), '列表包含文件大小');
  ok(B.read(r1.name).content === '{"a":1}', '读取备份内容一致');
  ok(!B.read('../x.nettopo').ok, '读取拒绝路径穿越');
  ok(!B.read('missing.nettopo').ok, '读取不存在的备份报错');

  // 轮转保留：写入 5 份，keep=3 仅保留最新 3 份
  for (let i = 0; i < 5; i++) B.save('{"i":' + i + '}', 'manual', 3);
  const l5 = B.list();
  ok(l5.items.length === 3, '保留份数裁剪到 3');
  ok(l5.items.every(it => /^备份_/.test(it.name)), '裁剪后保留最新 3 份');
  ok(!B.read('备份_19700101_000000.nettopo').ok, '最旧备份已被裁剪删除');

  // 无效 keep 回退默认 30
  const rk = B.save('{"k":1}', 'manual', 0);
  ok(rk.ok, 'keep=0 时按默认 30 保存');

  // 删除
  ok(B.remove(l5.items[0].name).ok, '删除单份备份');
  ok(!B.remove(l5.items[0].name).ok, '重复删除报错');
  ok(!B.remove('../x.nettopo').ok, '删除拒绝路径穿越');
  const cntBeforeClear = B.list().items.length;
  ok(cntBeforeClear === 3, '清空前应有 3 份（裁剪 3 + 手动 1 - 删除 1）');
  const ra = B.removeAll();
  ok(ra.ok && ra.removed === cntBeforeClear, '清空全部备份（' + cntBeforeClear + ' 份）');
  ok(B.list().items.length === 0, '清空后列表为空');

  // 目录中存在无关文件时不受影响
  fs.writeFileSync(path.join(tmp, 'random.txt'), 'x');
  fs.mkdirSync(path.join(tmp, 'subdir'));
  B.save('{"x":1}', 'manual', 30);
  ok(B.list().items.length === 1, '列表忽略无关文件与子目录');
  const ra2 = B.removeAll();
  ok(ra2.ok && ra2.removed === 1, '清空仅删除 .nettopo 备份');
  ok(fs.existsSync(path.join(tmp, 'random.txt')), '清空不误删无关文件');

  cleanup();
  try { fs.rmSync(tmp + '-small', { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/* ================= 回归测试（代码审查修复项） ================= */
console.log('== 回归：normalizeBw 锚定 ==');
{
  ok(U.normalizeBw('21gbps') === 21000, "normalizeBw('21gbps')=21000（未被 '1gbps' 分支误命中）");
  ok(U.normalizeBw('x100gbps') === '', "normalizeBw('x100gbps')=''（未锚定分支不误匹配）");
  ok(U.normalizeBw('100gbps') === 100000 && U.normalizeBw('1000m') === 1000 && U.normalizeBw('100m') === 100 && U.normalizeBw('10m') === 10, '锚定后常规取值不变');
}

console.log('== 回归：normalizeWebUrl host:port ==');
{
  ok(U.normalizeWebUrl('example.com:8080') === 'http://example.com:8080', '域名:端口 视为主机+端口');
  ok(U.normalizeWebUrl('10.0.0.1:8080/path') === 'http://10.0.0.1:8080/path', 'IP:端口/路径 保留');
  ok(U.normalizeWebUrl('javascript:alert(1)') === null && U.normalizeWebUrl('file:///C:/x') === null && U.normalizeWebUrl('ftp://x') === null, '危险/非 http(s) 协议仍拒绝');
}

console.log('== 回归：addCustomType 键唯一 ==');
{
  const prev = U.customTypes.slice();
  try {
    U.customTypes = [{ key: 'ct1', label: 'A' }, { key: 'ct2', label: 'B' }, { key: 'ct3', label: 'C' }];
    U.removeCustomType('ct2'); // 删除中间类型后新增，旧实现会复用 ct3
    const t = U.addCustomType('新类型', '');
    ok(U.customTypes.filter(x => x.key === t.key).length === 1, '删除中间类型后新增 key 不冲突（' + t.key + '）');
  } finally {
    U.customTypes = prev;
  }
}

console.log('== 回归：导出标注防碰撞（pdf.js 障碍物坐标） ==');
{
  // 节点 n3 位于链路 n1-n2 中点上方：标注初始位置会压到 n3 上半部分。
  // 修复前障碍物取了节点底边（SVG 坐标下整体下移一个节点高度），标注不被推开；修复后必须推出 n3 范围。
  const nodes = [
    { id: 'n1', name: 'R1', type: 'router', x: 0, y: 100, w: 160, h: 56 },
    { id: 'n2', name: 'SW1', type: 'switch', x: 300, y: 100, w: 160, h: 56 },
    { id: 'n3', name: 'FW1', type: 'firewall', x: 70, y: 30, w: 160, h: 56 }
  ];
  const links = [
    { id: 'l1', a: 'n1', b: 'n2', aIf: 'GE0/0/1', aIp: '10.0.0.1', bIf: 'GE1/0/1', bIp: '10.0.0.2', bw: '1000' }
  ];
  const svg = sandbox.TopoPdf.buildSvgImage({ nodes, links, texts: [] }, { showLabels: true });
  // 节点 n3 在导出 SVG 中的 y 范围：Y(30)=60 ~ Y(30)+56=116（buildSvgImage 的 minY=30、M=60）
  const re = /<text x="[\d.]+" y="([\d.]+)"[^>]*font-size="13"[^>]*>(GE0\/0\/1|GE1\/0\/1)[^<]*<\/text>/g;
  const ys = [];
  let m;
  while ((m = re.exec(svg)) !== null) ys.push(parseFloat(m[1]));
  ok(ys.length >= 1, '导出的 SVG 包含链路标注');
  const inside = ys.filter(y => y > 56 && y < 120);
  ok(inside.length === 0, '标注不落在节点 n3 范围内（标注 y=' + ys.join('/') + '，n3 范围 60~116）');
}

console.log('== Web Shell（SSH/Telnet 会话） ==');

(async () => {
  const net = require('net');
  const fs = require('fs');
  const { ShellManager } = require(path.join(root, 'js', 'shell.js'));
  const waitFor = (cond, ms) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('waitFor 超时')); }
    }, 10);
  });

  // 参数校验
  {
    const mgr = new ShellManager();
    const r0 = mgr.connect({});
    ok(r0 && r0.ok === false, 'Shell 空主机拒绝连接');
    const r1 = mgr.connect({ host: '1.2.3.4', protocol: 'ftp' });
    ok(r1 && r1.ok === false, 'Shell 不支持的协议拒绝连接');
    const r2 = mgr.connect({ host: '127.0.0.1', protocol: 'ssh', port: 1 });
    ok(r2 && r2.ok === true && /^s\d+$/.test(r2.id), 'Shell 发起连接返回会话 ID');
    mgr.close(r2.id);
  }

  // Telnet：连接超时（服务器接受但无任何响应）
  {
    const idleSocks = new Set();
    const idle = net.createServer((sock) => {
      idleSocks.add(sock);
      sock.on('close', () => idleSocks.delete(sock));
      sock.on('error', () => {});
    });
    await new Promise((res) => idle.listen(0, '127.0.0.1', res));
    const port = idle.address().port;
    const mgr = new ShellManager();
    const statuses = [];
    mgr.on('status', (id, info) => statuses.push(info));
    const r = mgr.connect({ protocol: 'telnet', host: '127.0.0.1', port, timeout: 300 });
    const ended = new Promise((res) => mgr.on('end', (id, reason) => res(reason)));
    const reason = await Promise.race([ended, new Promise((res) => setTimeout(() => res('__NOT_FIRED__'), 3000))]);
    ok(String(reason).includes('连接超时'), 'Telnet 无响应触发连接超时（' + reason + '）');
    ok(statuses.some(s => s.state === 'error' && s.text.includes('连接超时')), 'Telnet 超时上报 error 状态');
    for (const s of idleSocks) s.destroy();
    await Promise.race([
      new Promise((res) => idle.close(res)),
      new Promise((res) => setTimeout(res, 1000))
    ]);
  }

  // Telnet：跨包多字节 UTF-8 不产生乱码
  {
    const unicodeSocks = new Set();
    const unicode = net.createServer((sock) => {
      unicodeSocks.add(sock);
      sock.on('close', () => unicodeSocks.delete(sock));
      sock.on('error', () => {});
      const b = Buffer.from('中文OK\r\n', 'utf8');
      sock.write(b.slice(0, 1)); // 拆开第一个多字节字符
      setTimeout(() => sock.write(b.slice(1)), 60);
    });
    await new Promise((res) => unicode.listen(0, '127.0.0.1', res));
    const port = unicode.address().port;
    const mgr = new ShellManager();
    const outs = [];
    mgr.on('output', (id, d) => outs.push(d));
    const r = mgr.connect({ protocol: 'telnet', host: '127.0.0.1', port, timeout: 3000 });
    await waitFor(() => outs.join('').includes('OK'), 3000);
    ok(outs.join('').includes('中文OK'), 'Telnet 跨包多字节 UTF-8 正常（' + JSON.stringify(outs.join('')) + '）');
    ok(!outs.join('').includes('\uFFFD'), 'Telnet 输出无替换符');
    mgr.close(r.id);
    for (const s of unicodeSocks) s.destroy();
    await Promise.race([
      new Promise((res) => unicode.close(res)),
      new Promise((res) => setTimeout(res, 1000))
    ]);
  }

  // Telnet：本地模拟服务器（RFC854 协商 + NAWS）
  {
    const serverData = [];
    const server = net.createServer((sock) => {
      sock.on('data', (d) => serverData.push(d));
      sock.write(Buffer.from([255, 251, 1, 255, 251, 3])); // WILL ECHO / WILL SGA
      sock.write('\r\nWelcome to mock telnet\r\n> ');
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    const mgr = new ShellManager();
    const outs = [];
    mgr.on('output', (id, d) => outs.push(d));
    const r = mgr.connect({ protocol: 'telnet', host: '127.0.0.1', port, cols: 80, rows: 24 });
    ok(r.ok, 'Telnet 发起连接成功');
    await waitFor(() => outs.join('').includes('Welcome to mock telnet'), 3000);
    const allOut = outs.join('');
    ok(allOut.includes('Welcome to mock telnet'), 'Telnet 输出剔除 IAC 协商字节');
    ok(!/[\uFFFD]/.test(allOut), 'Telnet 输出无乱码替换符');
    await waitFor(() => serverData.some(b => b.includes(Buffer.from([255, 253, 1]))), 3000);
    ok(serverData.some(b => b.includes(Buffer.from([255, 253, 1]))), 'Telnet 客户端请求服务器回显（DO ECHO）');
    ok(serverData.some(b => b.includes(Buffer.from([255, 251, 3]))), 'Telnet 客户端启用 SGA（WILL SGA）');
    mgr.write(r.id, 'show version\r\n');
    await waitFor(() => serverData.some(b => b.toString('latin1').includes('show version')), 3000);
    ok(serverData.some(b => b.toString('latin1').includes('show version')), 'Telnet 输入转发到服务器');
    mgr.resize(r.id, 100, 30);
    await waitFor(() => serverData.some(b => b.includes(Buffer.from([255, 250, 31, 0, 100, 0, 30, 255, 240]))), 3000);
    ok(serverData.some(b => b.includes(Buffer.from([255, 250, 31, 0, 100, 0, 30, 255, 240]))), 'Telnet 发送窗口尺寸 NAWS');
    const endedT = new Promise((res) => mgr.on('end', (id) => res(id)));
    mgr.close(r.id);
    await endedT;
    ok(true, 'Telnet 关闭会话触发 end');
    await new Promise((res) => server.close(res));
  }

  // SSH：本地模拟服务器（ssh2 自带测试主机密钥）
  {
    const { Server } = require('ssh2');
    const hostKey = fs.readFileSync(path.join(root, 'node_modules', 'ssh2', 'test', 'fixtures', 'ssh_host_rsa_key'));
    const got = [];
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('error', () => {}); // 客户端中途断连/握手失败时避免未处理 error
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === 'admin' && ctx.password === 'secret') ctx.accept();
        else ctx.reject();
      }).on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (a, r, info) => a());
          session.on('window-change', (a, r, info) => { if (info) got.push(['resize', info.cols, info.rows]); a && a(); });
          session.on('shell', (accept2) => {
            const stream = accept2();
            stream.write('SSH-READY\r\n');
            stream.on('data', (d) => got.push(['data', d.toString()]));
            stream.on('close', () => stream.end());
          });
        });
      });
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const port = server.address().port;
    const mgr = new ShellManager();
    const outs = [];
    const statuses = [];
    mgr.on('output', (id, d) => outs.push(d));
    mgr.on('status', (id, info) => statuses.push(info));
    const r = mgr.connect({ protocol: 'ssh', host: '127.0.0.1', port, username: 'admin', password: 'secret', cols: 80, rows: 24 });
    ok(r.ok, 'SSH 发起连接成功');
    // 首次连接：先上报指纹确认（TOFU），未确认前不建立会话
    await waitFor(() => statuses.some(s => s.state === 'fingerprint'), 5000);
    const fpStatus = statuses.find(s => s.state === 'fingerprint');
    ok(!!fpStatus, 'SSH 首次连接上报指纹确认');
    ok(fpStatus && /^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(fpStatus.fp), 'SSH 指纹为标准 SHA256:base64 格式（' + (fpStatus && fpStatus.fp) + '）');
    ok(!outs.join('').includes('SSH-READY'), '确认前不建立会话');
    ok(mgr.trustFingerprint('127.0.0.1', true), '信任指纹放行握手');
    await waitFor(() => outs.join('').includes('SSH-READY'), 5000);
    ok(outs.join('').includes('SSH-READY'), 'SSH 打开远程 Shell 并收到欢迎信息');
    // 已信任主机再次连接：直接通过并展示指纹（不再弹确认）
    {
      const mgr2 = new ShellManager();
      const outs2 = [];
      const statuses2 = [];
      mgr2.on('output', (id, d) => outs2.push(d));
      mgr2.on('status', (id, info) => statuses2.push(info));
      const r2 = mgr2.connect({ protocol: 'ssh', host: '127.0.0.1', port, username: 'admin', password: 'secret', cols: 80, rows: 24, expectFp: fpStatus.fp });
      await waitFor(() => outs2.join('').includes('SSH-READY'), 5000);
      ok(outs2.join('').includes('SSH-READY'), '已信任指纹直接建立会话');
      ok(!statuses2.some(s => s.state === 'fingerprint'), '已信任主机不再弹指纹确认');
      ok(statuses2.some(s => s.state === 'info' && s.text.includes('指纹')), '已信任主机展示主机密钥指纹');
      mgr2.close(r2.id);
    }
    mgr.write(r.id, 'ping\r\n');
    await waitFor(() => got.some(g => g[0] === 'data' && g[1].includes('ping')), 3000);
    ok(got.some(g => g[0] === 'data' && g[1].includes('ping')), 'SSH 输入转发到服务器');
    mgr.resize(r.id, 120, 40);
    await waitFor(() => got.some(g => g[0] === 'resize' && g[1] === 120 && g[2] === 40), 3000);
    ok(got.some(g => g[0] === 'resize' && g[1] === 120 && g[2] === 40), 'SSH 窗口尺寸同步（resize）');
    // 指纹校验：期望指纹不匹配时拒绝连接
    {
      const mgrBad = new ShellManager();
      const badStatus = [];
      mgrBad.on('status', (id, info) => badStatus.push(info));
      const rb = mgrBad.connect({ protocol: 'ssh', host: '127.0.0.1', port, username: 'admin', password: 'secret', expectFp: '00:11:22:33' });
      await waitFor(() => badStatus.some(s => s.state === 'error' && s.text.includes('不匹配')), 5000);
      ok(badStatus.some(s => s.state === 'error' && s.text.includes('不匹配')), 'SSH 指纹不匹配时拒绝连接');
      mgrBad.close(rb.id);
    }
    const endedS = new Promise((res) => mgr.on('end', (id) => res(id)));
    mgr.close(r.id);
    await endedS;
    ok(true, 'SSH 关闭会话触发 end');
    await new Promise((res) => server.close(res));
  }

  /* ---- 监控模块（monitor.js）单元测试 ---- */
  {
    const { MonitorManager, sanitizeFilename } = require(path.join(root, 'js', 'monitor.js'));
    // 0) sanitizeFilename 路径穿越回归（R3 修复：正则曾写成 "/字符类" 永不匹配）
    eq(sanitizeFilename('..\\..\\escape'), '____escape', 'sanitizeFilename 剔除 ..（防路径穿越）');
    eq(sanitizeFilename('a/b'), 'a_b', 'sanitizeFilename 剔除斜杠');
    eq(sanitizeFilename('my:device'), 'my_device', 'sanitizeFilename 剔除冒号');
    eq(sanitizeFilename('ok-name'), 'ok-name', 'sanitizeFilename 正常名不变');
    eq(sanitizeFilename('R1.core'), 'R1.core', 'sanitizeFilename 保留单点');
    eq(sanitizeFilename('abc.'), 'abc', 'sanitizeFilename 剔除尾点');
    eq(sanitizeFilename(''), 'device', 'sanitizeFilename 空值兜底');
    const tmpBase = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nettopo-mon-test-'));
    const stubShell = { on() {}, connect() { return { ok: true, id: 's1' }; }, close() {}, trustFingerprint() { return true; } };
    const mgr = new MonitorManager(stubShell, tmpBase, null, {});
    // 1) expectFp 透传：渲染层复用 Web Shell 已信任指纹时严格比对，不能丢弃
    const v1 = mgr._validate({ key: 'n1@10.0.0.1', host: '10.0.0.1', commands: ['show version'], expectFp: 'SHA256:abc==' });
    eq(v1.ok, true, '监控参数校验通过');
    eq(v1.cfg.expectFp, 'SHA256:abc==', 'expectFp 透传（不丢失）');
    // 2) 告警正则：嵌套量词模式启发式拒绝（主进程同步执行防灾难性回溯）
    const v2 = mgr._validate({ key: 'n2@10.0.0.2', host: '10.0.0.2', commands: ['x'], alerts: ['(a+)+', 'error|down'] });
    eq(v2.ok, true, '含被拒正则时任务仍可启动');
    eq(v2.cfg.alerts.length, 1, '嵌套量词模式 (a+)+ 被启发式拒绝');
    eq(v2.cfg.alerts[0].pattern, 'error|down', '正常正则保留');
    // 3) 超长无换行输出强制断行（lineBuf 上限，防主进程内存无界增长）
    const job = mgr._newJob(v1.cfg);
    job.logStream = { bytesWritten: 0, write() {} };
    mgr.jobs.set(job.key, job);
    mgr._bySid.set('s1', job.key);
    mgr._onOutput('s1', 'x'.repeat(300 * 1024));
    ok(job.lineBuf.length <= 256 * 1024, '无换行超长输出被强制断行（lineBuf 不超限，实际 ' + job.lineBuf.length + '）');
    // 4) 首连指纹自动信任并发出 trust 事件（主进程据此弹系统通知）
    let trustEvt = null;
    mgr.on('trust', (i) => { trustEvt = i; });
    mgr._handleFingerprint(job, { fp: 'SHA256:test' });
    ok(trustEvt && trustEvt.fp === 'SHA256:test' && trustEvt.host === '10.0.0.1', '首连信任触发 trust 事件');
    eq(mgr.trusted.get('10.0.0.1'), 'SHA256:test', '指纹已记录');
    // 5) 指纹变化拒绝连接且不篡改已信任记录
    let errEvt = null;
    mgr.on('status', (i) => { if (i.state === 'error') errEvt = i; });
    mgr._handleFingerprint(job, { fp: 'SHA256:other' });
    ok(errEvt && errEvt.text.indexOf('中间人') >= 0, '指纹变化拒绝连接（疑似中间人）');
    eq(mgr.trusted.get('10.0.0.1'), 'SHA256:test', '已信任指纹不被篡改');
    // 6) 会话就绪门槛（回归：首条命令打在设备 banner/登录期会被吞，必须先等提示符）
    //    _onOutput 收提示符行（<SW1>/[SW1]/R1#/Huawei> 等）后才置 _ready
    {
      const job2 = mgr._newJob(v1.cfg);
      job2.logStream = { bytesWritten: 0, write() {} };
      mgr.jobs.set(job2.key, job2); mgr._bySid.set('s1', job2.key);
      eq(job2._ready, false, '新任务初始未就绪');
      mgr._onOutput('s1', 'Device init...\r\n<SW1>\r\n');
      ok(job2._ready === true, '收到提示符行后会话就绪（banner 期间输出不影响）');
      const job3 = mgr._newJob(v1.cfg);
      job3.logStream = { bytesWritten: 0, write() {} };
      mgr.jobs.set(job3.key, job3); mgr._bySid.set('s1', job3.key);
      mgr._onOutput('s1', 'Info: config...\r\nsysname SW1\r\n');
      eq(job3._ready, false, '无提示符行（仅正文）不触发就绪');
      // 提示符形态覆盖：华为用户/系统视图 + 思科风格 + H3C。
      const promptShapes = ['<SW1>', '<SW1> ', '[SW1]', 'R1>', 'R1#', 'Huawei>', '[H3C-GigabitEthernet0/0/0]'];
      let pShapeOk = true;
      for (const p of promptShapes) {
        const j = mgr._newJob(v1.cfg); j.logStream = { bytesWritten: 0, write() {} };
        j.key = 'pshape' + promptShapes.indexOf(p);
        mgr.jobs.set(j.key, j); mgr._bySid.set('s1', j.key);
        mgr._onOutput('s1', p + '\r\n');
        if (j._ready !== true) { pShapeOk = false; console.log('  提示符未识别: ' + JSON.stringify(p)); }
      }
      ok(pShapeOk, '常见厂商提示符全部识别为就绪');
      // 冒烟暴露的两类漏判（R4 修复）：提示符粘连协商残渣/回显、裸提示符（如思科 SSH 的 "> "）
      {
        const j5 = mgr._newJob(v1.cfg); j5.logStream = { bytesWritten: 0, write() {} };
        j5.key = 'promptdirty'; mgr.jobs.set(j5.key, j5); mgr._bySid.set('s1', j5.key);
        mgr._onOutput('s1', 'R1> \uFFFD..x(\r\n');
        eq(j5._ready, true, '提示符粘连协商残渣（R1> <FFFD>..x(）仍判就绪');
        const j6 = mgr._newJob(v1.cfg); j6.logStream = { bytesWritten: 0, write() {} };
        j6.key = 'promptbare'; mgr.jobs.set(j6.key, j6); mgr._bySid.set('s1', j6.key);
        mgr._onOutput('s1', 'SSH-READY\r\n> '); // 裸提示符无换行结尾：残留在 lineBuf
        const t6 = Date.now();
        const got6 = await mgr._waitReady(j6, j6.gen, 2000);
        ok(got6 === true && (Date.now() - t6) < 1500, 'lineBuf 残段中的裸提示符（> ）判就绪（不等满超时）');
      }
      // _waitReady 超时兜底：设备长时间无提示符也不阻塞
      {
        const j4 = mgr._newJob(v1.cfg); j4.logStream = { bytesWritten: 0, write() {} };
        const t0 = Date.now();
        const gotReady = await mgr._waitReady(j4, j4.gen, 300);
        ok(gotReady === false && (Date.now() - t0) < 3000, '就绪等待超时返回且不长时间阻塞');
      }
    }
    // 7) cleanBackupLines：系统视图提示符（[SW1]）/ Telnet 协商残渣粘连行（<SW1>\uFFFD..x(）必须剔除
    {
      const { cleanBackupLines } = require(path.join(root, 'js', 'monitor.js'));
      const cmds2 = ['screen-length 0 temporary', 'display current-configuration'];
      const got = cleanBackupLines([
        '[SW1]',                                       // 系统视图提示符（旧正则漏剔）
        '<SW1>\uFFFD\u0001\u0003\u001f\u0000x\u0000(',  // 提示符+协商残渣粘连（own 连接空行探测常见）
        '[SW1]screen-length 0 temporary',              // 首条命令回显（带提示符前缀）
        '<SW1>display current-configuration',          // 次条命令回显
        '#',
        'sysname SW1',
        'return'
      ], cmds2);
      ok(!got.includes('[SW1]') && !got.some(l => l.indexOf('\uFFFD') >= 0) && !got.some(l => l.indexOf('x(') >= 0),
        '提示符粘连行被剔除');
      ok(!got.some(l => l.includes('screen-length 0 temporary') || l.includes('display current-configuration')),
        '两条命令回显全部剔除（首条+次条）');
      ok(got.includes('sysname SW1') && got.includes('return'), '命令真实输出保留');
    }
    // 8) cleanBackupLines：命令回显折行/分片残片（一条命令显示成很多行）剔除
    {
      const { cleanBackupLines } = require(path.join(root, 'js', 'monitor.js'));
      const cmds3 = ['screen-length 0 temporary', 'display current-configuration'];
      const got = cleanBackupLines([
        '<SW1>display current-configur',  // 折行首片（含提示符）
        'ation',                          // 折行尾片
        'lay current-configuration',      // 重打分片（无提示符前缀）
        '#',
        'sysname SW1',
        'return'
      ], cmds3);
      ok(got.length >= 2 && got.includes('sysname SW1') && got.includes('return'),
        '命令折行/分片残片全部剔除，真实输出保留（' + JSON.stringify(got) + '）');
      ok(!got.some(l => l.trim() === 'ation' || l.trim() === 'lay current-configuration' || l.trim() === 'current-configur'),
        '命令碎片不再漏入备份');
    }

    /* ================= 回归（R4 审查修复项·第二批） ================= */
    console.log('== 回归：isValidImg 收紧与节点图标口径统一（R4/F-2②③） ==');
    {
      ok(U.isValidImg('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), '常规 PNG dataURL 通过');
      ok(U.isValidImg('data:image/JPEG;base64,/9j/4AAQ'), 'MIME 大小写不敏感');
      ok(!U.isValidImg('data:image/png;base64,QUFB" onerror="alert(1)'), '载荷体含引号等非法字符被拒（前缀穿透封死）');
      ok(!U.isValidImg('data:image/svg+xml;base64,PHN2Zy8+'), '类型图片不接受 svg（类型面走 innerHTML img）');
      ok(!U.isValidImg('data:image/png;base64,' + 'A'.repeat(1600 * 1024)), '超过长度上限拒绝');
      const g5 = U.sanitizeGraph([
        { id: 'n1', name: 'R1', type: 'router', x: 0, y: 0, icon: 'data:image/svg+xml;base64,PHN2Zy8+' },
        { id: 'n2', name: 'SW', type: 'switch', x: 0, y: 0, icon: 'data:image/png;base64,QUFB' },
        { id: 'n3', name: 'FW', type: 'firewall', x: 0, y: 0, icon: 'data:image/svg+xml;base64,QUFB" onload="x' },
        { id: 'n4', name: 'PC', type: 'pc', x: 0, y: 0, icon: 'server' }
      ], [], []);
      const ic = Object.fromEntries(g5.nodes.map(n => [n.id, n.icon]));
      ok(ic.n1 === 'data:image/svg+xml;base64,PHN2Zy8+', '节点图标 svg dataURL 保留（渲染走 image/href 安全上下文）');
      ok(ic.n2 === 'data:image/png;base64,QUFB', '节点图标 png dataURL 保留');
      ok(ic.n3 === '', '节点图标载荷含引号清除（与 isValidImg 同一口径）');
      ok(ic.n4 === 'server', '内置图标 key 保留');
    }

    console.log('== 回归：删除错误如实上报（R4/L-8） ==');
    {
      const os = require('os');
      const { BackupStore } = require(path.join(root, 'js', 'backup-store.js'));
      const dir8 = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-rm8-'));
      const store8 = new BackupStore(dir8);
      store8.save('A', 'manual'); store8.save('B', 'manual');
      const missing = store8.remove('备份_20990101_000000.nettopo');
      ok(missing.ok === false && /不存在/.test(missing.error), '删除不存在备份仍报「不存在」');
      const rma = store8.removeAll();
      ok(rma.ok === true && rma.removed === 2 && Array.isArray(rma.failed) && rma.failed.length === 0,
        'removeAll 成功路径返回 failed 明细数组（新增形状向后兼容）');
      fs.rmSync(dir8, { recursive: true, force: true });
    }
    {
      // 确定性失败模拟：合法备份名处放同位名目录 → unlink 必失败（Linux EISDIR / Windows EPERM），
      // 断言错误如实携带码值而非谎报「不存在」
      const os = require('os');
      const dir9 = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-bk9-'));
      fs.mkdirSync(path.join(dir9, '备份_20990101_000000.nettopo'));
      const { BackupStore } = require(path.join(root, 'js', 'backup-store.js'));
      const store9 = new BackupStore(dir9);
      const rr = store9.remove('备份_20990101_000000.nettopo');
      ok(rr.ok === false && !/不存在/.test(rr.error), '删除失败的错误如实上报而非「不存在」（' + rr.error + '）');
      fs.rmSync(dir9, { recursive: true, force: true });
    }

    /* ================= 回归（R4 审查修复项） ================= */
    console.log('== 回归：config-backup 目录穿越（R4/F-1） ==');
    {
      const os = require('os');
      const cbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-cb-'));
      const { ConfigBackupStore } = require(path.join(root, 'js', 'config-backup.js'));
      const store = new ConfigBackupStore(cbDir);
      const rs = store.save('..', '..', 'sysname SW1\nreturn');
      ok(rs.ok === true, '.. 作为 device/host 仍可正常保存（不被误拒）');
      const written = path.join(cbDir, '_', '_', rs.name || '#');
      ok(fs.existsSync(written), '备份落在库内清洗后的占位目录 _/_（含 monitor.js 同款 ".." 剔除）');
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
        .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.basename(e.name)]);
      const inLib = walk(cbDir).filter(n => /^cfg_\d{8}_\d{6}(_\d+)?\.cfg$/.test(n));
      ok(inLib.length === 1, '整库仅此一份备份，无库外落盘（旧实现会把 cfg 文件写到临时目录上级）');
      fs.rmSync(cbDir, { recursive: true, force: true });
    }

    console.log('== 回归：负数 timeout 与 SSH 多字节撕裂（R4/L-1、L-2） ==');
    {
      const socks = [];
      const server = net.createServer((s) => { socks.push(s); s.on('error', () => {}); });
      await new Promise((res) => server.listen(0, '127.0.0.1', res));
      const mgr = new ShellManager();
      let threw = null, rr = null;
      try { rr = mgr.connect({ protocol: 'telnet', host: '127.0.0.1', port: server.address().port, timeout: -5 }); }
      catch (e) { threw = e; }
      ok(!threw && rr && rr.ok === true, 'Telnet 负数 timeout 不同步抛错（旧行为抛 ERR_OUT_OF_RANGE）');
      if (rr && rr.ok) mgr.close(rr.id);
      for (const s of socks) s.destroy();
      await new Promise((res) => server.close(res));
    }
    {
      const { Server } = require('ssh2');
      const hostKey = fs.readFileSync(path.join(root, 'node_modules', 'ssh2', 'test', 'fixtures', 'ssh_host_rsa_key'));
      const socks = [];
      const server = new Server({ hostKeys: [hostKey] }, (client) => {
        client.on('error', () => {});
        client.on('authentication', (ctx) => ctx.accept());
        client.on('ready', () => {
          client.on('session', (accept) => {
            const sess = accept();
            sess.on('pty', (a, r2, info) => a());
            sess.on('shell', (acc) => {
              const st = acc();
              const b = Buffer.from('中文OK', 'utf8');
              st.write(b.slice(0, 1)); // 把首个多字节字符按字节撕裂
              setTimeout(() => st.write(b.slice(1)), 60);
            });
          });
        });
      });
      await new Promise((res) => server.listen(0, '127.0.0.1', res));
      const mgr = new ShellManager();
      const outs = [], statuses = [];
      mgr.on('output', (id, d) => outs.push(d));
      mgr.on('status', (id, info) => statuses.push(info));
      const r = mgr.connect({ protocol: 'ssh', host: '127.0.0.1', port: server.address().port, username: 'admin', password: 'secret' });
      await waitFor(() => statuses.some(s => s.state === 'fingerprint'), 4000);
      ok(mgr.trustFingerprint('127.0.0.1', true), 'SSH 指纹确认放行');
      await waitFor(() => outs.join('').includes('OK'), 4000);
      ok(outs.join('').includes('中文OK'), 'SSH 跨包多字节 UTF-8 正常（' + JSON.stringify(outs.join('')) + '）');
      ok(!outs.join('').includes('\uFFFD'), 'SSH 输出无替换符（旧实现 toString 撕裂半字符）');
      mgr.close(r.id);
      for (const s of socks) s.destroy();
      await new Promise((res) => server.close(res));
    }

    console.log('== 回归：NAWS 0xFF 双写转义与尺寸钳制（R4/F-3） ==');
    {
      const nawsData = [];
      const nawsSocks = [];
      const server = net.createServer((sock) => {
        nawsSocks.push(sock);
        sock.on('data', (d) => nawsData.push(d));
        sock.on('error', () => {});
        sock.write('\r\nOK\r\n> ');
      });
      await new Promise((res) => server.listen(0, '127.0.0.1', res));
      const mgr = new ShellManager();
      const outs = [];
      mgr.on('output', (id, d) => outs.push(d));
      const r = mgr.connect({ protocol: 'telnet', host: '127.0.0.1', port: server.address().port, cols: 80, rows: 255 });
      await waitFor(() => outs.join('').includes('> '), 3000);
      // rows=255：载荷低字节恰为 0xFF，必须双写（wire …00 FF FF… 后接 IAC SE）；旧实现少一个 FF 致服务端解协商错乱
      await waitFor(() => nawsData.some(b => b.includes(Buffer.from([255, 250, 31, 0, 80, 0, 255, 255, 255, 240]))), 3000);
      ok(nawsData.some(b => b.includes(Buffer.from([255, 250, 31, 0, 80, 0, 255, 255, 255, 240]))),
        'NAWS 载荷 0xFF 双写转义（rows=255）');
      mgr.resize(r.id, 70000, 30); // 上限钳制 65535（16 位语义），不再回绕
      await waitFor(() => nawsData.some(b => b.includes(Buffer.from([255, 250, 31, 255, 255, 255, 255, 0, 30, 255, 240]))), 3000);
      ok(nawsData.some(b => b.includes(Buffer.from([255, 250, 31, 255, 255, 255, 255, 0, 30, 255, 240]))),
        'resize 超上限钳制为 65535 且转义正确');
      mgr.close(r.id);
      for (const s of nawsSocks) s.destroy();
      await new Promise((res) => server.close(res));
    }

    // RFC 4256 数量契约（R4/L-3）：多提示服务器下应答数必须等于提示数、密码只进口令位
    {
      const { Server } = require('ssh2');
      const hostKey = fs.readFileSync(path.join(root, 'node_modules', 'ssh2', 'test', 'fixtures', 'ssh_host_rsa_key'));
      const socks = [];
      let got = null;
      let connected = false;
      const server = new Server({ hostKeys: [hostKey] }, (client) => {
        client.on('error', () => {});
        client.on('authentication', (ctx) => {
          if (ctx.method === 'password') return ctx.reject(['keyboard-interactive']); // 引导客户端进入 KI 流程
          if (ctx.method !== 'keyboard-interactive') return ctx.reject();
          ctx.prompt(['Username: ', { prompt: 'Password: ', echo: false }], '', '', (answers) => {
            got = { n: answers.length, first: answers[0], second: answers[1] };
            if (answers.length === 2 && answers[0] === '' && answers[1] === 'secret') ctx.accept();
            else ctx.reject();
          });
        });
        client.on('ready', () => { connected = true; client.end(); });
      });
      await new Promise((res) => server.listen(0, '127.0.0.1', res));
      const mgr = new ShellManager();
      const statuses = [], ends = [];
      mgr.on('status', (id, info) => statuses.push(info));
      mgr.on('end', (id, reason) => ends.push(reason));
      const r = mgr.connect({ protocol: 'ssh', host: '127.0.0.1', port: server.address().port, username: 'user1', password: 'secret' });
      await waitFor(() => statuses.some(s => s.state === 'fingerprint'), 4000);
      ok(mgr.trustFingerprint('127.0.0.1', true), 'KI 测试指纹确认放行');
      await waitFor(() => connected || ends.length, 6000);
      ok(connected === true, '双提示 keyboard-interactive 认证成功（旧实现固定回 1 个应答必败）');
      ok(got !== null && got.n === 2 && got.first === '' && got.second === 'secret',
        '应答数==提示数且密码只进 Password 位（' + JSON.stringify(got) + '）');
      mgr.close(r.id);
      for (const s of socks) s.destroy();
      await new Promise((res) => server.close(res));
    }

    // SSH 公钥认证（R4 新功能）：PKCS#8 私钥完成认证（服务端仅放行 publickey）
    {
      const { generateKeyPairSync } = require('crypto');
      const { privateKey: privPem } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' } // PKCS#1（ssh2 1.17 对 Node 生成的 PKCS#8 解析不支持）
      });
      const { Server } = require('ssh2');
      const hostKey = fs.readFileSync(path.join(root, 'node_modules', 'ssh2', 'test', 'fixtures', 'ssh_host_rsa_key'));
      const socks = [];
      const server = new Server({ hostKeys: [hostKey] }, (client) => {
        client.on('error', () => {});
        client.on('authentication', (ctx) => {
          if (ctx.method === 'publickey') return ctx.accept();
          ctx.reject(); // 密码/keyboard-interactive 一律拒绝：证明走的是公钥
        });
        client.on('ready', () => {
          client.on('session', (accept) => {
            const sess = accept();
            sess.on('pty', (a, r2, info) => a());
            sess.on('shell', (acc) => { acc().write('PUBKEY-OK\r\n'); });
          });
        });
      });
      await new Promise((res) => server.listen(0, '127.0.0.1', res));
      const mgr = new ShellManager();
      const outs = [], statuses = [];
      mgr.on('output', (id, d) => outs.push(d));
      mgr.on('status', (id, info) => statuses.push(info));
      const r = mgr.connect({ protocol: 'ssh', host: '127.0.0.1', port: server.address().port, username: 'ops', privateKey: privPem });
      await waitFor(() => statuses.some(s => s.state === 'fingerprint'), 4000);
      ok(mgr.trustFingerprint('127.0.0.1', true), '公钥测试指纹确认放行');
      await waitFor(() => outs.join('').includes('PUBKEY-OK'), 5000);
      ok(outs.join('').includes('PUBKEY-OK'), 'SSH 私钥（PKCS#1 PEM）认证成功建立会话');
      ok(!statuses.some(s => s.state === 'error'), '私钥认证过程无错误状态');
      mgr.close(r.id);
      for (const s of socks) s.destroy();
      await new Promise((res) => server.close(res));
    }

    // 监控私钥链路：start 接受私钥参数且 status() 不泄露机密字段
    {
      const os = require('os');
      const tmpM = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-mon-'));
      const { MonitorManager } = require(path.join(root, 'js', 'monitor.js'));
      const mm = new MonitorManager(new ShellManager(), tmpM, path.join(tmpM, 'trust.json'));
      const rs = mm.start({
        key: 'devA@10.255.255.1', deviceId: 'devA', name: 'devA',
        protocol: 'ssh', host: '10.255.255.1', port: 22, commands: ['display version'],
        password: 'pw1', privateKey: '-----BEGIN TEST KEY-----', keyPassphrase: 'topsecret'
      });
      ok(rs.ok === true, '监控任务接受私钥/口令参数');
      const items = mm.status();
      const it = items[0] || {};
      ok(items.length === 1, '任务已登记');
      ok(!('privateKey' in it) && !('password' in it) && !('keyPassphrase' in it),
        'status() 不输出 password/privateKey/keyPassphrase 字段');
      mm.stopAll();
      fs.rmSync(tmpM, { recursive: true, force: true });
    }

    // 资产清单行构建（R4 新功能）
    console.log('== 回归：资产清单行构建（新功能） ==');    {
      const nodes = [
        { id: 'n1', name: '核心-R1', type: 'router', mgmt: '10.0.0.1', note: '出口' },
        { id: 'n2', name: '接入-SW1', type: 'switch', mgmt: '10.0.0.2', mgmts: ['10.0.0.2', '192.168.1.2'], note: '' }
      ];
      const mon = { n1: { state: 'monitoring', text: '监控中：10.0.0.1:22（SSH）' } };
      const bk = { '核心-R1': { lastAt: Date.now(), count: 3 } };
      const rows = U.buildInventoryRows(nodes, mon, bk);
      ok(rows[0].join(',') === '设备名,类型,管理地址,设备型号,软件版本,备注,监控状态,最近配置备份,备份份数', '表头完整（含型号/软件版本列）');
      ok(rows[1][0] === '核心-R1' && rows[1][1] === '路由器', '内置类型中文标签');
      ok(rows[1][2] === '10.0.0.1' && rows[1][6].indexOf('监控中') === 0, '管理地址与监控状态取值');
      ok(/^\d{8}_\d{4}$/.test(rows[1][7]) && rows[1][8] === '3', '最近备份时间与份数');
      ok(rows[2][2] === '10.0.0.2 / 192.168.1.2', '多管理口斜杠连接');
      ok(rows[2][6] === '未监控', '无监控状态设备回退「未监控」');
      ok(U.buildInventoryRows(null, null, null)[0].length === 9, '空入参不抛错仅表头（9 列）');
    }

    // 本批新功能：直角布线几何 / 工程口令加密 / SNMP 编解码 / 备份自动合规巡检
    console.log('== 回归：直角布线几何（新功能） ==');
    {
      const nodes = [
        { id: 'a', name: 'A', type: 'router', x: 0, y: 0, w: 160, h: 56 },
        { id: 'b', name: 'B', type: 'switch', x: 500, y: 300, w: 160, h: 56 }
      ];
      const links = [{ id: 'l1', a: 'a', b: 'b', aIf: 'GE0/0/1', aIp: '10.0.0.1', bIf: 'GE0/0/2', bIp: '10.0.0.2', bw: '1000' }];
      const straight = U.linkGeom(nodes, links);
      ok(!straight.l1.pts && straight.l1.x1 != null, '默认直线模式无 pts');
      const ortho = U.linkGeom(nodes, links, { ortho: true });
      ok(Array.isArray(ortho.l1.pts) && ortho.l1.pts.length === 4, '直角模式产出 4 点折线');
      const p = ortho.l1.pts;
      ok(p[0][1] === p[1][1] && p[1][0] === p[2][0] && p[2][1] === p[3][1], '折线为正交（横-竖-横三段）');
      ok(p[0][0] === straight.l1.x1 && p[3][0] === straight.l1.x2, '端点与直线模式一致');
      const same = U.linkGeom(
        [{ id: 'a', name: 'A', type: 'router', x: 0, y: 0, w: 160, h: 56 }, { id: 'b', name: 'B', type: 'switch', x: 500, y: 0, w: 160, h: 56 }],
        [{ id: 'l1', a: 'a', b: 'b' }], { ortho: true });
      ok(!same.l1.pts, '等高设备退化为直线（pts=null）');
    }

    console.log('== 回归：工程口令加解密（新功能） ==');
    {
      ok(U.isProjectCryptoAvailable() === true, 'Node webcrypto 可用（沙箱注入）');
      const secret = JSON.stringify({ app: 'NetTopo', nodes: [{ id: 'n1', name: '机密拓扑' }] });
      const env = await U.encryptProjectText(secret, '口令123');
      const envObj = JSON.parse(env);
      ok(envObj.app === 'NetTopo-Enc' && envObj.v === 1 && !!envObj.ct && !!envObj.salt && !!envObj.iv, '信封格式正确（NetTopo-Enc）');
      ok(env.indexOf('机密拓扑') < 0, '密文中不含明文');
      const back = await U.decryptProjectText(env, '口令123');
      eq(back, secret, '正确口令解密还原');
      let threw = false;
      try { await U.decryptProjectText(env, '错口令'); } catch (e) { threw = true; }
      ok(threw === true, '错误口令解密抛错');
      threw = false;
      try { await U.decryptProjectText('{"app":"NetTopo"}', 'x'); } catch (e) { threw = true; }
      ok(threw === true, '非加密工程被拒绝');
    }

    console.log('== 回归：SNMP v2c 编解码（新功能） ==');
    {
      const { snmpGet, extractVersion, OID_SYSDESCR } = require(path.join(root, 'js', 'monitor.js'));
      const dgram = require('dgram');
      const agent = dgram.createSocket('udp4');
      agent.on('message', (msg, rinfo) => {
        const tlv = (tag, body) => Buffer.concat([Buffer.from([tag, body.length]), body]);
        const val = Buffer.from('Huawei Versatile Routing Platform Software VRP (R) software V300R019 Version 8.180', 'utf8');
        const vb = tlv(0x30, Buffer.concat([tlv(0x06, Buffer.from([43, 6, 1, 2, 1, 1, 1, 0])), tlv(0x04, val)]));
        const pduBody = Buffer.concat([tlv(0x02, Buffer.from([0x12, 0x34])), tlv(0x02, Buffer.from([0])), tlv(0x02, Buffer.from([0])), tlv(0x30, vb)]);
        const resp = tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([1])), tlv(0x04, Buffer.from('public')), tlv(0xa2, pduBody)]));
        agent.send(resp, rinfo.port, rinfo.address);
      });
      await new Promise((res) => agent.bind(0, '127.0.0.1', res));
      const r = await snmpGet('127.0.0.1', 'public', [OID_SYSDESCR], 2000, agent.address().port);
      ok(r.ok === true, 'SNMP GET 收到 mock agent 响应');
      const vb0 = (r.varbinds || [])[0] || {};
      ok(vb0.oid === OID_SYSDESCR, '响应 OID 正确解码（' + vb0.oid + '）');
      ok(String(vb0.value).indexOf('Huawei') === 0, 'OCTET STRING 值解码正确');
      ok(extractVersion(String(vb0.value)) === '8.180', 'sysDescr 启发式提取版本（华为 Version 8.180）');
      ok(extractVersion('Huawei Versatile Routing Platform Software VRP (R) software, Version 8.180 (S5735-H48UM V300R019C00SPC500)') === '8.180', '真实华为 sysDescr 格式提取');
      ok(extractVersion('Cisco IOS Software, Version 15.2(4)M') === '15.2(4)M', '思科 IOS 版本提取');
      const r2 = await snmpGet('127.0.0.1', 'public', [OID_SYSDESCR], 250, agent.address().port + 7);
      ok(r2.ok === false, '无响应端口超时返回失败');
      agent.close();
    }

    console.log('== 回归：备份自动合规巡检与 sysinfo（新功能） ==');
    {
      const os = require('os');
      const { MonitorManager, compileComplianceRules, runCompliance } = require(path.join(root, 'js', 'monitor.js'));
      const rules = compileComplianceRules([{ id: 'r1', name: '必须NTP', pattern: 'ntp', negate: false }, { id: 'r2', name: '禁Telnet', pattern: 'telnet server enable', negate: true }]);
      ok(rules.length === 2 && typeof rules[0].re.test === 'function', '主进程侧规则编译可用');
      const rep = runCompliance('ntp-service unicast-server 1.1.1.1\n#\ntelnet server enable', rules);
      ok(rep.failed === 1 && rep.results[1].pass === false, '主进程侧检查口径与渲染层一致');
      const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-cmp-'));
      const { EventEmitter } = require('events');
      const stubShell = new EventEmitter();
      stubShell.connect = (opts) => { stubShell.lastConnect = opts; return { ok: true, id: 'x9' }; };
      stubShell.write = () => {}; stubShell.close = () => {}; stubShell.trustFingerprint = () => true;
      const mm = new MonitorManager(stubShell, tmpC, path.join(tmpC, 't.json'));
      const comps = [], sys = [];
      mm.on('compliance', (info) => comps.push(info));
      mm.on('sysinfo', (info) => sys.push(info));
      const rs = mm.start({
        key: 'd1@10.9.9.9', deviceId: 'd1', name: 'd1', protocol: 'ssh', host: '10.9.9.9', port: 22,
        commands: ['display version'], password: 'p',
        backup: { enabled: true, command: 'display current-configuration', compliance: { enabled: true, rules: [{ id: 'r1', name: '必须NTP', pattern: 'ntp', negate: false }, { id: 'r2', name: '禁Telnet', pattern: 'telnet server enable', negate: true }] } },
        sysinfo: { enabled: true, community: 'pub1' }
      });
      ok(rs.ok === true, '任务接受合规/SNMP 参数');
      const jobC = mm.jobs.get('d1@10.9.9.9');
      mm._runCompliance(jobC, 1, 'telnet server enable\n#');
      ok(comps.length === 1 && comps[0].ok === false && comps[0].failed === 2 && comps[0].total === 2,
        '合规巡检违规触发事件（必须NTP 缺失 + 禁Telnet 命中，failed=2）');
      ok(comps[0].items[0].name === '必须NTP' && comps[0].items[0].line === '未找到匹配行'
        && comps[0].items[1].name === '禁Telnet' && comps[0].items[1].line === 'telnet server enable',
        '违规项携带规则名与命中行/说明');
      const it = mm.status()[0] || {};
      ok(it.compliance && it.compliance.failed === 2 && it.compliance.total === 2, 'status() 携带合规概要（failed/total）');
      mm._fetchSysInfo(jobC, jobC.gen);
      await new Promise((res) => setTimeout(res, 300));
      ok(sys.length === 0, '无 SNMP agent 时识别静默不广播（不抛错）');
      mm.stopAll();
      fs.rmSync(tmpC, { recursive: true, force: true });
    }

    // 配置合规基线引擎（新功能）
    console.log('== 回归：配置合规基线引擎（新功能） ==');
    {
      const rules = U.cleanComplianceRules([
        { id: 'r1', name: '必须NTP', pattern: 'ntp', negate: false },
        { id: 'bad', name: '非法正则', pattern: '(', negate: false },
        { id: 'r1', name: '重复id', pattern: 'x' },
        { name: '缺id', pattern: 'x' },
        { id: 'r2', name: '禁Telnet', pattern: 'telnet server enable', negate: true }
      ]);
      ok(rules.length === 2, '非法正则/重复id/缺id 规则被清洗（' + rules.length + ' 条）');
      ok(rules.every(r => typeof (r.re && r.re.test) === 'function'), '规则编译为正则');
      const rep = U.checkCompliance('ntp-service unicast-server 1.1.1.1\ntelnet server enable\n#', rules);
      const byId = Object.fromEntries(rep.results.map(r => [r.id, r]));
      ok(byId.r1.pass === true && byId.r1.lines[0].includes('ntp-service'), '必须类规则命中即通过并携带行');
      ok(byId.r2.pass === false && byId.r2.lines[0].includes('telnet server enable'), '禁止类规则命中即违规并携带行');
      const rep2 = U.checkCompliance('sysname SW1\n#', rules);
      ok(rep2.results.find(r => r.id === 'r1').pass === false, '必须类规则缺失即违规');
      ok(rep2.results.find(r => r.id === 'r2').pass === true, '禁止类规则无命中即通过');
      const defs = U.loadComplianceRules();
      ok(defs.length >= 5 && defs.every(r => r.re), '默认规则加载可用（' + defs.length + ' 条）');
      U.saveComplianceRules(defs);
      ok(U.complianceRules.length === defs.length, '规则保存后内存一致');
      U.saveComplianceRules([{ id: 'x1', name: '启用', pattern: 'x', enabled: true }, { id: 'x2', name: '停用', pattern: 'y', enabled: false }]);
      const rep3 = U.checkCompliance('x\ny\n', U.complianceRules);
      ok(rep3.results.length === 1 && rep3.results[0].id === 'x1', '停用规则不参与检查');
      U.saveComplianceRules(U.COMPLIANCE_DEFAULT_RULES); // 还原默认，避免污染后续用例
    }

    // 合规默认规则包扩充（分组 + undo/no 误报排除）
    console.log('== 回归：合规默认规则包扩充（分组 + undo/no 误报排除） ==');
    {
      const defs = U.cleanComplianceRules(U.COMPLIANCE_DEFAULT_RULES);
      ok(defs.length >= 10, '默认规则扩充到 ≥10 条（' + defs.length + ' 条）');
      ok(defs.every(r => typeof r.group === 'string' && r.group), '每条默认规则都带分组');
      ok(new Set(defs.map(r => r.group)).size >= 4, '分组 ≥4 类（时间/日志/认证/服务/路由）');
      ok(new Set(defs.map(r => r.id)).size === defs.length, '规则 id 无重复');
      const telnet = defs.find(r => r.id === 'telnet');
      ok(!!telnet && telnet.negate, 'Telnet 禁止规则存在且为禁止类');
      ok(U.checkCompliance('undo telnet server enable\n#', [telnet]).results[0].pass === true, 'undo telnet server enable（已关闭）不误报');
      ok(U.checkCompliance('telnet server enable\n#', [telnet]).results[0].pass === false, 'telnet server enable 仍判违规');
      ok(U.checkCompliance('transport input none\n#', [telnet]).results[0].pass === true, 'transport input none（仅 SSH）不误报');
      const http = defs.find(r => r.id === 'http');
      ok(!!http && U.checkCompliance('interface GigabitEthernet0/0/1\n no ip http server\n#', [http]).results[0].pass === true, '缩进 no ip http server 不误报');
      ok(U.checkCompliance(' ip http server\n#', [http]).results[0].pass === false, '缩进 ip http server 仍判违规');
      ok(U.checkCompliance(' ip http secure-server\n#', [http]).results[0].pass === true, 'ip http secure-server（HTTPS）不误报');
      const snmp = defs.find(r => r.id === 'snmpv2');
      ok(!!snmp && U.checkCompliance('undo snmp-agent community read abc\n#', [snmp]).results[0].pass === true, 'undo snmp-agent community 不误报');
      ok(U.checkCompliance('snmp-agent community read cipher %^%#abc\n#', [snmp]).results[0].pass === false, 'snmp-agent community 仍判违规');
      const saved = U.saveComplianceRules(U.COMPLIANCE_DEFAULT_RULES);
      ok(saved.every(r => r.group) && saved.find(r => r.id === 'ntp').group === '时间同步', '分组字段随规则保存保留');
    }

    // Web Shell 会话审计日志（新功能）
    console.log('== 回归：Web Shell 会话审计日志（新功能） ==');
    {
      const os = require('os');
      const tmpL = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-shlog-'));
      const socksL = [];
      const srvL = net.createServer((s) => {
        socksL.push(s);
        s.on('error', () => {});
        s.write('WELCOME-SHLOG\r\n');
        s.on('data', (d) => { if (d.toString().includes('cmd1')) s.write('ECHO-CMD1\r\n'); });
      });
      await new Promise((res) => srvL.listen(0, '127.0.0.1', res));
      const mgrL = new ShellManager({ logDir: tmpL });
      const outsL = [];
      mgrL.on('output', (id, d) => outsL.push(d));
      const rL = mgrL.connect({ protocol: 'telnet', host: '127.0.0.1', port: srvL.address().port, timeout: 3000, username: 'op' });
      ok(rL.ok === true, '带审计日志目录发起连接成功');
      await waitFor(() => outsL.join('').includes('WELCOME-SHLOG'), 3000);
      mgrL.write(rL.id, 'cmd1\r\n');
      await waitFor(() => outsL.join('').includes('ECHO-CMD1'), 3000);
      const endL = new Promise((res) => mgrL.on('end', () => res()));
      mgrL.close(rL.id);
      await endL;
      await new Promise((res) => setTimeout(res, 300)); // 等待流 flush
      const walkL = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p2 = path.join(d, e.name); e.isDirectory() ? walkL(p2, out) : out.push(p2); } return out; };
      const logs = walkL(tmpL);
      ok(logs.length === 1 && /WebShell-127\.0\.0\.1/.test(logs[0]), '审计日志按 WebShell-<主机> 设备目录生成');
      const logName = path.basename(logs[0]);
      ok(/^(?:[\u4e00-\u9fa5A-Za-z0-9_.-]+)_(?:[\u4e00-\u9fa5A-Za-z0-9_.-]+)(?:_\d{8}_\d{6}(?:_\d+)?)?\.log$/.test(logName),
        '文件名兼容监控日志浏览器白名单（' + logName + '）');
      const contentL = fs.readFileSync(logs[0], 'utf8');
      ok(contentL.includes('会话开始') && contentL.includes('TELNET') && contentL.includes('用户名: op'),
        '日志含开始头（协议/地址/用户名）');
      ok(contentL.includes('WELCOME-SHLOG') && contentL.includes('ECHO-CMD1'), '设备输出（含命令回显）原样留痕');
      ok(contentL.includes('会话结束'), '日志含结束尾');
      // 不传 logDir 的旧行为不受影响
      const mgrNoLog = new ShellManager();
      ok(mgrNoLog.logDir === '', '未配置 logDir 时不启用审计日志（兼容旧行为）');
      for (const s of socksL) s.destroy();
      await new Promise((res) => srvL.close(res));
      fs.rmSync(tmpL, { recursive: true, force: true });
    }

    // 群发结果对比（纯函数）+ 合规报告行构建
    console.log('== 回归：群发结果对比与合规报告行（新功能） ==');
    {
      const { diffSessionOutputs } = require(path.join(root, 'js', 'shell-ui.js'));
      const d = diffSessionOutputs([
        { name: 'R1', lines: ['sysname R1', 'vlan 10', 'uptime 5d'] },
        { name: 'R2', lines: ['sysname R2', 'vlan 10', 'uptime 99d'] }
      ]);
      ok(d.names.join('|') === 'R1|R2', '输出名称保留');
      ok(d.perOut[0][1].diff === false && d.perOut[1][1].diff === false, '共有行（vlan 10）不标差异');
      ok(d.perOut[0][0].diff === true && d.perOut[1][0].diff === true, '各自主机名行标差异');
      ok(d.perOut[0][2].diff === true && d.perOut[0][2].text === 'uptime 5d', '不同值行标差异');
      ok(diffSessionOutputs([]).perOut.length === 0, '空入参不抛错');
      const rows = U.buildComplianceReportRows([
        { device: 'SW1', host: '10.0.0.1', time: '20260828_1800', rep: { results: [
          { name: '必须配置 NTP', negate: false, pass: false, lines: [] },
          { name: '禁止 Telnet', negate: true, pass: true, lines: [] }
        ] } }
      ]);
      eq(rows.length, 3, '报告行=表头+规则数');
      ok(rows[1][4] === '违规' && rows[1][5].includes('未找到'), '必须类违规说明');
      ok(rows[2][4] === '通过' && rows[2][2] === '禁止 Telnet', '禁止类通过行');
    }

    // 在线率采样库（UptimeStore）
    console.log('== 回归：在线率采样库（新功能） ==');
    {
      const os = require('os');
      const { UptimeStore } = require(path.join(root, 'js', 'monitor.js'));
      const fU = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-up-')), 'up.json');
      const us = new UptimeStore(fU, { bucketMs: 100, keepMs: 7 * 86400000, maxKeys: 3 });
      const base = Math.floor(Date.now() / 100) * 100; // 对齐 100ms 桶，避免被 7 天保留期清掉
      us.record('k1', true, base + 10);
      us.record('k1', false, base + 60); // 同桶覆盖
      us.record('k1', true, base + 150); // 新桶
      const s1 = us.series('k1');
      ok(s1.length === 2 && s1[0][1] === 0 && s1[1][1] === 1, '同桶覆盖保留最后一次、异桶追加（' + JSON.stringify(s1) + '）');
      us.record('k2', true, base + 10); us.record('k3', true, base + 10); us.record('k4', true, base + 10);
      ok(us.map.size <= 3, '键数超限淘汰最旧键（' + us.map.size + '）');
      us.record('kX', true, base + 10);
      ok(us.flush() === true, '有变更时落盘成功');
      ok(us.flush() === false, '无变更时跳过写盘');
      const us2 = new UptimeStore(fU, { bucketMs: 100 });
      ok(us2.series('kX').length === 1 && us2.series('kX')[0][1] === 1, '重启后从文件恢复采样');
      const empty = new UptimeStore('', { bucketMs: 100 });
      empty.record('z', true);
      ok(empty.series('z').length === 1 && empty.file === '', '无文件路径时仅内存可用');
    }

    // SSH 跳板机端到端：jump forwardOut 通道上完成目标握手
    console.log('== 回归：SSH 跳板机端到端（新功能） ==');
    {
      const { Server } = require('ssh2');
      const hostKey = fs.readFileSync(path.join(root, 'node_modules', 'ssh2', 'test', 'fixtures', 'ssh_host_rsa_key'));
      const mkAuthSsh = (passwd, onReady) => new Server({ hostKeys: [hostKey] }, (client) => {
        client.on('error', () => {});
        client.on('authentication', (ctx) => { if (ctx.method === 'password' && ctx.password === passwd) ctx.accept(); else ctx.reject(); });
        client.on('ready', () => onReady(client));
      });
      // 目标 SSH：shell 输出标志行
      const target = mkAuthSsh('tpass', (client) => {
        client.on('session', (accept) => {
          const sess = accept();
          sess.on('pty', (a) => a());
          sess.on('shell', (acc) => {
            const st = acc();
            st.write('JUMP-TARGET-OK\r\n');
            st.on('close', () => st.end());
          });
        });
      });
      // 跳板 SSH：direct-tcpip 请求转发到真实目标
      const jump = mkAuthSsh('jpass', (client) => {
        client.on('tcpip', (accept, reject, info) => {
          const chan = accept();
          const sock = net.connect(info.destPort, info.destIP, () => {});
          chan.pipe(sock).pipe(chan);
          const kill = () => { try { sock.destroy(); } catch (e) {} try { chan.end(); } catch (e) {} };
          chan.on('close', kill); sock.on('close', kill); sock.on('error', kill);
        });
      });
      const socksJ = [];
      let tPort = 0, jPort = 0;
      await new Promise((res) => target.listen(0, '127.0.0.1', (e) => { tPort = target.address().port; res(); }));
      await new Promise((res) => jump.listen(0, '127.0.0.1', (e) => { jPort = jump.address().port; res(); }));
      const mgr = new ShellManager();
      const outs = [], statuses = [];
      mgr.on('output', (id, d) => outs.push(d));
      mgr.on('status', (id, info) => { statuses.push(info); if (info.state === 'fingerprint') mgr.trustFingerprint(info.host, true); });
      const r = mgr.connect({ protocol: 'ssh', host: '127.0.0.1', port: tPort, username: 'ops', password: 'tpass', jump: { host: '127.0.0.1', port: jPort, username: 'ju', password: 'jpass' } });
      ok(r.ok === true, '经跳板发起连接成功');
      await waitFor(() => outs.join('').includes('JUMP-TARGET-OK'), 10000);
      ok(outs.join('').includes('JUMP-TARGET-OK'), '经跳板 forwardOut 通道建立目标会话并收到输出');
      ok(statuses.some(s => s.state === 'fingerprint' && s.host === '127.0.0.1'), '跳板/目标指纹确认按主机独立排队（同一主机多轮）');
      mgr.close(r.id);
      await new Promise((res) => target.close(res));
      await new Promise((res) => jump.close(res));
    }

    // 监控任务跳板参数透传 + 指纹按事件主机放行
    console.log('== 回归：监控跳板透传与指纹主机（新功能） ==');
    {
      const os = require('os');
      const { EventEmitter } = require('events');
      const tmpJ = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-jmp-'));
      const { MonitorManager } = require(path.join(root, 'js', 'monitor.js'));
      const stubShell = new EventEmitter();
      stubShell.connect = (opts) => { stubShell.lastConnect = opts; return { ok: true, id: 'x1' }; };
      stubShell.write = () => {};
      stubShell.close = () => {};
      stubShell.trustFingerprint = (h, t) => { stubShell.trusted = [h, t]; return true; };
      const mm = new MonitorManager(stubShell, tmpJ, path.join(tmpJ, 'trust.json'));
      const rs = mm.start({
        key: 'd1@10.9.9.9', deviceId: 'd1', name: 'd1',
        protocol: 'ssh', host: '10.9.9.9', port: 22, commands: ['display version'], password: 'p1',
        jump: { host: '10.0.0.1', port: '2222', username: 'ju', password: 'jp' }
      });
      ok(rs.ok === true, '监控任务接受跳板参数');
      ok(stubShell.lastConnect && stubShell.lastConnect.jump && stubShell.lastConnect.jump.host === '10.0.0.1'
        && stubShell.lastConnect.jump.port === 2222 && stubShell.lastConnect.jump.username === 'ju',
        '跳板参数透传到连接（端口归一化为数字）');
      mm._onStatus('x1', { state: 'fingerprint', host: '10.0.0.1', fp: 'SHA256:jumpfp' });
      ok(Array.isArray(stubShell.trusted) && stubShell.trusted[0] === '10.0.0.1',
        '指纹确认按事件携带的主机（跳板）放行');
      ok(mm.trusted.get('10.0.0.1') === 'SHA256:jumpfp', '跳板指纹按归属主机记录');
      mm.stopAll();
      fs.rmSync(tmpJ, { recursive: true, force: true });
    }

    console.log('== 回归：IP 子网计算器与拓扑快速搜索（新功能） ==');
    {
      // 子网计算：/26 主机地址
      let c = U.subnetCalc('192.168.1.130', 26);
      eq(c.network, '192.168.1.128', '/26 网络地址');
      eq(c.broadcast, '192.168.1.191', '/26 广播地址');
      eq(c.mask, '255.255.255.192', '/26 点分掩码');
      eq(c.wildcard, '0.0.0.63', '/26 反掩码');
      eq(c.first, '192.168.1.129', '/26 可用起始');
      eq(c.last, '192.168.1.190', '/26 可用结束');
      eq(c.usable, 62, '/26 可用主机数');
      eq(c.kind, 'host', '/26 地址类型');
      // 掩码文本格式
      eq(U.subnetCalc('10.0.0.5', '255.255.255.0').bits, 24, '点分掩码识别');
      eq(U.subnetCalc('10.0.0.5', '0.0.0.255').bits, 24, '反掩码识别');
      eq(U.subnetCalc('10.0.0.5').bits, 24, '缺省 /24');
      // 边界位数
      eq(U.subnetCalc('192.168.1.4', 31).usable, 2, '/31 RFC3021 两个可用');
      eq(U.subnetCalc('192.168.1.4', 31).kind, 'host', '/31 两地址均为主机');
      eq(U.subnetCalc('1.2.3.4', 32).usable, 1, '/32 单主机');
      eq(U.subnetCalc('8.8.8.8', 0).total, 4294967296, '/0 全地址空间');
      eq(U.subnetCalc('192.168.0.0', 24).kind, 'network', '网络地址识别');
      eq(U.subnetCalc('192.168.0.255', 24).kind, 'broadcast', '广播地址识别');
      eq(U.subnetCalc('abc', 24), null, '非法 IP 返回 null');
      eq(U.subnetCalc('1.2.3.4', 33), null, '掩码位越界返回 null');
      eq(U.maskTextToBits('0.1.0.0'), null, '混合型掩码非法');
      eq(U.parseIpMaskText('192.168.1.5/24').bits, 24, 'IP/掩码 解析');
      eq(U.parseIpMaskText('10.0.0.1 0.0.0.255').bits, 24, '空格+反掩码 解析');
      eq(U.parseIpMaskText('10.0.0.1/33'), null, '非法掩码整体拒绝');
      // 拓扑快速搜索
      const sNodes = [
        { id: 'n1', name: '核心R1', type: 'router', mgmts: ['10.0.0.1'], vlans: [], note: '出口' },
        { id: 'n2', name: 'SW2', type: 'switch', mgmts: [], vlans: [{ id: '10', ip: '192.168.10.1' }] }
      ];
      const sLinks = [{ id: 'l1', a: 'n1', b: 'n2', aIf: 'GE0/0/1', aIp: '10.0.0.1', bIf: 'GE1/0/1', bIp: '10.0.0.2', note: '' }];
      ok(U.searchTopology(sNodes, sLinks, '核心').length === 1
        && U.searchTopology(sNodes, sLinks, '核心')[0].kind === 'node', '设备名命中');
      ok(U.searchTopology(sNodes, sLinks, '10.0.0').some(x => x.kind === 'link'), '连线 IP 命中');
      ok(U.searchTopology(sNodes, sLinks, '10.0.0').some(x => x.kind === 'node' && x.sub.indexOf('管理地址') >= 0), '管理地址命中');
      eq(U.searchTopology(sNodes, sLinks, '10')[0].id, 'n1', '名称命中优先于其他字段');
      ok(U.searchTopology(sNodes, sLinks, '192.168.10').some(x => x.id === 'n2' && x.sub.indexOf('VLAN') >= 0), 'VLAN 接口命中');
      eq(U.searchTopology(sNodes, sLinks, '').length, 0, '空查询返回空');
      eq(U.searchTopology(sNodes, sLinks, '查无此项xyz').length, 0, '无命中返回空');
    }

    console.log('== 回归：区域分组容器（清洗 + SVG/PDF 导出，新功能） ==');
    {
      const regs = U.sanitizeRegions([
        { id: 'r1', name: '核心区', x: 0, y: 0, w: 480, h: 320, color: '#6366f1' },
        { x: 5, y: 5, w: -10, color: 'javascript:alert(1)' },
        null
      ]);
      eq(regs.length, 2, '区域清洗保留合法项');
      eq(regs[0].name, '核心区', '名称保留');
      eq(regs[1].w, 60, '过小宽钳制到 60');
      eq(regs[1].color, '#6366f1', '非法颜色回退默认');
      eq(U.sanitizeRegions().length, 0, '缺参返回空数组');
      // SVG 导出（PDF/PNG 同链路）：区域在最底层、含名称与设备计数
      const svg = sandbox.TopoPdf.buildSvgImage({
        nodes: [{ id: 'n1', name: 'R1', type: 'router', x: 100, y: 100, w: 160, h: 56 }],
        links: [],
        texts: [],
        regions: [{ id: 'r1', name: '核心区', x: 50, y: 50, w: 480, h: 320, color: '#6366f1' }]
      }, {});
      ok(svg.indexOf('核心区') > 0 && svg.indexOf('1 台') > 0, 'SVG 含区域名称与设备计数');
      ok(svg.indexOf('fill-opacity="0.06"') > 0, 'SVG 区域浅色填充');
      ok(svg.indexOf('stroke-dasharray="10 6"') > 0, 'SVG 区域虚线边框');
      ok(svg.indexOf('>R1<') > 0, 'SVG 仍含设备（区域未遮挡）');
      // 空区域数组不破坏导出
      const svg2 = sandbox.TopoPdf.buildSvgImage({ nodes: [{ id: 'n1', name: 'R1', type: 'router', x: 0, y: 0, w: 160, h: 56 }], links: [] }, {});
      ok(svg2.indexOf('</svg>') > 0, '无区域时导出不受影响');
    }

    console.log('== 回归：VSDX 含区域导出（新功能） ==');
    {
      const buf = sandbox.TopoVsdx.buildVSDX({
        nodes: [{ id: 'n1', name: 'R1', type: 'router', x: 100, y: 100, w: 160, h: 56 }],
        links: [],
        texts: [],
        regions: [{ id: 'r1', name: '核心区', x: 50, y: 50, w: 480, h: 320, color: '#6366f1' }]
      }, {});
      ok(buf instanceof Uint8Array && buf.length > 1000, 'VSDX 含区域可生成（ZIP 字节流）');
      const buf2 = sandbox.TopoVsdx.buildVSDX({ nodes: [{ id: 'n1', name: 'R1', type: 'router', x: 0, y: 0, w: 160, h: 56 }], links: [] }, {});
      ok(buf2 instanceof Uint8Array && buf2.length > 1000, 'VSDX 无区域仍可生成');
    }

    console.log('== 回归：SNMP ifTable 接口流量采集（新功能） ==');
    {
      const os = require('os');
      const dgram = require('dgram');
      const {
        MonitorManager, snmpWalk, rateBps,
        OID_IF_DESCR, OID_IF_SPEED, OID_IF_OPER, OID_IF_HCIN, OID_IF_HCOUT
      } = require(path.join(root, 'js', 'monitor.js'));
      // 速率计算
      eq(rateBps(12500000, 10000000, 10), 2000000, '速率 = Δ计数×8/Δ秒');
      eq(rateBps(1000, 2000, 10), null, '计数器回绕（负差）返回 null');
      eq(rateBps(1000, 1000, 0), null, 'dt=0 返回 null');
      eq(rateBps(null, 1000, 10), null, '缺计数返回 null');
      // mock SNMP agent：3 个接口的 ifTable 子树（GETNEXT 遍历）
      const counters = { 1: 10000000, 2: 20000000, 3: 30000000 };
      const outCounters = { 1: 5000000, 2: 8000000, 3: 9000000 };
      let operMap = { 1: 1, 2: 2, 3: 1 }; // if2 初始 down，用于状态变化事件
      const tree = {};
      for (const i of [1, 2, 3]) {
        tree[OID_IF_DESCR + '.' + i] = { tag: 0x04, val: Buffer.from('GE0/0/' + i, 'utf8') };
        tree[OID_IF_SPEED + '.' + i] = { tag: 0x42, val: [0x3B, 0x9A, 0xCA, 0x00] }; // Gauge 1e9
        tree[OID_IF_OPER + '.' + i] = { tag: 0x02, val: null }; // 运行时填充（可翻转）
        tree[OID_IF_HCIN + '.' + i] = { tag: 0x46, val: null }; // Counter64（测试 64 位解析路径）
        tree[OID_IF_HCOUT + '.' + i] = { tag: 0x46, val: null };
      }
      const fillDyn = () => {
        for (const i of [1, 2, 3]) {
          tree[OID_IF_OPER + '.' + i].val = [operMap[i]];
          tree[OID_IF_HCIN + '.' + i].val = u64Bytes(counters[i]);
          tree[OID_IF_HCOUT + '.' + i].val = u64Bytes(outCounters[i]);
        }
      };
      function u64Bytes(n) {
        const out = [];
        let v = n;
        do { out.unshift(v & 0xff); v = Math.floor(v / 256); } while (v);
        return out.length ? out : [0];
      }
      const oidBytes = (s) => {
        const p = String(s).split('.').map(Number);
        const b = [p[0] * 40 + p[1]];
        for (let k = 2; k < p.length; k++) {
          let v = p[k];
          const t = [v & 0x7f];
          v = Math.floor(v / 128);
          while (v) { t.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
          b.push(...t);
        }
        return Buffer.from(b);
      };
      const tlv = (tag, body) => Buffer.concat([Buffer.from([tag, body.length]), Buffer.from(body)]);
      // 完整 TLV 解析请求首 varbind 的 OID（比 indexOf 稳健：rid/社区字里可能恰有 0x06 字节）
      const parseReqOid = (msg) => {
        const rdFrom = (buf, p) => {
          const tag = buf[p];
          let len = buf[p + 1];
          let hs = 2;
          if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[p + 2 + i]; hs = 2 + n; }
          return { tag, body: buf.subarray(p + hs, p + hs + len), next: p + hs + len };
        };
        const top = rdFrom(msg, 0);       // MSG-SEQ
        const f1 = rdFrom(top.body, 0);   // version INT
        const f2 = rdFrom(top.body, f1.next); // community
        const pdu = rdFrom(top.body, f2.next); // GetNext PDU（0xa1）
        const rid = rdFrom(pdu.body, 0);
        const err = rdFrom(pdu.body, rid.next);
        const ei = rdFrom(pdu.body, err.next);
        const vbs = rdFrom(pdu.body, ei.next); // varbind SEQ
        const vb = rdFrom(vbs.body, 0);
        const oid = rdFrom(vb.body, 0);
        const b = oid.body;
        const arcs = [Math.floor(b[0] / 40), b[0] % 40];
        let v = 0;
        for (let k = 1; k < b.length; k++) {
          v = (v << 7) | (b[k] & 0x7f);
          if (!(b[k] & 0x80)) { arcs.push(v); v = 0; }
        }
        return arcs.join('.');
      };
      const agent = dgram.createSocket('udp4');
      agent.on('message', (msg, rinfo) => {
        const req = parseReqOid(msg);
        fillDyn();
        const keys = Object.keys(tree).sort();
        const next = keys.find(k => k > req);
        const pick = next || '1.3.6.1.2.1.1.1.0'; // 表结束：返回子树外 OID 让 walk 停止
        const ent = next ? tree[pick] : { tag: 0x04, val: Buffer.from('x') };
        const vb = tlv(0x30, Buffer.concat([tlv(0x06, oidBytes(pick)), tlv(ent.tag, ent.val)]));
        const pduBody = Buffer.concat([tlv(0x02, [0, 1]), tlv(0x02, [0]), tlv(0x02, [0]), tlv(0x30, vb)]);
        const resp = tlv(0x30, Buffer.concat([tlv(0x02, [1]), tlv(0x04, Buffer.from('c', 'utf8')), tlv(0xa2, pduBody)]));
        agent.send(resp, rinfo.port, rinfo.address);
      });
      await new Promise((res) => agent.bind(0, '127.0.0.1', res));
      const port = agent.address().port;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // snmpWalk：子树内 3 条 + 离开子树停止
      const w = await snmpWalk(OID_IF_DESCR, '127.0.0.1', 'c', 2000, port);
      ok(w.ok === true && w.varbinds.length === 3, 'snmpWalk 遍历 ifDescr 子树 3 条');
      eq(w.varbinds[0].oid, OID_IF_DESCR + '.1', 'walk 起点为子树首个实例');
      eq(w.varbinds[2].value, 'GE0/0/3', 'OCTET STRING 值正确');
      // MonitorManager 端到端：任务级采集 + 速率 + 状态事件
      const tmpIf = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-if-'));
      const { EventEmitter } = require('events');
      const stubShell = new EventEmitter();
      stubShell.connect = () => ({ ok: true, id: 'if1' });
      stubShell.write = () => {}; stubShell.close = () => {}; stubShell.trustFingerprint = () => true;
      const mm = new MonitorManager(stubShell, tmpIf, path.join(tmpIf, 't.json'));
      // 校验：intervalSec 钳制
      const vcfg = mm._validate({ key: 'dev1@127.0.0.1', host: '127.0.0.1', commands: ['display version'], sysinfo: { ifTable: true, intervalSec: 5 } });
      eq(vcfg.cfg.sysinfo.intervalSec, 30, '采集间隔下限钳制 30 秒');
      eq(vcfg.cfg.sysinfo.ifTable, true, 'ifTable 开关透传');
      const traffics = [], statuses = [];
      mm.on('iftraffic', (info) => traffics.push(info));
      mm.on('ifstatus', (info) => statuses.push(info));
      const rs = mm.start({
        key: 'dev1@127.0.0.1', deviceId: 'dev1', name: '核心R1',
        protocol: 'ssh', host: '127.0.0.1', port: 22,
        commands: ['display version'], password: 'p1',
        sysinfo: { ifTable: true, community: 'c', intervalSec: 30, snmpPort: port }
      });
      ok(rs.ok === true, '接口流量任务启动成功');
      const job = mm.jobs.get('dev1@127.0.0.1');
      // 首次采样：只有计数器基线，无速率、无状态事件
      await mm._pollIfTable(job);
      eq(job.ifHist.length, 1, '首采样入历史');
      eq(traffics.length, 1, '首采样广播 iftraffic');
      eq(traffics[0].ifs.length, 3, '采样含 3 个接口');
      eq(traffics[0].ifs[0].oper, 'up', '接口 1 状态 up');
      eq(traffics[0].ifs[1].oper, 'down', '接口 2 状态 down（首采样基线不报事件）');
      eq(traffics[0].ifs[0].in, null, '首采样无速率');
      eq(statuses.length, 0, '首采样不发状态事件');
      // 第二次采样：计数器增长 → 速率；接口 2 恢复 → 状态事件
      await sleep(1100);
      counters[1] += 12500000; outCounters[1] += 1250000;
      counters[2] += 625000; outCounters[2] += 625000;
      counters[3] += 0; outCounters[3] += 0;
      operMap[2] = 1;
      await mm._pollIfTable(job);
      eq(job.ifHist.length, 2, '第二采样入历史');
      const if1 = traffics[1].ifs.find(x => x.i === 1);
      ok(Number.isFinite(if1.in) && if1.in > 0, '计数器差值算出正速率（' + if1.in + ' bps）');
      const if3 = traffics[1].ifs.find(x => x.i === 3);
      eq(if3.in, 0, '计数器无增长速率为 0');
      eq(statuses.length, 1, '接口恢复产生 ifstatus 事件');
      eq(statuses[0].changes[0].name, 'GE0/0/2', '状态事件携带接口名');
      eq(statuses[0].changes[0].from + '>' + statuses[0].changes[0].to, 'down>up', '状态变化方向 down→up');
      ok(job.ifHist.length <= 120, '历史容量上限 120');
      mm.stopAll(); // 清理 snmp 定时器
      agent.close();
      fs.rmSync(tmpIf, { recursive: true, force: true });
    }

    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
})().then(() => {
  console.log('');
  console.log(`结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
