/* NetTopo 备份管理冒烟测试（Electron 端到端）
 * 用法：node test/smoke-backup.js
 * 1) 以 NETTOPO_USERDATA 临时目录启动应用（--remote-debugging-port=9334，不污染真实备份库）
 * 2) 主窗口：验证 window.topoBackup 桥 → save/list/read/remove/removeAll 全链路
 * 3) UI：打开「备份管理」弹窗，验证列表渲染、立即备份、删除、清空
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');

// 随机 CDP 端口，避免与残留实例/其它测试冲突
const CDP_PORT = 9400 + Math.floor(Math.random() * 200);
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
  return cdp;
}

(async () => {
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-smoke-bk-'));
  const profileDir = path.join(root, 'build', 'smoke_bk_profile');
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
    ok(await main.eval('typeof window.topoBackup !== "undefined"'), 'preload 桥 topoBackup 已注入');

    // 清空测试库（应为空）
    const r0 = await main.eval('window.topoBackup.removeAll()');
    ok(r0 && r0.ok && r0.removed === 0, '测试库初始为空（清空返回 0）');

    // 保存 → 列表 → 读取 全链路
    const s1 = await main.eval(`window.topoBackup.save({ content: JSON.stringify({ app: 'NetTopo', nodes: [{ id: 'n1', name: 'R1' }] }), label: 'auto', keep: 5 })`);
    ok(s1 && s1.ok && /^自动备份_\d{8}_\d{6}\.nettopo$/.test(s1.name), 'IPC 保存自动备份成功（' + (s1 && s1.name) + '）');
    const s2 = await main.eval(`window.topoBackup.save({ content: JSON.stringify({ app: 'NetTopo', nodes: [{ id: 'n2', name: 'SW1' }] }), label: 'manual', keep: 5 })`);
    ok(s2 && s2.ok && /^备份_\d{8}_\d{6}\.nettopo$/.test(s2.name), 'IPC 保存手动备份成功（' + (s2 && s2.name) + '）');
    const l1 = await main.eval('window.topoBackup.list()');
    ok(l1 && l1.ok && l1.items.length === 2, 'IPC 列表返回 2 份');
    const rd = await main.eval(`window.topoBackup.read(${JSON.stringify(s1.name)})`);
    ok(rd && rd.ok && rd.content.includes('"n1"'), 'IPC 读取备份内容一致');
    const bad = await main.eval(`window.topoBackup.read('../evil.nettopo')`);
    ok(bad && !bad.ok, 'IPC 读取拒绝路径穿越');
    const del = await main.eval(`window.topoBackup.remove(${JSON.stringify(s2.name)})`);
    ok(del && del.ok, 'IPC 删除单份备份');
    ok((await main.eval('window.topoBackup.list()')).items.length === 1, '删除后列表剩 1 份');

    // UI：打开备份管理弹窗
    await main.eval('__topo.loadSample(); true');
    await sleep(600);
    await main.eval(`(() => { document.getElementById('btnDropFile').click(); return true; })()`);
    await sleep(250);
    const opened = await main.eval(`(() => { const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('备份管理')); if (b) b.click(); return !!b; })()`);
    ok(opened, '菜单点击「备份管理…」');
    await sleep(500);
    const modal = await main.eval(`(() => {
      const ov = document.querySelector('#modalRoot .overlay');
      if (!ov) return null;
      return { title: (ov.querySelector('.modal h3') || {}).textContent, rows: ov.querySelectorAll('#bkList .vrow').length, sub: (ov.querySelector('#bkSub') || {}).textContent || '' };
    })()`);
    ok(modal && modal.title === '备份管理', '备份管理弹窗已打开');
    ok(modal && modal.rows === 1 && modal.sub.includes('共 1 份备份'), '弹窗列表渲染 1 份（' + (modal && modal.sub) + '）');

    // UI：立即备份 → 列表变 2 份
    await main.eval(`(() => { document.querySelector('#modalRoot [data-act=now]').click(); return true; })()`);
    await sleep(600);
    const rows2 = await main.eval(`document.querySelectorAll('#bkList .vrow').length`);
    ok(rows2 === 2, '「立即备份」后列表 2 份');

    // UI：删除一行 → 剩 1 份
    await main.eval(`(() => { const d = document.querySelector('#bkList [data-act=del]'); if (d) d.click(); return true; })()`);
    await sleep(300);
    await main.eval(`(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); return true; })()`);
    await sleep(600);
    ok(await main.eval(`document.querySelectorAll('#bkList .vrow').length`) === 1, '弹窗删除一行后剩 1 份');

    // 关闭弹窗
    await main.eval(`(() => { const b = document.querySelector('#modalRoot [data-act=close]'); if (b) b.click(); return true; })()`);
    await sleep(300);

    // 备份目录确实在临时 userData 下
    const bkDir = path.join(tmpUserData, 'backups');
    ok(fs.existsSync(bkDir) && fs.readdirSync(bkDir).filter(f => f.endsWith('.nettopo')).length === 1, '备份文件落在临时 userData/backups（不污染真实数据）');

    console.log('app stderr 异常: ' + (appLog.includes('Error') ? appLog.split('\n').filter(l => l.includes('Error')).slice(0, 3).join(' | ') : '无'));
  } finally {
    // 必须杀整棵进程树：portable 包装器被杀后内部 exe 会变孤儿进程，占住 CDP 端口并残留临时目录
    try { require('child_process').execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { try { proc.kill(); } catch (e2) {} }
    await sleep(800);
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('');
  console.log('结果：' + (failed ? failed + ' 项失败' : '全部通过'));
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
