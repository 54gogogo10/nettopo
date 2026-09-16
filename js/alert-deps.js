/* NetTopo 告警依赖抑制 —— 上游设备失联时归并下游离线通知（主进程，纯 Node，不依赖 Electron）
 * 由 electron-main.js 经 IPC 接收渲染层推送的拓扑邻接表后使用；也可在 Node 测试中直接调用。
 *
 * 要解决的问题：核心一挂，下游几十台设备的探测同时失败，通知栏被「设备离线」刷屏，真正的根因
 * （核心失联）反而被淹没。这里按**拓扑邻接关系**归并：同一个故障连通分量里只通知根因那一台。
 *
 * 根因判据（确定性，与探测事件的到达顺序无关——这点很关键）：
 *   同一「故障连通分量」（沿邻接表相连、且当前都判为离线的设备集合）中，按以下顺序裁决根因：
 *   ① 最早开始失败的那台（失败时刻相差在 failTieMs 容差内视为**同一轮齐掉**，进入下一级裁决——
 *      探测定时器毫秒级的先后是随机的，不足以定序）；
 *   ② 上游度 rank 高者（渲染层按设备类型给出：路由器/防火墙 > 交换机 > 其他 > 终端）；
 *   ③ 离线邻接度高者（分支更多的更像汇聚点）；
 *   ④ 键序（保证结果稳定可复现）。
 *   为什么不用「谁先上报谁当上游」：邻接下方向是未知的，先上报的可能正是被核心拖垮的接入交换机——
 *   那会把核心静默掉，甚至出现两台设备互相把对方当上游、结果谁都不通知。
 *   为什么单靠「离线邻居最多者当根」不够：链状拓扑里汇聚交换机的离线邻居数比核心更多，会被误判为根。
 *   已知残留：同类型设备串成的长链**同时**齐掉且类型无差异时，可能选中链中间那台作为根——
 *   此时通知里报的仍是一台确实离线的设备，且每台设备自己的事件时间线都如实记录，不会丢失信息。
 *
 * 语义（刻意保守，宁可多报也不误静默）：
 * - 上游判据：只有「装了在线探测且探测失败」的设备才进入故障连通分量。**未监控的邻居不参与**——
 *   把「对端没配监控」当成上游故障，会把真实告警静默掉。
 * - 连通分量只在**离线设备的子图**上扩散：中间设备在线说明路径是通的，下游故障不该归因到它上游。
 * - 抑制的只是**系统通知**；事件时间线仍由调用方照常记录（并标注归并原因），证据不丢。
 * - 恢复：被抑制设备恢复时，若根因已恢复且在其宽限期（graceMs，默认 10 分钟）内，则其恢复通知也归并
 *   ——根因恢复时会发一条聚合通知，列出随之恢复的设备名，信号不丢。
 *   若设备恢复时根因**仍然离线**（例如它自己重启回来了而核心还挂着），照常发它自己的恢复通知。
 * - 根因恢复时仍未恢复的下游：如实单列（「仍不可达」），并解除其归并状态——它的离线通知此前从未发出过，
 *   此时补发是第一条而不是重复（不谎报「已随之恢复」）。
 */
'use strict';

const DEFAULTS = {
  maxChain: 32,                 // 连通分量扩散的跳数上限（防病态拓扑拖死）
  failTieMs: 5000,              // 失败时刻相差在此容差内视为同一轮齐掉（毫秒级先后不定序）
  graceMs: 10 * 60 * 1000,      // 根因恢复后的归并宽限期（超期的下游恢复各自通知）
  staleMs: 24 * 60 * 60 * 1000, // 抑制登记的兜底清理时长
  maxKeys: 2000                 // 状态/登记表的条目上限（防无界增长）
};

class AlertDeps {
  /** @param {object} [opts] {now(), maxChain, graceMs, staleMs, maxKeys} */
  constructor(opts) {
    const o = opts || {};
    this.now = typeof o.now === 'function' ? o.now : Date.now;
    this.maxChain = Math.max(1, Math.min(256, parseInt(o.maxChain, 10) || DEFAULTS.maxChain));
    this.failTieMs = Math.max(0, parseInt(o.failTieMs, 10) || (o.failTieMs === 0 ? 0 : DEFAULTS.failTieMs));
    this.graceMs = Math.max(1000, parseInt(o.graceMs, 10) || DEFAULTS.graceMs);
    this.staleMs = Math.max(this.graceMs, parseInt(o.staleMs, 10) || DEFAULTS.staleMs);
    this.maxKeys = Math.max(16, parseInt(o.maxKeys, 10) || DEFAULTS.maxKeys);
    this.edges = new Map();      // key -> [邻接 key…]
    this.names = {};             // key -> 设备名
    this.ranks = {};             // key -> 上游度（设备类型序，裁决并列用；缺省 0）
    this.states = new Map();     // key -> true 在线 / false 离线（无记录 = 未知）
    this.failAt = new Map();     // key -> 本轮故障的首次失败时刻（恢复即清除）
    this.suppressed = new Map(); // 下游 key -> {rootKey, at}
    this.byRoot = new Map();     // 根因 key -> Set(下游 key)
  }

  /** 渲染层推送的拓扑邻接表：edges 为 [keyA, keyB] 对（键与监控任务一致：deviceId@host），
   *  names 为 key→设备名（通知文案用）、ranks 为 key→上游度（设备类型序，裁决并列用）。
   *  长度与形状全部校验，超限整体拒绝（不半途截断造成错图）。 */
  setTopology(payload) {
    const p = payload || {};
    const rawEdges = Array.isArray(p.edges) ? p.edges : [];
    const names = (p.names && typeof p.names === 'object') ? p.names : {};
    const ranks = (p.ranks && typeof p.ranks === 'object') ? p.ranks : {};
    if (rawEdges.length > 4000) return { ok: false, error: '邻接表过大（超过 4000 条）' };
    const edges = new Map();
    let count = 0;
    for (const e of rawEdges) {
      if (!Array.isArray(e) || e.length < 2) continue;
      const a = String(e[0] == null ? '' : e[0]).slice(0, 128);
      const b = String(e[1] == null ? '' : e[1]).slice(0, 128);
      if (!a || !b || a === b) continue;   // 自环无意义
      if (!edges.has(a)) edges.set(a, []);
      if (!edges.has(b)) edges.set(b, []);
      if (edges.get(a).indexOf(b) < 0) edges.get(a).push(b);
      if (edges.get(b).indexOf(a) < 0) edges.get(b).push(a);
      count++;
    }
    const cleanNames = {};
    for (const k of Object.keys(names).slice(0, 4000)) {
      const key = String(k).slice(0, 128);
      if (!key) continue;
      cleanNames[key] = String(names[k] == null ? '' : names[k]).slice(0, 120);
    }
    const cleanRanks = {};
    for (const k of Object.keys(ranks).slice(0, 4000)) {
      const key = String(k).slice(0, 128);
      const v = Number(ranks[k]);
      if (!key || !Number.isFinite(v)) continue;
      cleanRanks[key] = Math.max(-99, Math.min(99, Math.round(v)));
    }
    this.edges = edges;
    this.names = cleanNames;
    this.ranks = cleanRanks;
    // 拓扑变了：既有归并登记可能指向已不存在的链路，清掉（宁可按新拓扑重新判断）
    this.suppressed.clear();
    this.byRoot.clear();
    return { ok: true, edges: count, keys: edges.size };
  }

  /** 记录某监控任务的在线状态（每次探测都可调用；只认 true/false，其余保持原状）。
   *  failSince 为该轮故障的起始时刻（monitor 的 probeFailSince），缺省用当前时间。 */
  noteProbe(key, ok, failSince) {
    const k = String(key == null ? '' : key).slice(0, 128);
    if (!k) return;
    if (ok !== true && ok !== false) return;
    if (!this.states.has(k) && this.states.size >= this.maxKeys) {
      const oldest = this.states.keys().next().value;
      this.states.delete(oldest);
      this.failAt.delete(oldest);
      this._dropSuppressed(oldest);
    }
    this.states.set(k, ok === true);
    if (ok === false) {
      const at = Number(failSince);
      if (!this.failAt.has(k)) this.failAt.set(k, Number.isFinite(at) && at > 0 ? at : this.now());
    } else {
      this.failAt.delete(k);
    }
    this._prune();
  }

  isOffline(key) { return this.states.get(String(key)) === false; }
  isOnline(key) { return this.states.get(String(key)) === true; }
  nameOf(key) { return this.names[String(key)] || String(key); }
  /** 该设备是否在监控清单里：渲染层推送的 names/ranks 只含「已启用监控」的设备键，故可作此判据。
   *  不能用 states（探测状态）判断——故障刚发生时，先失败的那台还不知道邻居有没有装探测，
   *  用 states 判会让它跳过延迟判定、直接通知，归并随即失效（实测踩过）。 */
  isMonitored(key) { return Object.prototype.hasOwnProperty.call(this.names, String(key == null ? '' : key)); }

  /** 该设备是否存在「在监控清单里的邻居」：只有存在时才值得延迟判定（否则上游无从判断，
   *  立即通知即可，行为与旧版一致）。 */
  hasMonitoredNeighbor(key) {
    const list = this.edges.get(String(key == null ? '' : key)) || [];
    return list.some(k => this.isMonitored(k));
  }

  /** 故障连通分量（沿邻接表相连、且当前都判为离线的设备），返回 [{key, failAt, degree, depth}] */
  component(key, maxNodes) {
    const start = String(key == null ? '' : key);
    const out = [];
    if (!start || this.states.get(start) !== false) return out;
    const seen = new Set([start]);
    let frontier = [start], depth = 0;
    const limit = Math.max(1, Math.min(this.maxKeys, parseInt(maxNodes, 10) || this.maxKeys));
    while (frontier.length && out.length < limit && depth <= this.maxChain) {
      const next = [];
      for (const k of frontier) {
        const list = this.edges.get(k) || [];
        // 邻接度：该设备当前离线的邻居数（根因判据的并列裁决用）
        out.push({ key: k, failAt: this.failAt.get(k) || 0, degree: list.filter(x => this.states.get(x) === false).length, depth });
        for (const nb of list) {
          if (seen.has(nb) || this.states.get(nb) !== false) continue;   // 只看离线邻居：路径在线说明不是它的锅
          seen.add(nb);
          next.push(nb);
        }
      }
      frontier = next;
      depth++;
    }
    return out;
  }

  /** 故障连通分量的根因：最早失败 → 上游度 → 离线邻接度 → 键序（确定性，与事件到达顺序无关） */
  componentRoot(key) {
    const nodes = this.component(key);
    if (nodes.length < 2) return null;   // 只有自己：没有可归因的上游
    // 失败时刻相差在容差内的视为同一轮齐掉：毫秒级先后是探测定时器抖动，不足以判定因果
    const earliest = Math.min(...nodes.map(n => n.failAt || 0));
    const tol = this.failTieMs;
    const near = (n) => (n.failAt || 0) <= earliest + tol;
    const rankOf = (n) => Number(this.ranks[n.key]) || 0;
    let best = null;
    for (const n of nodes) {
      if (!best) { best = n; continue; }
      const bn = near(best), nn = near(n);
      if (bn !== nn) { if (nn) best = n; continue; }      // 非同时性：早的那一档优先
      if (bn && nn) {
        // 同一轮齐掉：上游度 → 离线邻接度 → 键序
        if (rankOf(n) > rankOf(best)) { best = n; continue; }
        if (rankOf(n) < rankOf(best)) continue;
        if (n.degree > best.degree) { best = n; continue; }
        if (n.degree < best.degree) continue;
        if (n.key < best.key) best = n;
        continue;
      }
      if (n.failAt < best.failAt) best = n;               // 容差为 0 的严格比较
    }
    return best;
  }

  /** 判定某设备离线是否应被抑制：同分量中存在更早失败的设备（根因）时不单独通知。
   *  返回 {suppress:false} 或 {suppress:true, rootKey, rootName, size, hops} */
  judgeOffline(key) {
    const start = String(key == null ? '' : key);
    if (!start) return { suppress: false };
    const root = this.componentRoot(start);
    if (!root || root.key === start) return { suppress: false };
    const nodes = this.component(start);
    const self = nodes.find(n => n.key === start);
    return {
      suppress: true,
      rootKey: root.key,
      rootName: this.nameOf(root.key),
      size: nodes.length,
      hops: self ? self.depth : 0
    };
  }

  /** 登记一次抑制（供恢复时归并恢复通知、根因恢复时聚合播报） */
  noteSuppressed(key, rootKey) {
    const k = String(key == null ? '' : key), r = String(rootKey == null ? '' : rootKey);
    if (!k || !r || k === r) return;
    if (!this.suppressed.has(k) && this.suppressed.size >= this.maxKeys) {
      const oldest = this.suppressed.keys().next().value;
      this._dropSuppressed(oldest);
    }
    this.suppressed.set(k, { rootKey: r, at: this.now() });
    if (!this.byRoot.has(r)) this.byRoot.set(r, new Set());
    this.byRoot.get(r).add(k);
  }

  /** 判定某设备的**恢复**是否应被归并；若该设备本身就是根因，返回聚合播报内容。
   *  调用前请先 noteProbe(key, true)（本函数据当前状态判断根因是否已恢复）。 */
  judgeRecover(key) {
    const k = String(key == null ? '' : key);
    const out = { suppress: false };
    const rec = this.suppressed.get(k);
    if (rec) {
      const withinGrace = (this.now() - rec.at) <= this.graceMs;
      if (withinGrace && this.isOnline(rec.rootKey)) {
        out.suppress = true;
        out.rootKey = rec.rootKey;
        out.rootName = this.nameOf(rec.rootKey);
      }
      this._dropSuppressed(k);
    }
    // 本设备若是某些设备的根因、且自己已恢复在线：给出聚合播报
    if (this.isOnline(k)) {
      const set = this.byRoot.get(k);
      if (set && set.size) {
        const keys = [...set];
        const online = keys.filter(x => this.isOnline(x));
        const stillDown = keys.filter(x => !this.isOnline(x));
        out.aggregate = {
          rootKey: k, rootName: this.nameOf(k),
          keys, names: keys.map(x => this.nameOf(x)), count: keys.length,
          recoveredNames: online.map(x => this.nameOf(x)),
          stillDownKeys: stillDown, stillDownNames: stillDown.map(x => this.nameOf(x))
        };
        // 仍未恢复的下游：解除归并——它们的离线通知此前从未发出，此处补发是第一条而非重复
        for (const x of stillDown) this._dropSuppressed(x);
      }
    }
    return out;
  }

  /** 当前仍被归并的下游（根因 key -> 设备名数组），供界面/排障查看 */
  pending() {
    const out = [];
    for (const [rootKey, set] of this.byRoot) {
      out.push({ rootKey, rootName: this.nameOf(rootKey), keys: [...set], names: [...set].map(k => this.nameOf(k)) });
    }
    return out;
  }

  /** 规模统计（界面/测试排查「邻接表到底推没推上来」） */
  stats() {
    let edgeCount = 0;
    for (const list of this.edges.values()) edgeCount += list.length;
    return { edges: edgeCount / 2, keys: this.edges.size, states: this.states.size, names: Object.keys(this.names).length, pending: this.suppressed.size };
  }

  /** 逐键视图（仅用于界面排查与测试：键、是否在监控清单、在线状态、本轮失败时刻、归并去向） */
  debugView() {
    const out = [];
    const keys = new Set([...this.edges.keys(), ...this.states.keys(), ...Object.keys(this.names)]);
    for (const k of keys) {
      const rec = this.suppressed.get(k);
      out.push({
        key: k,
        monitored: this.isMonitored(k),
        state: this.states.has(k) ? (this.states.get(k) ? 'online' : 'offline') : 'unknown',
        failAt: this.failAt.get(k) || 0,
        neighbors: (this.edges.get(k) || []).length,
        suppressedBy: rec ? rec.rootKey : ''
      });
    }
    return out;
  }

  _dropSuppressed(key) {
    const rec = this.suppressed.get(key);
    if (!rec) return;
    this.suppressed.delete(key);
    const set = this.byRoot.get(rec.rootKey);
    if (set) { set.delete(key); if (!set.size) this.byRoot.delete(rec.rootKey); }
  }

  /** 兜底清理：超期未恢复的归并登记不再参与（避免长期离线设备把后续恢复通知一直吞掉） */
  _prune() {
    const now = this.now();
    for (const [k, rec] of [...this.suppressed]) {
      if (now - rec.at > this.staleMs) this._dropSuppressed(k);
    }
  }
}

module.exports = { AlertDeps, DEFAULTS };
