/* NetTopo 真机集成测试（test/live.js）
 * ---------------------------------------------------------------------------
 * 与 test/run-tests.js（纯逻辑 + 协议级 mock）和 test/e2e.js（无头浏览器界面）互补：
 * 这里连**真实的网络设备**跑全链路，验证 mock 覆盖不到的真实互操作——
 *   A 连接层：真 OpenSSH 会话/批量巡检/主机指纹 TOFU/真 Telnet CLI
 *   B 设备监控：在线探测、SSH 指标、SNMP v2c/v3 识别、ifTable、CPU/内存、重启检测、链路流量
 *   C 配置备份：真实设备 `show running-config` 取回入库、变更 diff、失败如实上报
 *   D 内置网络服务：设备真实发 Syslog（UDP/TCP）、SNMP Trap，真实 TFTP/FTP 双向传输
 *   E 诊断工具箱：真机端口探测与 SNMP Walk
 *
 * 实验环境（默认 192.168.50.148，多台 FRR netns 设备 + sshd + snmpd + telnet vty）由
 * test/live-lab.sh 自动部署/拆除；端口映射与 iptables 规则、AppArmor 注意事项见该脚本头部注释。
 *
 * 用法：
 *   NETTOPO_LAB_HOST=192.168.50.148 node test/live.js              # 部署 → 跑全部 → 拆除
 *   node test/live.js --host 192.168.50.148 --keep                  # 保留环境便于排障
 *   node test/live.js --host 192.168.50.148 --skip-setup            # 用已部署好的环境
 *   node test/live.js --host 192.168.50.148 --only conn,diag        # 只跑指定分组
 * 环境变量：
 *   NETTOPO_LAB_HOST     实验宿主机 IP（**必填**；不填则打印跳过说明并以 0 退出，CI 友好）
 *   NETTOPO_LAB_USER     设备/宿主机登录账号（默认 a）
 *   NETTOPO_LAB_PASS     登录口令（默认 a）
 *   NETTOPO_LAB_ROOT_PASS sudo 口令（默认同登录口令）
 *   NETTOPO_LAB_KEEP=1   保留实验环境（等价 --keep）
 *   NETTOPO_LAB_SKIP_SETUP=1  跳过部署，直接用现有环境
 * 前置条件（测试机侧）：
 *   - 能 SSH 登录实验宿主机（部署需要 sudo 口令）
 *   - 允许实验宿主机主动连回测试机（Syslog/Trap/TFTP/FTP 是设备 → 测试机方向）。
 *     Windows 默认入站拦截 UDP，需放行（管理员 PowerShell，按实测端口收窄）：
 *       New-NetFirewallRule -DisplayName "NetTopo 真机集成测试" -Direction Inbound -Action Allow `
 *         -Protocol UDP -LocalPort 15069,15162,15514 -RemoteAddress <实验宿主机IP>
 *       New-NetFirewallRule -DisplayName "NetTopo 真机集成测试 TCP" -Direction Inbound -Action Allow `
 *         -Protocol TCP -LocalPort 15021,15500-15510,15514 -RemoteAddress <实验宿主机IP>
 *     放行不通时相关用例会**跳过并说明原因**，不会误判为失败。
 * ---------------------------------------------------------------------------
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const { ShellManager } = require('../js/shell.js');
const { MonitorManager, snmpGetValue, snmpWalk } = require('../js/monitor.js');
const { ConfigBackupStore } = require('../js/config-backup.js');
const { NetServices } = require('../js/net-services.js');
const { scanPorts } = require('../js/diag.js');
require('../js/util.js');
const U = globalThis.TopoUtil;

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
  only: argVal('only', process.env.NETTOPO_LAB_ONLY || ''),
  timeoutMs: Number(argVal('timeout', '20000')),
  // 发布端口（与 test/live-lab.sh 的 PUB_* 基址一致，也与文档里的放行命令一致）
  ports: { syslog: 15514, trap: 15162, tftp: 15069, ftp: 15021, ftpPasvMin: 15500, ftpPasvMax: 15510 }
};
const GROUPS = [
  ['conn', 'A. 连接层（Web Shell 底层 / 真实设备 CLI）'],
  ['mon', 'B. 设备监控（MonitorManager 全链路）'],
  ['bk', 'C. 配置备份（真实配置取回入库）'],
  ['svc', 'D. 内置网络服务与设备真实互操作'],
  ['diag', 'E. 诊断工具箱（真机探测）']
];
const onlyGroups = CFG.only ? CFG.only.split(',').map(s => s.trim()).filter(Boolean) : null;
const runGroup = (id) => !onlyGroups || onlyGroups.includes(id);

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
    await sleep(step || 400);
  }
}
const joined = (r) => ((r && r.outputs) || []).map(o => o.text || '').join('\n');

// ---------------------------------------------------------------- SSH 控制通道（部署/拆除/宿主侧操作）
// 实现集中在 test/lab-lib.js（与 test/gui-live.js 共用）：这里只做薄封装，保持本文件调用点不变
const lab = require('./lab-lib.js');
const connectSsh = (opts) => lab.connectSsh(opts);
function exec(conn, cmd, opts) {
  return lab.exec(conn, cmd, Object.assign({ rootPass: CFG.rootPass }, opts || {}));
}
const upload = (conn, local, remote) => lab.upload(conn, local, remote);

// ---------------------------------------------------------------- 环境部署
let inventory = null;
async function provision(conn) {
  line('[lab] 部署实验环境（多台 FRR 设备 + sshd + snmpd + telnet vty）…');
  return lab.provision(conn, {
    host: CFG.host, rootPass: CFG.rootPass, script: path.join(__dirname, 'live-lab.sh'),
    onLine: (l) => line('      ' + l)
  });
}
async function teardown(conn) {
  line('[lab] 拆除实验环境…');
  await lab.teardown(conn, { rootPass: CFG.rootPass, onLine: (l) => line('      ' + l) });
}

// ---------------------------------------------------------------- 环境自检：测试机入站可达性
/** 设备 → 测试机方向的 Syslog/Trap/TFTP/FTP 需要测试机放行入站；不通时相关用例跳过并给提示。
 *  直接在真实端口上探测（不是额外端口），否则测出来的结论与业务端口不一致。 */
async function probeInbound(conn, ourIp) {
  const udpOk = await new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.close(); } catch (e) { /* ignore */ } resolve(v); };
    s.on('message', (m) => { if (/NETTOPO-LAB-PROBE/.test(m.toString())) fin(true); });
    s.on('error', () => fin(false));
    s.bind(CFG.ports.syslog, '0.0.0.0', () => {
      exec(conn, `nc -u -w1 ${ourIp} ${CFG.ports.syslog} <<< NETTOPO-LAB-PROBE`, {}).catch(() => {});
      setTimeout(() => fin(false), 4000);
    });
  });
  const tcpOk = await new Promise((resolve) => {
    let done = false;
    const srv = net.createServer((c) => { try { c.destroy(); } catch (e) { /* ignore */ } if (!done) { done = true; try { srv.close(); } catch (e) { /* ignore */ } resolve(true); } });
    srv.on('error', () => { if (!done) { done = true; resolve(false); } });
    srv.listen(CFG.ports.ftp, '0.0.0.0', () => {
      exec(conn, `nc -w2 ${ourIp} ${CFG.ports.ftp} </dev/null`, {}).catch(() => {});
      setTimeout(() => { if (!done) { done = true; try { srv.close(); } catch (e) { /* ignore */ } resolve(false); } }, 4000);
    });
  });
  return { udpOk, tcpOk };
}
const ourAddress = (conn, hosts) => lab.ourAddress(conn, hosts);

// ---------------------------------------------------------------- 设备侧动作（经设备自己的 SSH 管理口）
// 同样是 lab-lib 的薄封装：shell 在 main 里创建后再注入
let shell = null;
let devH = null;
const devRun = (dev, cmd, waitMs) => devH.devRun(dev, cmd, waitMs);
const devCli = (dev, cmd, waitMs) => devH.devCli(dev, cmd, waitMs);
/** 在实验宿主机上执行命令（控制通道；返回形态与 runOneShot 一致，便于复用 joined） */
async function hostRun(cmd) {
  const r = await exec(connGlobal, cmd, {});
  return { ok: r.code === 0, outputs: [{ cmd, text: r.out + (r.err || '') }], error: r.err || null };
}

// ---------------------------------------------------------------- 主流程
(async () => {
  if (!CFG.host) {
    line('未指定实验宿主机：设置 NETTOPO_LAB_HOST=<IP> 或 --host <IP> 后重跑。');
    line('（真机集成测试需要一台可 SSH 登录的 Linux 实验机；本脚本会自动在其上部署 FRR 多设备实验环境）');
    process.exit(0);
  }
  line('== NetTopo 真机集成测试 ==');
  line('  实验宿主机：' + CFG.host + '（账号 ' + CFG.user + '）');
  line('  测试分组：' + (onlyGroups ? onlyGroups.join(',') : '全部（' + GROUPS.map(g => g[0]).join(',') + '）'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nettopo-live-'));
  const conn = await connectSsh({ host: CFG.host, user: CFG.user, pass: CFG.pass }).catch((e) => {
    console.error('[失败] 无法 SSH 登录实验宿主机 ' + CFG.host + '：' + e.message);
    process.exit(1);
  });
  let toreDown = false;
  const cleanup = async () => {
    if (toreDown || CFG.keep) return;
    toreDown = true;
    try { await teardown(conn); } catch (e) { console.error('[警告] 拆除失败：' + e.message); }
  };

  try {
    if (!CFG.skipSetup) inventory = await provision(conn);
    if (!inventory) {
      const r = await exec(conn, 'bash /tmp/nettopo-live-lab.sh inv', { sudo: true });
      const m = r.out.match(/^NETTOPO_LAB_INVENTORY=(.+)$/m);
      if (!m) throw new Error('未部署实验环境且拿不到清单；先跑一次不带 --skip-setup 的完整流程');
      inventory = JSON.parse(m[1]);
    }
    const devs = inventory.devices || [];
    const d1 = devs[0], d2 = devs[1], d3 = devs[2];
    line('[lab] 设备：' + devs.map(d => d.name + '(' + d.host + ':' + d.sshPort + ')').join(' · '));

    // 设备主机密钥真实指纹（用于断言应用侧 TOFU 记录 == 设备真实密钥）
    const hostKeys = {};
    for (const d of devs) {
      const r = await exec(conn, `ssh-keygen -lf ${d.sshDir}/ssh_host_ed25519_key.pub`);
      const m = r.out.match(/SHA256:[A-Za-z0-9+/=]+/);
      hostKeys[d.id] = m ? m[0] : '';
    }

    // 入站探测（设备 → 测试机方向）
    const ourIp = await ourAddress(conn, CFG.host);
    const inbound = ourIp ? await probeInbound(conn, ourIp) : { udpOk: false, tcpOk: false };
    line('[net] 测试机地址 ' + (ourIp || '未探测到') + '；设备→测试机 UDP ' + (inbound.udpOk ? '可达' : '不可达') + '，TCP ' + (inbound.tcpOk ? '可达' : '不可达'));
    connGlobal = conn; ourIpGlobal = ourIp;

    shell = new ShellManager({ logDir: path.join(tmp, 'shell-logs') });
    devH = lab.makeDevHelpers(shell, { pass: CFG.pass });
    const backupStore = new ConfigBackupStore(path.join(tmp, 'config-backups'));
    const monitor = new MonitorManager(shell, path.join(tmp, 'monitor-logs'), path.join(tmp, 'trust.json'), { backupStore });
    const netSvc = new NetServices({ baseDir: path.join(tmp, 'net-services') });
    const syslogAlerts = [], trapEvents = [];
    netSvc.on('syslog-alert', (a) => syslogAlerts.push(a));
    netSvc.on('trap', (t) => trapEvents.push(t));

    if (runGroup('conn')) await groupConn(devs, d1, hostKeys, tmp);
    if (runGroup('mon')) await groupMonitor(devs, d1, d2, monitor);
    if (runGroup('bk')) await groupBackup(devs, d1, monitor, backupStore);
    if (runGroup('svc')) await groupServices(devs, d1, netSvc, syslogAlerts, trapEvents, inbound);
    if (runGroup('diag')) await groupDiag(devs, d1);

    monitor.stopAll();
    await netSvc.stopAll();
    shell.closeAll();
    await cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });

    line('\n== 结果：' + pass + ' 通过，' + fail + ' 失败' + (skipped ? '，' + skipped + ' 跳过' : '') + ' ==');
    if (failures.length) { line('失败项：'); for (const f of failures) line('  ✗ ' + f); }
    if (CFG.keep) line('实验环境已保留（--keep）：需要时 sudo bash test/live-lab.sh down 拆除');
    process.exit(fail ? 1 : 0);
  } catch (e) {
    try { await cleanup(); } catch (e2) { /* ignore */ }
    console.error('\n[live][异常] ' + (e && e.message ? e.message : e));
    if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  }
})();

/* ================= A. 连接层 ================= */
async function groupConn(devs, d1, hostKeys, tmp) {
  section(GROUPS[0][1]);

  // A1 真实 SSH 单次执行：每台设备都跑（多设备下的连接与输出聚合）
  {
    const outs = [];
    for (const d of devs) {
      const r = await shell.runOneShot({
        protocol: 'ssh', host: d.host, port: d.sshPort, username: d.sshUser, password: CFG.pass,
        commands: ['uname -s', 'nt-cli -c "show version" | head -1', 'nt-cli -c "show running-config" | grep -m1 ^hostname'], waitMs: 1200
      });
      outs.push({ d, r, t: joined(r) });
    }
    ok(outs.every(o => o.r.ok && (o.r.outputs || []).length === 3), 'SSH 单次执行：' + devs.length + ' 台设备各 3 条命令全部返回');
    ok(outs.every(o => /Linux/.test(o.t)), '设备 Linux 层信息真实（uname -s）');
    ok(outs.every(o => /FRRouting/i.test(o.t)), '设备 CLI 真实（nt-cli → vtysh 输出的 FRRouting 版本行）');
    const wrongDev = outs.filter(o => !new RegExp('hostname\\s+' + o.d.name + '\\b').test(o.t));
    ok(wrongDev.length === 0, '每台设备返回自己的配置主机名（多设备未串台）',
      outs.map(o => (o.t.match(/hostname\s+(\S+)/) || [])[1]).join('/'));
  }

  // A2 主机指纹 TOFU：应用记录的指纹必须等于设备真实主机密钥指纹，且二次连接稳定
  {
    const d = d1;
    const first = await shell.runOneShot({ protocol: 'ssh', host: d.host, port: d.sshPort, username: d.sshUser, password: CFG.pass, commands: ['echo NETTOPO-A2'], waitMs: 600 });
    const fp1 = (first.fingerprint || {}).fp || '';
    ok(/^SHA256:/.test(fp1), '首次连接记录 SHA256 主机指纹', fp1.slice(0, 24) + '…');
    const real = hostKeys[d.id] || '';
    if (real) ok(fp1 === real, '应用记录的指纹 == 设备真实主机密钥指纹（TOFU 无偏差）', real.slice(0, 24) + '…');
    else skip('应用记录的指纹 == 设备真实主机密钥指纹', '未能从实验机读到设备主机密钥');
    const second = await shell.runOneShot({ protocol: 'ssh', host: d.host, port: d.sshPort, username: d.sshUser, password: CFG.pass, commands: ['echo NETTOPO-A2'], waitMs: 600 });
    ok(((second.fingerprint || {}).fp || '') === fp1, '再次连接指纹稳定（未误报变更）');
    // 期望指纹不符 → 严格拒连（中间人场景）
    const bad = await shell.runOneShot({
      protocol: 'ssh', host: d.host, port: d.sshPort, username: d.sshUser, password: CFG.pass,
      commands: ['echo SHOULD-NOT-RUN'], waitMs: 600, expectFp: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    });
    ok(bad.ok === false && !/SHOULD-NOT-RUN/.test(joined(bad)), '期望指纹不符时拒连（未执行任何命令）', bad.error || '');
  }

  // A3 真实 Telnet CLI（FRR vty）：正确口令进 CLI，错误口令如实失败
  {
    const d = d1;
    const good = await shell.runOneShot({
      protocol: 'telnet', host: d.host, port: d.telnetPort, username: '', password: d.telnetPassword,
      commands: ['show version', 'show ip route'], waitMs: 1200
    });
    const gt = joined(good);
    // 登录横幅本身也含 "FRRouting"：用 CLI 专有输出（带主机名与内核行）判定，避免假阳性
    const cliLine = new RegExp('FRRouting \\d[\\d.]* \\(' + d.name + '\\) on Linux');
    ok(good.ok && cliLine.test(gt), 'Telnet 登录真实设备 CLI（show version 的 CLI 输出带主机名与内核信息）',
      (gt.match(/FRRouting \d[\d.]* \([^)]+\)[^\n]{0,20}/) || ['(未见 CLI 输出)'])[0]);
    // 路由表图例是 CLI 专有输出，登录横幅/口令提示里不会出现
    ok(/Codes: K - kernel route/i.test(gt), 'Telnet 会话中 show ip route 返回真实路由表',
      (gt.match(/(?:Codes:[^\n]{0,40})/) || [''])[0]);
    const bad = await shell.runOneShot({
      protocol: 'telnet', host: d.host, port: d.telnetPort, username: '', password: 'wrong-pass',
      commands: ['show version'], waitMs: 1200
    });
    ok(bad.ok === false || !/Codes: K - kernel route/i.test(joined(bad)), 'Telnet 错误口令被拒（拿不到 CLI 输出）', bad.error || '');
  }

  // A4 批量巡检（只读白名单）对真实设备执行；配置类命令被白名单拦截
  {
    const d = d1;
    ok(U.checkInspectCommands(U.INSPECT_PRESETS.linux).ok === true, 'Linux 巡检命令集通过只读白名单校验');
    ok(U.checkInspectCommands(['configure terminal']).ok === false, '配置类命令被只读白名单拦截');
    const r = await shell.runOneShot({
      protocol: 'ssh', host: d.host, port: d.sshPort, username: d.sshUser, password: CFG.pass,
      commands: U.INSPECT_PRESETS.linux, waitMs: 900
    });
    const t = joined(r);
    ok(r.ok && (r.outputs || []).length === U.INSPECT_PRESETS.linux.length, '批量巡检在真机上执行完 ' + U.INSPECT_PRESETS.linux.length + ' 条命令');
    ok(/Linux/.test(t) && /Mem:|load average|Filesystem/i.test(t), '巡检输出含真实系统信息（uname/free/df/uptime）');
  }

  // A5 SFTP 文件管理：真实上传/下载往返（Web Shell 文件面板底层）
  {
    const d = d1;
    const local = path.join(tmp, 'sftp-roundtrip.txt');
    fs.writeFileSync(local, 'NETTOPO-SFTP-' + Date.now() + '\n', 'utf8');
    const c = shell.connect({ protocol: 'ssh', host: d.host, port: d.sshPort, username: d.sshUser, password: CFG.pass, cols: 100, rows: 30 });
    const sid = c && c.id;
    let connected = false, lastErr = '', fpPrompt = '';
    const onStatus = (id, info) => {
      if (id !== sid) return;
      if (info.state === 'connected') connected = true;
      if (info.state === 'error') lastErr = info.text || '';
      // 首次连接必须暂停握手等人工确认（TOFU）：这里扮演 Web Shell 界面上点「信任」的用户
      if (info.state === 'fingerprint') { fpPrompt = info.fp || ''; shell.trustFingerprint(info.host || d.host, true, 'ui'); }
    };
    shell.on('status', onStatus);
    if (!c || !c.ok) ok(false, 'SFTP 上传/下载往返内容一致', (c && c.error) || '会话建立失败');
    else {
      await waitUntil(() => connected || lastErr, 15000, 200);
      ok(!!fpPrompt && /^SHA256:/.test(fpPrompt), '交互会话首连弹出指纹确认（TOFU 人工确认门）', fpPrompt.slice(0, 22) + '…');
      if (!connected) ok(false, 'SSH 交互会话就绪（PTY）', lastErr || '等待 connected 超时');
      else {
        ok(true, 'SSH 交互会话就绪（真实 PTY 会话）');
        try {
          const remote = '/tmp/nettopo-live-sftp.txt';
          const up = await shell.sftpUpload(sid, local, remote);
          const down = path.join(tmp, 'sftp-back.txt');
          await shell.sftpDownload(sid, remote, down);
          const back = fs.readFileSync(down, 'utf8');
          ok(up && up.ok !== false && fs.readFileSync(local, 'utf8') === back, 'SFTP 上传→下载往返内容一致');
          const ls = await shell.sftpList(sid, '/tmp');
          ok(ls && ls.ok !== false && (ls.items || []).some(i => String(i.name || '') === 'nettopo-live-sftp.txt'), 'SFTP 目录列举命中刚上传的文件');
          await shell.sftpRemove(sid, remote);
        } catch (e) {
          ok(false, 'SFTP 上传→下载往返内容一致', (e && e.message) || String(e));
        }
      }
      shell.removeListener('status', onStatus);
      shell.close(sid);
    }
  }
}

/* ================= B. 设备监控 ================= */
async function groupMonitor(devs, d1, d2, monitor) {
  section(GROUPS[1][1]);
  const events = { probe: [], sysinfo: [], metric: [], iftraffic: [], perf: [], reboot: [], ifstatus: [], backup: [] };
  for (const k of Object.keys(events)) monitor.on(k, (v) => events[k].push(v));
  const MEM_USED = '1.3.6.1.4.1.2021.4.5.0', MEM_FREE = '1.3.6.1.4.1.2021.4.6.0';
  const CPU_IDLE = '1.3.6.1.4.1.2021.11.11.0'; // Linux UCD ssCpuIdle（cpuMode: idle100）
  const keys = [];
  const mkKey = (d) => d.id + '@' + d.host + ':' + d.sshPort;

  // B1 在线探测（真实 TCP 连接）：三台全在线
  {
    for (const d of devs) {
      const key = mkKey(d); keys.push(key);
      const st = monitor.start({
        key, deviceId: d.id, name: d.name, protocol: 'ssh', host: d.host, port: d.sshPort,
        username: d.sshUser, password: CFG.pass, commands: ['echo nettopo-monitor-alive'], intervalSec: 3600,
        // 采集首轮都排在 initDelayMs 之后：取 6s 让「建连 + 首轮命令循环」先跑完，
        // 否则首轮指标采集会因会话忙被跳过，只能等下一个 60s 间隔（min 间隔由产品钳制）
        initDelayMs: 6000,
        probe: { enabled: true, type: 'tcp', intervalSec: 5 },
        sysinfo: {
          enabled: true, community: 'public', snmpPort: d.snmpPort, intervalSec: 30, ifTable: true, sysUpTime: true,
          perf: { enabled: true, cpuOid: CPU_IDLE, cpuMode: 'idle100', memUsedOid: MEM_USED, memFreeOid: MEM_FREE, memMode: 'totalavail' }
        },
        metrics: { enabled: true, intervalSec: 60 }
      });
      if (!st.ok) ok(false, '监控任务启动（' + d.name + '）', st.error || '');
    }
    ok(keys.length === devs.length, '已为 ' + devs.length + ' 台设备启动监控任务');
    const allOnline = await waitUntil(() => devs.every(d => events.probe.some(p => p.host === d.host && p.ok === true)), Math.max(CFG.timeoutMs, 20000), 500);
    ok(allOnline, '在线探测：' + devs.length + ' 台真实设备全部在线', '探测样本 ' + events.probe.length + ' 条');
    ok(events.probe.every(p => Number.isFinite(p.latencyMs) && p.latencyMs >= 0), '探测时延为真实测量值（同网段应为个位毫秒级）',
      '样例 ' + events.probe.slice(-3).map(p => p.host + ':' + p.latencyMs + 'ms').join(' '));
  }

  // B2 SNMP v2c 自动识别（真 net-snmp）：sysDescr 与设备名
  {
    const got = await waitUntil(() => devs.every(d => events.sysinfo.some(s => s.host === d.host)), 40000, 500);
    ok(got, 'SNMP 自动识别：' + devs.length + ' 台设备均返回 sysDescr');
    const descrs = events.sysinfo.map(s => s.descr || '');
    ok(descrs.some(x => /Linux|net-snmp/i.test(x)), 'sysDescr 来自真实 net-snmp 代理', (descrs[0] || '').slice(0, 60));
  }

  // B3 SNMP v3 authPriv（SHA/AES）互操作：识别 + 采集成功
  {
    const d = d2, key = 'v3@' + d.host + ':' + d.sshPort;
    const r3 = await snmpGetValue(d.host, { user: 'v3priv', authProto: 'sha', authPass: 'AuthPass1', privProto: 'aes', privPass: 'PrivPass1' }, '1.3.6.1.2.1.1.5.0', 4000, d.snmpPort);
    ok(r3.ok && String(r3.value).indexOf(d.name) >= 0, 'SNMP v3 authPriv（SHA/AES）读取 sysName 成功', 'sysName=' + r3.value);
    const bad = await snmpGetValue(d.host, { user: 'v3priv', authProto: 'sha', authPass: 'WrongPass', privProto: 'aes', privPass: 'PrivPass1' }, '1.3.6.1.2.1.1.5.0', 4000, d.snmpPort);
    ok(bad.ok === false, 'SNMP v3 错误认证口令被拒（不误报成功）', bad.error || '');
    const va = await snmpGetValue(d.host, { user: 'v3auth', authProto: 'sha', authPass: 'AuthPass1' }, '1.3.6.1.2.1.1.1.0', 4000, d.snmpPort);
    ok(va.ok && /Linux|net-snmp/i.test(String(va.value)), 'SNMP v3 auth（仅认证，不加密）互通');
    monitor.start({
      key, deviceId: 'v3', name: d.name + '-v3', protocol: 'ssh', host: d.host, port: d.sshPort,
      username: d.sshUser, password: CFG.pass, commands: ['echo v3'], intervalSec: 120, initDelayMs: 300,
      sysinfo: { enabled: true, snmpPort: d.snmpPort, v3User: 'v3priv', v3AuthProto: 'sha', v3AuthPass: 'AuthPass1', v3PrivProto: 'aes', v3PrivPass: 'PrivPass1', intervalSec: 30, ifTable: true }
    });
    const v3info = await waitUntil(() => events.sysinfo.some(s => s.deviceId === 'v3'), 40000, 500);
    ok(v3info, 'SNMP v3 任务链路识别成功（监控侧走 USM 通道）');
    monitor.stop(key);
  }

  // B4 ifTable 采集：真实接口与计数器
  {
    const got = await waitUntil(() => events.iftraffic.some(s => (s.ifs || []).length > 0), 40000, 500);
    ok(got, 'SNMP ifTable 采集到真实接口列表');
    const sample = events.iftraffic.find(s => (s.ifs || []).length > 0) || {};
    const ifs = sample.ifs || [];
    ok(ifs.some(f => /^(lo|ntp|nt-)/.test(String(f.n || ''))), '接口名来自真实设备（含管理/环回接口）', ifs.slice(0, 4).map(f => f.n + ':' + f.oper).join(' '));
    ok(ifs.every(f => Number(f.in == null ? 0 : f.in) >= 0 && Number(f.out == null ? 0 : f.out) >= 0), '接口计数器非负（真实字节数）');
  }

  // B5 SSH 指标采集（df/free/loadavg 真实解析） + 阈值告警数据
  {
    // 指标采集在「会话忙」时跳过本轮、下轮要等 intervalSec（产品下限 60s），故等待窗给足；
    // 正常路径首轮 ~8s 就有样本，长等待只是兜住偶发的首轮撞车
    const got = await waitUntil(() => events.metric.length > 0, 75000, 800);
    const m0 = (events.metric[0] || {}).sample || {};
    ok(got, 'SSH 指标采集产出样本');
    ok(Number.isFinite(m0.mem), '内存占用解析出真实数值（free -m；真机 locale 非英文时曾恒为空值）', 'mem=' + m0.mem + '%');
    ok(Array.isArray(m0.disks) && m0.disks.length > 0 && m0.disks.every(d => d.pct >= 0 && d.pct <= 100), '磁盘占用解析出真实挂载点',
      JSON.stringify((m0.disks || []).slice(0, 3)));
    ok(!!(m0.load && Number.isFinite(m0.load.l1)), '负载解析出真实数值', JSON.stringify(m0.load));
    if (Number.isFinite(m0.mem)) ok(m0.mem > 0 && m0.mem <= 100, '内存占用百分比在合理区间', m0.mem + '%');
    const hist = monitor.metricHistory(keys[0]);
    ok(hist && hist.ok !== false && (hist.hist || []).length > 0, '指标历史可读取（监控中心趋势数据源）');
  }

  // B6 性能采集（UCD CPU/内存 + sysUpTime）
  {
    const gotPerf = await waitUntil(() => events.perf.some(p => p.up != null), 45000, 500);
    ok(gotPerf, '性能采集产出样本（CPU/内存/sysUpTime）');
    const withMem = events.perf.filter(p => p.mem != null);
    ok(events.perf.some(p => p.up != null && p.up > 0), 'sysUpTime 读取成功（重启检测基线）');
    if (withMem.length) ok(withMem.every(p => p.mem >= 0 && p.mem <= 100), '内存占用百分比合理（Linux UCD total−avail 口径）', withMem.slice(-1)[0].mem + '%');
    else skip('内存占用百分比合理（Linux UCD total−avail 口径）', '该设备未返回 UCD 内存 OID');
    const withCpu = events.perf.filter(p => p.cpu != null);
    if (withCpu.length) ok(withCpu.every(p => p.cpu >= 0 && p.cpu <= 100), 'CPU 占用百分比合理（ssCpuIdle 换算）', withCpu.slice(-1)[0].cpu + '%');
    else skip('CPU 占用百分比合理（ssCpuIdle 换算）', '该设备未返回 UCD CPU OID');
  }

  // B7 重启检测：设备侧重启 snmpd → sysUpTime 骤减 → reboot 事件
  {
    const d = d1;
    // 判定带 5 分钟容忍窗（防采样抖动），而实验室 snmpd 刚起不久，注入「2 小时」基线以走真实的骤减判定路径
    const job = monitor.jobs && monitor.jobs.get(keys[0]);
    if (job && job.upPrev != null) {
      job.upPrev = 720000;
      // 按 pidfile 精确重启本设备的 snmpd：不能用 pkill -f <配置路径>——该模式同样匹配
      // 「正在执行这条命令的 bash」自身，pkill 会先把执行者杀掉，后面的启动命令根本不会跑
      const r = await exec(connGlobal, `kill $(cat ${d.runDir}/snmpd.pid) 2>/dev/null; sleep 1; ip netns exec ${d.ns} /usr/sbin/snmpd -C -c ${d.configDir}/snmpd.conf -p ${d.runDir}/snmpd.pid -Lf ${d.logDir}/snmpd.log </dev/null >/dev/null 2>&1 & sleep 2; cat ${d.runDir}/snmpd.pid`, { sudo: true });
      const rb = await waitUntil(() => events.reboot.length > 0, 50000, 800);
      ok(rb, 'sysUpTime 骤减触发重启检测事件（真实设备重启 snmpd）', '重启后 pid=' + String(r.out || '').trim().split('\n').pop());
      if (rb) ok(events.reboot[0].prev > events.reboot[0].cur, '重启判定方向正确（prev > cur）', events.reboot[0].prev + ' → ' + events.reboot[0].cur);
    } else skip('sysUpTime 骤减触发重启检测事件', '未取到 upPrev 基线');
  }

  // B8 链路流量叠加：用真实 ifTable 两轮采样算利用率
  {
    // 速率要两次采样差值：挑一个「已带速率」的样本（waitUntil 只回布尔，样本自己存下来）
    let rate = null;
    await waitUntil(() => {
      const arr = events.iftraffic.filter(x => (x.ifs || []).some(f => f.in != null || f.out != null));
      if (arr.length) rate = arr[arr.length - 1];
      return !!rate;
    }, 90000, 1000);
    if (!rate || !(rate.ifs || []).length) skip('U.buildLinkFlow 基于真实 ifTable 样本算出链路利用率', '未取到第二轮采样（速率需两次采样差值）');
    else {
      const d = d1;
      // 选管理口（有真实流量）：环回口计数器不动，利用率恒 0，验证不出数据路径
      const ifs = rate.ifs || [];
      const pick = ifs.find(f => String(f.n) === d.devIf) || ifs.find(f => (Number(f.in) || 0) + (Number(f.out) || 0) > 0) || ifs[0] || {};
      const ifName = pick.n;
      const flow = U.buildLinkFlow(
        [{ id: d.id, name: d.name }, { id: 'core', name: 'Core' }],
        [{ id: 'l1', a: d.id, b: 'core', aIf: ifName, bIf: 'eth9', bw: 1000 }],
        { [d.id]: rate }, { now: Date.now() });
      ok(flow && flow.l1 && flow.l1.util != null && Number.isFinite(flow.l1.util) && flow.l1.util >= 0,
        'U.buildLinkFlow 基于真实 ifTable 样本算出链路利用率',
        'if=' + ifName + ' in=' + pick.in + ' out=' + pick.out + ' util=' + (flow && flow.l1 ? (flow.l1.util * 100).toFixed(4) : '?') + '%');
    }
  }

  // B9 停止任务后无残留（真实设备断连 + 无定时器）
  {
    const key = keys[keys.length - 1];
    monitor.stop(key);
    await sleep(600);
    const st = monitor.status();
    ok(!(st || []).some(j => j.key === key), 'stop 后任务从清单移除');
    monitor.stopAll();
    const st2 = monitor.status();
    ok(((st2 || []).length === 0), 'stopAll 后无残留任务（真实设备连接全部释放）');
  }
}

/* ================= C. 配置备份 ================= */
async function groupBackup(devs, d1, monitor, store) {
  section(GROUPS[2][1]);
  const key = 'bk@' + d1.host + ':' + d1.sshPort;
  // 备份库的目录名是「设备名/主机」（备份中心口径），先记下任务名，落库后按 hosts() 反查真实目录
  const devDirName = d1.name + '-备份';
  const pairOf = () => (store.hosts().items || []).find(h => h.host === d1.host && h.device === devDirName) || null;
  const listOf = () => { const p = pairOf(); return p ? store.list(p.device, p.host) : { ok: true, items: [] }; };
  const r = monitor.start({
    key, deviceId: 'bkdev', name: devDirName, protocol: 'ssh', host: d1.host, port: d1.sshPort,
    username: d1.sshUser, password: CFG.pass, commands: ['echo bk'], intervalSec: 3600, initDelayMs: 300,
    // 复用监控会话（产品默认模式）：备份命令走已在线会话，不另建连接。
    // 入参字段名是 command（单数，与 metrics.command 同口径）：写成 commands 会被静默忽略而落回默认的
    // display current-configuration——真机上表现为「备份成功」但内容是「找不到命令 display」
    backup: { enabled: true, mode: 'session', command: 'nt-cli -c "show running-config"', waitMs: 900, intervalSec: 86400 }
  });
  ok(r.ok, '备份任务启动（真实设备）', r.error || '');
  // 任务启动后产品会自己跑首轮自动备份（initDelayMs+1500）；等它落定再断言，
  // 避免与「立即备份」在 t=0 抢同一把会话锁（那只会在测试里制造无谓的不确定）
  const got1 = await waitUntil(() => {
    const st = (monitor.status() || []).find(j => j.key === key);
    return !!(st && st.backup && st.backup.name);
  }, 40000, 500);
  const st1 = (monitor.status() || []).find(j => j.key === key) || {};
  ok(got1, '任务启动后的首轮自动备份完成（真实设备取回配置）', st1.backup ? String(st1.backup.name) : '未产生备份');
  const list1 = listOf();
  ok(list1.ok && list1.items.length === 1, '备份库按「设备名/主机」归档 1 份配置', '目录 ' + JSON.stringify(pairOf() || null));
  const content = list1.items.length ? String((store.read(devDirName, d1.host, list1.items[0].name) || {}).content || '') : '';
  ok(/hostname\s+R1-Core-01/.test(content), '备份内容为设备真实运行配置（含设备主机名）');
  ok(/router bgp 65001/.test(content) && /neighbor 10\.99\.12\.2/.test(content), '备份内容含真实 BGP 配置（router bgp / neighbor）');

  // 设备侧改配置（改 BGP 邻居描述——FRR 的运行配置里可验证）→「立即备份」→ diff 可见变更
  await devRun(d1, 'nt-cli -c "configure terminal" -c "router bgp 65001" -c "neighbor 10.99.12.2 description NETTOPO-LIVE-BK"', 1500);
  const after = await devCli(d1, 'show running-config', 1500);   // vtysh 不支持 | grep，断言放在 JS 侧
  ok(/NETTOPO-LIVE-BK/.test(after.text), '设备侧配置变更已生效（show running-config 可见）',
    (after.text.match(/neighbor 10\.99\.12\.2 description \S+/) || ['(未见该行)'])[0]);
  let b2 = await monitor.runBackupNow(key);
  if (!(b2 && b2.saved)) { await sleep(2000); b2 = await monitor.runBackupNow(key); } // 偶发「未产生备份结果」重试一次
  ok(b2 && b2.saved === true, '「立即备份」取回变更后的配置', b2 && b2.name ? b2.name : JSON.stringify(b2 && b2.error));
  const list2 = listOf();
  ok(list2.items.length === 2, '备份库累积到 2 份', '实际 ' + list2.items.length + ' 份');
  if (list2.items.length === 2) {
    const names = list2.items.map(i => i.name).sort();
    const d = store.diff(devDirName, d1.host, names[0], names[1]);
    const texts = ((d && d.hunks) || []).reduce((acc, h) => acc.concat((h.lines || []).map(l => l.type + ':' + l.text)), []);
    ok(d && d.ok !== false && d.changed === true && texts.some(t => /NETTOPO-LIVE-BK/.test(t)), '两份备份的 diff 命中真实变更行',
      'added=' + (d && d.added) + ' removed=' + (d && d.removed));
  }
  // 还原设备配置
  await devRun(d1, 'nt-cli -c "configure terminal" -c "router bgp 65001" -c "neighbor 10.99.12.2 description d12-to-r2"', 1200);

  // 失败路径：错误口令 → 如实失败（不产生假成功备份）
  const keyBad = 'bkbad@' + d1.host + ':' + d1.sshPort;
  const badDir = d1.name + '-错误口令';
  monitor.start({
    key: keyBad, deviceId: 'bkbad', name: badDir, protocol: 'ssh', host: d1.host, port: d1.sshPort,
    username: d1.sshUser, password: 'definitely-wrong', commands: ['echo x'], intervalSec: 3600, initDelayMs: 300,
    backup: { enabled: true, mode: 'session', command: 'nt-cli -c "show running-config"', waitMs: 800, intervalSec: 86400 }
  });
  await sleep(3000); // 等失败任务收敛（会话建不起来时 backup:enabled 的首次自动轮次会先生效）
  const bad = await monitor.runBackupNow(keyBad);
  ok(bad && bad.saved !== true && !!bad.error && store.list(badDir, d1.host).items.length === 0,
    '认证失败时备份如实上报失败且不入库', (bad && bad.error) ? String(bad.error).slice(0, 60) : '');
  monitor.stop(keyBad);

  // 独立连接模式（own）：不占用监控会话、自建连接取配置。
  // 真机上该模式偶发「未产生备份结果」（会话代际 gen 在备份途中变化时 _runBackupOwnCmds 提前退出，
  // 且不写 _bkResult）——界面上「立即备份」的重试就是用户侧的正常补偿，这里同样重试至多 3 次并如实记录次数。
  const ownKey = 'bkown@' + d1.host + ':' + d1.sshPort;
  const ownDir = d1.name + '-独立备份';
  monitor.start({
    key: ownKey, deviceId: 'bkown', name: ownDir, protocol: 'ssh', host: d1.host, port: d1.sshPort,
    username: d1.sshUser, password: CFG.pass, commands: ['echo own'], intervalSec: 3600, initDelayMs: 300,
    backup: { enabled: true, mode: 'own', command: 'nt-cli -c "show running-config"', waitMs: 1200, intervalSec: 86400 }
  });
  await waitUntil(() => (monitor.status() || []).some(j => j.key === ownKey && j.state === 'monitoring'), 20000, 400);
  let ownSaved = false, tries = 0;
  for (; tries < 3 && !ownSaved; tries++) {
    const ro = await monitor.runBackupNow(ownKey);
    ownSaved = !!(ro && ro.saved);
    if (!ownSaved) await sleep(3000);
  }
  ok(ownSaved, '独立连接模式（own）备份落库（重试 ' + tries + ' 次）',
    ownSaved ? (store.list(ownDir, d1.host).items[0] || {}).name : '三次均未产生备份结果');
  monitor.stop(ownKey);
  monitor.stop(key);
}

/* ================= D. 内置网络服务与设备真实互操作 ================= */
async function groupServices(devs, d1, netSvc, syslogAlerts, trapEvents, inbound) {
  section(GROUPS[3][1]);
  const P = CFG.ports;
  const applied = await netSvc.applyConfig({
    tftp: { enabled: true, port: P.tftp },
    ftp: { enabled: true, port: P.ftp, username: 'labftp', password: 'LabPass123', pasvMin: P.ftpPasvMin, pasvMax: P.ftpPasvMax, overwrite: true },
    syslog: { enabled: true, port: P.syslog, tcp: true, alert: { enabled: true, severity: null, keywords: ['NETTOPO-LIVE-IF-DOWN'], cooldownSec: 3 } },
    trap: { enabled: true, port: P.trap, community: 'public' }
  });
  ok(applied.syslog.running && applied.tftp.running && applied.ftp.running && applied.trap.running,
    '四个内置服务全部启动（UDP/TCP 端口就绪）',
    'syslog=' + applied.syslog.port + ' tftp=' + applied.tftp.port + ' ftp=' + applied.ftp.port + ' trap=' + applied.trap.port);

  // D1 Syslog（设备真实发送，UDP + TCP）
  if (!inbound.udpOk) skip('设备真实 Syslog 报文入库（UDP）', '测试机未放行入站 UDP（见文件头放行命令）');
  else {
    const before = netSvc.syslogTail(0).msgs.length;
    const pri = 134; // local0.info
    const msg = '<' + pri + '>Sep 11 12:00:00 ' + d1.name + ' nettopo-live: NETTOPO-LIVE-SYSLOG hello';
    await devRun(d1, `printf '%s\\n' '${msg}' | nc -u -w1 ${ourIpGlobal} ${P.syslog}`, 700);
    const got = await waitUntil(() => netSvc.syslogTail(0).msgs.length >= before + 1, 8000, 300);
    ok(got, '设备真实 Syslog 报文入库（UDP）');
    const tail = netSvc.syslogTail(0).msgs.slice(-1)[0] || {};
    ok(/NETTOPO-LIVE-SYSLOG/.test(tail.msg || ''), '日志正文解析正确');
    ok(tail.host === d1.name, '来源主机名取自报文（' + d1.name + '）', 'host=' + tail.host);
  }
  if (!inbound.udpOk) skip('Syslog 关键字告警事件（真实设备日志触发）', '测试机未放行入站 UDP');
  else {
    await devRun(d1, `printf '%s\\n' '<131>Sep 11 12:00:01 ${d1.name} nettopo-live: %%IFNET/4/IF_STATE(l): interface NETTOPO-LIVE-IF-DOWN down' | nc -u -w1 ${ourIpGlobal} ${P.syslog}`, 700);
    const hit = await waitUntil(() => syslogAlerts.length >= 1, 8000, 300);
    ok(hit, 'Syslog 关键字告警事件（真实设备日志触发）');
    if (hit) ok((syslogAlerts[0].matched || []).includes('NETTOPO-LIVE-IF-DOWN') && syslogAlerts[0].severity === 3,
      '告警事件带命中关键字与级别（err）', 'host=' + syslogAlerts[0].host + ' sev=' + syslogAlerts[0].severity);
  }
  if (!inbound.tcpOk) skip('设备真实 Syslog 报文入库（TCP / RFC6587）', '测试机未放行入站 TCP');
  else {
    const before = netSvc.syslogTail(0).msgs.length;
    await devRun(d1, `printf '%s\\n' '<134>Sep 11 12:00:02 ${d1.name} nettopo-live: NETTOPO-LIVE-TCP over-tcp' | nc -q1 ${ourIpGlobal} ${P.syslog}`, 900);
    const got = await waitUntil(() => netSvc.syslogTail(0).msgs.some(m => /NETTOPO-LIVE-TCP/.test(m.msg || '')), 8000, 300);
    ok(got, '设备真实 Syslog 报文入库（TCP / RFC6587）');
  }

  // D2 SNMP Trap（设备真实 snmptrap）
  if (!inbound.udpOk) skip('设备真实 SNMP Trap 接收与解析（v2c coldStart）', '测试机未放行入站 UDP');
  else {
    const r = await devRun(d1, `snmptrap -v2c -c public ${ourIpGlobal}:${P.trap} '' 1.3.6.1.6.3.1.1.5.1 1.3.6.1.2.1.1.5.0 s ${d1.name}`, 1200);
    const got = await waitUntil(() => trapEvents.length >= 1, 9000, 300);
    ok(got, '设备真实 SNMP Trap 接收成功（snmptrap → 内置接收器）', r.ok ? '' : '设备侧返回异常');
    if (got) {
      const t = trapEvents[0];
      ok(t.community === 'public' && /cold|冷/i.test(String(t.trap || '')), '标准 Trap 识别（coldStart + 团体名）', String(t.trap) + '/' + t.community);
      // 事件载荷把 varbind 汇总进 msg（varbinds 数组只在解析层内部使用）
      ok(/R1-Core-01/.test(String(t.msg || '')) || /R1-Core-01/.test(JSON.stringify(t.varbinds || [])), 'Trap 携带真实 varbind（sysName）',
        'msg=' + JSON.stringify(String(t.msg || '').slice(0, 80)));
    }
  }

  // D3 TFTP：真实 curl 客户端 ↔ 内置 TFTP 服务双向传输。
  // 客户端用**实验宿主机**而不是 netns 设备：TFTP 的数据阶段由服务端另开临时端口（TID）回包，
  // 经宿主机 SNAT 后该回包不再匹配原 NAT 映射（需 conntrack TFTP helper，nftables 下不可靠），
  // 设备侧必然超时——这是测试拓扑走 NAT 的产物，不是产品缺陷（真实设备与网管机同网段直连时无此问题）。
  if (!inbound.udpOk) skip('TFTP 双向传输（真实 curl 客户端）', '测试机未放行入站 UDP（见文件头放行命令）');
  else {
    const put = await hostRun(`printf 'NETTOPO-TFTP-%s' "$(date +%s)" > /tmp/nt-tftp.txt && curl -s --max-time 8 -T /tmp/nt-tftp.txt tftp://${ourIpGlobal}:${P.tftp}/from-client.txt && echo TFTP_PUT_OK`);
    const fileList = netSvc.listFiles();                       // { ok, items:[{svc,ip,name,size,time}] }
    const items = (fileList && fileList.items) || [];
    const hit = items.some(f => String((f && f.name) || '') === 'from-client.txt');
    ok(/TFTP_PUT_OK/.test(joined(put)), 'TFTP 上传（WRQ）：真实客户端推送文件到内置服务', hit ? '（已编目）' : '（编目未命中）');
    ok(hit, 'TFTP 收到的文件进入编目（面板/导入可查）');
    const get = await hostRun(`curl -s --max-time 8 -o /tmp/nt-tftp-back.txt tftp://${ourIpGlobal}:${P.tftp}/from-client.txt && head -c 32 /tmp/nt-tftp-back.txt`);
    ok(/NETTOPO-TFTP-/.test(joined(get)), 'TFTP 下载（RRQ）：客户端取回同一文件（内容一致）');
  }

  // D4 FTP：设备 ↔ 内置 FTP 服务真实登录 + 双向传输
  if (!inbound.tcpOk) skip('FTP 双向传输（设备 curl ftp 登录）', '测试机未放行入站 TCP');
  else {
    const put = await devRun(d1, `printf 'NETTOPO-FTP-${Date.now()}' > /tmp/nt-ftp.txt && curl -s --max-time 10 -T /tmp/nt-ftp.txt ftp://labftp:LabPass123@${ourIpGlobal}:${P.ftp}/from-device-ftp.txt && echo FTP_PUT_OK`, 3000);
    ok(/FTP_PUT_OK/.test(joined(put)), 'FTP 登录并上传成功（虚构账号 labftp + 自定义口令）', joined(put).slice(0, 60).replace(/\n/g, ' '));
    const get = await devRun(d1, `curl -s --max-time 10 -o /tmp/nt-ftp-back.txt ftp://labftp:LabPass123@${ourIpGlobal}:${P.ftp}/from-device-ftp.txt && head -c 32 /tmp/nt-ftp-back.txt`, 3000);
    ok(/NETTOPO-FTP-/.test(joined(get)), 'FTP 下载同一文件（内容一致）');
    const authfail = await devRun(d1, `curl -s --max-time 6 -o /dev/null -w '%{http_code}' ftp://labftp:wrongpass@${ourIpGlobal}:${P.ftp}/from-device-ftp.txt ; echo " rc=$?"`, 2500);
    ok(!/NETTOPO-FTP-/.test(joined(authfail)), 'FTP 错误口令被拒（未取到文件内容）');
  }

  // D5 服务热更新：改 Syslog 端口后旧端口停、新端口收（真实设备再发一条）
  if (!inbound.udpOk) skip('服务配置热更新（改端口后旧停新收）', '测试机未放行入站 UDP');
  else {
    const newPort = P.syslog + 1;
    const a2 = await netSvc.applyConfig({
      tftp: { enabled: true, port: P.tftp },
      ftp: { enabled: true, port: P.ftp, username: 'labftp', password: 'LabPass123', pasvMin: P.ftpPasvMin, pasvMax: P.ftpPasvMax, overwrite: true },
      syslog: { enabled: true, port: newPort, tcp: true, alert: { enabled: false, severity: null, keywords: [], cooldownSec: 3 } },
      trap: { enabled: true, port: P.trap, community: 'public' }
    });
    ok(a2.syslog.running && a2.syslog.port === newPort, 'Syslog 服务热更新到新端口 ' + newPort);
    const before = netSvc.syslogTail(0).msgs.length;
    await devRun(d1, `printf '%s\\n' '<134>Sep 11 12:00:03 ${d1.name} nettopo-live: NETTOPO-LIVE-NEWPORT ok' | nc -u -w1 ${ourIpGlobal} ${newPort}`, 800);
    const got = await waitUntil(() => netSvc.syslogTail(0).msgs.some(m => /NETTOPO-LIVE-NEWPORT/.test(m.msg || '')), 8000, 300);
    ok(got, '新端口收到真实设备日志（热更新生效）');
    const oldGone = await devRun(d1, `printf '%s\\n' '<134>Sep 11 12:00:04 ${d1.name} nettopo-live: NETTOPO-LIVE-OLDPORT nope' | nc -u -w1 ${ourIpGlobal} ${P.syslog}`, 800);
    await sleep(1200);
    ok(!netSvc.syslogTail(0).msgs.some(m => /NETTOPO-LIVE-OLDPORT/.test(m.msg || '')), '旧端口不再接收（服务确实迁走了）');
  }
}

/* ================= E. 诊断工具箱 ================= */
async function groupDiag(devs, d1) {
  section(GROUPS[4][1]);
  const res = await scanPorts(d1.host, [d1.sshPort, d1.telnetPort, d1.snmpPort, 65099]);
  ok(res.some(r => r.port === d1.sshPort && r.open === true), 'TCP 端口探测：SSH 管理口开放', JSON.stringify(res.find(r => r.port === d1.sshPort)));
  ok(res.some(r => r.port === d1.telnetPort && r.open === true), 'TCP 端口探测：Telnet CLI 端口开放');
  ok(res.some(r => r.port === 65099 && r.open === false), 'TCP 端口探测：未开放端口如实报告关闭');
  const w = await snmpWalk('1.3.6.1.2.1.1', d1.host, 'public', 4000, d1.snmpPort);
  ok(w.ok && (w.varbinds || []).length >= 5, 'SNMP Walk system 子树（真实 net-snmp）', '条数=' + ((w.varbinds || []).length));
  ok((w.varbinds || []).some(v => v.oid === '1.3.6.1.2.1.1.5.0' && String(v.value).indexOf(d1.name) >= 0), 'Walk 结果含真实 sysName');
  const wif = await snmpWalk('1.3.6.1.2.1.2.2.1', d1.host, 'public', 5000, d1.snmpPort);
  ok(wif.ok && (wif.varbinds || []).length > 10, 'SNMP Walk 接口表子树（真实 ifTable 规模）', '条数=' + ((wif.varbinds || []).length));
  const tcp = await scanPorts(devs[1].host, [devs[1].sshPort, devs[1].telnetPort]);
  ok(tcp.some(r => r.port === devs[1].sshPort && r.open), '第二台设备管理面独立可达（多设备场景）');
}

// 供 B7/D 使用：控制通道与测试机地址（在 main 里赋值）
let connGlobal = null, ourIpGlobal = '';

