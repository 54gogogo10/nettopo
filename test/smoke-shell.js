/* NetTopo Web Shell 冒烟测试（Electron 端到端 · 独立窗口多标签）
 * 用法：node test/smoke-shell.js [SMOKE_APP=可执行文件]
 * 1) 本地 mock Telnet 服务器（127.0.0.1:2323）
 * 2) 启动应用（--remote-debugging-port=9333）
 * 3) 主窗口：右键设备 → Web Shell → 连接 → 不应锁定主界面
 * 4) 独立 Shell 窗口：标签出现、xterm 输出、输入回显、多标签切换、关闭标签
 */
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const root = path.join(__dirname, '..');

const CDP_PORT = 9333;
let failed = 0;
const ok = (cond, name) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failed++; };

/* ---- mock telnet 服务器 ---- */
const mockSocks = new Set();
const mockRecv = []; // { t, txt } 记录收到数据的时间戳（验证 \p 暂停）
const mockServer = net.createServer((sock) => {
  mockSocks.add(sock);
  sock.on('close', () => mockSocks.delete(sock));
  sock.on('error', () => {});
  sock.on('data', (d) => {
    const txt = d.toString('utf8');
    mockRecv.push({ t: Date.now(), txt });
    if (txt.includes('show version')) sock.write('v9.9.9 MOCK\r\n> ');
    else if (txt.trim()) sock.write(txt.replace(/\r?\n$/, '') + '\r\n> '); // 回显，便于验证粘贴
  });
  sock.write('\r\nWelcome to MOCK-TELNET-READY\r\n> ');
});
mockServer.on('error', () => {});

/* ---- 本地模拟设备管理 Web 页 ---- */
const webServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html><head><title>NetTopo Web Test</title></head><body>Hello from device web</body></html>');
});
function listen(server, port) { return new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); }); }

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

(async () => {
  await listen(mockServer, 2323);
  await listen(webServer, 2324);
  console.log('mock telnet 127.0.0.1:2323 / web 127.0.0.1:2324 就绪');

  const appExe = process.env.SMOKE_APP || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const appArgs = appExe.includes('portable') ? [] : ['.'];
  const profileDir = path.join(root, 'build', 'smoke_profile');
  try { require('fs').rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  const proc = spawn(appExe,
    [...appArgs, '--remote-debugging-port=' + CDP_PORT, '--no-sandbox', '--user-data-dir=' + profileDir],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NETTOPO_SMOKE: '1' } });
  let appLog = '';
  proc.stdout.on('data', d => { appLog += d.toString(); });
  proc.stderr.on('data', d => { appLog += d.toString(); });

  try {
    const main = await connectCDP(await waitTarget('index.html'));
    // 等待应用脚本完成（__topo 为 app.js 末尾注入的调试钩子）
    const t0 = Date.now();
    while (!(await main.eval('typeof __topo !== "undefined"')) && Date.now() - t0 < 15000) await sleep(300);
    ok(await main.eval('typeof __topo !== "undefined"'), '主窗口应用脚本就绪');
    await main.eval('__topo.loadSample(); true');
    await sleep(500);
    await main.eval(`(() => { const b = document.querySelector('[data-act=yes]'); if (b) b.click(); return true; })()`);
    await sleep(800);
    ok(await main.eval('document.querySelectorAll(".node").length') > 0, '示例拓扑已载入');

    // 主窗口：右键设备 → Web Shell → 连接
    const openShellDlg = async () => {
      await main.eval(`(() => { const el = document.querySelector('.node[data-id]'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 })); return true; })()`);
      await sleep(300);
      await main.eval(`(() => { const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('Web Shell')); b && b.click(); return !!b; })()`);
      await sleep(300);
    };

    // 多管理口：主机字段应为可选下拉，且包含全部地址
    await main.eval(`(() => { const n = __topo.state.nodes.find(x => document.querySelector('.node[data-id]').getAttribute('data-id') === x.id); n.mgmts = ['10.255.0.99']; return true; })()`);
    await openShellDlg();
    const dlgInfo = await main.eval(`(() => {
      const h = document.getElementById('wsHost');
      return { tag: h.tagName, opts: [...h.options].map(o => o.value) };
    })()`);
    ok(dlgInfo.tag === 'SELECT' && dlgInfo.opts.length === 2 && dlgInfo.opts[1] === '10.255.0.99', '多管理口下拉包含全部地址（' + dlgInfo.opts.join('|') + '）');
    await main.eval(`(() => { const b = document.querySelector('[data-act=cancel]'); if (b) b.click(); return true; })()`);
    await main.eval(`(() => { const n = __topo.state.nodes.find(x => document.querySelector('.node[data-id]').getAttribute('data-id') === x.id); n.mgmts = []; return true; })()`);
    await openShellDlg();
    ok(await main.eval(`document.getElementById('wsHost').tagName === 'INPUT'`), '单管理口回退为主机输入框');
    ok(await main.eval(`!!document.getElementById('wsProto')`), '主窗口连接参数弹窗已打开');
    await main.eval(`(() => {
      const proto = document.getElementById('wsProto');
      const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
      setVal(proto, 'telnet');
      document.getElementById('wsHost').value = '127.0.0.1';
      document.getElementById('wsPort').value = '2323';
      document.querySelector('[data-act=connect]').click();
      return true;
    })()`);
    await sleep(2500);
    const overlayInfo = await main.eval(`(() => { const o = document.querySelector('.overlay'); return o ? o.outerHTML.slice(0, 160) : ''; })()`);
    ok(overlayInfo === '', '主窗口连接后无遮罩（界面不锁定）' + (overlayInfo ? '（残留: ' + overlayInfo + '）' : ''));
    ok(await main.eval(`document.querySelectorAll('.node').length > 0`), '主窗口画布仍可交互（节点仍在）');

    // 独立 Shell 窗口出现
    const shellTarget = await waitTarget('shell.html');
    const shell = await connectCDP(shellTarget);
    await sleep(600);
    const tabInfo = await shell.eval(`(() => ({
      count: document.querySelectorAll('.sh-tab').length,
      title: (document.querySelector('.sh-tab .tt') || {}).textContent || '',
      text: (document.querySelector('.xterm-rows') || {}).textContent || ''
    }))()`);
    ok(tabInfo.count === 1, '独立 Shell 窗口出现 1 个标签');
    ok(tabInfo.title.includes('R1') && tabInfo.title.includes('TELNET'), '标签标题含设备名与协议（' + tabInfo.title + '）');
    const waitText = async (cdp, sel, needle, ms) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        if ((await cdp.eval(`(${sel} || {}).textContent || ''`)).includes(needle)) return true;
        await sleep(200);
      }
      return false;
    };
    ok(await waitText(shell, `document.querySelector('.xterm-rows')`, 'MOCK-TELNET-READY', 5000), 'xterm 渲染服务器欢迎信息');

    // 输入命令 → 回显
    await shell.eval(`(() => { const ta = document.querySelector('.xterm-helper-textarea') || document.querySelector('.xterm-rows textarea'); if (!ta) return false; ta.value = 'show version\\r'; ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'show version\\r', inputType: 'insertText' })); return true; })()`);
    await sleep(1200);
    ok((await shell.eval(`(document.querySelector('.xterm-rows') || {}).textContent || ''`)).includes('v9.9.9 MOCK'), '收到命令回显');

    // 快捷按钮条（SecureCRT Button Bar 风格）
    await shell.eval(`(() => { const bar = document.getElementById('shBbar'); bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 300 })); return true; })()`);
    await sleep(300);
    ok(await shell.eval(`(() => { const m = document.getElementById('shCtx'); return m && !m.classList.contains('hidden') && m.textContent.includes('新建按钮'); })()`), '按钮条右键菜单含「新建按钮」');
    await shell.eval(`(() => { const b = [...document.querySelectorAll('#shCtx .ci')].find(x => x.textContent.includes('新建按钮')); b && b.click(); return !!b; })()`);
    await sleep(300);
    ok(await shell.eval(`!!document.getElementById('bbLabel')`), '新建按钮弹窗打开');
    await shell.eval(`(() => { document.getElementById('bbLabel').value = '运行'; document.getElementById('bbText').value = 'show running'; document.querySelector('[data-act=save]').click(); return true; })()`);
    await sleep(300);
    ok(await shell.eval(`document.querySelectorAll('.sh-bbtn').length === 1 && document.querySelector('.sh-bbtn').textContent === '运行'`), '按钮已创建并显示名称');
    await shell.eval(`document.querySelector('.sh-bbtn').click()`);
    ok(await waitText(shell, `document.querySelector('.xterm-rows')`, 'show running', 4000), '点击按钮发送命令并收到回显');
    ok(await shell.eval(`localStorage.getItem('topoShellButtons') && localStorage.getItem('topoShellButtons').includes('show running')`), '按钮配置已持久化');
    await shell.eval(`(() => { const b = document.querySelector('.sh-bbtn'); b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 300 })); return true; })()`);
    await sleep(300);
    await shell.eval(`(() => { const b = [...document.querySelectorAll('#shCtx .ci')].find(x => x.textContent.includes('删除按钮')); b && b.click(); return !!b; })()`);
    await sleep(300);
    ok(await shell.eval(`document.querySelectorAll('.sh-bbtn').length === 0`), '删除按钮后条内无按钮');

    // \p 暂停：按钮内容 show version\pshow running，两条命令间隔约 1 秒
    await shell.eval(`(() => { const bar = document.getElementById('shBbar'); bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 300 })); return true; })()`);
    await sleep(300);
    await shell.eval(`(() => { const b = [...document.querySelectorAll('#shCtx .ci')].find(x => x.textContent.includes('新建按钮')); b && b.click(); return !!b; })()`);
    await sleep(300);
    await shell.eval(`(() => { document.getElementById('bbLabel').value = '暂停测试'; document.getElementById('bbText').value = 'show version\\\\pshow running'; document.querySelector('[data-act=save]').click(); return true; })()`);
    await sleep(300);
    mockRecv.length = 0;
    await shell.eval(`document.querySelector('.sh-bbtn').click()`);
    const tPause = Date.now();
    while (Date.now() - tPause < 6000 && !(mockRecv.some(x => x.txt.includes('show version')) && mockRecv.some(x => x.txt.includes('show running')))) await sleep(100);
    const idxOf = (needle) => { for (let i = mockRecv.length - 1; i >= 0; i--) if (mockRecv[i].txt.includes(needle)) return i; return -1; };
    const iv = idxOf('show version'), ir = idxOf('show running');
    ok(iv >= 0 && ir >= 0 && mockRecv[ir].t - mockRecv[iv].t >= 900, '\p 暂停约 1 秒（间隔 ' + (iv >= 0 && ir >= 0 ? mockRecv[ir].t - mockRecv[iv].t : -1) + 'ms）');

    // 字号调节
    ok(await shell.eval(`document.getElementById('shFontVal').textContent === '13'`), '终端字号默认 13');
    await shell.eval(`document.getElementById('shFontInc').click()`);
    ok(await shell.eval(`document.getElementById('shFontVal').textContent === '14' && localStorage.getItem('topoShellFontSize') === '14'`), '增大字号到 14 并记忆');
    await shell.eval(`document.getElementById('shFontDec').click()`);
    ok(await shell.eval(`document.getElementById('shFontVal').textContent === '13'`), '减小字号回 13');

    // 剪贴板桥
    const clipOk = await shell.eval(`(() => { window.topoShell.copyText('NETTOPO-CLIP-TEST'); return window.topoShell.pasteText(); })()`);
    ok(clipOk === 'NETTOPO-CLIP-TEST', '复制/读取剪贴板桥可用');

    // 终端内 Ctrl+Shift+V 粘贴 → 远程回显
    await shell.eval(`window.topoShell.copyText('NETTOPO-PASTE-OK')`);
    await shell.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))`);
    ok(await waitText(shell, `document.querySelector('.xterm-rows')`, 'NETTOPO-PASTE-OK', 4000), '终端粘贴文本并收到回显');

    // 新建第二个连接（Shell 窗口内发起）
    await shell.eval(`document.getElementById('shNew').click()`);
    await sleep(300);
    ok(await shell.eval(`!!document.getElementById('wsProto')`), 'Shell 窗口内可打开新建连接弹窗');
    await shell.eval(`(() => {
      const proto = document.getElementById('wsProto');
      const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
      setVal(proto, 'telnet');
      document.getElementById('wsHost').value = '127.0.0.1';
      document.getElementById('wsPort').value = '2323';
      document.querySelector('[data-act=connect]').click();
      return true;
    })()`);
    await sleep(2500);
    const tabs2 = await shell.eval(`({
      count: document.querySelectorAll('.sh-tab').length,
      activeText: (document.querySelector('.sh-term-wrap.active .xterm-rows') || {}).textContent || '',
      titles: [...document.querySelectorAll('.sh-tab .tt')].map(x => x.textContent)
    })`);
    ok(tabs2.count === 2, '多标签：共 2 个连接标签');
    ok(tabs2.activeText.includes('MOCK-TELNET-READY'), '第二个标签自动激活并渲染输出');
    ok(tabs2.titles[0].includes('R1') && tabs2.titles[1].includes('127.0.0.1'), '两个标签标题正确（' + tabs2.titles.join(' | ') + '）');

    // 切换回第一个标签
    await shell.eval(`document.querySelectorAll('.sh-tab')[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    ok(await waitText(shell, `document.querySelector('.sh-term-wrap.active .xterm-rows')`, 'MOCK-TELNET-READY', 4000), '切换回第一个标签仍显示输出');

    // 关闭一个标签
    await shell.eval(`document.querySelectorAll('.sh-tab')[1].querySelector('.x').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))`);
    await sleep(400);
    ok(await shell.eval(`document.querySelectorAll('.sh-tab').length === 1`), '关闭标签后剩余 1 个');
    ok(await shell.eval(`document.querySelectorAll('.sh-term-wrap.active').length === 1`), '关闭后自动激活剩余标签');

    // 设备管理 Web 页：独立窗口 + 多标签 + 不锁定主界面
    await main.eval(`(() => { const n = __topo.state.nodes.find(x => document.querySelector('.node[data-id]').getAttribute('data-id') === x.id); n.web = 'http://127.0.0.1:2324/'; return true; })()`);
    await main.eval(`(() => { const el = document.querySelector('.node[data-id]'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 })); return true; })()`);
    await sleep(300);
    ok(await main.eval(`(() => { const m = document.getElementById('ctx'); return m && !m.classList.contains('hidden') && m.textContent.includes('打开设备管理页面'); })()`), '右键菜单含「打开设备管理页面」');
    await main.eval(`(() => { const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('打开设备管理页面')); b && b.click(); return !!b; })()`);
    await sleep(2500);
    ok(await main.eval(`!document.querySelector('.overlay')`), '打开管理页后主界面无遮罩（不锁定）');
    const webTarget = await waitTarget('webview.html');
    const webv = await connectCDP(webTarget);
    ok(await webv.eval(`document.querySelectorAll('.wv-tab').length === 1`), '设备管理页窗口出现 1 个标签');
    ok(await webv.eval(`!!document.querySelector('webview')`), '标签内嵌 webview 已创建');
    ok(await waitText(webv, `document.querySelector('.wv-tab .tt')`, 'NetTopo Web Test', 8000), '标签标题更新为页面标题');
    // 第二台设备 → 同窗口第 2 个标签
    await main.eval(`(() => { const n = __topo.state.nodes.find(x => document.querySelectorAll('.node[data-id]')[1].getAttribute('data-id') === x.id); n.web = 'http://127.0.0.1:2324/'; return true; })()`);
    await main.eval(`(() => { const el = document.querySelectorAll('.node[data-id]')[1]; el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 })); return true; })()`);
    await sleep(300);
    await main.eval(`(() => { const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('打开设备管理页面')); b && b.click(); return !!b; })()`);
    await sleep(2500);
    ok(await webv.eval(`document.querySelectorAll('.wv-tab').length === 2`), '第二台设备在同一窗口新增第 2 个标签');

    webv.ws.close();
    shell.ws.close();
    main.ws.close();
  } catch (e) {
    console.error('冒烟测试异常：', e);
    failed++;
  } finally {
    try { require('child_process').execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { try { proc.kill(); } catch (e2) {} }
    for (const s of mockSocks) s.destroy();
    mockServer.close();
    webServer.close();
    await sleep(500);
    console.log('');
    console.log(failed ? ('冒烟结果：失败 ' + failed) : '冒烟结果：全部通过');
    process.exit(failed ? 1 : 0);
  }
})();
