/* NetTopo 真机测试共用底座：实验环境部署 + SSH 控制通道 + 设备侧命令执行
 * ---------------------------------------------------------------------------
 * test/live.js（真机集成测试）与 test/gui-live.js（真机 GUI 集成测试）共用：
 *   - connectSsh / exec / upload：到实验机的控制通道（sudo 口令走 stdin，不进 argv）
 *   - provision / teardown / readInventory：上传并执行 test/live-lab.sh（up/down/inv）
 *   - ourAddress：测试机在实验机侧看到的来源地址（设备 → 测试机方向的回连目标）
 *   - makeDevHelpers：经设备自身管理口执行命令（runOneShot 包装）
 * 说明：本模块只做「怎么连上实验环境」，不含任何用例与断言；断言留在各自的入口脚本里。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { Client } = require('ssh2');

/** 建立到实验机的控制通道（返回 ssh2 Client） */
function connectSsh(opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c)).on('error', (e) => reject(e))
      .connect({
        host: o.host, port: o.port || 22, username: o.user, password: o.pass,
        readyTimeout: o.timeoutMs || 20000
      });
  });
}

/** 在控制通道上执行命令；opts.sudo 时以 root 执行（口令从 stdin 读，避免出现在进程参数里） */
function exec(conn, cmd, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    conn.exec((o.sudo ? "sudo -S -p '' bash -c " + JSON.stringify(cmd) : cmd), { pty: false }, (err, stream) => {
      if (err) { resolve({ code: -1, out: '', err: err.message }); return; }
      let out = '', errOut = '', code = 0;
      if (o.sudo) stream.write(String(o.rootPass == null ? '' : o.rootPass) + '\n');
      stream.on('close', (c) => { code = c == null ? 0 : c; resolve({ code, out, err: errOut }); });
      stream.on('data', (d) => { out += d.toString('utf8'); if (o.echo) process.stdout.write(d); });
      stream.stderr.on('data', (d) => { errOut += d.toString('utf8'); if (o.echo) process.stderr.write(d); });
    });
  });
}

function upload(conn, local, remote) {
  return new Promise((resolve, reject) => {
    conn.sftp((e, sftp) => {
      if (e) { reject(e); return; }
      sftp.fastPut(local, remote, (e2) => (e2 ? reject(e2) : resolve(remote)));
    });
  });
}

/** 上传并执行 test/live-lab.sh up；返回设备清单（inventory）。
 *  opts: { host, rootPass, script, onLine } —— onLine 用于把 [live-lab] 行转发到测试输出 */
async function provision(conn, opts) {
  const o = opts || {};
  const script = o.script || path.join(__dirname, 'live-lab.sh');
  const tmpScript = path.join(os.tmpdir(), 'nettopo-live-lab-' + process.pid + '.sh');
  fs.copyFileSync(script, tmpScript);
  await upload(conn, tmpScript, '/tmp/nettopo-live-lab.sh');
  const r = await exec(conn, `LAB_PUBLIC_IP=${o.host} bash /tmp/nettopo-live-lab.sh up`, { sudo: true, rootPass: o.rootPass });
  const lines = r.out.split('\n');
  if (o.onLine) for (const l of lines) if (/^\[live-lab\]/.test(l)) o.onLine(l);
  const m = r.out.match(/^NETTOPO_LAB_INVENTORY=(.+)$/m);
  if (!m) throw new Error('未拿到设备清单（部署失败）：\n' + r.out.slice(-1500) + r.err.slice(-500));
  return JSON.parse(m[1]);
}

/** 读已部署环境的设备清单（不重新部署） */
async function readInventory(conn, opts) {
  const o = opts || {};
  const r = await exec(conn, 'bash /tmp/nettopo-live-lab.sh inv', { sudo: true, rootPass: o.rootPass });
  const m = r.out.match(/^NETTOPO_LAB_INVENTORY=(.+)$/m);
  if (!m) throw new Error('拿不到设备清单：先跑一次不带 --skip-setup 的完整流程');
  return JSON.parse(m[1]);
}

async function teardown(conn, opts) {
  const o = opts || {};
  const r = await exec(conn, 'bash /tmp/nettopo-live-lab.sh down', { sudo: true, rootPass: o.rootPass });
  if (o.onLine) for (const l of r.out.split('\n')) if (/^\[live-lab\]/.test(l)) o.onLine(l);
  return r;
}

/** 测试机在实验机侧看到的来源地址（$SSH_CLIENT 首字段）；退路：与实验机同网段的本机地址 */
function ourAddress(conn, labHost) {
  return exec(conn, 'echo "$SSH_CLIENT"').then((r) => {
    const ip = String(r.out || '').trim().split(/\s+/)[0];
    if (net.isIPv4(ip)) return ip;
    const lab = String(labHost || '').split('.').slice(0, 3).join('.') + '.';
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal && a.address.startsWith(lab)) return a.address;
    }
    return '';
  });
}

/** 经设备自身管理口执行命令的助手（复用 runOneShot，输出合并为一个文本） */
function makeDevHelpers(shell, opts) {
  const o = opts || {};
  const joined = (r) => ((r && r.outputs) || []).map(x => x.text || '').join('\n');
  const devRun = (dev, cmd, waitMs) => shell.runOneShot({
    protocol: 'ssh', host: dev.host, port: dev.sshPort, username: dev.sshUser, password: o.pass,
    commands: Array.isArray(cmd) ? cmd : [cmd], waitMs: waitMs || 900
  });
  return {
    joined,
    devRun,
    devCli: async (dev, cmd, waitMs) => {
      const r = await devRun(dev, 'nt-cli -c ' + JSON.stringify(cmd), waitMs);
      return { ok: r.ok, text: joined(r), raw: r };
    }
  };
}

module.exports = { connectSsh, exec, upload, provision, readInventory, teardown, ourAddress, makeDevHelpers };
