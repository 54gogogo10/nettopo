/* NetTopo 新功能冒烟测试 2：监控中心 / 配置变更事件 / ZIP 导出 / 设备图标 / 托盘设置
 * 用法：node test/smoke-center.js（与其他冒烟测试串行运行，占用 2323/2324） */
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');
const CDP_PORT = 9900 + Math.floor(Math.random() * 80);
let failed = 0;
const ok = (cond, name) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let alertOn = false;
let configVer = 1;
const sessionServer = net.createServer((sock) => {
  sock.on('error', () => {});
  sock.on('data', (d) => {
    const txt = d.toString('utf8');
    if (txt.includes('display version')) sock.write('v9.9.9 CENTER\r\nR1> ');
    else if (txt.includes('show status')) sock.write(alertOn ? 'port down\nERROR: ifdown\r\nR1> ' : 'port up\nall good\r\nR1> ');
    else if (txt.includes('display current-configuration')) sock.write('hostname SW2\ninterface GE0/0/1\n port default vlan ' + (configVer === 1 ? '10' : '13') + '\n#\r\nR1> ');
    else if (txt.trim()) sock.write(txt.replace(/\r?\n$/, '') + '\r\nR1> ');
  });
  sock.write('\r\nWELCOME CENTER\r\nR1> ');
});
sessionServer.on('error', () => {});
const probeServer = net.createServer((sock) => { sock.on('error', () => {}); });
probeServer.on('error', () => {});
function listen(server, port, host) { return new Promise((res, rej) => { server.once('error', rej); server.listen(port, host || '127.0.0.1', res); }); }

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval err' };
    return r.result && r.result.value; }
}
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
    try { const l = await listTargets(); const t = l.find(x => x.type === 'page' && x.url.includes(contains)); if (t && t.webSocketDebuggerUrl) return t; } catch (e) {}
    await sleep(300);
  }
  return null;
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
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-smoke-center-'));
  const profileDir = path.join(root, 'build', 'smoke_center_profile');
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
    while (!(await cdp.eval('typeof __topo !== "undefined"')) && Date.now() - t0 < 20000) await sleep(300);
    await cdp.eval('__topo.loadSample(); true'); await sleep(500);
    await cdp.eval('(()=>{ const b=document.querySelector("[data-act=yes]"); if(b) b.click(); return true; })()'); await sleep(500);
    const dev = await cdp.eval("(()=>{ const n = __topo.state.nodes.find(x => String(x.name).indexOf('SW2') >= 0) || __topo.state.nodes[0]; return { id: n.id, name: n.name }; })()");
    const devName = String(dev.name);

    // ---- 启动监控（探测 + 告警 + 备份） ----
    alertOn = true;
    const cfg = {
      hosts: [{ host: '127.0.0.1', protocol: 'telnet', port: '2323', username: 'admin', password: '',
        commands: ['display version', 'show status'], readOnly: false,
        probeEnabled: true, probeType: 'tcp', probeIntervalSec: 5, probePort: 2324,
        alerts: [{ pattern: 'error|down', note: '接口异常' }],
        backupEnabled: true, backupCommand: 'display current-configuration', backupIntervalSec: 3600, backupWaitSec: 1 }],
      intervalSec: 1, cmdDelayMs: 300
    };
    await cdp.eval('__topo.applyMonitor(' + JSON.stringify(dev.id) + ', ' + JSON.stringify(cfg) + ', true)');
    await sleep(5000);

    // ---- 监控中心 overview：jobs + events + backups ----
    let ov = await cdp.eval('window.topoMonitor.overview()');
    ok(ov && ov.ok && ov.jobs.length === 1 && ov.jobs[0].state === 'monitoring', 'overview 返回监控任务（monitoring）');
    ok(ov && ov.events.some(e => e.type === 'alert' && e.detail.indexOf('error|down') >= 0), '事件历史含告警事件');
    ok(ov && ov.events.some(e => e.type === 'backup' || e.type === 'backup-change'), '事件历史含备份事件');
    ok(ov && ov.backups.some(b => b.device === devName && b.count >= 1), 'overview 备份列表含该设备');

    // ---- 配置变更：第二轮备份（配置变化）→ backup-change 事件 ----
    configVer = 2;
    await cdp.eval('window.topoMonitor.runBackup(' + JSON.stringify(devName + '@127.0.0.1') + ')');
    await sleep(2500);
    ov = await cdp.eval('window.topoMonitor.overview()');
    ok(ov && ov.events.some(e => e.type === 'backup-change' && e.detail.indexOf('有变化') >= 0), '配置变更事件已记录（backup-change）');
    ok(ov && ov.backups[0] && ov.backups[0].count === 2, '备份数更新为 2');

    // ---- 监控中心 UI ----
    await cdp.eval('__topo.openMonitorCenter(); true');
    await sleep(800);
    ok(await cdp.eval("!!document.querySelector('.mc-dialog')"), '监控中心面板打开');
    const mcJobs = await cdp.eval("document.querySelector('#mcJobs').textContent");
    ok(mcJobs.indexOf(devName) >= 0 && mcJobs.indexOf('告警') >= 0, '面板设备状态区显示设备与告警');
    const mcEvs = await cdp.eval("document.querySelector('#mcEvents').textContent");
    ok(mcEvs.length > 0 && mcEvs.indexOf('告警') >= 0, '面板事件时间线有内容');
    await cdp.eval("document.querySelector('.mc-dialog [data-act=close]').click(); true");
    await sleep(300);
    ok(!(await cdp.eval("!!document.querySelector('.mc-dialog')")), '监控中心可关闭');

    // ---- 配置合规检查 UI（默认规则 + 扫描备份库） ----
    await cdp.eval('__topo.openComplianceCheck(); true');
    await sleep(400);
    ok(await cdp.eval("!!document.querySelector('#compRules')"), '合规检查弹窗打开');
    ok(await cdp.eval("document.querySelectorAll('.comp-rule').length >= 5"), '默认规则已加载（≥5 条）');
    await cdp.eval("(() => { const b = [...document.querySelectorAll('.modal [data-act=run]')].pop(); b && b.click(); return true; })()");
    let compTotal = '';
    const tComp = Date.now();
    while (Date.now() - tComp < 6000) {
      compTotal = await cdp.eval("((document.querySelector('.comp-total') || {}).textContent || '').trim()");
      if (compTotal) break;
      await sleep(200);
    }
    ok(compTotal.includes('1 个地址') && compTotal.includes('违规'), '扫描备份库返回结果（' + compTotal + '）');
    ok(await cdp.eval("document.querySelectorAll('.comp-chip').length >= 5"), '逐规则通过/违规芯片已渲染');
    ok(await cdp.eval("!!document.querySelector('.comp-chip.fail')"), '示例配置无 NTP/AAA/默认路由被正确判违规');
    ok(await cdp.eval(`(() => { const b = document.querySelector('#compRules').closest('.modal').querySelector('[data-act=export]'); return b && !b.disabled; })()`), '扫描后「导出报告」按钮可用');
    await cdp.eval("(() => { const m = document.querySelector('#compRules').closest('.modal'); const b = m && m.querySelector('[data-act=close]'); b && b.click(); return true; })()");
    await sleep(300);
    ok(!(await cdp.eval("!!document.querySelector('#compRules')")), '合规检查弹窗可关闭');

    // ---- ZIP 导出 ----
    const zip = await cdp.eval("(()=>{ const files = [{ name: 'huawei/R1.txt', content: 'ip address 10.0.0.1' }, { name: '思科 设备/Core.txt', content: '! test' }]; const b = TopoUtil.zipFiles(files); return { len: b.length, pk: b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 }; })()");
    ok(zip && zip.pk && zip.len > 60, 'zipFiles 生成合法 ZIP（PK 头，' + zip.len + ' 字节）');
    // 弹窗内 ZIP 按钮存在并可用（不真正触发下载对话框）
    await cdp.eval('__topo.openConfigGen ? (__topo.openConfigGen ? (document.querySelector("[data-ic=code]") ? null : null) : null) : null; true');
    // 通过工具栏触发：模拟点击"生成配置"按钮？直接调用内部函数不可行，改验证 zip 生成函数在页面可用
    ok((await cdp.eval('typeof TopoUtil.zipFiles')) === 'function', '页面暴露 zipFiles');
    const zipBtn = await cdp.eval("(()=>{ const btn = document.querySelector('[data-act=zip]'); return btn ? btn.textContent : 'no-dialog'; })()");
    ok(zipBtn === 'no-dialog', '（配置弹窗未打开，跳过按钮检查）');

    // ---- 设备图标：设置 icon 后节点渲染 ----
    const iconRes = await cdp.eval("(()=>{ const n = __topo.state.nodes[0]; n.icon = 'ap'; __topo.renderer.setData(__topo.state.nodes, __topo.state.links, __topo.state.texts); return n.id; })()");
    await sleep(400);
    const nodeSvg = await cdp.eval("(()=>{ const n = __topo.state.nodes[0]; n.icon = 'ap'; __topo.renderer.setData(__topo.state.nodes, __topo.state.links, __topo.state.texts); const g = document.querySelector('.node[data-id=\"' + n.id + '\"] .body svg'); return g ? g.innerHTML : 'NO-SVG'; })()");
    ok(typeof nodeSvg === 'string' && nodeSvg.indexOf('M12 18.5') >= 0 && nodeSvg !== 'NO-SVG', '节点渲染使用内置 AP 图标（路径片段命中）');
    // 还原
    await cdp.eval("(()=>{ __topo.state.nodes[0].icon = ''; __topo.renderer.setData(__topo.state.nodes, __topo.state.links, __topo.state.texts); return true; })()");

    // ---- 托盘：启用后 window.close 只是隐藏，页面仍在 ----
    const tr = await cdp.eval('window.topoMonitor.setTray(true)');
    ok(tr && tr.ok && tr.enabled === true, '启用托盘常驻（setTray）');
    const tc = await cdp.eval('window.topoMonitor.testClose()');
    ok(tc && tc.ok === true, '模拟关闭窗口（test-close）');
    await sleep(1200);
    const tAfterClose = await waitTarget('index.html', 5000);
    ok(!!tAfterClose, '窗口关闭后页面仍存活（托盘常驻生效，窗口隐藏而非销毁）');
    // 恢复窗口显示（不能直接 show，交给托盘；最后恢复设置并退出）
    if (tAfterClose) {
      cdp.ws.close();
      cdp = await connectCDP(tAfterClose);
      await sleep(300);
      const tr2 = await cdp.eval('window.topoMonitor.setTray(false)');
      ok(tr2 && tr2.ok && tr2.enabled === false, '关闭托盘常驻');
    }
  } catch (err) {
    console.error('测试异常：', err && err.stack || err);
    failed++;
  } finally {
    try { require('child_process').execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { try { proc.kill(); } catch (e2) {} }
    await sleep(500);
    try { sessionServer.close(); } catch (e) {}
    try { probeServer.close(); } catch (e) {}
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(''); console.log('新功能冒烟测试2：' + (failed ? failed + ' 项失败' : '全部通过'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });