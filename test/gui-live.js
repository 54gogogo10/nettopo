/* NetTopo 真机 GUI 集成测试（Electron 界面 + 真实设备）
 * ---------------------------------------------------------------------------
 * 与 test/smoke-*.js 的分工：那些冒烟测试用**本地 mock 服务器**验证界面逻辑；本套件把同一套界面
 * 接到 test/live-lab.sh 部署出来的**真实设备**上，验证「界面 → 主进程 → 真实设备」整条链路：
 *   G1 应用启动 / 示例拓扑
 *   G2-G4 Web Shell：真机 SSH 连接（首次指纹确认）、真机命令输出、多设备多标签
 *   G5-G9 设备监控：界面配置真机（SSH + SNMP）→ 监控中心概览/接口流量/性能呈现真实数据、日志落盘
 *   G10 配置备份：界面开启备份 → 真实运行配置落库 → 备份管理列出
 *   G11 网络服务：界面启用 Syslog/Trap/TFTP → 真机发日志/Trap、实验机传文件 → 面板实时呈现
 *   G12 诊断工具箱：界面发起真机端口探测与 SNMP Walk
 *
 * 用法（与 test/live.js 同一套环境变量与实验机）：
 *   NETTOPO_LAB_HOST=192.168.50.148 node test/gui-live.js              # 部署 → 跑全部 → 拆除
 *   node test/gui-live.js --host 192.168.50.148 --keep                 # 保留实验环境便于排障
 *   node test/gui-live.js --host 192.168.50.148 --skip-setup           # 用已部署好的实验环境
 *   node test/gui-live.js --host 192.168.50.148 --only g2,g3           # 只跑指定用例（g1..g12）
 * 依赖：本机 Chrome 不需要，但需要能启动 Electron（node_modules/electron）；实验机侧同上；
 *      设备 → 测试机方向的 Syslog/Trap/TFTP 需放行入站（见 README 真机集成测试一节）。
 * ---------------------------------------------------------------------------
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const { spawn } = require('child_process');
const { ShellManager } = require('../js/shell.js');
const lab = require('./lab-lib.js');

const root = path.join(__dirname, '..');

// ---------------------------------------------------------------- 参数
function argVal(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const hasFlag = (n) => process.argv.includes('--' + n);
const CFG = {
  host: argVal('host', process.env.NETTOPO_LAB_HOST || ''),
  user: argVal('user', process.env.NETTOPO_LAB_USER || 'a'),
  pass: argVal('pass', process.env.NETTOPO_LAB_PASS || 'a'),
  rootPass: process.env.NETTOPO_LAB_ROOT_PASS || process.env.NETTOPO_LAB_PASS || 'a',
  keep: hasFlag('keep') || !!process.env.NETTOPO_LAB_KEEP,
  skipSetup: hasFlag('skip-setup') || !!process.env.NETTOPO_LAB_SKIP_SETUP,
  only: (argVal('only', '') || '').split(',').map(s => s.trim()).filter(Boolean),
  cdpPort: Number(argVal('cdp', '9345')),
  // 内置网络服务的测试端口（与 test/live.js、README 放行命令一致）
  ports: { syslog: 15514, trap: 15162, tftp: 15069 }
};
const want = (id) => !CFG.only.length || CFG.only.includes(id);

// ---------------------------------------------------------------- 断言/报告
let pass = 0, fail = 0, skipped = 0;
const failures = [];
const line = (s) => console.log(s);
const section = (t) => line('\n== ' + t + ' ==');
const ok = (cond, name, extra) => {
  if (cond) { pass++; line('  ✓ ' + name + (extra ? '（' + extra + '）' : '')); return true; }
  fail++; failures.push(name); line('  ✗ ' + name + (extra ? '（' + extra + '）' : ''));
  return false;
};
const skip = (name, why) => { skipped++; line('  ⊘ 跳过：' + name + (why ? '（' + why + '）' : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms, step) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > (ms || 15000)) return false;
    await sleep(step || 300);
  }
}

// ---------------------------------------------------------------- CDP 挂具（与 smoke-*.js 同口径）
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
}
async function listTargets(port) {
  return await new Promise((resolve) => {
    http.get('http://127.0.0.1:' + port + '/json/list', (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}
async function waitTarget(port, contains, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await listTargets(port);
    const t = list.find(x => x.type === 'page' && x.url.includes(contains));
    if (t && t.webSocketDebuggerUrl) return t;
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

// ---------------------------------------------------------------- 主流程
(async () => {
  if (!CFG.host) {
    line('未指定实验宿主机：设置 NETTOPO_LAB_HOST=<IP> 或 --host <IP> 后重跑。');
    line('（真机 GUI 集成测试需要一台可 SSH 登录的 Linux 实验机 + 本机能启动 Electron）');
    process.exit(0);
  }
  line('== NetTopo 真机 GUI 集成测试 ==');
  line('  实验宿主机：' + CFG.host + '（账号 ' + CFG.user + '）  用例：' + (CFG.only.length ? CFG.only.join(',') : '全部 g1..g12'));

  const conn = await lab.connectSsh({ host: CFG.host, user: CFG.user, pass: CFG.pass }).catch((e) => {
    console.error('[失败] 无法 SSH 登录实验宿主机 ' + CFG.host + '：' + e.message);
    process.exit(1);
  });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-gui-live-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-gui-live-profile-'));
  let proc = null, toreDown = false;
  const cleanup = async () => {
    try { if (proc && !proc.killed) proc.kill(); } catch (e) { /* ignore */ }
    await sleep(500);
    if (toreDown || CFG.keep) return;
    toreDown = true;
    line('[lab] 拆除实验环境…');
    try { await lab.teardown(conn, { rootPass: CFG.rootPass, onLine: (l) => line('      ' + l) }); } catch (e) { console.error('[警告] 拆除失败：' + e.message); }
  };

  try {
    // ---- 实验环境 ----
    let inventory;
    if (!CFG.skipSetup) {
      line('[lab] 部署实验环境（多台 FRR 设备 + sshd + snmpd + telnet vty）…');
      inventory = await lab.provision(conn, { host: CFG.host, rootPass: CFG.rootPass, onLine: (l) => line('      ' + l) });
    } else {
      inventory = await lab.readInventory(conn, { rootPass: CFG.rootPass });
    }
    const devs = inventory.devices || [];
    const d1 = devs[0], d2 = devs[1];
    const ourIp = await lab.ourAddress(conn, CFG.host);
    line('[lab] 设备：' + devs.map(d => d.name + '(' + d.host + ':' + d.sshPort + ')').join(' · ') + '；测试机地址 ' + (ourIp || '未知'));

    const devH = lab.makeDevHelpers(new ShellManager({ logDir: path.join(userData, 'gui-live-dev-logs') }), { pass: CFG.pass });
    const devRun = (dev, cmd, waitMs) => devH.devRun(dev, cmd, waitMs);

    // ---- 启动应用（独立 userData，避免污染真实配置） ----
    const appExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(appExe)) throw new Error('找不到 Electron：' + appExe + '（先 npm i）');
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({}), 'utf8');
    proc = spawn(appExe, ['.', '--remote-debugging-port=' + CFG.cdpPort, '--no-sandbox', '--user-data-dir=' + profileDir],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NETTOPO_SMOKE: '1', NETTOPO_USERDATA: userData } });
    let appLog = '';
    proc.stdout.on('data', (d) => { appLog += d.toString(); });
    proc.stderr.on('data', (d) => { appLog += d.toString(); });

    const main = await connectCDP(await waitTarget(CFG.cdpPort, 'index.html'));
    const mainEval = (js) => main.evaluate(js);
    const t0 = Date.now();
    while (!(await mainEval('typeof __topo !== "undefined"')) && Date.now() - t0 < 20000) await sleep(300);

    // 经监控/备份等主进程能力的可用性（浏览器降级时应为 false）
    const desktopOk = await mainEval('!!(window.topoShell && window.topoMonitor && window.topoBackup)');
    if (want('g1')) await caseG1(mainEval, desktopOk);
    await mainEval('__topo.loadSample(); true');
    await sleep(600);
    await mainEval(`(() => { const b = document.querySelector('[data-act=yes]'); if (b) b.click(); return true; })()`);
    await sleep(800);

    // 设备清单：把两台真机的管理地址写进节点，供弹窗预填
    await mainEval(`(() => {
      const ns = __topo.state.nodes.slice(0, 2);
      ${JSON.stringify([d1, d2])}.forEach((d, i) => { if (ns[i]) { ns[i].mgmts = [d.host]; ns[i].mgmt = d.host; } });
      return true;
    })()`);

    let shellCdp = null;
    if (want('g2') || want('g3') || want('g4')) shellCdp = await caseShell(CFG, mainEval, d1, d2);
    if (want('g5') || want('g6') || want('g7') || want('g8') || want('g9') || want('g10')) {
      await caseMonitor(CFG, mainEval, d1, userData);
    }
    if (want('g11')) await caseServices(CFG, mainEval, conn, devRun, ourIp, d1);
    if (want('g12')) await caseDiag(CFG, mainEval, d1);

    await cleanup();
    line('\n== 结果：' + pass + ' 通过，' + fail + ' 失败' + (skipped ? '，' + skipped + ' 跳过' : '') + ' ==');
    if (failures.length) { line('失败项：'); for (const f of failures) line('  ✗ ' + f); }
    if (fail) { line('\n应用日志尾部（排障用）：'); line(appLog.split('\n').slice(-12).join('\n')); }
    if (CFG.keep) line('实验环境已保留（--keep）');
    process.exit(fail ? 1 : 0);
  } catch (e) {
    await cleanup();
    console.error('\n[gui-live][异常] ' + (e && e.message ? e.message : e));
    if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  }
})();

// ================= G1 应用启动 =================
async function caseG1(mainEval, desktopOk) {
  section('G1 应用启动与桌面能力');
  ok(await mainEval('typeof __topo !== "undefined"'), '主窗口应用脚本就绪（__topo 钩子）');
  ok(desktopOk, '桌面专属桥可用（topoShell / topoMonitor / topoBackup）');
  ok(await mainEval('typeof __topo.state === "object"'), '拓扑状态可访问');
}

// ================= G2–G4 Web Shell 真机会话 =================
async function caseShell(CFG, mainEval, d1, d2) {
  section('G2–G4 Web Shell（真实 SSH 会话）');
  // 主窗口：右键设备 → Web Shell → 填真机参数 → 连接
  const openWs = async (dev) => {
    await mainEval(`(() => { const el = document.querySelector('.node[data-id]'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120 })); return true; })()`);
    await sleep(300);
    await mainEval(`(() => { const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('Web Shell')); b && b.click(); return !!b; })()`);
    await sleep(300);
    return mainEval(`(() => {
      const setV = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      const setS = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
      if (!document.getElementById('wsProto')) return false;
      setS(document.getElementById('wsProto'), 'ssh');
      setV(document.getElementById('wsHost'), ${JSON.stringify(d1.host)});
      setV(document.getElementById('wsPort'), ${JSON.stringify(String(dev.sshPort))});
      setV(document.getElementById('wsUser'), ${JSON.stringify(dev.sshUser)});
      setV(document.getElementById('wsPass'), ${JSON.stringify(CFG.pass)});
      document.querySelector('[data-act=connect]').click();
      return true;
    })()`);
  };
  ok(await openWs(d1), '主窗口连接弹窗可打开并填入真机参数');

  const shellTarget = await waitTarget(CFG.cdpPort, 'shell.html');
  const shell = await connectCDP(shellTarget);
  const shEval = (js) => shell.evaluate(js);
  await sleep(800);

  // 首次连接必须人工确认指纹（TOFU）
  const fpShown = await waitUntil(() => shEval(`!!document.getElementById('fpModal')`), 15000, 300);
  const fpTxt = fpShown ? String(await shEval(`(document.getElementById('fpModal') || {}).textContent || ''`)) : '';
  ok(fpShown && /SHA256:/.test(fpTxt) && fpTxt.includes(d1.host), '真机首次连接弹出指纹确认（SHA256 + 主机地址）', fpTxt.replace(/\s+/g, ' ').slice(0, 70));
  if (fpShown) await shEval(`document.querySelector('#fpModal [data-act=trust]').click()`);

  const rowsSel = `document.querySelector('.sh-term-wrap.active .xterm-rows') || document.querySelector('.xterm-rows')`;
  const termText = async () => String(await shEval(`(${rowsSel} || {}).textContent || ''`));
  const waitTerm = (needle, ms) => waitUntil(async () => (await termText()).includes(needle), ms || 12000, 300);
  const typeIn = async (text) => shEval(`(() => {
    const ta = document.querySelector('.sh-term-wrap.active .xterm-helper-textarea') || document.querySelector('.xterm-helper-textarea');
    if (!ta) return false;
    ta.focus();
    const d = ${JSON.stringify(text)};
    ta.value = d;
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: d, inputType: 'insertText' }));
    return true;
  })()`);

  ok(await waitTerm('$', 20000), '真机 SSH 会话建立（终端出现 shell 提示符）');
  await typeIn('uname -s\r');
  ok(await waitTerm('Linux', 12000), '真机命令输出进入终端（uname -s → Linux）');
  await typeIn('nt-cli -c "show version"\r');
  ok(await waitTerm('FRRouting', 15000), '设备 CLI 真实输出进入终端（nt-cli show version → FRRouting）',
    (await termText()).match(/FRRouting[^\n]{0,30}/) ? String((await termText()).match(/FRRouting[^\n]{0,30}/)[0]) : '');

  const tab1 = await shEval(`(() => { const t = document.querySelector('.sh-tab .tt'); return t ? t.textContent : ''; })()`);
  ok(/SSH/i.test(tab1), '标签标题标明协议（' + tab1 + '）');

  // G4：从主窗口再连第二台真机 → 第二个标签
  await openWs(d2);
  const twoTabs = await waitUntil(async () => (await shEval(`document.querySelectorAll('.sh-tab').length`)) >= 2, 20000, 400);
  if (twoTabs && await shEval(`!!document.getElementById('fpModal')`)) await shEval(`document.querySelector('#fpModal [data-act=trust]').click()`);
  ok(twoTabs, '第二台真机连接后出现第 2 个标签');
  if (twoTabs) {
    // 切到第 2 个标签并确认它是活会话（拿到自己的提示符）
    await shEval(`document.querySelectorAll('.sh-tab')[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await sleep(600);
    await typeIn('hostname\r');
    const t2 = await waitUntil(async () => /a\b/.test(await termText()), 12000, 300);
    ok(t2, '第 2 个标签为独立活会话（可执行命令并回显）');
  }
  return shell;
}

// ================= G5–G10 设备监控与配置备份 =================
async function caseMonitor(CFG, mainEval, d1, userData) {
  section('G5–G9 设备监控（界面配置真机 → 真实采集）');
  // 界面配置：SSH + SNMP(ifTable/性能) + 命令
  const opened = await mainEval(`(() => { const el = document.querySelector('.node[data-id]'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120 })); return true; })()`);
  await sleep(300);
  await mainEval(`(() => { const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('设备监控')); b && b.click(); return !!b; })()`);
  await sleep(400);
  ok(await mainEval(`!!document.getElementById('monHostList')`), '设备监控配置弹窗可打开', '右键=' + !!opened);

  const configured = await mainEval(`(() => {
    const setV = (el, v) => { if (!el) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); return true; };
    const setS = (el, v) => { if (!el) return false; el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    const setC = (el, v) => { if (!el) return false; el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    const r = document.querySelector('.mon-host-row');
    if (!r) return { ok: false, why: 'no-row' };
    const found = {};
    setV(r.querySelector('.mh-host'), ${JSON.stringify(d1.host)});
    setS(r.querySelector('.mh-proto'), 'ssh');
    setV(r.querySelector('.mh-port'), ${JSON.stringify(String(d1.sshPort))});
    setV(r.querySelector('.mh-user'), ${JSON.stringify(d1.sshUser)});
    setV(r.querySelector('.mh-pass'), ${JSON.stringify(CFG.pass)});
    const btn = r.querySelector('.mh-cmd-btn');
    if (btn) btn.click();
    setV(r.querySelector('.mh-cmds'), 'uname -a');
    // SNMP：识别 + ifTable + 性能（Linux UCD：ssCpuIdle / memTotalReal / memAvailReal）
    setC(r.querySelector('.mh-si-cb'), true);
    setV(r.querySelector('.mh-si-comm'), 'public');
    setV(r.querySelector('.mh-si-sp'), ${JSON.stringify(String(d1.snmpPort))});
    setC(r.querySelector('.mh-sift-cb'), true);
    setC(r.querySelector('.mh-si-pf-cb'), true);
    setC(r.querySelector('.mh-si-up-cb'), true);
    setV(r.querySelector('.mh-si-cpu'), '1.3.6.1.4.1.2021.11.11.0');
    setS(r.querySelector('.mh-si-mode'), 'idle100');
    setV(r.querySelector('.mh-si-mused'), '1.3.6.1.4.1.2021.4.5.0');
    setV(r.querySelector('.mh-si-mfree'), '1.3.6.1.4.1.2021.4.6.0');
    for (const k of ['mh-si-cb','mh-sift-cb','mh-si-pf-cb','mh-si-up-cb','mh-si-cpu','mh-si-mused','mh-si-mfree','mh-si-mode']) found[k] = !!r.querySelector('.' + k);
    setV(document.getElementById('monInterval'), '5');
    setV(document.getElementById('monCmdDelay'), '0.5');
    setC(document.getElementById('monEnable'), true);
    document.querySelector('[data-act=save]').click();
    return { ok: true, found };
  })()`);
  ok(configured && configured.ok, '真机参数写入监控弹窗并保存', configured && configured.found ? JSON.stringify(configured.found) : String(configured && configured.why));
  await sleep(1500);

  const nodeId = await mainEval('__topo.state.nodes[0].id');
  const stOf = async () => await mainEval('(__topo.monitorStatus[' + JSON.stringify(nodeId) + '] || {})');
  const gotMon = await waitUntil(async () => (await stOf()).state === 'monitoring', 25000, 400);
  const st = await stOf();
  ok(gotMon, '真机监控进入 monitoring 状态', '当前=' + (st.state || '?') + ' ' + (st.text || ''));
  const perHost = (await stOf()).perHost || {};
  ok(!!perHost[d1.host] && perHost[d1.host].state === 'monitoring', '该真机管理地址被监控（perHost）',
    Object.keys(perHost).join(','));
  const badge = await waitUntil(async () => String(await mainEval(`(() => { const it = [...document.querySelectorAll('.pitem')].find(x => x.dataset.id === ${JSON.stringify(nodeId)}); return it ? ((it.querySelector('.mon-badge') || {}).className || '') : ''; })()`)).includes('ok'), 10000, 400);
  ok(badge, '侧栏设备项显示监控在线标记');

  section('G6–G9 监控中心的真实数据');
  const openCenter = async () => {
    await mainEval(`document.getElementById('btnDropMonitor').click(); true`);
    await sleep(300);
    await mainEval(`(() => { const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('监控中心')); b && b.click(); return !!b; })()`);
    await sleep(1200);
    return mainEval(`!!document.getElementById('mcJobs')`);
  };
  ok(await openCenter(), '监控中心可打开（概览/统计就绪）');

  // G6 概览：列出该真机（设备名 + 真实管理地址）与在线统计
  const overviewTxt = async () => String(await mainEval(`(() => { const g = id => (document.getElementById(id) || {}).textContent || ''; return g('mcJobs') + ' ' + g('mcSOk') + '/' + g('mcSTotal'); })()`));
  const listedReal = await waitUntil(async () => {
    const t = await overviewTxt();
    return t.includes(d1.host) && /[1-9]\d*\s*\/\s*[1-9]/.test(t);
  }, 30000, 700);
  ok(listedReal, '概览列出该真机（真实管理地址 ' + d1.host + '）且在线统计计入', (await overviewTxt()).replace(/\s+/g, ' ').slice(0, 80));

  // G7 接口流量页：真实接口名
  const switchPane = async (pane) => {
    await mainEval(`(() => { const t = [...document.querySelectorAll('.mc-tab')].find(x => x.dataset.pane === ${JSON.stringify(pane)}); if (t) t.click(); return !!t; })()`);
    await sleep(1200);
  };
  await switchPane('ifaces');
  // 精确读表：行 = .mc-if-row（接口名 .mc-if-nm / 状态 .mc-if-op），避免被页面提示文案误判
  const ifaceRows = () => mainEval(`[...document.querySelectorAll('#mcIfaces .mc-if-row')].map(r => ({ nm: (r.querySelector('.mc-if-nm') || {}).textContent || '', op: (r.querySelector('.mc-if-op') || {}).textContent || '' }))`);
  const realIf = await waitUntil(async () => (await ifaceRows()).some(r => /^(ntp1|nt-d12a|lo)$/.test(r.nm.trim())), 45000, 1000);
  const rows1 = await ifaceRows();
  ok(realIf, '接口流量页列出真机接口（ifTable 真实接口名）', rows1.map(r => r.nm.trim() + ':' + r.op.trim()).slice(0, 4).join(' '));
  ok(rows1.some(r => /up/i.test(r.op)), '接口状态取自真机（含 up 接口）');

  // G8 性能页：CPU/内存行取自真机 SNMP（读行元素，避免匹配到页头说明里的 ≥75%/≥90%）
  await switchPane('perf');
  const perfRows = () => mainEval(`[...document.querySelectorAll('#mcPerfs .mc-if-row')].map(r => ({ nm: (r.querySelector('.mc-if-nm') || {}).textContent || '', val: (r.querySelector('.mc-if-rate') || {}).textContent || '' }))`);
  const cpuMemOk = await waitUntil(async () => {
    const rs = await perfRows();
    const cpu = rs.find(r => /CPU/.test(r.nm));
    const mem = rs.find(r => /内存占用$/.test(r.nm.trim()));
    return !!(cpu && mem && /%/.test(cpu.val) && /%/.test(mem.val));
  }, 90000, 1500);
  const rows2 = await perfRows();
  const fmt = rows2.filter(r => /CPU|内存|开机/.test(r.nm)).map(r => r.nm.trim() + '=' + String(r.val).replace(/\s+/g, ' ').trim()).join(' ');
  ok(cpuMemOk, '性能页呈现真机 CPU/内存百分比（SNMP UCD 采集）', fmt.slice(0, 90));
  ok(rows2.some(r => /开机/.test(r.nm) && /\d/.test(r.val)), '性能页含 sysUpTime（重启检测基线）');

  // 关闭监控中心
  await mainEval(`(() => { const b = document.querySelector('#modalRoot [data-act=close]'); if (b) b.click(); return true; })()`);
  await sleep(400);

  // G9 监控日志落盘：真实设备输出
  const logDirs = path.join(userData, 'monitor-logs');
  const readLogs = () => {
    const out = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (!p.startsWith(d + path.sep)) continue;
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.log')) out.push({ p, t: fs.readFileSync(p, 'utf8') });
      }
    };
    walk(logDirs);
    return out;
  };
  const logs = await waitUntil(() => readLogs().some(l => /Linux/.test(l.t)), 20000, 800) ? readLogs() : readLogs();
  ok(logs.some(l => /Linux/.test(l.t)), '监控日志落盘且含真机输出（uname -a → Linux）', logs.length + ' 个日志文件');
  ok(logs.some(l => /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/.test(l.t)), '日志逐行带时间戳前缀');
  ok(logs.some(l => /SNMP 识别/.test(l.t) && /Linux/.test(l.t)), 'SNMP 自动识别结果（真机 sysDescr）写入监控日志');

  // G10 配置备份（界面开启 → 真实配置落库 → 备份管理列出）
  section('G10 配置备份（界面触发真机取配置）');
  await mainEval(`(() => { const el = document.querySelector('.node[data-id]'); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120 })); return true; })()`);
  await sleep(300);
  await mainEval(`(() => { const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('设备监控')); b && b.click(); return !!b; })()`);
  await sleep(400);
  const bkCfg = await mainEval(`(() => {
    const setV = (el, v) => { if (!el) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); return true; };
    const setC = (el, v) => { if (!el) return false; el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    const setS = (el, v) => { if (!el) return false; el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    const r = document.querySelector('.mon-host-row');
    const okBk = setC(r.querySelector('.mh-bk-cb'), true);
    setS(r.querySelector('.mh-bk-mode'), 'session');
    setV(r.querySelector('.mh-bk-ta'), 'nt-cli -c "show running-config"');
    document.querySelector('[data-act=save]').click();
    return { okBk, hasMode: !!r.querySelector('.mh-bk-mode'), hasTa: !!r.querySelector('.mh-bk-ta') };
  })()`);
  ok(bkCfg && bkCfg.okBk, '备份开关与真机取配置命令写入（session 模式）', JSON.stringify(bkCfg));
  await sleep(1500);

  // 等待落库（首轮自动备份）
  const bkRoot = path.join(userData, 'config-backups');
  const readBaks = () => {
    const out = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (!p.startsWith(d + path.sep)) continue;
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.cfg')) out.push({ p, t: fs.readFileSync(p, 'utf8') });
      }
    };
    walk(bkRoot);
    return out;
  };
  const baks = await waitUntil(() => readBaks().some(b => /hostname\s+R1-Core-01/.test(b.t)), 60000, 1000) ? readBaks() : readBaks();
  ok(baks.some(b => /hostname\s+R1-Core-01/.test(b.t)), '界面开启备份后，真机运行配置落库（含设备主机名）', baks.length + ' 份');
  ok(baks.some(b => /router bgp 65001/.test(b.t)), '备份内容含真实 BGP 配置');

  // 界面上浏览设备配置备份：监控 ▾ →「配置备份…」（设备配置备份库，区别于「备份管理」的工程备份库）
  await mainEval(`document.getElementById('btnDropMonitor').click(); true`);
  await sleep(300);
  await mainEval(`(() => { const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('配置备份')); b && b.click(); return !!b; })()`);
  await sleep(1500);
  const bkHosts = String(await mainEval(`(document.getElementById('bkHosts') || {}).textContent || ''`));
  ok(bkHosts.includes(d1.host), '「配置备份」弹窗按真机地址列出备份来源', bkHosts.replace(/\s+/g, ' ').slice(0, 70));
  // 文件列表可能随后端异步加载（选中来源后填充），点一下来源行再等
  const filesTxt = async () => String(await mainEval(`(document.getElementById('bkFiles') || {}).textContent || ''`));
  await mainEval(`(() => { const h = document.querySelector('#bkHosts > *'); if (h) h.click(); return !!h; })()`);
  const fileSeen = await waitUntil(async () => /cfg_\d{8}_\d{6}\.cfg/.test(await filesTxt()), 10000, 400);
  ok(fileSeen, '备份文件列表列出真实配置备份文件', (await filesTxt()).replace(/\s+/g, ' ').slice(0, 70));
  await mainEval(`(() => { const b = document.querySelector('#modalRoot [data-act=close]'); if (b) b.click(); return true; })()`);
  await sleep(300);
}

// ================= G11 网络服务（真机流量进面板） =================
async function caseServices(CFG, mainEval, conn, devRun, ourIp, d1) {
  section('G11 网络服务（界面启用 + 真机真实流量）');
  if (!ourIp) { skip('网络服务真机互操作', '未取到测试机地址'); return; }
  await mainEval(`document.getElementById('btnDropMonitor').click(); true`);
  await sleep(300);
  await mainEval(`(() => { const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('网络服务')); b && b.click(); return !!b; })()`);
  await sleep(1500);
  const hasPanel = await mainEval(`!!document.getElementById('nsvSysOn')`);
  if (!ok(hasPanel, '网络服务面板可打开')) return;

  const applied = await mainEval(`(() => {
    const setV = (el, v) => { if (!el) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); return true; };
    const setC = (el, v) => { if (!el) return false; el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    setC(document.getElementById('nsvSysOn'), true);
    setV(document.getElementById('nsvSysPort'), ${JSON.stringify(String(CFG.ports.syslog))});
    setC(document.getElementById('nsvSysAlertOn'), true);
    setV(document.getElementById('nsvSysAlertKw'), 'NETTOPO-GUI-IF-DOWN');
    setC(document.getElementById('nsvTrapOn'), true);
    setV(document.getElementById('nsvTrapPort'), ${JSON.stringify(String(CFG.ports.trap))});
    setV(document.getElementById('nsvTrapCommunity'), 'public');
    setC(document.getElementById('nsvTftpOn'), true);
    setV(document.getElementById('nsvTftpPort'), ${JSON.stringify(String(CFG.ports.tftp))});
    document.querySelector('[data-act=apply]').click();
    return true;
  })()`);
  ok(applied, '界面启用 Syslog（含告警关键字）/ Trap / TFTP 并应用');
  await sleep(2500);
  const stText = String(await mainEval(`(() => { const g = id => (document.getElementById(id) || {}).textContent || ''; return 'sys=' + g('nsvSysSt') + ' trap=' + g('nsvTrapSt') + ' tftp=' + g('nsvTftpSt'); })()`));
  ok(/运行|running|端口/i.test(stText), '面板显示三个服务已运行', stText.replace(/\s+/g, ' ').slice(0, 80));

  // 真机发一条命中关键字的 syslog
  const r1 = await devRun(d1, `printf '%s\\n' '<131>Sep 12 10:00:00 ${d1.name} nettopo-gui: %IFNET/4/IF_STATE(l): interface NETTOPO-GUI-IF-DOWN down' | nc -u -w1 ${ourIp} ${CFG.ports.syslog}`, 1200);
  const logSeen = await waitUntil(async () => String(await mainEval(`(document.getElementById('nsvLog') || {}).textContent || ''`)).includes('NETTOPO-GUI-IF-DOWN'), 12000, 500);
  ok(logSeen, '真机 Syslog 实时出现在面板日志区', r1 && r1.ok ? '' : '（设备侧返回异常）');
  // 命中关键字的行由面板打 s-hit 标记（title 写明命中的关键字）
  const alertInfo = await mainEval(`(() => {
    const l = document.getElementById('nsvLog');
    if (!l) return null;
    const hit = [...l.querySelectorAll('.nsv-lg.s-hit')].find(x => (x.textContent || '').includes('NETTOPO-GUI-IF-DOWN'));
    return hit ? { cls: hit.className, title: hit.getAttribute('title') || '' } : null;
  })()`);
  ok(!!alertInfo && /命中/.test(alertInfo.title), '命中关键字的日志在面板中被标记为告警（s-hit + 命中说明）',
    alertInfo ? String(alertInfo.title).slice(0, 60) : '未找到告警标记');

  // 真机发一个 trap
  await devRun(d1, `SNMP_PERSISTENT_DIR=/tmp/nt-gui HOME=/tmp snmptrap -v2c -c public ${ourIp}:${CFG.ports.trap} '' 1.3.6.1.6.3.1.1.5.1 1.3.6.1.2.1.1.5.0 s ${d1.name}`, 1500);
  const trapSeen = await waitUntil(async () => String(await mainEval(`(document.getElementById('nsvTrapList') || {}).textContent || ''`)).includes(d1.name), 12000, 500);
  ok(trapSeen, '真机 SNMP Trap 实时出现在面板 Trap 区');

  // 实验机 TFTP 上传 → 面板文件列表
  const fname = 'gui-live-' + Date.now() + '.txt';
  await lab.exec(conn, `printf NETTOPO-GUI-TFTP > /tmp/nt-gui-tftp.txt && curl -s --max-time 8 -T /tmp/nt-gui-tftp.txt tftp://${ourIp}:${CFG.ports.tftp}/${fname} && echo PUT_OK`, {});
  await mainEval(`(() => { const b = document.querySelector('[data-act=refresh]'); if (b) b.click(); return true; })()`);
  const fileSeen = await waitUntil(async () => String(await mainEval(`(document.getElementById('nsvFiles') || {}).textContent || ''`)).includes(fname), 12000, 600);
  ok(fileSeen, 'TFTP 收到的文件出现在面板文件区（真实传输）', fname);

  await mainEval(`(() => { const b = document.querySelector('#modalRoot [data-act=close]'); if (b) b.click(); return true; })()`);
  await sleep(300);
}

// ================= G12 诊断工具箱（真机探测） =================
async function caseDiag(CFG, mainEval, d1) {
  section('G12 诊断工具箱（界面发起真机诊断）');
  await mainEval(`document.getElementById('btnDropMonitor').click(); true`);
  await sleep(300);
  await mainEval(`(() => { const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('诊断工具箱')); b && b.click(); return !!b; })()`);
  await sleep(600);
  if (!ok(await mainEval(`!!document.getElementById('dgHost')`), '诊断工具箱可打开')) return;

  // 端口扫描：真机 SSH/Telnet 端口应开放，未用端口应关闭
  const runScan = await mainEval(`(() => {
    const setV = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const setS = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    setV(document.getElementById('dgHost'), ${JSON.stringify(d1.host)});
    setS(document.getElementById('dgTool'), 'tcp');
    setV(document.getElementById('dgPorts'), ${JSON.stringify(String(d1.sshPort) + ',' + String(d1.telnetPort) + ',65099')});
    document.getElementById('dgRun').click();
    return true;
  })()`);
  ok(runScan, '界面发起 TCP 端口探测（真机）');
  const outTxt = async () => String(await mainEval(`(document.getElementById('dgOut') || {}).textContent || ''`));
  const scanOk = await waitUntil(async () => new RegExp(String(d1.sshPort) + '[^\\n]*(开放|open)').test(await outTxt()), 20000, 500);
  ok(scanOk, '探测结果标注真机 SSH 管理口开放', (await outTxt()).replace(/\s+/g, ' ').slice(0, 90));
  ok(new RegExp('65099[^\\n]*(关闭|closed|未开放|超时)').test(await outTxt()), '未开放端口如实标注关闭');

  // SNMP Walk：真机 system 子树
  await mainEval(`(() => {
    const setV = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const setS = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    setV(document.getElementById('dgHost'), ${JSON.stringify(d1.host)});
    setS(document.getElementById('dgTool'), 'snmp');
    const p = document.getElementById('dgSnmpPort'); if (p) setV(p, ${JSON.stringify(String(d1.snmpPort))});
    const c = document.getElementById('dgComm'); if (c) setV(c, 'public');
    const o = document.getElementById('dgOid'); if (o) setV(o, '1.3.6.1.2.1.1');
    document.getElementById('dgRun').click();
    return true;
  })()`);
  const walkOk = await waitUntil(async () => (await outTxt()).includes(d1.name), 25000, 600);
  ok(walkOk, 'SNMP Walk 结果含真机 sysName（' + d1.name + '）');
  await mainEval(`(() => { const b = document.querySelector('#modalRoot [data-act=close]'); if (b) b.click(); return true; })()`);
}
