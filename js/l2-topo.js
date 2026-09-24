/* NetTopo 二层拓扑推断（SNMP BRIDGE-MIB）—— 纯逻辑（主进程/渲染层共用，不依赖 Electron）
 *
 * 解决什么问题：现场大量设备不开 LLDP/CDP（老交换机、哑交换机、只读权限只给 SNMP），
 * 但这些设备的网桥转发表（BRIDGE-MIB）照样在跑。两台交换机之间的链路，在各自的转发表里表现为
 * 「同一批 MAC 同时挂在我这条端口和它的那条端口上」——据此可以反推出链路，不需要任何邻居协议。
 *
 * 判据（从强到弱，全部可解释，界面上逐条给出证据）：
 *  - 桥地址命中：A 的某端口上学到了 B 的桥 MAC（dot1dBaseBridgeAddress），直接证据；
 *  - 独占交集：某批 MAC 在 A 与 B 上都只出现在这一对端口上（uniqueShared）——链路；
 *  - 若交集里的 MAC 在 A 或 B 的**其他端口**上也出现，说明那是共享网段（集线器/环路/泛洪），
 *    **不算链路**（这正是二层推断最容易出假链路的地方，宁可不出也不出错链路）；
 *  - 互为最优：A 认定的对端端口与 B 认定的对端端口必须是同一对，否则判定为歧义（多口等分），
 *    只报「疑似」不给结论——歧义往往意味着拓扑里有共享网段。
 *
 * 诚实标注：采集被上限截断（大表只取到前 N 行）时置信度整体降级并注明；MAC 表是**学到的**，
 * 会随流量变化，所以推断链路在界面上与实测（LLDP/CDP）链路视觉区分。
 */
'use strict';

/* ---------- 标准 OID ---------- */
const OIDS = {
  bridgeAddr: '1.3.6.1.2.1.17.1.1.0',            // dot1dBaseBridgeAddress（单值 GET）
  portIfIndex: '1.3.6.1.2.1.17.1.4.1.2',         // dot1dBasePortIfIndex：桥端口 → ifIndex
  fdbAddress: '1.3.6.1.2.1.17.4.3.1.1',          // dot1dTpFdbAddress（索引即 MAC）
  fdbPort: '1.3.6.1.2.1.17.4.3.1.2',             // dot1dTpFdbPort：MAC → 桥端口
  fdbStatus: '1.3.6.1.2.1.17.4.3.1.3',           // dot1dTpFdbStatus（1 other/2 invalid/3 learned/4 self/5 mgmt）
  ifName: '1.3.6.1.2.1.31.1.1.1.1',              // ifName
  ifDescr: '1.3.6.1.2.1.2.2.1.2'                 // ifDescr（ifName 缺失时的回退）
};

/** MAC 归一：12 位十六进制小写；非法返回空串 */
function normMac(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return s.length === 12 ? s : '';
}
/** 组播/广播/全零 MAC：不参与推断（它们出现在所有端口上，会把任意两条链路连起来） */
function isNoiseMac(mac) {
  if (!mac || mac === '000000000000') return true;
  const first = parseInt(mac.slice(0, 2), 16);
  if (!Number.isFinite(first)) return true;
  if (first & 0x01) return true;                       // 组播位（含广播 ff:ff:…）
  if (mac === 'ffffffffffff') return true;
  return false;
}
/** OID 索引（点分十进制）末 6 段 → MAC */
function macFromOidSuffix(oid) {
  const parts = String(oid == null ? '' : oid).split('.');
  if (parts.length < 6) return '';
  const six = parts.slice(-6);
  return six.map(n => String(parseInt(n, 10).toString(16)).padStart(2, '0')).join('');
}
const intOf = (v) => {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : NaN;
};

/** 解析 dot1dBaseBridgeAddress 的单值返回（hex-string 或 6 段点分十进制） */
function parseBridgeAddr(varbinds) {
  for (const vb of (Array.isArray(varbinds) ? varbinds : [])) {
    const raw = vb && vb.value;
    if (raw == null) continue;
    const s = String(raw);
    const mac = normMac(s);
    if (mac) return mac;
    if (/^\d+(\.\d+){5}$/.test(s.trim())) return macFromOidSuffix(s.trim());
  }
  return '';
}
/** 解析 dot1dBasePortIfIndex → {桥端口号: ifIndex} */
function parsePortIfIndex(varbinds) {
  const out = {};
  for (const vb of (Array.isArray(varbinds) ? varbinds : [])) {
    const parts = String((vb && vb.oid) || '').split('.');
    const port = intOf(parts[parts.length - 1]);
    const ifIndex = intOf(vb && vb.value);
    if (Number.isFinite(port) && port > 0 && Number.isFinite(ifIndex) && ifIndex > 0) out[String(port)] = ifIndex;
  }
  return out;
}
/** 解析 ifName / ifDescr 表 → {ifIndex: 名称}（保留首个非空值） */
function parseIfNames(varbinds) {
  const out = {};
  for (const vb of (Array.isArray(varbinds) ? varbinds : [])) {
    const parts = String((vb && vb.oid) || '').split('.');
    const idx = parts[parts.length - 1];
    const name = String((vb && vb.value) == null ? '' : vb.value).trim();
    if (!idx || !name) continue;
    if (!out[idx]) out[idx] = name.slice(0, 64);
  }
  return out;
}
/** 解析 FDB 三张表（address/port/status 各自一份 walk 结果）→ [{mac, port, status}] */
function parseFdb(addressVb, portVb, statusVb) {
  const portByMac = new Map(), statusByMac = new Map();
  for (const vb of (Array.isArray(portVb) ? portVb : [])) {
    const mac = macFromOidSuffix(vb && vb.oid);
    const p = intOf(vb && vb.value);
    if (mac && Number.isFinite(p) && p > 0) portByMac.set(mac, p);
  }
  for (const vb of (Array.isArray(statusVb) ? statusVb : [])) {
    const mac = macFromOidSuffix(vb && vb.oid);
    const s = intOf(vb && vb.value);
    if (mac) statusByMac.set(mac, s);
  }
  const out = [];
  const seen = new Set();
  for (const vb of (Array.isArray(addressVb) ? addressVb : [])) {
    const mac = macFromOidSuffix(vb && vb.oid);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    const port = portByMac.has(mac) ? portByMac.get(mac) : NaN;
    out.push({ mac, port, status: statusByMac.has(mac) ? statusByMac.get(mac) : 0 });
  }
  // 只有 address 表没有 port 表时，退化用 MAC 值本身（个别设备把 MAC 放值里）
  if (!out.length) {
    for (const vb of (Array.isArray(portVb) ? portVb : [])) {
      const mac = macFromOidSuffix(vb && vb.oid);
      if (mac) out.push({ mac, port: intOf(vb && vb.value), status: 0 });
    }
  }
  return out.filter(x => !isNoiseMac(x.mac));
}

/** 端口显示名：ifName/ifDescr 优先，缺失时标为「桥端口 N」 */
function portLabel(dev, port) {
  const key = String(port);
  const ifIndex = (dev.portIfIndex || {})[key];
  const nm = ifIndex != null ? (dev.ifNames || {})[String(ifIndex)] : '';
  return nm || ('桥端口 ' + key);
}

/**
 * 推断二层链路。
 * @param {Array} devices [{id, name, host, bridgeAddr, portIfIndex, ifNames, fdb, truncated}]
 * @param {object} [opts] {minUnique=1, maxLinks=200}
 * @returns {{ok:true, links:[…], ambiguous:[…], stats:{…}}}
 */
function inferLinks(devices, opts) {
  const o = opts || {};
  const maxLinks = Math.max(1, Math.min(2000, parseInt(o.maxLinks, 10) || 200));
  const list = (Array.isArray(devices) ? devices : []).filter(d => d && d.id && Array.isArray(d.fdb) && d.fdb.length);
  const stats = { devices: list.length, macs: 0, truncated: 0, pairs: 0, skippedNoUnique: 0, skippedAmbiguous: 0, skippedSelf: 0 };

  // 每台设备：端口 → MAC 集合；MAC → 端口集合（判「独占」用）
  const views = new Map();
  for (const d of list) {
    const portMacs = new Map(), macPorts = new Map();
    for (const e of d.fdb) {
      const mac = normMac(e.mac);
      const port = intOf(e.port);
      if (!mac || isNoiseMac(mac) || !Number.isFinite(port) || port <= 0) continue;
      if (!portMacs.has(port)) portMacs.set(port, new Set());
      portMacs.get(port).add(mac);
      if (!macPorts.has(mac)) macPorts.set(mac, new Set());
      macPorts.get(mac).add(port);
      stats.macs++;
    }
    if (d.truncated) stats.truncated++;
    if (!portMacs.size) continue;
    views.set(d.id, { dev: d, portMacs, macPorts, bridgeAddr: normMac(d.bridgeAddr || '') });
  }
  const usable = list.filter(d => views.has(d.id));

  const links = [], ambiguous = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const A = views.get(usable[i].id), B = views.get(usable[j].id);
      stats.pairs++;
      // 逐对端口打分：unique = 交集里在双方都只挂这一个端口的 MAC 数
      const cand = [];
      for (const [pA, setA] of A.portMacs) {
        for (const [pB, setB] of B.portMacs) {
          let shared = 0, unique = 0;
          for (const mac of setA) {
            if (!setB.has(mac)) continue;
            shared++;
            if (A.macPorts.get(mac).size === 1 && B.macPorts.get(mac).size === 1) unique++;
          }
          // 桥地址证据：A 在 pA 上看到 B 的桥 MAC，且 B 在 pB 上看到 A 的桥 MAC（互为对方，双向才算）。
          // 注意这条**不要求**两端口有 MAC 交集——交换机通常不会把自己的桥 MAC 学进转发表，
          // 因此仅凭「转发表交集」判据会漏掉这种最明确的链路（实测构造用例时踩到）。
          const aSeesB = !!(B.bridgeAddr && setA.has(B.bridgeAddr));
          const bSeesA = !!(A.bridgeAddr && setB.has(A.bridgeAddr));
          const addrHit = aSeesB && bSeesA;
          if (!shared && !addrHit) continue;
          cand.push({ pA, pB, shared, unique, addrHit });
        }
      }
      if (!cand.length) continue;
      const score = (c) => (c.addrHit ? 1e6 : 0) + c.unique * 100 + c.shared;
      cand.sort((x, y) => score(y) - score(x));
      const best = cand[0];
      if (!best.addrHit && best.unique < Math.max(1, parseInt(o.minUnique, 10) || 1)) {
        // 交集里的 MAC 在双方的其他端口上也出现 → 共享网段，不是链路
        stats.skippedNoUnique++;
        continue;
      }
      // 互为最优：A 为 B 选出的端口、B 为 A 选出的端口必须就是这一对
      const bestForA = cand.filter(c => c.pB === best.pB).sort((x, y) => score(y) - score(x))[0];
      const bestForB = cand.filter(c => c.pA === best.pA).sort((x, y) => score(y) - score(x))[0];
      const mutual = bestForA && bestForB && bestForA.pA === best.pA && bestForB.pB === best.pB;
      // 同分并列（同一对设备之间有多个端口并列最优）→ 歧义，只报疑似
      const tied = cand.filter(c => c !== best && score(c) === score(best));
      if (!mutual || tied.length) {
        stats.skippedAmbiguous++;
        ambiguous.push({
          aId: usable[i].id, aName: usable[i].name || usable[i].id, aIf: portLabel(usable[i], best.pA),
          bId: usable[j].id, bName: usable[j].name || usable[j].id, bIf: portLabel(usable[j], best.pB),
          shared: best.shared, unique: best.unique, reason: tied.length ? '多个端口并列最优（疑似共享网段/环路）' : '双方认定的对端端口不一致'
        });
        continue;
      }
      let confidence = best.addrHit ? 'high' : (best.unique >= 2 || best.shared >= 2 ? 'medium' : 'low');
      const truncated = !!(usable[i].truncated || usable[j].truncated);
      if (truncated && confidence === 'high') confidence = 'medium';
      else if (truncated && confidence === 'medium') confidence = 'low';
      links.push({
        aId: usable[i].id, aName: usable[i].name || usable[i].id, aIf: portLabel(usable[i], best.pA), aPort: best.pA,
        bId: usable[j].id, bName: usable[j].name || usable[j].id, bIf: portLabel(usable[j], best.pB), bPort: best.pB,
        shared: best.shared, unique: best.unique,
        evidence: (best.addrHit ? ['桥地址命中'] : []).concat(
          best.unique > 0 ? ['转发表独占交集 ×' + best.unique] : (best.shared > 0 ? ['转发表交集 ×' + best.shared + '（非独占）'] : [])
        ),
        confidence,
        truncated,
        note: truncated ? '采集被上限截断，置信度已下调' : ''
      });
      if (links.length >= maxLinks) { stats.capped = true; return { ok: true, links, ambiguous, stats }; }
    }
  }
  // 同一台设备被推断出多条链路是正常的（上联 + 下联），但同一对端口只能有一条
  links.sort((x, y) => (x.aName < y.aName ? -1 : x.aName > y.aName ? 1 : 0) || (x.bName < y.bName ? -1 : 1));
  return { ok: true, links, ambiguous, stats };
}

/** 推断结果 → 可直接合并进拓扑的连线（带 inferred 标记，界面与实测链路视觉区分） */
function toGraphLinks(links, opts) {
  const o = opts || {};
  const uid = typeof o.uid === 'function' ? o.uid : (() => { let n = 0; return (p) => p + (++n); })('l');
  const out = [];
  for (const l of (Array.isArray(links) ? links : [])) {
    if (!l || !l.aId || !l.bId) continue;
    out.push({
      id: uid, a: l.aId, b: l.bId, aIf: l.aIf || '', bIf: l.bIf || '',
      aIp: '', bIp: '', bw: 0, note: 'SNMP 转发表推断' + (l.confidence === 'low' ? '（低置信）' : ''),
      agg: '', inferred: true, inferredBy: 'snmp-l2', evidence: (l.evidence || []).join('、')
    });
  }
  return out;
}

/* 双形态导出：主进程/测试用 module.exports，渲染层（无打包器、无 ES modules）挂 globalThis.TopoL2 */
const API = { OIDS, normMac, isNoiseMac, macFromOidSuffix, parseBridgeAddr, parsePortIfIndex, parseIfNames, parseFdb, inferLinks, toGraphLinks, portLabel };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.TopoL2 = API;
