/* NetTopo 网络服务冒烟测试（Electron 端到端）
 * 用法：node test/smoke-services.js
 * 1) 以 NETTOPO_USERDATA 临时目录启动应用（--remote-debugging-port=随机，不污染真实数据目录）
 * 2) 主窗口：验证 window.topoNetSvc 桥 → setConfig 启用 TFTP/FTP/Syslog（探测空闲端口）
 * 3) 从测试进程发起真实协议流量：TFTP WRQ 上传、FTP PASV+STOR 上传、UDP syslog 发送
 * 4) UI：打开「网络服务」面板，验证服务状态点 / 接收文件表 / Syslog 实时视图 / 导入配置备份库
 * 5) 截图走查：test/shot_services.png（接收文件页）与 test/shot_services_syslog.png（日志页）
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const root = path.join(__dirname, '..');

const CDP_PORT = 9700 + Math.floor(Math.random() * 200);
let failed = 0;
const ok = (cond, name) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; };

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
  await cdp.send('Page.enable');
  return cdp;
}
const freeUdpPort = () => new Promise((res) => { const s = dgram.createSocket('udp4'); s.bind(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const freeTcpPort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

/** 最小 TFTP 客户端（WRQ，无选项）：成功返回 true */
async function tftpPut(port, name, content) {
  const sock = dgram.createSocket('udp4');
  try {
    const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; };
    const send = (buf, p) => new Promise((res) => sock.send(buf, 0, buf.length, p, '127.0.0.1', res));
    const recv = () => new Promise((res) => { const t = setTimeout(() => res(null), 4000); sock.once('message', (b, ri) => { clearTimeout(t); res({ b, ri }); }); });
    await send(Buffer.concat([Buffer.from([0, 2]), Buffer.from(name + '\0octet\0')]), port);
    const r0 = await recv();
    if (!r0 || r0.b.readUInt16BE(0) !== 4) return false;
    const rp = r0.ri.port;
    const buf = Buffer.from(content);
    for (let off = 0, blk = 1; ; blk++) {
      const chunk = buf.slice(off, off + 512);
      await send(Buffer.concat([Buffer.from([0, 3]), u16(blk), chunk]), rp);
      const a = await recv();
      if (!a || a.b.readUInt16BE(0) !== 4 || a.b.readUInt16BE(2) !== blk) return false;
      off += 512;
      if (chunk.length < 512) return true;
    }
  } finally { try { sock.close(); } catch (e) { /* ignore */ } }
}

(async () => {
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-smoke-svc-'));
  const profileDir = path.join(root, 'build', 'smoke_svc_profile');
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
    ok(await main.eval('typeof window.topoNetSvc !== "undefined"'), 'preload 桥 topoNetSvc 已注入');
    ok((await main.eval('window.topoNetSvc.getConfig()')).ok === true, 'netsvc:get 基础 IPC 连通');

    // 载入示例拓扑（给导入备份流程准备设备）
    await main.eval('__topo.loadSample()');
    await sleep(300);

    // 探测空闲端口并启用三服务（走真实 IPC：主进程落 settings.json 并启动监听）
    const tPort = await freeUdpPort(), fPort = await freeTcpPort(), sPort = await freeUdpPort();
    const setR = await main.eval(`window.topoNetSvc.setConfig({
      tftp: { enabled: true, port: ${tPort} },
      ftp: { enabled: true, port: ${fPort}, username: 'op', password: 'secret' },
      syslog: { enabled: true, port: ${sPort}, tcp: true }
    })`);
    ok(setR && setR.ok === true, 'setConfig 保存并应用');
    ok(setR.status.tftp.running === true && setR.status.tftp.port === tPort, 'TFTP 主进程监听运行');
    ok(setR.status.ftp.running === true && setR.status.ftp.port === fPort, 'FTP 主进程监听运行');
    ok(setR.status.syslog.running === true && setR.status.syslog.tcp === true, 'Syslog 主进程监听运行（UDP+TCP）');

    // 真实协议流量打到运行中的应用
    const cfgText = '!\nversion 15.2\nhostname SW-SMOKE\nsnmp-agent community read public\ninfo-center loghost 127.0.0.1\n!\nend\n';
    ok(await tftpPut(tPort, 'smoke-tftp.cfg', cfgText), 'TFTP WRQ 上传到应用主进程');
    // FTP：上面 ftpStor 为骨架，这里直接内联完整流程
    const ftpOk = await (async () => {
      const sock = net.connect(fPort, '127.0.0.1');
      const queue = []; let resolve = null; let buf = ''; let group = [];
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        for (;;) {
          const i = buf.indexOf('\r\n');
          if (i < 0) break;
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          group.push(line);
          if (/^\d{3} /.test(line)) { const t = group.join('\n'); group = []; const w = resolve; resolve = null; if (w) w(t); else queue.push(t); }
        }
      });
      const resp = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r, rej) => { resolve = r; setTimeout(() => rej(new Error('FTP 超时')), 6000); });
      const cmd = async (l) => { const p = resp(); sock.write(l + '\r\n'); return p; };
      await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
      try {
        await resp();
        await cmd('USER op');
        if (!(await cmd('PASS secret')).startsWith('230')) return false;
        const pm = (await cmd('PASV')).match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
        if (!pm) return false;
        const dport = parseInt(pm[5], 10) * 256 + parseInt(pm[6], 10);
        const data = net.connect(dport, '127.0.0.1');
        data.on('error', () => {});
        await new Promise((res, rej) => { data.once('connect', res); data.once('error', rej); });
        const p150 = resp();
        sock.write('STOR smoke-ftp.cfg\r\n');
        const r150 = await p150;
        data.write(Buffer.from(cfgText));
        data.end();
        const r226 = await resp();
        await cmd('QUIT');
        return r150.startsWith('150') && r226.startsWith('226');
      } finally { try { sock.destroy(); } catch (e) { /* ignore */ } }
    })();
    ok(ftpOk, 'FTP PASV+STOR 上传到应用主进程');
    {
      const us = dgram.createSocket('udp4');
      const sendU = (msg) => new Promise((res) => us.send(Buffer.from(msg), 0, Buffer.byteLength(msg), sPort, '127.0.0.1', res));
      await sendU('<189>Oct 12 22:14:15 SW-SMOKE %%01SEC/4/SMOKE(l): smoke syslog message NETSVC-SMOKE-KEY');
      await sendU('<134>Oct 12 22:14:16 SW-SMOKE sshd[42]: Accepted password for admin');
      await sleep(400);
      try { us.close(); } catch (e) { /* ignore */ }
    }
    const tailR = await main.eval('window.topoNetSvc.syslogTail(0)');
    ok(tailR && (tailR.msgs || []).length >= 2 && tailR.msgs.some(m => m.msg.includes('NETSVC-SMOKE-KEY')), 'Syslog 消息入环形缓冲（severity=5）');
    ok(tailR.msgs[0].host === 'SW-SMOKE' && tailR.msgs[0].severity === 5, 'Syslog 解析：host/severity 正确');

    // 收到的文件编目 / 读取 / 导入备份库（真实 IPC）
    const filesR = await main.eval('window.topoNetSvc.files()');
    const items = (filesR && filesR.items) || [];
    ok(items.length === 2 && items.some(i => i.svc === 'tftp' && i.name === 'smoke-tftp.cfg') && items.some(i => i.svc === 'ftp' && i.name === 'smoke-ftp.cfg'), '接收文件编目（TFTP+FTP）');
    const readR = await main.eval('window.topoNetSvc.fileRead({ svc: "tftp", ip: "127.0.0.1", name: "smoke-tftp.cfg" })');
    ok(readR && readR.ok && readR.content === cfgText, '读取收到的文件内容');
    const impR = await main.eval('window.topoNetSvc.importBackup({ svc: "tftp", ip: "127.0.0.1", name: "smoke-tftp.cfg", device: "SW-SMOKE", host: "192.168.56.1" })');
    ok(impR && impR.ok === true, '导入配置备份库');
    const hostsR = await main.eval('window.topoConfigBackup.hosts()');
    ok((hostsR && hostsR.items || []).some(h => h.device === 'SW-SMOKE'), '备份库出现该设备');

    // UI：网络服务面板
    await main.eval('__topo.openNetServices()');
    await sleep(700);
    ok(await main.eval('!!document.querySelector(".nsv-dialog")'), '网络服务面板打开');
    ok(await main.eval('document.querySelectorAll(".nsv-card").length === 3'), '三张服务卡片渲染');
    ok(await main.eval('document.querySelectorAll("#nsvIps .nsv-ip").length >= 1'), '本机地址列表展示');
    ok(await main.eval('document.querySelectorAll("#nsvFiles .nsv-fr").length === 2'), '接收文件表渲染 2 行');
    ok(await main.eval('[...document.querySelectorAll("#nsvFiles .nsv-fr")].some(r => r.textContent.includes("smoke-ftp.cfg"))'), '文件表包含 FTP 文件');
    ok(await main.eval('document.querySelector("#nsvTftpSt").textContent.includes("运行中")'), 'TFTP 状态点文本「运行中」');
    // 截图走查：接收文件页
    const shot1 = await main.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'shot_services.png'), Buffer.from(shot1.data, 'base64'));
    console.log('  📷 截图：test/shot_services.png');

    // UI：导入备份（点击文件行「导入备份」→ 选设备确认）
    await main.eval('[...document.querySelectorAll("#nsvFiles .nsv-fr .ops button")].find(b => b.dataset.op === "imp").click()');
    await sleep(300);
    ok(await main.eval('!!document.querySelector("#nsvImpDev")'), '导入对话框弹出（设备下拉）');
    await main.eval('document.querySelector("#nsvImpDev").value = document.querySelector("#nsvImpDev").options[0].value');
    await main.eval('document.querySelector("#nsvImpHost").value = "192.168.56.2"');
    await main.eval('[...document.querySelectorAll(".overlay")].pop().querySelector(\'[data-act=ok]\').click()');
    await sleep(500);
    const hostsR2 = await main.eval('window.topoConfigBackup.hosts()');
    ok((hostsR2 && hostsR2.items || []).length >= 2, 'UI 导入后备份库新增设备条目');

    // UI：Syslog 标签页
    await main.eval('[...document.querySelectorAll(".nsv-tabs .mc-tab")].find(t => t.dataset.pane === "syslog").click()');
    await sleep(900);
    const logCnt = await main.eval('document.querySelectorAll("#nsvLog .nsv-lg").length');
    ok(logCnt >= 2, 'Syslog 实时视图渲染（' + logCnt + ' 行）');
    ok(await main.eval('[...document.querySelectorAll("#nsvLog .nsv-lg")].some(l => l.textContent.includes("NETSVC-SMOKE-KEY"))'), '实时视图含测试消息');
    const shot2 = await main.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'shot_services_syslog.png'), Buffer.from(shot2.data, 'base64'));
    console.log('  📷 截图：test/shot_services_syslog.png');

    // UI：检索历史 syslog
    await main.eval('document.querySelector("#nsvLogKw").value = "NETSVC-SMOKE-KEY"');
    await main.eval('document.querySelector("#nsvLogSearch").click()');
    await sleep(400);
    ok(await main.eval('[...document.querySelectorAll("#nsvLog .nsv-lg")].some(l => l.textContent.includes("命中 1 条"))'), '关键字检索命中');

    // 停用全部（走 UI 保存并应用）
    await main.eval('document.querySelector(\'[data-act=apply]\').disabled = false');
    await main.eval(`
      document.querySelector('#nsvTftpOn').checked = false;
      document.querySelector('#nsvFtpOn').checked = false;
      document.querySelector('#nsvSysOn').checked = false;
      document.querySelector('.nsv-dialog [data-act=apply]').click()`);
    await sleep(600);
    const stOff = await main.eval('window.topoNetSvc.getConfig()');
    ok(stOff.status.tftp.running === false && stOff.status.ftp.running === false && stOff.status.syslog.running === false, 'UI 停用后三服务全部停止');

    console.log('');
    console.log(failed ? `结果：${failed} 项失败` : '结果：全部通过');
  } finally {
    try { proc.kill(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }, 500);
  }
  setTimeout(() => process.exit(failed ? 1 : 0), 800);
})().catch((err) => { console.error(err); process.exit(1); });
