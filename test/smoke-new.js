/* NetTopo 新功能冒烟测试：在线探测 / 输出告警 / 配置自动备份 / 日志浏览器 / 冲突检查 / 多厂商
 * 用法：node test/smoke-new.js（与其他冒烟测试串行运行，占用 2323/2324 端口）
 */
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');

const CDP_PORT = 9700 + Math.floor(Math.random() * 150);
let failed = 0;
const ok = (cond, name) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; };

/* ---- mock telnet 会话服务器（127.0.0.1:2323） ---- */
let alertOn = true;
let configVer = 1;
const sessionServer = net.createServer((sock) => {
  sock.on('error', () => {});
  sock.on('data', (d) => {
    const txt = d.toString('utf8');
    if (txt.includes('display version')) sock.write('v9.9.9 NEW-FEATURES\r\nR1> ');
    else if (txt.includes('show status')) sock.write(alertOn ? 'port down\nERROR: ifdown\r\nR1> ' : 'port up\nall good\r\nR1> ');
    else if (txt.includes('display current-configuration')) sock.write('hostname SW2\ninterface GE0/0/1\n port link-type access\n port default vlan ' + (configVer === 1 ? '10' : '13') + '\n#\r\nR1> ');
    else if (txt.trim()) sock.write(txt.replace(/\r?\n$/, '') + '\r\nR1> ');
  });
  sock.write('\r\nWELCOME NEW\r\nR1> ');
});
sessionServer.on('error', () => {});
/* ---- 探测目标服务器（127.0.0.1:2324，可关闭以模拟离线） ---- */
const probeServer = net.createServer((sock) => { sock.on('error', () => {}); });
probeServer.on('error', () => {});
function listen(server, port, host) { return new Promise((res, rej) => { server.once('error', rej); server.listen(port, host || '127.0.0.1', res); }); }

/* ---- CDP ---- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function listTargets() {
  return await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + CDP_PORT + '/json/list', (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve([]); } });
    }).on('error', reject);
  });
}
async function waitTarget(contains, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const list = await listTargets(); const t = list.find(x => x.type === 'page' && x.url.includes(contains)); if (t && t.webSocketDebuggerUrl) return t; } catch (e) {}
    await sleep(300);
  }
  throw new Error('未找到目标窗口: ' + contains);
}
async function connectCDP(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  return cdp;
}

(async () => {
  await listen(sessionServer, 2323);
  await listen(probeServer, 2324);
  console.log('mock 就绪：telnet 2323 / probe 2324');
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-smoke-new-'));
  const profileDir = path.join(root, 'build', 'smoke_new_profile');
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  const appExe = process.env.SMOKE_APP || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const appArgs = appExe.includes('portable') ? [] : ['.'];
  const proc = spawn(appExe,
    [...appArgs, '--remote-debugging-port=' + CDP_PORT, '--no-sandbox', '--user-data-dir=' + profileDir],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NETTOPO_USERDATA: tmpUserData } });
  let cdp = null;
  try {
    cdp = await connectCDP(await waitTarget('index.html'));
    const t0 = Date.now();
    while (!(await cdp.eval('typeof __topo !== "undefined" && typeof TopoUtil !== "undefined"')) && Date.now() - t0 < 20000) await sleep(300);
    await cdp.eval('__topo.loadSample(); true'); await sleep(600);
    await cdp.eval('(()=>{ const b=document.querySelector("[data-act=yes]"); if(b) b.click(); return true; })()'); await sleep(600);
    const dev = await cdp.eval("(()=>{ const n = __topo.state.nodes.find(x => String(x.name).indexOf('SW2') >= 0) || __topo.state.nodes[0]; return { id: n.id, name: n.name }; })()");
    console.log('目标设备：', JSON.stringify(dev));
    const devName = String(dev.name);

    const cfg = {
      hosts: [{ host: '127.0.0.1', protocol: 'telnet', port: '2323', username: 'admin', password: '',
        commands: ['display version', 'show status'], readOnly: false,
        probeEnabled: true, probeType: 'tcp', probeIntervalSec: 5, probePort: 2324,
        alerts: [{ pattern: 'error|down', note: '接口异常' }],
        backupEnabled: true, backupCommand: 'display current-configuration', backupIntervalSec: 3600, backupWaitSec: 1 }],
      intervalSec: 1, cmdDelayMs: 300
    };
    const startRes = await cdp.eval('__topo.applyMonitor(' + JSON.stringify(dev.id) + ', ' + JSON.stringify(cfg) + ', true)');
    ok(startRes === true, '启动监控（applyMonitor）');
    await sleep(4000);

    let st = await cdp.eval("(()=>{ const ms = __topo.state.monitorStatus[" + JSON.stringify(dev.id) + "]; const h = ms && ms.perHost && ms.perHost['127.0.0.1']; return { state: ms && ms.state, probeOk: h && h.probeOk, alert: h && h.alert, text: ms && ms.text }; })()");
    ok(st && st.probeOk === true, '探测在线（TCP 2324，probeOk=' + st.probeOk + '）');
    ok(st && st.alert === 'error|down', '输出告警触发（alert=' + st.alert + '）');
    ok(st && st.state === 'alert', '设备聚合状态 alert（实际 ' + st.state + '）');
    const badge = await cdp.eval("document.querySelector('.mon-badge.alert') ? true : false");
    ok(badge, '侧栏告警徽标（.mon-badge.alert）出现');

    probeServer.close();
    await sleep(7000);
    st = await cdp.eval("(()=>{ const ms = __topo.state.monitorStatus[" + JSON.stringify(dev.id) + "]; const h = ms && ms.perHost && ms.perHost['127.0.0.1']; return { state: ms && ms.state, probeOk: h && h.probeOk }; })()");
    ok(st && st.probeOk === false, '探测离线（probeOk=false）');
    ok(st && st.state === 'alert', '告警优先级高于离线（state=' + st.state + '）');

    alertOn = false;
    await sleep(4000);
    st = await cdp.eval("(()=>{ const ms = __topo.state.monitorStatus[" + JSON.stringify(dev.id) + "]; const h = ms && ms.perHost && ms.perHost['127.0.0.1']; return { state: ms && ms.state, alert: h && h.alert }; })()");
    ok(st && st.alert === null, '告警恢复（alert=null）');
    ok(st && st.state === 'offline', '状态回落为离线（state=' + st.state + '）');
    const badgeOff = await cdp.eval("document.querySelector('.mon-badge.off') ? true : false");
    ok(badgeOff, '侧栏离线徽标（.mon-badge.off）出现');

    await listen(probeServer, 2324);
    await sleep(7000);
    st = await cdp.eval("(()=>{ const ms = __topo.state.monitorStatus[" + JSON.stringify(dev.id) + "]; const h = ms && ms.perHost && ms.perHost['127.0.0.1']; return { state: ms && ms.state, probeOk: h && h.probeOk }; })()");
    ok(st && st.probeOk === true && st.state === 'monitoring', '探测恢复（state=' + st.state + '）');
    const badge2 = await cdp.eval("document.querySelector('.mon-badge.ok') ? true : false");
    ok(badge2, '侧栏恢复绿色徽标');

    let hosts = await cdp.eval('window.topoConfigBackup.hosts()');
    let h = (hosts && hosts.ok && hosts.items || []).find(x => x.device === devName && x.host === '127.0.0.1');
    ok(!!h && h.count === 1, '自动备份已生成 1 份（' + (h && h.last) + '）');
    configVer = 2;
    const rb = await cdp.eval('window.topoMonitor.runBackup(' + JSON.stringify(devName + '@127.0.0.1') + ')');
    ok(rb && rb.ok === true, '立即备份触发成功');
    await sleep(2500);
    hosts = await cdp.eval('window.topoConfigBackup.hosts()');
    h = (hosts && hosts.ok && hosts.items || []).find(x => x.device === devName && x.host === '127.0.0.1');
    ok(!!h && h.count === 2, '第二轮备份已生成（共 ' + (h && h.count) + ' 份）');
    const list = await cdp.eval('window.topoConfigBackup.list(' + JSON.stringify(devName) + ", '127.0.0.1')");
    const files = (list && list.ok && list.items || []).map(i => i.name);
    const d = await cdp.eval('window.topoConfigBackup.diff(' + JSON.stringify(devName) + ", '127.0.0.1', " + JSON.stringify(files[1]) + ', ' + JSON.stringify(files[0]) + ')');
    ok(d && d.ok && d.changed === true && d.added === 1 && d.removed === 1, '备份差异 +1/-1（+' + d.added + '/-' + d.removed + '）');

    const tree = await cdp.eval('window.topoMonitor.logsTree()');
    const devNode = (tree && tree.ok && tree.devices || []).find(x => x.device === devName);
    ok(!!devNode && devNode.dates.length > 0, '日志树包含设备与日期');
    const date0 = devNode.dates[0].date;
    const file0 = devNode.dates[0].files[0].name;
    const log = await cdp.eval('window.topoMonitor.logsRead(' + JSON.stringify(devName) + ', ' + JSON.stringify(date0) + ', ' + JSON.stringify(file0) + ')');
    ok(log && log.ok && log.content.indexOf('开始后台监控') >= 0 && log.content.indexOf('【告警】') >= 0, '日志内容含监控开始与告警标记');
    const logBad = await cdp.eval('window.topoMonitor.logsRead(' + JSON.stringify(devName) + ', ' + JSON.stringify(date0) + ", '../evil.log')");
    ok(logBad && logBad.ok === false, '非法日志路径被拒绝');

    const chk1 = await cdp.eval('TopoUtil.checkConfigs(__topo.state.nodes, __topo.state.links)');
    ok(chk1 && Array.isArray(chk1.issues) && chk1.ok === true && chk1.issues.length >= 4, '示例拓扑冲突检查通过（' + chk1.issues.length + ' 条警告，无错误）');
    const chk2 = await cdp.eval("(()=>{ const l0 = __topo.state.links[0], l1 = __topo.state.links[1]; if (!l1) return null; const saved0 = { aIp: l0.aIp }, saved1 = { aIp: l1.aIp }; l0.aIp = '10.99.99.99'; l1.aIp = '10.99.99.99'; const r = TopoUtil.checkConfigs(__topo.state.nodes, __topo.state.links); l0.aIp = saved0.aIp; l1.aIp = saved1.aIp; return r; })()");
    ok(chk2 && chk2.ok === false && chk2.issues.some(i => i.level === 'error' && i.msg.indexOf('10.99.99.99') >= 0), 'IP 重复被检出（error）');

    const h3c = await cdp.eval("TopoUtil.generateConfigs(__topo.state.nodes, __topo.state.links, 'h3c', { vlan: true, routes: true })");
    const ruijie = await cdp.eval("TopoUtil.generateConfigs(__topo.state.nodes, __topo.state.links, 'ruijie', { vlan: true, routes: true })");
    const cisco = await cdp.eval("TopoUtil.generateConfigs(__topo.state.nodes, __topo.state.links, 'cisco', { vlan: true, routes: true })");
    const huawei = await cdp.eval("TopoUtil.generateConfigs(__topo.state.nodes, __topo.state.links, 'huawei', { vlan: true, routes: true })");
    await cdp.eval("(()=>{ const l = __topo.state.links[0]; window.__savedLink = { aL2: l.aL2, bL2: l.bL2, aVlan: l.aVlan, bVlan: l.bVlan, aVlanMode: l.aVlanMode, bVlanMode: l.bVlanMode, aIp: l.aIp, bIp: l.bIp }; l.aL2 = true; l.bL2 = true; l.aVlan = '10,20'; l.bVlan = '10,20'; l.aVlanMode = 'trunk'; l.bVlanMode = 'trunk'; l.aIp = ''; l.bIp = ''; return true; })()");
    const h3c2 = await cdp.eval("TopoUtil.generateConfigs(__topo.state.nodes, __topo.state.links, 'h3c', { vlan: true })");
    const ruijie2 = await cdp.eval("TopoUtil.generateConfigs(__topo.state.nodes, __topo.state.links, 'ruijie', { vlan: true })");
    const hw2 = await cdp.eval("TopoUtil.generateConfigs(__topo.state.nodes, __topo.state.links, 'huawei', { vlan: true })");
    const cs2 = await cdp.eval("TopoUtil.generateConfigs(__topo.state.nodes, __topo.state.links, 'cisco', { vlan: true })");
    ok(hw2.indexOf('port trunk allow-pass vlan 10 20') >= 0, '华为二层 trunk（port trunk allow-pass vlan 10 20）');
    ok(h3c2.indexOf('port trunk permit vlan 10 20') >= 0, 'H3C 二层 trunk（port trunk permit vlan 10 20）');
    ok(ruijie2.indexOf('switchport trunk allowed vlan 10,20') >= 0, '锐捷二层 trunk（switchport trunk allowed vlan 10,20）');
    ok(cs2.indexOf('switchport trunk allowed vlan 10,20') >= 0, 'Cisco 二层 trunk（switchport trunk allowed vlan 10,20）');
    await cdp.eval("(()=>{ const l = __topo.state.links[0]; const sv = window.__savedLink; l.aL2 = sv.aL2; l.bL2 = sv.bL2; l.aVlan = sv.aVlan; l.bVlan = sv.bVlan; l.aVlanMode = sv.aVlanMode; l.bVlanMode = sv.bVlanMode; l.aIp = sv.aIp; l.bIp = sv.bIp; return true; })()");
    ok(cisco !== huawei && cisco.indexOf('no shutdown') >= 0, 'Cisco 与华为输出不同（no shutdown）');

    cdp.ws.close();
  } catch (err) {
    console.error('测试异常：', err && err.stack || err);
    failed++;
  } finally {
    try { require('child_process').execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { try { proc.kill(); } catch (e2) {} }
    await sleep(600);
    try { sessionServer.close(); } catch (e) {}
    try { probeServer.close(); } catch (e) {}
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(''); console.log('新功能冒烟测试：' + (failed ? failed + ' 项失败' : '全部通过'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });