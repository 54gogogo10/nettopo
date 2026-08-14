/* NetTopo 设备后台静默监控 冒烟测试（Electron 端到端）
 * 用法：node test/smoke-monitor.js
 * 1) 本地 mock Telnet 服务器（127.0.0.1:2323）
 * 2) 以 NETTOPO_USERDATA 临时目录启动应用（--remote-debugging-port 随机，不污染真实数据）
 * 3) 加载示例拓扑 → 右键设备「设备监控（静默采集）…」配置 Telnet → 保存启用
 * 4) 断言：侧栏绿色标记出现、monitorStatus==monitoring、日志按日期归档且含时间戳
 * 5) 停止监控 → 断言标记消失
 */
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');

const CDP_PORT = 9600 + Math.floor(Math.random() * 200);
let failed = 0;
const ok = (cond, name) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; };

/* ---- mock telnet 服务器 ---- */
const mockSocks = new Set();
const mockServer = net.createServer((sock) => {
  mockSocks.add(sock);
  sock.on('close', () => mockSocks.delete(sock));
  sock.on('error', () => {});
  sock.on('data', (d) => {
    const txt = d.toString('utf8');
    if (txt.includes('show version')) sock.write('v9.9.9 MONITOR\r\nR1> ');
    else if (txt.includes('display time')) sock.write('2026-08-14 15:30:00\r\nR1> ');
    else if (txt.trim()) sock.write(txt.replace(/\r?\n$/, '') + '\r\nR1> ');
  });
  sock.write('\r\nWelcome to MONITOR-TELNET-READY\r\nR1> ');
});
mockServer.on('error', () => {});
/* 第二个 mock（127.0.0.2，多管理口测试）：SSH 服务器（不同协议/端口/账号密码） */
const sshHostKey = fs.readFileSync(path.join(root, 'node_modules', 'ssh2', 'test', 'fixtures', 'ssh_host_rsa_key'));
const mockServer2 = new (require('ssh2').Server)({ hostKeys: [sshHostKey] }, (client) => {
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'admin' && ctx.password === 'secret') ctx.accept();
    else ctx.reject();
  }).on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (a) => a());
      session.on('shell', (accept2) => {
        const stream = accept2();
        stream.write('SSH-MULTI-READY\r\n> ');
        stream.on('data', (d) => { const tx = d.toString(); if (tx.includes('show version')) stream.write('v9.9.9 SSH-MULTI\r\n> '); else if (tx.trim()) stream.write(tx.replace(/\r?\n$/, '') + '\r\n> '); });
        stream.on('close', () => stream.end());
      });
    });
  });
});
/* 第三个 mock（127.0.0.3，仅读取测试）：连接后不依赖命令，主动持续推送输出 */
const mockServer3 = net.createServer((sock) => {
  mockSocks.add(sock);
  sock.on('close', () => mockSocks.delete(sock));
  sock.on('error', () => {});
  sock.write('READY-PUSH\r\n');
  const timer = setInterval(() => { if (sock.destroyed) { clearInterval(timer); return; } sock.write('PUSH-DATA ' + Date.now() + '\r\n'); }, 400);
  sock.on('close', () => clearInterval(timer));
});
function listen(server, port, host) { return new Promise((res, rej) => { server.once('error', rej); server.listen(port, host || '127.0.0.1', res); }); }

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
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
    try {
      const list = await listTargets();
      const t = list.find(x => x.type === 'page' && x.url.includes(contains));
      if (t && t.webSocketDebuggerUrl) return t;
    } catch (e) { /* 未就绪 */ }
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

const ev = (nodeId, code) => {
  // 把 nodeId 以 JSON 字符串安全插入 eval 表达式
  return `(${code.replace(/@ID@/g, JSON.stringify(nodeId))})`;
};

(async () => {
  await listen(mockServer, 2323);
  await listen(mockServer2, 2322, '127.0.0.2');
  await listen(mockServer3, 2323, '127.0.0.3');
  console.log('mock telnet 127.0.0.1:2323 就绪');
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-smoke-mon-'));
  const profileDir = path.join(root, 'build', 'smoke_mon_profile');
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  const appExe = process.env.SMOKE_APP || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const appArgs = appExe.includes('portable') ? [] : ['.'];
  const proc = spawn(appExe,
    [...appArgs, '--remote-debugging-port=' + CDP_PORT, '--no-sandbox', '--user-data-dir=' + profileDir],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NETTOPO_USERDATA: tmpUserData } });
  let appLog = '';
  proc.stdout.on('data', d => { appLog += d.toString(); });
  proc.stderr.on('data', d => { appLog += d.toString(); });

  try {
    const main = await connectCDP(await waitTarget('index.html'));
    const t0 = Date.now();
    while (!(await main.eval('typeof __topo !== "undefined"')) && Date.now() - t0 < 20000) await sleep(300);
    ok(await main.eval('typeof __topo !== "undefined"'), '主窗口应用脚本就绪');
    ok(await main.eval('typeof window.topoMonitor !== "undefined"'), 'preload 桥 topoMonitor 已注入');

    await main.eval('__topo.loadSample(); true');
    await sleep(600);
    await main.eval(`(() => { const b = document.querySelector('[data-act=yes]'); if (b) b.click(); return true; })()`);
    await sleep(800);
    const nodeCount = await main.eval('document.querySelectorAll(\'.node\').length');
    ok(nodeCount > 0, '示例拓扑已载入（' + nodeCount + ' 节点）');
    const nodeId = await main.eval('__topo.state.nodes[0].id');
    const devName = await main.eval('__topo.state.nodes[0].name');

    // 右键第一个设备 → 打开「设备监控（静默采集）…」
    await main.eval(`(() => { const el = document.querySelector('.node[data-id]'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120 })); return true; })()`);
    await sleep(300);
    await main.eval(`(() => { const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('设备监控')); b && b.click(); return !!b; })()`);
    await sleep(300);
    ok(await main.eval(`!!document.getElementById('monHostList')`), '右键菜单打开「设备监控」配置弹窗');

    // 配置两个管理地址（各自独立连接方式）：Telnet 127.0.0.1:2323 + SSH 127.0.0.2:2322(admin/secret)
    await main.eval(`(() => {
      const setSel = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
      const rows = () => [...document.querySelectorAll('.mon-host-row')];
      // 第一行：Telnet 127.0.0.1:2323
      let r = rows()[0];
      r.querySelector('.mh-host').value = '127.0.0.1';
      setSel(r.querySelector('.mh-proto'), 'telnet');
      r.querySelector('.mh-port').value = '2323';
      r.querySelector('.mh-user').value = 'admin';
      // 增加第二行：SSH 127.0.0.2:2322（不同协议/端口/账号密码）
      document.querySelector('[data-act=addHost]').click();
      r = rows()[1];
      r.querySelector('.mh-host').value = '127.0.0.2';
      setSel(r.querySelector('.mh-proto'), 'ssh');
      r.querySelector('.mh-port').value = '2322';
      r.querySelector('.mh-user').value = 'admin';
      r.querySelector('.mh-pass').value = 'secret';
      // 每个地址独立命令：地址1 两条命令，地址2 一条不同命令
      rows()[0].querySelector('.mh-cmd-btn').click();
      rows()[0].querySelector('.mh-cmds').value = 'show version\\ndisplay time';
      rows()[1].querySelector('.mh-cmd-btn').click();
      rows()[1].querySelector('.mh-cmds').value = 'show version\\ndisplay clock';
      // 第三行：仅读取模式（不执行命令，只记录设备推送）
      document.querySelector('[data-act=addHost]').click();
      r = rows()[2];
      r.querySelector('.mh-host').value = '127.0.0.3';
      setSel(r.querySelector('.mh-proto'), 'telnet');
      r.querySelector('.mh-port').value = '2323';
      r.querySelector('.mh-ro-cb').checked = true;
      document.getElementById('monInterval').value = '2';
      document.getElementById('monCmdDelay').value = '0.5';
      document.getElementById('monEnable').checked = true;
      document.querySelector('[data-act=save]').click();
      return true;
    })()`);
    await sleep(1200);
    ok(!(await main.eval(`!!document.getElementById('monHostList')`)), '保存后配置弹窗关闭');

    // 等待监控建立与第一轮执行
    const waitState = async (s, ms) => { const tS = Date.now(); while (Date.now() - tS < ms) { if ((await main.eval('(__topo.monitorStatus[' + JSON.stringify(nodeId) + '] || {}).state')) === s) return true; await sleep(200); } return false; };
    ok(await waitState('monitoring', 12000), '监控状态变为 monitoring');
    ok((await main.eval('(__topo.monitorStatus[' + JSON.stringify(nodeId) + '] || {}).state')) === 'monitoring', 'monitorStatus 记录为 monitoring');
    // 多管理口：perHost 应同时包含三个地址（含仅读取）
    const perHost = await main.eval('(__topo.monitorStatus[' + JSON.stringify(nodeId) + '] || {}).perHost || {}');
    ok(!!perHost['127.0.0.1'] && !!perHost['127.0.0.2'] && !!perHost['127.0.0.3'], '三个管理地址均被监控（perHost 含 127.0.0.1/127.0.0.2/127.0.0.3）');
    ok(perHost['127.0.0.1'] && perHost['127.0.0.1'].state === 'monitoring' && perHost['127.0.0.2'] && perHost['127.0.0.2'].state === 'monitoring' && perHost['127.0.0.3'] && perHost['127.0.0.3'].state === 'monitoring', '三个管理口状态均为 monitoring');

    // 侧栏该设备项出现绿色标记
    const badgeCls = async () => (await main.eval('(() => { const it = [...document.querySelectorAll(\'.pitem\')].find(x => x.dataset.id === ' + JSON.stringify(nodeId) + '); return it ? ((it.querySelector(\'.mon-badge\') || {}).className || \'\') : \'\'; })()'));
    const tBadge = Date.now(); let cls = '';
    while (Date.now() - tBadge < 6000) { cls = await badgeCls(); if (cls.indexOf('ok') >= 0) break; await sleep(200); }
    ok(cls.indexOf('ok') >= 0, '侧栏设备项显示绿色监控标记（' + cls + '）');

    // 日志文件存在且按日期归档、含时间戳与命令回显
    await sleep(2500);
    const findLogs = (() => {
      const dir = path.join(tmpUserData, 'monitor-logs');
      const out = [];
      const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.log')) out.push(p);
        }
      };
      walk(dir);
      return out;
    })();
    ok(findLogs.length >= 3, '三个管理口各自生成独立日志文件（' + findLogs.length + ' 个）');
    ok(findLogs.some(p => /\d{4}-\d{2}-\d{2}/.test(p)), '日志按日期目录归档（YYYY-MM-DD）');
    const files = findLogs.map(p => fs.readFileSync(p, 'utf8'));
    const all = files.join('\n');
    // 仅读取地址（127.0.0.3）日志：含设备主动推送，且不含任何命令标记
    const roLog = files.find(f => f.indexOf('PUSH-DATA') >= 0) || '';
    ok(roLog.indexOf('PUSH-DATA') >= 0, '仅读取地址收到设备主动推送（PUSH-DATA）');
    ok(roLog.indexOf('>> ') < 0, '仅读取地址日志不含命令标记（未执行任何命令）');
    ok(roLog.indexOf('READY-PUSH') >= 0, '仅读取地址记录连接欢迎信息');
    ok(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/.test(all), '日志逐行带时间戳前缀');
    ok(all.indexOf('>> show version') >= 0 && all.indexOf('v9.9.9 MONITOR') >= 0, '日志含命令标记与回显（第一管理口）');
    ok(all.indexOf('v9.9.9 SSH-MULTI') >= 0, '第二管理口（SSH）回显写入独立日志'); // SSH mock 对 show version 的响应（smoke 早期地址2命令亦含 show version）
    ok(all.indexOf('v9.9.9 MONITOR') >= 0, '第一管理口（Telnet）回显写入独立日志');
    ok(all.indexOf('SSH-MULTI-READY') >= 0, 'SSH 会话欢迎信息写入日志');
    // 每个地址独立命令：地址1 含 display time，地址2 含 display clock（互不共享）
    ok(all.indexOf('display time') >= 0, '地址1 的独立命令 display time 已执行并记录');
    ok(all.indexOf('display clock') >= 0, '地址2 的独立命令 display clock 已执行并记录');
    const noMixed = files.every(f => !(f.indexOf('display time') >= 0 && f.indexOf('display clock') >= 0));
    ok(noMixed && files.some(f => f.indexOf('display time') >= 0) && files.some(f => f.indexOf('display clock') >= 0), '两地址命令互不混入对方日志（各自独立）');
    // 验证配置确实按地址分开：重新打开弹窗时应能看到两个地址各自的命令
    await main.eval(`(() => { const el = document.querySelector('.node[data-id]'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120 })); return true; })()`);
    await sleep(250);
    await main.eval(`(() => { const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('设备监控')); b && b.click(); return !!b; })()`);
    await sleep(300);
    const cmds0 = await main.eval(`document.querySelectorAll('.mh-cmds')[0] ? document.querySelectorAll('.mh-cmds')[0].value : ''`);
    const cmds1 = await main.eval(`document.querySelectorAll('.mh-cmds')[1] ? document.querySelectorAll('.mh-cmds')[1].value : ''`);
    ok(cmds0.indexOf('display time') >= 0, '弹窗回显：地址1 命令列表独立（含 display time）');
    ok(cmds1.indexOf('display clock') >= 0 && cmds1.indexOf('display time') < 0, '弹窗回显：地址2 命令列表独立（含 display clock，不含地址1 的 display time）');
    await main.eval(`(() => { const b = [...document.querySelectorAll('#modalRoot [data-act]')].find(x => x && x.getAttribute && x.getAttribute('data-act') === 'cancel'); if (b) b.click(); return true; })()`);
    await sleep(200);

    // 停止监控 → 标记消失
    await main.eval('__topo.applyMonitor(' + JSON.stringify(nodeId) + ', __topo.monitorCfg[' + JSON.stringify(nodeId) + '], false)');
    const tStop = Date.now(); let gone = false;
    while (Date.now() - tStop < 5000) { if (!(await badgeCls()).length) { gone = true; break; } await sleep(200); }
    ok(gone, '停止后侧栏监控标记消失');
    ok((await main.eval('(window.__topo.monitorStatus[' + JSON.stringify(nodeId) + '] === undefined)')) === true, '停止后 monitorStatus 中该设备已移除');

    main.ws.close();
  } catch (e) {
    console.error('冒烟测试异常：', e);
    failed++;
  } finally {
    try { require('child_process').execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { try { proc.kill(); } catch (e2) {} }
    for (const s of mockSocks) s.destroy();
    mockServer.close();
    try { mockServer2.close(); } catch (e) {}
    await sleep(600);
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
    console.log('app stderr 异常: ' + (appLog.includes('Error') ? appLog.split('\n').filter(l => l.includes('Error')).slice(0, 3).join(' | ') : '无'));
  }
  console.log('');
  console.log('结果：' + (failed ? failed + ' 项失败' : '全部通过'));
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
