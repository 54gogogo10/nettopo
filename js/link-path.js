/* NetTopo 端到端链路连通性监测 —— 路径构建、探测判定与状态机（主进程/渲染层共用，纯逻辑，不依赖 Electron）
 *
 * 解决什么问题：现有的「在线探测」只回答「本机 → 设备管理地址」通不通——设备管理口在线不等于
 * 中间那段链路通。核心交换机与接入交换机之间的链路断了，两台设备的管理口可能都还 ping 得通
 * （管理网另走一路），现状是「一切正常」，故障要等用户投诉才知道。
 *
 * 本模块把「链路」本身当作监测对象，两种口径：
 *  - 连线链路（kind=link）：一条拓扑连线 = 一个任务，两端设备在该连线上的接口 IP 互探；
 *  - 端到端路径（kind=path）：任意两台设备之间沿拓扑自动选路（最宽路径），拆成逐段探测，
 *    这样断在哪一段是**测出来的**而不是猜的。
 *
 * 两个诚实的口径（写在界面上，也写在这里）：
 *  1) 本机模式（mode=local）：从本机逐跳探测路径上每一跳的目标接口 IP，结论是
 *     「本机到第 N 跳开始不可达」。它要求本机能到达这些地址（同一管理网/有回程路由）；
 *     跨网段或有 ACL 时本机可能本来就到不了——所以默认「首轮探测只建基线不报警」，
 *     之后只看**状态翻转**，不会因为「本机天生不通」而刷屏。
 *  2) 设备模式（mode=device）：从每一段的起点设备上执行 ping（复用监控/凭据库的会话），
 *     这才是设备视角的链路端到端结论；代价是要有可用凭据，且各厂家 ping 语法不同。
 *  解析不出结论时一律记「无法判定」（verdict=null）并保持原状态——设备命令回显拿不准时
 *  宁可不动，也不把一条好链路判成断的。
 */
/* IIFE 包裹（与 util/pdf/alert-level 同款）：渲染层是普通 <script>，顶层 const 与其它脚本共享
 * 全局词法作用域——重名会让整个脚本 SyntaxError 静默失效 */
(function (global) {
'use strict';

/* ---------- 常量与默认值 ---------- */
const MODES = ['local', 'device'];
const PROTOCOLS = ['icmp', 'tcp'];
const DEFAULT_VENDOR = 'generic';
/** 厂家 ping 命令差异（设备模式下从段起点设备执行）：
 *  - 华为：-c 次数（-t 超时不带——真机实测经典 VRP 的 -t 单位是秒、云路由 YunShan OS（AR6700 等）是毫秒，
 *          同一参数两套量纲没法两全；两代设备缺省超时都是 2 秒，省略 -t 两代通用，会话层另有 cmdTimeoutMs 兜底）
 *  - H3C Comware / 锐捷：-c 次数
 *  - 思科 IOS：ping <ip> repeat N timeout S（交互式 ping 的管道形态，一行可下发）
 *  - Linux / 通用（含 FRR、net-snmp 主机）：-c 次数 -W 超时（秒） */
const VENDOR_PING = {
  huawei: (t, o) => 'ping -c ' + o.count + ' ' + t,
  h3c: (t, o) => 'ping -c ' + o.count + ' ' + t,
  cisco: (t, o) => 'ping ' + t + ' repeat ' + o.count + ' timeout ' + o.timeoutSec,
  ruijie: (t, o) => 'ping -c ' + o.count + ' ' + t,
  linux: (t, o) => 'ping -c ' + o.count + ' -W ' + o.timeoutSec + ' ' + t,
  generic: (t, o) => 'ping -c ' + o.count + ' -W ' + o.timeoutSec + ' ' + t
};
const LIMITS = {
  intervalSec: [10, 3600],
  timeoutMs: [500, 30000],
  port: [1, 65535],
  segments: 12,          // 单条端到端路径最多 12 段（跳数上限，防误选全网点对点把探测打满）
  failThreshold: [1, 5], // 连续 N 次失败才判「链路中断」（抖动抑制）
  okThreshold: [1, 5],
  failThresholdDft: 2,
  okThresholdDft: 1,
  count: 2,              // 每次探测的发包数（够判定又不至于长占会话）
  maxTasks: 200
};
const DEFAULTS = {
  mode: 'local',
  protocol: 'icmp',
  port: 80,
  intervalSec: 60,
  timeoutMs: 3000,
  vendor: DEFAULT_VENDOR,
  failThreshold: LIMITS.failThresholdDft,
  okThreshold: LIMITS.okThresholdDft,
  baselineFirst: true   // 首轮探测只建基线、不报警（见头注「诚实口径 1」）
};
const STATES = ['unknown', 'up', 'down'];

/** 整数钳制：解析不出用默认值，超出区间**钳到边界**（用户填 1 秒间隔 → 按允许的最小 10 秒走，
 *  而不是悄悄换成默认 60 秒——后者会让「我明明改了」与「跑起来的」对不上） */
const clampInt = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, n));
};
/** IPv4 字面量校验（与 diag/util 同口径：四段 0-255，不做去前导零之外的宽容） */
function isIpv4(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) if (parseInt(m[i], 10) > 255) return false;
  return true;
}
/** 主机/地址字面量（IPv4 或主机名）：长度与字符集收敛，杜绝把空格/换行/选项前缀带进命令 */
function isHost(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > 64) return false;
  if (isIpv4(s)) return true;
  if (s[0] === '-') return false;                       // 防 'ping -t …' 之类被当作选项
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(s);
}
const normHost = (v) => { const s = String(v == null ? '' : v).trim(); return isHost(s) ? s : ''; };
/** 设备管理地址列表（与 U.nodeMgmts 同口径，供本模块在 Node 侧独立使用） */
function mgmtHostsOf(node) {
  const out = [];
  const push = (v) => { const s = normHost(v); if (s && out.indexOf(s) < 0) out.push(s); };
  if (node) {
    push(node.mgmt);
    for (const m of (Array.isArray(node.mgmts) ? node.mgmts : [])) push(m);
  }
  return out;
}

/* ---------- 路径选择 ---------- */
/** 最宽路径：优先注入调用方的实现（渲染层传 U.bestPath，聚合组语义与「路径分析」完全一致）；
 *  未注入时退化为自带的跳数优先 BFS（并列时取瓶颈带宽更大者）——Node 测试与主进程不需要依赖 util.js */
function pathBetween(nodes, links, fromId, toId, opts) {
  const o = opts || {};
  if (typeof o.bestPath === 'function') return o.bestPath(nodes, links, fromId, toId, o.bestPathOpts || {});
  const list = Array.isArray(nodes) ? nodes : [];
  const edgesIn = Array.isArray(links) ? links : [];
  const adj = new Map();
  for (const n of list) adj.set(n.id, []);
  for (const l of edgesIn) {
    if (!l || !adj.has(l.a) || !adj.has(l.b)) continue;
    const cap = Number(l.bw) > 0 ? Number(l.bw) : 0;
    adj.get(l.a).push({ to: l.b, lid: l.id, cap });
    adj.get(l.b).push({ to: l.a, lid: l.id, cap });
  }
  if (!adj.has(fromId) || !adj.has(toId)) return null;
  if (fromId === toId) return { nodeIds: [fromId], linkIds: [], bottleneck: Infinity };
  // BFS 逐层扩展（跳数最少）；同一层里用瓶颈带宽做择优，避免在并列最短路里选中一条窄链路
  const prev = new Map([[fromId, null]]);
  let frontier = [fromId];
  while (frontier.length && !prev.has(toId)) {
    const next = [];
    for (const cur of frontier) {
      for (const e of adj.get(cur) || []) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, { from: cur, lid: e.lid, cap: e.cap });
        next.push(e.to);
      }
    }
    frontier = next;
  }
  if (!prev.has(toId)) return null;
  const nodeIds = [toId];
  const linkIds = [];
  let bottleneck = Infinity;
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur);
    if (!p) return null;
    linkIds.push(p.lid);
    nodeIds.push(p.from);
    bottleneck = Math.min(bottleneck, p.cap > 0 ? p.cap : Infinity);
    cur = p.from;
  }
  nodeIds.reverse(); linkIds.reverse();
  return { nodeIds, linkIds, bottleneck };
}

/* ---------- 拓扑 → 监测任务 ---------- */
/** 一条 a→b 连线上的「目标地址」：优先对端接口 IP（真正的链路对端），回退对端设备管理地址。
 *  返回 { host, linkId, link }；取不到地址返回 null（该段无法监测，如实计入 skipped）。 */
function hopTarget(links, aId, bId, preferredLinkIds) {
  const cands = (Array.isArray(links) ? links : []).filter(l => l && ((l.a === aId && l.b === bId) || (l.a === bId && l.b === aId)));
  if (!cands.length) return null;
  // 端到端路径已给出该跳的链路 id（含聚合组展开的多条）：优先在给定集合里挑
  const pref = Array.isArray(preferredLinkIds) && preferredLinkIds.length
    ? cands.filter(l => preferredLinkIds.indexOf(l.id) >= 0)
    : [];
  const list = pref.length ? pref : cands;
  const withIp = list.find(l => normHost(l.a === aId ? l.bIp : l.aIp));
  const pick = withIp || list[0];
  const host = withIp ? normHost(pick.a === aId ? pick.bIp : pick.aIp) : '';
  return { host, linkId: pick.id, link: pick };
}
/** 段起点（设备模式用）：设备 id/名称/管理地址 + 连接参数（凭据由渲染层在主进程侧解析，见 electron-main.js） */
function segFrom(node, host, extra) {
  return Object.assign({
    deviceId: String((node && node.id) || ''),
    name: String((node && node.name) || ''),
    host: normHost(host)
  }, extra || {});
}
/** 构造任务的段列表：path.nodeIds 逐跳 + 每跳取目标地址（没有地址的跳跳过，但要如实标注） */
function segmentsOf(graph, nodeIds, linkIds, opts) {
  const nodes = (graph && graph.nodes) || [];
  const links = (graph && graph.links) || [];
  const o = opts || {};
  const byId = new Map(nodes.map(n => [n.id, n]));
  const segs = [];
  const skipped = [];
  for (let i = 0; i + 1 < nodeIds.length && segs.length < LIMITS.segments; i++) {
    const aId = nodeIds[i], bId = nodeIds[i + 1];
    const a = byId.get(aId), b = byId.get(bId);
    if (!a || !b) continue;
    const hit = hopTarget(links, aId, bId, linkIds);
    let host = hit && hit.host;
    if (!host && hit) host = (mgmtHostsOf(b)[0] || '');   // 回退：对端设备管理地址（口径写在界面上）
    if (!host) { skipped.push({ linkId: (hit && hit.linkId) || '', reason: '该跳两端都没有可用地址（接口 IP / 管理地址）' }); continue; }
    segs.push({
      index: segs.length,
      linkId: (hit && hit.linkId) || '',
      aId: aId, bId: bId,
      aName: String(a.name || aId), bName: String(b.name || bId),
      from: Object.assign(segFrom(a, mgmtHostsOf(a)[0] || '', o.fromExtra && o.fromExtra(aId)), {}),
      target: host,
      targetKind: hit && hit.host ? 'ifip' : 'mgmt',
      aIf: String(o.ifOf ? o.ifOf(hit && hit.link, aId) : ((hit && hit.link ? (hit.link.a === aId ? hit.link.aIf : hit.link.bIf) : '') || '')),
      bIf: String(o.ifOf ? o.ifOf(hit && hit.link, bId) : ((hit && hit.link ? (hit.link.a === bId ? hit.link.aIf : hit.link.bIf) : '') || ''))
    });
  }
  return { segments: segs, skipped: skipped };
}
/** 一条连线的展示名：SW1（GE0/0/1）⇄ SW2（GE0/0/2） */
function linkTaskName(a, b, aIf, bIf) {
  const af = aIf ? '（' + aIf + '）' : '';
  const bf = bIf ? '（' + bIf + '）' : '';
  return String((a && a.name) || '?') + af + ' ⇄ ' + String((b && b.name) || '?') + bf;
}
function taskBase(kind, name, segments, opts) {
  const o = opts || {};
  return {
    id: String(o.id || ''),
    kind: kind,
    name: String(name).slice(0, 120),
    enabled: o.enabled !== false,
    mode: MODES.indexOf(o.mode) >= 0 ? o.mode : DEFAULTS.mode,
    protocol: PROTOCOLS.indexOf(o.protocol) >= 0 ? o.protocol : DEFAULTS.protocol,
    port: clampInt(o.port, LIMITS.port[0], LIMITS.port[1], DEFAULTS.port),
    intervalSec: clampInt(o.intervalSec, LIMITS.intervalSec[0], LIMITS.intervalSec[1], DEFAULTS.intervalSec),
    timeoutMs: clampInt(o.timeoutMs, LIMITS.timeoutMs[0], LIMITS.timeoutMs[1], DEFAULTS.timeoutMs),
    vendor: VENDOR_PING[o.vendor] ? o.vendor : DEFAULT_VENDOR,
    failThreshold: clampInt(o.failThreshold, LIMITS.failThreshold[0], LIMITS.failThreshold[1], LIMITS.failThresholdDft),
    okThreshold: clampInt(o.okThreshold, LIMITS.okThreshold[0], LIMITS.okThreshold[1], LIMITS.okThresholdDft),
    baselineFirst: o.baselineFirst !== false,
    segments: segments,
    linkIds: segments.map(s => s.linkId).filter(Boolean),
    nodeIds: (o.nodeIds || []).slice(0, LIMITS.segments + 1)
  };
}
/** 一键为全部连线生成链路任务：每条连线一个「两端接口 IP 互探」任务（无地址的连线如实跳过） */
function buildLinkTasks(graph, opts) {
  const o = opts || {};
  const nodes = (graph && graph.nodes) || [];
  const links = (graph && graph.links) || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const tasks = [];
  const skipped = [];
  const idOf = typeof o.idOf === 'function' ? o.idOf : (i) => 'lk' + (i + 1);
  for (const l of links) {
    if (tasks.length >= LIMITS.maxTasks) { skipped.push({ linkId: l.id, reason: '已达任务上限 ' + LIMITS.maxTasks }); continue; }
    const a = byId.get(l.a), b = byId.get(l.b);
    if (!a || !b) { skipped.push({ linkId: l.id, reason: '连线两端设备不存在' }); continue; }
    const segs = [];
    const skippedSegs = [];
    // 双向各一段：A→B 探测 B 的接口 IP、B→A 探测 A 的接口 IP，任一方向不通都说明这段链路有问题。
    // 这里**只认接口 IP**、不用管理地址回退：管理口通不代表这条链路通（两者常走不同的网），
    // 用管理地址凑出来的「链路监测」会给出一条毫无意义的绿灯——宁可不建，也不能给假结论。
    for (const dir of [[a, b, l.bIp, l.bIf], [b, a, l.aIp, l.aIf]]) {
      const host = normHost(dir[2]);
      if (!host) { skippedSegs.push(dir[0].name); continue; }
      segs.push({
        index: segs.length, linkId: l.id, aId: dir[0].id, bId: dir[1].id,
        aName: String(dir[0].name || dir[0].id), bName: String(dir[1].name || dir[1].id),
        from: segFrom(dir[0], mgmtHostsOf(dir[0])[0] || '', o.fromExtra && o.fromExtra(dir[0].id)),
        target: host, targetKind: 'ifip',
        aIf: String(dir[3] || ''), bIf: ''
      });
    }
    if (!segs.length) { skipped.push({ linkId: l.id, reason: '两端都没有接口 IP（管理地址不能代表这条链路）' }); continue; }
    const name = linkTaskName(a, b, l.aIf, l.bIf) + (skippedSegs.length ? '（' + skippedSegs.join('、') + ' 侧无接口 IP，仅单向监测）' : '');
    tasks.push(taskBase('link', name, segs, Object.assign({}, o, { id: idOf(tasks.length, l), nodeIds: [a.id, b.id] })));
  }
  return { tasks: tasks, skipped: skipped };
}
/** 端到端路径任务：任意两设备，沿拓扑选路后逐段探测（断在哪一段是测出来的） */
function buildPathTask(graph, fromId, toId, opts) {
  const o = opts || {};
  const nodes = (graph && graph.nodes) || [];
  const links = (graph && graph.links) || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const from = byId.get(fromId), to = byId.get(toId);
  if (!from || !to) return { ok: false, error: '起点或终点设备不存在' };
  if (fromId === toId) return { ok: false, error: '起点与终点相同' };
  const path = pathBetween(nodes, links, fromId, toId, o);
  if (!path) return { ok: false, error: '两台设备之间没有可达路径（可能被故障标记断开）' };
  if (path.nodeIds.length - 1 > LIMITS.segments) return { ok: false, error: '路径超过 ' + LIMITS.segments + ' 跳，请选择更近的两台设备' };
  const built = segmentsOf(graph, path.nodeIds, path.linkIds, o);
  if (!built.segments.length) return { ok: false, error: '路径上没有可探测的地址（两端都没填接口 IP / 管理地址）' };
  const hops = path.nodeIds.map(id => { const n = byId.get(id); return String((n && n.name) || id); });
  // 有跳没有可用地址时如实写进名称：否则界面上看是「端到端 3 跳」，实际只测了 2 段
  const miss = built.skipped.length ? '（' + built.skipped.length + ' 跳无可用地址，未纳入探测）' : '';
  const name = '端到端：' + hops[0] + ' → ' + hops[hops.length - 1] + '（' + (path.nodeIds.length - 1) + ' 跳）' + miss;
  const task = taskBase('path', name, built.segments, Object.assign({}, o, { nodeIds: path.nodeIds }));
  task.bottleneck = Number.isFinite(path.bottleneck) ? path.bottleneck : 0;
  task.missingHops = built.skipped.length;
  return { ok: true, task: task, skipped: built.skipped };
}

/* ---------- 任务归一化（渲染层传来的载荷一律当不可信输入） ---------- */
function normSegment(raw, i) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const target = normHost(s.target);
  if (!target) return null;
  const from = (s.from && typeof s.from === 'object') ? s.from : {};
  const out = {
    index: i,
    linkId: String(s.linkId || '').slice(0, 64),
    aId: String(s.aId || '').slice(0, 64),
    bId: String(s.bId || '').slice(0, 64),
    aName: String(s.aName || '').slice(0, 80),
    bName: String(s.bName || '').slice(0, 80),
    target: target,
    targetKind: s.targetKind === 'mgmt' ? 'mgmt' : 'ifip',
    aIf: String(s.aIf || '').slice(0, 64),
    bIf: String(s.bIf || '').slice(0, 64),
    from: {
      deviceId: String(from.deviceId || '').slice(0, 64),
      name: String(from.name || '').slice(0, 80),
      host: normHost(from.host),
      // 设备模式连接参数：port/协议/账号等由主进程按凭据补齐（credId 或监控配置快照）
      // 端口 0/空 表示「未指定，按凭据或协议默认」——不能被钳制成 1
      port: (() => { const p = parseInt(from.port, 10); return (Number.isFinite(p) && p > 0) ? clampInt(p, LIMITS.port[0], LIMITS.port[1], 0) : 0; })(),
      protocol: String(from.protocol || '').toLowerCase() === 'telnet' ? 'telnet' : (from.protocol ? 'ssh' : ''),
      username: String(from.username || '').slice(0, 128),
      password: String(from.password || '').slice(0, 1024),
      privateKey: typeof from.privateKey === 'string' ? from.privateKey.slice(0, 65536) : '',
      keyPassphrase: String(from.keyPassphrase || '').slice(0, 1024),
      preCmd: String(from.preCmd || '').slice(0, 256),
      credId: String(from.credId || '').slice(0, 64),
      expectFp: String(from.expectFp || '').slice(0, 128),
      vendor: VENDOR_PING[from.vendor] ? from.vendor : ''
    }
  };
  return out;
}
/** 归一化任务：非法/缺地址的段丢弃；没有可用段的任务作废（返回 null，由调用方如实报错） */
function normTask(raw) {
  const t = (raw && typeof raw === 'object') ? raw : {};
  const id = String(t.id || '');
  if (!/^[A-Za-z0-9_.:-]{1,48}$/.test(id)) return null;
  const segsIn = Array.isArray(t.segments) ? t.segments.slice(0, LIMITS.segments) : [];
  const segments = [];
  for (const s of segsIn) { const n = normSegment(s, segments.length); if (n) segments.push(n); }
  if (!segments.length) return null;
  const out = taskBase(t.kind === 'path' ? 'path' : 'link', String(t.name || '').slice(0, 120) || ('链路 ' + id), segments, {
    id: id,
    enabled: t.enabled !== false,
    mode: t.mode, protocol: t.protocol, port: t.port, intervalSec: t.intervalSec, timeoutMs: t.timeoutMs,
    vendor: t.vendor, failThreshold: t.failThreshold, okThreshold: t.okThreshold, baselineFirst: t.baselineFirst,
    nodeIds: Array.isArray(t.nodeIds) ? t.nodeIds.map(x => String(x).slice(0, 64)) : []
  });
  return out;
}

/* ---------- 探测判定 ---------- */
/** ping 回显判定：true=通 / false=不通 / null=无法判定（判定不出就不动状态，见头注）。
 *  覆盖四类回显：Linux iputils、华为/H3C（n packet(s) transmitted/received）、思科（Success rate）、
 *  中文 Windows（已发送/已接收/请求超时/来自 x 的回复）。失败证据优先于成功证据。 */
function judgeProbeText(text, target) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return null;
  const tgt = normHost(target);
  const esc = tgt ? tgt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  // ---- 明确的失败证据（优先）----
  if (/(?:Destination\s+(?:host\s+|net(?:work)?\s+)?unreachable|Network is unreachable|无法访问目标主机|目标主机不可达|目标网络不可达)/i.test(t)) return false;
  if (/(?:Request\s+timed\s+out|请求超时)/i.test(t)) return false;
  if (/100(?:\.0+)?%\s*(?:packet\s+)?loss/i.test(t) || /(?:丢失|Loss)\s*=\s*\d+\s*[(（]\s*100(?:\.0+)?%/i.test(t)) return false;
  if (/Success rate is 0 percent/i.test(t)) return false;
  const rx = t.match(/(\d+)\s*(?:packets?\s+|packet\(s\)\s*)?received/i);
  if (rx && parseInt(rx[1], 10) === 0) return false;
  if (/(?:已接收|Received)\s*=\s*0\b/i.test(t)) return false;
  // ---- 成功证据 ----
  if (rx) return parseInt(rx[1], 10) > 0;                      // Linux / 华为 / H3C 的 N received
  const sr = t.match(/Success rate is (\d+) percent/i);         // 思科
  if (sr) return parseInt(sr[1], 10) > 0;
  if (/(?:已接收|Received)\s*=\s*[1-9]\d*/i.test(t)) return true; // 中文 Windows
  if (tgt && new RegExp('(?:Reply\\s+from\\s+' + esc + '\\s*:)|(?:\\d+\\s+bytes\\s+from\\s+' + esc + '\\s*:)|(?:from\\s+' + esc + '\\s*:)|(?:来自\\s+' + esc + '\\s+的回复)', 'i').test(t)) return true;
  if (/(?:min\/avg\/max|最短\s*=|rtt\s+min)/i.test(t)) return true;
  // 中文回显（华为/H3C 中文版、中文 Windows）的成功行只打印 RTT，没有 "Reply from"；失败场景不会打印时间
  if (/(?:时间|time)\s*[<≤=]\s*[\d.]+\s*ms/i.test(t)) return true;
  return null;
}
/** 从 ping 回显里取平均时延（毫秒，取不到返回 null） */
function parseProbeLatency(text) {
  const t = String(text == null ? '' : text);
  let m = t.match(/min\/avg\/max(?:\/\w+)?\s*=\s*[\d.]+\/([\d.]+)\//i);
  if (m) return parseFloat(m[1]);
  m = t.match(/(?:平均|Average)\s*=\s*([\d.]+)\s*ms/i);
  if (m) return parseFloat(m[1]);
  m = t.match(/time[=<]\s*([\d.]+)\s*ms/i);
  if (m) return parseFloat(m[1]);
  m = t.match(/time[=<]\s*(\d+)\s*ms/i);
  return m ? parseFloat(m[1]) : null;
}
/** 设备侧探测命令（一行，命令注入面由 normHost 收敛到 IPv4/主机名字面量） */
function probeCommand(vendor, target, opts) {
  const t = normHost(target);
  if (!t) return '';
  const o = opts || {};
  const fn = VENDOR_PING[vendor] || VENDOR_PING.linux;
  const count = clampInt(o.count, 1, 5, LIMITS.count);
  const timeoutSec = Math.max(1, Math.min(10, Math.round((clampInt(o.timeoutMs, LIMITS.timeoutMs[0], LIMITS.timeoutMs[1], DEFAULTS.timeoutMs)) / 1000)));
  return fn(t, { count: count, timeoutSec: timeoutSec });
}
/** 本机模式下的逐跳探测目标（去重保序：同一地址只探一次，结果回填到所有引用它的段） */
function localTargets(task) {
  const out = [];
  const seen = new Map();
  for (const s of (task && task.segments) || []) {
    if (!s || !s.target) continue;
    if (!seen.has(s.target)) { seen.set(s.target, out.length); out.push({ host: s.target, segIndexes: [s.index] }); }
    else out[seen.get(s.target)].segIndexes.push(s.index);
  }
  return out;
}

/* ---------- 结论与状态机 ---------- */
/** 段结果 → 端到端结论：全通=up；有明确失败=down（并定位到第一段失败处）；全无法判定=unknown */
function evaluateSegments(segResults) {
  const list = Array.isArray(segResults) ? segResults : [];
  let up = 0, down = 0, unknown = 0, brokenAt = null, latency = 0, hasLatency = false;
  for (const r of list) {
    const v = (r && (r.ok === true || r.ok === false)) ? r.ok : null;
    if (v === true) {
      up++;
      if (Number.isFinite(r.latencyMs)) { latency += Number(r.latencyMs); hasLatency = true; }
    } else if (v === false) { down++; if (brokenAt == null) brokenAt = Number(r.index) || 0; }
    else unknown++;
  }
  const state = down > 0 ? 'down' : (up > 0 ? 'up' : 'unknown');
  return { state: state, up: up, down: down, unknown: unknown, brokenAt: brokenAt, latencyMs: hasLatency ? Math.round(latency) : null };
}
/** 状态机：连续 N 次失败才判中断、连续 M 次成功才判恢复（单次抖动不改状态）；
 *  「无法判定」既不计成功也不计失败——设备回显解析不出结论时保持原状态。
 *
 *  基线（baselineFirst 打开时）：**首个能判定的结论直接作为初始状态**，且不产生事件——
 *  这样「本机到对端本来就不可达」（跨网段 / ACL / 业务地址不在本机路由内）不会在第二轮
 *  去抖达成后刷出一条假的中断告警；此后只有**相对基线发生翻转**才告警。
 *  结论判不出来（全是 unknown）时不消费基线，留给下一次能判定时再建。 */
function applyProbe(prev, segResults, cfg) {
  const o = cfg || {};
  const evalr = evaluateSegments(segResults);
  const p = prev || {};
  const failThreshold = clampInt(o.failThreshold, LIMITS.failThreshold[0], LIMITS.failThreshold[1], LIMITS.failThresholdDft);
  const okThreshold = clampInt(o.okThreshold, LIMITS.okThreshold[0], LIMITS.okThreshold[1], LIMITS.okThresholdDft);
  const baselineFirst = o.baselineFirst !== false;
  const ts = Number.isFinite(o.ts) ? o.ts : Date.now();
  const prevState = STATES.indexOf(p.state) >= 0 ? p.state : 'unknown';
  let okStreak = Number(p.okStreak) || 0;
  let failStreak = Number(p.failStreak) || 0;
  if (evalr.state === 'up') { okStreak++; failStreak = 0; }
  else if (evalr.state === 'down') { failStreak++; okStreak = 0; }
  // unknown：streak 原样保留（既不奖励也不惩罚）
  const first = !p.baselined;
  const takeBaseline = first && baselineFirst && evalr.state !== 'unknown';
  let state = prevState;
  let changed = false;
  if (takeBaseline) {
    state = evalr.state;
  } else if (evalr.state === 'up' && okStreak >= okThreshold && prevState !== 'up') { state = 'up'; changed = true; }
  else if (evalr.state === 'down' && failStreak >= failThreshold && prevState !== 'down') { state = 'down'; changed = true; }
  const out = {
    state: state,
    prevState: prevState,
    probeState: evalr.state,          // 本轮原始结论（未经去抖），界面用「探测结论」与「判定状态」区分展示
    changed: changed,
    baselined: p.baselined === true || takeBaseline,
    baseline: takeBaseline,
    okStreak: okStreak, failStreak: failStreak,
    up: evalr.up, down: evalr.down, unknown: evalr.unknown,
    brokenAt: evalr.brokenAt,
    latencyMs: evalr.latencyMs,
    lastProbeAt: ts,
    since: (changed || takeBaseline) ? ts : (Number(p.since) || ts)
  };
  out.event = (out.changed && state === 'down') ? 'link-down'
    : (out.changed && state === 'up') ? 'link-up' : null;
  return out;
}
/** 状态 → 展示（中文名 + 颜色，渲染层与通知共用一套口径） */
function stateLabel(state) {
  return state === 'up' ? '连通' : state === 'down' ? '中断' : '未知';
}

const API = {
  MODES: MODES, PROTOCOLS: PROTOCOLS, VENDOR_PING: VENDOR_PING, LIMITS: LIMITS, DEFAULTS: DEFAULTS, STATES: STATES,
  isIpv4: isIpv4, isHost: isHost, normHost: normHost, mgmtHostsOf: mgmtHostsOf,
  pathBetween: pathBetween, hopTarget: hopTarget, segmentsOf: segmentsOf, linkTaskName: linkTaskName,
  buildLinkTasks: buildLinkTasks, buildPathTask: buildPathTask,
  normTask: normTask, normSegment: normSegment, localTargets: localTargets,
  probeCommand: probeCommand, judgeProbeText: judgeProbeText, parseProbeLatency: parseProbeLatency,
  evaluateSegments: evaluateSegments, applyProbe: applyProbe, stateLabel: stateLabel
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.TopoLinkPath = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
