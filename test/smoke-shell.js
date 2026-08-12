/* NetTopo Web Shell 冒烟测试（Electron 端到端）
 * 用法：node test/smoke-shell.js
 * 1) 本地起 mock Telnet 服务器（127.0.0.1:2323）
 * 2) 启动 Electron（--remote-debugging-port=9333）
 * 3) 载入示例拓扑 → 右键设备 → Web Shell → Telnet 连接 → 校验 xterm 输出
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
const mockServer = net.createServer((sock) => {
  sock.on('data', (d) => {
    const txt = d.toString('utf8');
    if (txt.includes('show version')) sock.write('v9.9.9 MOCK\r\n> ');
  });
  sock.write('\r\nWelcome to MOCK-TELNET-READY\r\n> ');
});
function listen(server) {
  return new Promise((res, rej) => { server.once('error', rej); server.listen(2323, '127.0.0.1', res); });
}

/* ---- 简易 CDP 客户端 ---- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.onEvent = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
      else if (msg.method && this.onEvent) this.onEvent(msg);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function getPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:' + CDP_PORT + '/json/list', (res) => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (e) { /* 未就绪 */ }
    await sleep(500);
  }
  throw new Error('未能连接 CDP');
}

(async () => {
  await listen(mockServer);
  console.log('mock telnet 127.0.0.1:2323 就绪');

  const appExe = process.env.SMOKE_APP || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const appArgs = appExe.endsWith('.exe') && appExe.includes('portable') ? [] : ['.'];
  const proc = spawn(appExe,
    [...appArgs, '--remote-debugging-port=' + CDP_PORT, '--no-sandbox', '--user-data-dir=' + path.join(root, 'build', 'smoke_profile')],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NETTOPO_SMOKE: '1' } });
  let appLog = '';
  proc.stdout.on('data', d => { appLog += d.toString(); });
  proc.stderr.on('data', d => { appLog += d.toString(); });

  try {
    const target = await getPageTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');

    // 载入示例拓扑
    await cdp.eval('__topo.loadSample(); true');
    await sleep(800);
    const nodeCount = await cdp.eval('document.querySelectorAll(".node").length');
    ok(nodeCount > 0, '示例拓扑已载入（节点数=' + nodeCount + '）');

    // 右键 R1（第一个带管理地址的节点）
    const hasNode = await cdp.eval(`(() => {
      const el = document.querySelector('.node[data-id]');
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 }));
      return true;
    })()`);
    ok(hasNode, '触发设备右键菜单');
    await sleep(300);
    const hasMenu = await cdp.eval(`(() => {
      const m = document.getElementById('ctx');
      return m && !m.classList.contains('hidden') && m.textContent.includes('Web Shell');
    })()`);
    ok(hasMenu, '右键菜单含 Web Shell 项');
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('Web Shell'));
      b && b.click();
      return !!b;
    })()`);
    await sleep(300);
    const hasModal = await cdp.eval(`!!document.getElementById('wsProto')`);
    ok(hasModal, '连接参数弹窗已打开');

    // 填写 Telnet 参数并连接
    const filled = await cdp.eval(`(() => {
      const proto = document.getElementById('wsProto');
      const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); };
      setVal(proto, 'telnet');
      const host = document.getElementById('wsHost'); host.value = '127.0.0.1';
      const port = document.getElementById('wsPort'); port.value = '2323';
      document.querySelector('[data-act=connect]').click();
      return true;
    })()`);
    ok(filled, '填写 Telnet 参数并点击连接');
    await sleep(2500);

    const shellState = await cdp.eval(`(() => {
      const ov = document.querySelector('.shell-ov');
      if (!ov) return { open: false };
      return {
        open: true,
        status: (ov.querySelector('.shell-status') || {}).textContent || '',
        text: (ov.querySelector('.xterm-rows') || {}).textContent || ''
      };
    })()`);
    ok(shellState.open, '终端面板已打开');
    ok(shellState.status && shellState.status.includes('已连接'), '状态显示已连接（实际：' + shellState.status + '）');
    ok(shellState.text.includes('MOCK-TELNET-READY'), 'xterm 渲染服务器欢迎信息');

    // 输入命令并验证回显（通过 xterm 输入辅助 textarea）
    const typed = await cdp.eval(`(() => {
      const ta = document.querySelector('.xterm-helper-textarea') || document.querySelector('.xterm-rows textarea');
      if (!ta) return false;
      ta.value = 'show version\\r';
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'show version\\r', inputType: 'insertText' }));
      return true;
    })()`);
    ok(typed, '向终端输入命令');
    await sleep(1500);
    const echo = await cdp.eval(`(document.querySelector('.xterm-rows') || {}).textContent || ''`);
    ok(echo.includes('v9.9.9 MOCK'), '收到命令回显（v9.9.9 MOCK）');

    // 关闭终端
    await cdp.eval(`(() => { const b = document.getElementById('shellClose'); if (b) b.click(); return true; })()`);
    await sleep(400);
    const closed = await cdp.eval(`!document.querySelector('.shell-ov')`);
    ok(closed, '关闭终端面板');

    ws.close();
  } catch (e) {
    console.error('冒烟测试异常：', e);
    failed++;
  } finally {
    proc.kill();
    mockServer.close();
    await sleep(500);
    console.log('');
    console.log(failed ? ('冒烟结果：失败 ' + failed) : '冒烟结果：全部通过');
    process.exit(failed ? 1 : 0);
  }
})();
