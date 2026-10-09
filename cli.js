#!/usr/bin/env node
/* NetTopo CLI —— 无头模式（纯 Node，无 Electron 依赖）
 * ---------------------------------------------------------------------------
 * 复用桌面版的主进程纯 Node 模块（js/shell.js / js/config-backup.js / js/util.js），
 * 面向 cron 定时巡检、CI 合规门禁与脚本化备份：
 *   node cli.js inspect    --devs hosts.csv --vendor huawei --out inspect.csv
 *   node cli.js backup     --devs hosts.csv --base ./nettopo-cli-data --diff
 *   node cli.js compliance --base ./nettopo-cli-data --pack 等保通用（违规退出码 2）
 *   node cli.js compliance --file running.cfg --pack minimal
 * 设备清单 CSV（--devs）：host,username,password,protocol,port（首行可为同名表头；
 *   protocol 缺省 ssh，port 缺省按协议 22/23；字段含逗号用英文双引号包裹）。
 * 退出码：0 成功 · 1 参数错误/连接失败 · 2 合规扫描发现违规。
 * --------------------------------------------------------------------------- */
'use strict';
const fs = require('fs');
const path = require('path');
require('./js/util.js'); // util.js 挂 global.TopoUtil（无 module.exports，与渲染层同口径）
const U = global.TopoUtil;
const { ShellManager } = require('./js/shell.js');
const { ConfigBackupStore } = require('./js/config-backup.js');

const VERSION = '1';
const PROG = 'nettopo-cli';
const SAVE_COMMANDS = {
  huawei: ['screen-length 0 temporary', 'display current-configuration'],
  h3c: ['screen-length disable', 'display current-configuration'],
  cisco: ['terminal length 0', 'show running-config'],
  ruijie: ['terminal length 0', 'show running-config'],
  linux: ['cat /etc/network/interfaces 2>/dev/null || true', 'hostname']
};

/* ---------- 纯函数（单测覆盖） ---------- */

/** 解析设备清单 CSV：首行若为表头（含 host）则跳过；每行 host,username,password,protocol,port */
function parseDevsCsv(text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]).map(c => c.trim());
    if (!cells.length || !cells[0]) continue;
    if (i === 0 && /^host$/i.test(cells[0])) continue; // 表头
    const isTelnet = (cells[3] || '').toLowerCase() === 'telnet';
    rows.push({
      host: cells[0],
      username: cells[1] || '',
      password: cells[2] || '',
      protocol: isTelnet ? 'telnet' : 'ssh',
      port: parseInt(cells[4], 10) || (isTelnet ? 23 : 22)
    });
  }
  return rows;
}

/** 单行 CSV 拆分（支持双引号包裹与 "" 转义） */
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** CSV 单元格转义 */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 巡检结果 → CSV 文本 */
function formatInspectCsv(results) {
  const rows = [['device', 'host', 'protocol', 'command', 'ok', 'output']];
  for (const r of results) {
    if (!r.outputs.length) rows.push([r.device, r.host, r.protocol, '', false, r.error || '']);
    for (const o of r.outputs) rows.push([r.device, r.host, r.protocol, o.cmd, o.ok !== false, o.text]);
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

/** 按名称取合规基线（名称模糊包含匹配；缺省第一套） */
function pickPack(name) {
  const packs = U.COMPLIANCE_PACKS || [];
  if (!packs.length) return null;
  if (!name) return packs[0];
  const key = String(name).toLowerCase();
  return packs.find(p => String(p.name).toLowerCase() === key)
    || packs.find(p => String(p.name).toLowerCase().includes(key))
    || packs[0];
}

/** 合规结果摘要（退出码判定用）：{hosts, violations, exitCode} */
function complianceSummary(perHost) {
  const violations = perHost.reduce((n, h) => n + (h.violations || 0), 0);
  return { hosts: perHost.length, violations, exitCode: violations > 0 ? 2 : 0 };
}

/* ---------- 主流程 ---------- */

function usage() {
  console.log(`${PROG} v${VERSION} —— NetTopo 无头模式（巡检 / 配置备份 / 合规扫描）
用法：
  ${PROG} inspect    --devs <csv> [--vendor auto|huawei|h3c|cisco|ruijie|linux] [--out <file>] [--format csv|json]
  ${PROG} backup     --devs <csv> [--base <dir>] [--name <设备名>] [--diff] [--vendor <v>]
  ${PROG} compliance --base <dir> | --file <cfg> [--pack <基线名>] [--out <file>]
通用：
  --host/--user/--pass/--proto/--port   单设备参数（等价一行 --devs；口令也可用环境变量 NETTOPO_CLI_PASS 传入，
                                        避免进 shell 历史与进程列表）
  --timeout <ms>   单命令超时（默认 15000）
退出码：0 成功 · 1 参数/连接错误 · 2 合规发现违规
设备清单 CSV：host,username,password,protocol,port（首行可为表头）`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

async function loadDevs(args) {
  if (args.devs) {
    const text = fs.readFileSync(args.devs, 'utf8');
    return parseDevsCsv(text);
  }
  if (args.host) {
    const proto = String(args.proto || 'ssh').toLowerCase() === 'telnet' ? 'telnet' : 'ssh';
    // 口令优先级：--pass 显式参数 > NETTOPO_CLI_PASS 环境变量（避免口令进 shell 历史与进程列表）
    return [{ host: args.host, username: args.user || '', password: args.pass || process.env.NETTOPO_CLI_PASS || '', protocol: proto, port: parseInt(args.port, 10) || (proto === 'telnet' ? 23 : 22) }];
  }
  throw new Error('需要 --devs <csv> 或 --host <地址>');
}

function dataBase(args) {
  return path.resolve(args.base || process.env.NETTOPO_CLI_DATA || path.join(process.cwd(), 'nettopo-cli-data'));
}

async function cmdInspect(args) {
  const vendor = String(args.vendor || 'auto').toLowerCase();
  const cmds = U.INSPECT_PRESETS[vendor] || U.INSPECT_PRESETS.auto;
  const devs = await loadDevs(args);
  if (!devs.length) throw new Error('设备清单为空');
  const sm = new ShellManager({ logDir: null });
  const results = [];
  let failed = 0;
  for (const d of devs) {
    process.stderr.write(`  巡检 ${d.host}（${d.protocol}/${d.port}，${cmds.length} 条命令）…\n`);
    let r;
    try {
      r = await sm.runOneShot({
        host: d.host, protocol: d.protocol, port: d.port, username: d.username, password: d.password,
        commands: cmds.slice(), waitMs: 800, cmdTimeoutMs: parseInt(args.timeout, 10) || 15000, readyTimeoutMs: 20000
      });
    } catch (e) {
      r = { ok: false, outputs: [], error: String((e && e.message) || e) };
    }
    if (!r.ok) failed++;
    results.push({ device: d.host, host: d.host, protocol: d.protocol, ok: !!r.ok, error: r.error || '', outputs: (r.outputs || []).map(o => ({ cmd: o.cmd, ok: true, text: String(o.text || '').trim() })) });
    await new Promise(res => setTimeout(res, 600)); // 设备 VTY 连接频率防御
  }
  try { sm.closeAll(); } catch (e) { /* ignore */ }
  const fmt = String(args.format || 'csv').toLowerCase();
  const body = fmt === 'json' ? JSON.stringify(results, null, 2) : formatInspectCsv(results);
  if (args.out) { fs.writeFileSync(args.out, body, 'utf8'); process.stderr.write(`已写出 ${args.out}\n`); }
  else process.stdout.write(body + '\n');
  process.stderr.write(`巡检完成：成功 ${results.length - failed} / ${results.length} 台\n`);
  if (failed >= results.length) process.exitCode = 1;
}

async function cmdBackup(args) {
  const vendor = String(args.vendor || 'huawei').toLowerCase();
  const cmds = SAVE_COMMANDS[vendor] || SAVE_COMMANDS.huawei;
  const devs = await loadDevs(args);
  if (!devs.length) throw new Error('设备清单为空');
  const store = new ConfigBackupStore(dataBase(args));
  const sm = new ShellManager({ logDir: null });
  let failed = 0;
  for (const d of devs) {
    process.stderr.write(`  备份 ${d.host} …\n`);
    let r;
    try {
      r = await sm.runOneShot({
        host: d.host, protocol: d.protocol, port: d.port, username: d.username, password: d.password,
        commands: cmds.slice(), waitMs: 900, cmdTimeoutMs: parseInt(args.timeout, 10) || 20000, readyTimeoutMs: 20000
      });
    } catch (e) {
      r = { ok: false, outputs: [], error: String((e && e.message) || e) };
    }
    const text = (r.outputs || []).map(o => o.text).join('\n').trim();
    if (!r.ok || text.length < 50) { failed++; process.stderr.write(`  ✗ ${d.host}：${r.error || '未取得有效配置输出'}\n`); continue; }
    const name = args.name || d.host;
    const prevName = store.latest(name, d.host);
    const saved = store.save(name, d.host, text);
    if (!saved || !saved.ok) { failed++; process.stderr.write(`  ✗ ${d.host}：${(saved && saved.error) || '入库失败'}\n`); continue; }
    process.stderr.write(`  ✓ ${d.host} → ${saved.name}${saved.first ? '（首次）' : ''}\n`);
    if (args.diff && prevName) {
      const prev = store.read(name, d.host, prevName);
      const same = prev.ok && require('./js/config-backup.js').sameAfterIgnore(prev.content, text);
      process.stderr.write(`    漂移：${same ? '无（易变行忽略口径）' : '有变化'}\n`);
    }
    await new Promise(res => setTimeout(res, 600));
  }
  try { sm.closeAll(); } catch (e) { /* ignore */ }
  if (failed >= devs.length) process.exitCode = 1;
}

async function cmdCompliance(args) {
  const pack = pickPack(args.pack);
  if (!pack) throw new Error('合规基线模板为空');
  const rules = U.cleanComplianceRules(pack.rules || []);
  if (!rules.length) throw new Error('合规基线规则为空');
  const perHost = [];
  const scanText = (label, text) => {
    const rep = U.checkCompliance(text, rules);
    const viols = (rep.results || []).filter(x => !x.pass).map(x => ({
      name: x.name, negate: !!x.negate,
      text: (x.lines && x.lines.length) ? x.lines[0] : (x.negate ? '（命中禁止项）' : '（未找到匹配行）')
    }));
    perHost.push({ host: label, violations: viols.length, viols });
  };
  if (args.file) {
    scanText(path.basename(String(args.file)), fs.readFileSync(args.file, 'utf8'));
  } else {
    const store = new ConfigBackupStore(dataBase(args));
    const items = (store.hosts().items || []);
    if (!items.length) throw new Error(`备份库 ${dataBase(args)} 为空（先跑 backup，或用 --file 指定配置文件）`);
    for (const it of items) {
      const latest = store.latest(it.device, it.host);
      const rd = latest ? store.read(it.device, it.host, latest) : { ok: false };
      if (!rd.ok) continue;
      scanText(`${it.device}(${it.host})`, rd.content);
    }
  }
  const summary = complianceSummary(perHost);
  const lines = [];
  for (const h of perHost) {
    lines.push(`# ${h.host}：${h.violations} 项违规`);
    for (const v of h.viols) lines.push(`  ✗ [${v.negate ? '禁止出现' : '必须存在'}] ${v.name}：${v.text}`);
  }
  lines.push(`# 汇总：${summary.hosts} 个配置源，${summary.violations} 项违规（基线：${pack.name}）`);
  const body = lines.join('\n');
  if (args.out) { fs.writeFileSync(args.out, body, 'utf8'); process.stderr.write(`已写出 ${args.out}\n`); }
  else process.stdout.write(body + '\n');
  process.exitCode = summary.exitCode;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (args.version) { console.log(PROG + ' v' + VERSION); return; }
  if (cmd === 'help' || args.help) { usage(); return; }
  if (cmd === 'inspect') return cmdInspect(args);
  if (cmd === 'backup') return cmdBackup(args);
  if (cmd === 'compliance') return cmdCompliance(args);
  throw new Error(`未知命令：${cmd}（见 node cli.js help）`);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${PROG}：${(e && e.message) || e}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, parseDevsCsv, splitCsvLine, csvCell, formatInspectCsv, pickPack, complianceSummary, SAVE_COMMANDS };
