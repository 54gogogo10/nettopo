/* ============================================================
 * NetTopo layout.js —— 力导向自动布局（rAF 动画，可在 Node 中单步测试）
 * ============================================================ */
(function (global) {
'use strict';

/* 求最大宽/高：Math.max(...arr) 的 spread 受引擎实参栈上限约束，超大节点数抛 RangeError */
const maxOf = (arr, f) => { let m = -Infinity; for (const x of arr) { const v = f(x); if (v > m) m = v; } return m; };

/* 力导向模拟：斥力 + 弹簧 + 弱重力，返回每一步的节点位置回调。
 * opts: { steps=520, stepsPerFrame=12, restLen=300, cancel:()=>bool }
 * 多节点（grid 化斥力 + BFS 初始）在 500~1000+ 节点下秒级收敛且形态分层清晰。
 */
function simulate(nodes, links, opts) {
  opts = opts || {};
  // BFS 初始已接近最终形态：大图步数减半收敛（斥力网格化后单步毫秒级，动画墙钟时间随之缩短）
  let steps = opts.steps || 520;
  if (nodes.length > 600 && steps > 200) steps = 200;
  const restLen = opts.restLen || 360;

  const N = nodes.length;
  if (N === 0) return null;
  // 大图钳制：节点数超过阈值时跳过 O(n²) 碰撞分离（斥力已网格化，仍可布局），防超大工程卡死
  const heavy = N > 2500;
  const pos = nodes.map(n => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 }));
  const vel = nodes.map(() => ({ x: 0, y: 0 }));
  const idIndex = new Map();
  nodes.forEach((n, i) => idIndex.set(n.id, i));

  // 邻接表（悬空引用不进图）
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, []);
  for (const l of links) {
    if (!adj.has(l.a) || !adj.has(l.b)) continue;
    adj.get(l.a).push(l.b);
    adj.get(l.b).push(l.a);
  }
  const degOf = (id) => (adj.get(id) || []).length;

  // 弹簧自然长度分级：叶子链路（任一端度为 1，如 终端↔接入）更短——扇出收紧在上级设备
  // 周围；与上联同长会把团块撑得又大又稀（千节点实测平均边长能到自然长度的 2 倍以上）
  const restOf = new Map();
  for (const l of links) {
    if (!adj.has(l.a) || !adj.has(l.b)) continue;
    restOf.set(l.id, Math.min(degOf(l.a), degOf(l.b)) === 1 ? restLen * 0.62 : restLen);
  }

  // 初始摆放：连通分量分扇区，分量内以最大度节点为根 BFS——深度为半径、BFS 序为角度。
  // 树状拓扑以近似最终形态起步（旧的整图单圆环乱序把终端与汇聚随机混排，大图收敛
  // 慢且形态松散；多分量也不会被挤进同一个圆互相穿插）
  const cx = pos.reduce((s, p) => s + p.x, 0) / N;
  const cy = pos.reduce((s, p) => s + p.y, 0) / N;
  const compCenter = new Array(N); // 每节点所属分量的重心（重力目标：分量各自回中，互不吸成一团）
  const ringGap = Math.max(210, restLen * 0.72);
  const comps = [];
  const seen = new Set();
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const ids = [];
    const q = [n.id]; seen.add(n.id);
    while (q.length) { const id = q.shift(); ids.push(id); for (const v of adj.get(id) || []) if (!seen.has(v)) { seen.add(v); q.push(v); } }
    comps.push(ids);
  }
  const placeComp = (ids, ccx, ccy, span, a0) => {
    let root = ids[0];
    for (const id of ids) if (degOf(id) > degOf(root)) root = id;
    const depth = new Map([[root, 0]]);
    const order = [root];
    const q = [root];
    while (q.length) { const id = q.shift(); for (const v of adj.get(id) || []) if (!depth.has(v)) { depth.set(v, depth.get(id) + 1); order.push(v); q.push(v); } }
    let maxD = 1;
    for (const id of order) if (depth.get(id) > maxD) maxD = depth.get(id);
    order.forEach((id, k) => {
      const r = depth.get(id) * ringGap;
      const t = order.length > 1 ? k / (order.length - 1) : 0;
      const i = idIndex.get(id);
      if (i == null) return;
      pos[i].x = ccx + Math.cos(a0 + t * span) * r;
      pos[i].y = ccy + Math.sin(a0 + t * span) * r;
    });
    let sx = 0, sy = 0;
    for (const id of ids) { const i = idIndex.get(id); if (i != null) { sx += pos[i].x; sy += pos[i].y; } }
    const k2 = ids.length || 1;
    for (const id of ids) { const i = idIndex.get(id); if (i != null) compCenter[i] = { x: sx / k2, y: sy / k2 }; }
  };
  if (comps.length === 1) {
    placeComp(comps[0], cx, cy, Math.PI * 1.7, -Math.PI * 0.85);
  } else {
    const R = Math.max(420, Math.sqrt(N) * 130);
    let ang = 0;
    for (const ids of comps) {
      const span = (ids.length / N) * Math.PI * 2;
      const mid = ang + span / 2 - Math.PI / 2;
      placeComp(ids, cx + Math.cos(mid) * R, cy + Math.sin(mid) * R, Math.max(span * 0.96, 0.3), ang - Math.PI / 2);
      ang += span;
    }
  }
  // 无边图的兜底：全部落在重心（placeComp 单节点分量已覆盖，这里防 NaN）
  for (let i = 0; i < N; i++) if (!Number.isFinite(pos[i].x)) { pos[i].x = cx; pos[i].y = cy; compCenter[i] = { x: cx, y: cy }; }
  for (let i = 0; i < N; i++) if (!compCenter[i]) compCenter[i] = { x: cx, y: cy };

  // 斥力网格（大规模时把 O(n²) 精确对替换为「3×3 邻域精确对 + 2~3 格环质心聚合斥力」）：
  // 只保留邻域精确对会让远团失去互斥而整体塌缩（实测千节点最小间距压到 9px），
  // 邻域外用格质心近似远距斥力——防塌缩且仍 ~O(n×格数)。
  // 格键用整数编码（(gx+2048)*4096+(gy+2048)）：每步数万次外环查询，字符串拼接键是隐藏大头
  const GRID = 220;
  const KEY_OX = 2048, KEY_SPAN = 4096;
  const cellKey = (x, y) => (Math.floor(x / GRID) + KEY_OX) * KEY_SPAN + (Math.floor(y / GRID) + KEY_OX);
  const gk = (gx, gy) => (gx + KEY_OX) * KEY_SPAN + (gy + KEY_OX);
  const gridded = N > 220;
  const buildGrid = () => {
    const g = new Map();
    for (let i = 0; i < N; i++) {
      const k = cellKey(pos[i].x, pos[i].y);
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(i);
    }
    return g;
  };
  const repel = (i, j) => {
    let dx = pos[j].x - pos[i].x;
    let dy = pos[j].y - pos[i].y;
    let d2 = dx * dx + dy * dy;
    if (d2 < 1) { dx = (Math.random() - .5) * 4; dy = (Math.random() - .5) * 4; d2 = dx * dx + dy * dy; }
    const d = Math.sqrt(d2);
    const f = Math.min(180000 / d2, 40) / d;
    const fx = dx * f, fy = dy * f;
    vel[i].x -= fx; vel[i].y -= fy;
    vel[j].x += fx; vel[j].y += fy;
  };
  // 节点 i 受格 (cx,cy) 质心的聚合斥力（cnt 个节点同距近似）
  let cellMass = null; // key -> {x, y, cnt}：每步建格后预计算（每节点扫 ~40 个外环格，现算质心是 O(N×格×成员) 的隐藏大头）
  const repelCell = (i, gx, gy) => {
    const m = cellMass.get(gk(gx, gy));
    if (!m) return;
    let dx = m.x - pos[i].x, dy = m.y - pos[i].y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1) return;
    const d = Math.sqrt(d2);
    const f = Math.min(180000 * m.cnt / d2, 40 * m.cnt) / d;
    vel[i].x -= dx * f; vel[i].y -= dy * f;
  };

  let stepCount = 0;
  const step = () => {
    stepCount++;
    // 斥力（小图精确 O(n²)；大图 = 邻域精确对 + 外环质心聚合；>2500 heavy 仍整体跳过——
    // 万级节点（尤其无边孤立点）格内密度不可控，钳制语义与旧版一致防卡死）
    if (!heavy && !gridded) {
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) repel(i, j);
      }
    } else if (!heavy) {
      const grid = buildGrid();
      cellMass = new Map();
      for (const [k, arr] of grid) {
        let sx = 0, sy = 0;
        for (const j of arr) { sx += pos[j].x; sy += pos[j].y; }
        cellMass.set(k, { x: sx / arr.length, y: sy / arr.length, cnt: arr.length });
      }
      for (const [k, arr] of grid) {
        const gx = Math.floor(k / KEY_SPAN) - KEY_OX;
        const gy = (k % KEY_SPAN) - KEY_OX;
        for (let a = 0; a < arr.length; a++) {
          const i = arr[a];
          // 邻域 3×3：精确对（前向半空间去重，避免同对重复计力）
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            if (dx > 0 || (dx === 0 && dy > 0)) {
              const nb = grid.get(gk(gx + dx, gy + dy));
              if (nb) for (let b = 0; b < nb.length; b++) repel(i, nb[b]);
            }
          }
          for (let b = a + 1; b < arr.length; b++) repel(i, arr[b]);
          // 2~3 格环：质心聚合斥力（防远团塌缩）
          for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
            if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue;
            repelCell(i, gx + dx, gy + dy);
          }
        }
      }
    }
    // 弹簧（自然长度按链路形态分级）
    for (const l of links) {
      const i = idIndex.get(l.a), j = idIndex.get(l.b);
      if (i == null || j == null) continue;
      let dx = pos[j].x - pos[i].x;
      let dy = pos[j].y - pos[i].y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - (restOf.get(l.id) || restLen)) * 0.018;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      vel[i].x += fx; vel[i].y += fy;
      vel[j].x -= fx; vel[j].y -= fy;
    }
    // 弱重力（各分量回自身重心）
    for (let i = 0; i < N; i++) {
      vel[i].x += (compCenter[i].x - pos[i].x) * 0.004;
      vel[i].y += (compCenter[i].y - pos[i].y) * 0.004;
    }
    // 积分 + 阻尼
    let energy = 0;
    for (let i = 0; i < N; i++) {
      vel[i].x *= 0.84; vel[i].y *= 0.84;
      pos[i].x += vel[i].x;
      pos[i].y += vel[i].y;
      energy += Math.abs(vel[i].x) + Math.abs(vel[i].y);
    }
    // 矩形碰撞分离：每 4 步一次（每步都做在大图上占大头且推不开弹簧回拉），
    // heavy 时跳过；收敛兜底由 layoutNow/runLayout 的收尾强分离负责
    if (!heavy && (stepCount % 4 === 0 || stepCount === 1)) separateRects(pos, nodes, N > 300 ? 3 : 3);
    return energy;
  };

  const apply = () => {
    nodes.forEach((n, i) => {
      n.x = pos[i].x - n.w / 2;
      n.y = pos[i].y - n.h / 2;
    });
  };
  /** 收尾：破挤压僵局（多方密集团内「你推我撞」振荡不收敛）——整体微膨胀放缩后强分离，
   *  最多两轮；网格化分离后即使千节点也很便宜。最终零重叠由此保证 */
  const finish = () => {
    if (!heavy) {
      for (let round = 0; round < 2; round++) {
        separateRects(pos, nodes, 30);
        if (!hasOverlap()) break;
        let mx = 0, my = 0;
        for (const p of pos) { mx += p.x; my += p.y; }
        mx /= N; my /= N;
        for (const p of pos) { p.x = mx + (p.x - mx) * 1.06; p.y = my + (p.y - my) * 1.06; }
      }
      separateRects(pos, nodes, 30);
    }
    apply();
  };
  const hasOverlap = () => {
    for (let i = 0; i < N; i += 2) { // 抽样步长 2：收尾判定用（全量清理由分离趟内 any 承担）
      const a = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        if (Math.abs(pos[i].x - pos[j].x) < (a.w + b.w) / 2 && Math.abs(pos[i].y - pos[j].y) < (a.h + b.h) / 2) return true;
      }
    }
    return false;
  };

  return { step, apply, finish, steps, energy: () => vel.reduce((s, v) => s + Math.abs(v.x) + Math.abs(v.y), 0) };
}

/* 运行布局动画。返回 Promise；onFrame 每帧回调（用于重绘）。
 * 大图每帧多跑几步（单步已网格化、毫秒级）：墙钟时间从「分钟级动画」压到秒级收敛。 */
function runLayout(nodes, links, onFrame, opts) {
  opts = opts || {};
  const sim = simulate(nodes, links, opts);
  if (!sim) return Promise.resolve();
  return new Promise((resolve) => {
    let i = 0;
    // 大图单步毫秒级仍重于普通帧预算：帧步数封顶 24，动画墙钟 ~2-4s 内收敛（旧版分钟级）
    const spf = opts.stepsPerFrame || Math.max(12, Math.min(24, Math.round(nodes.length / 40)));
    const frame = () => {
      if (opts.cancel && opts.cancel()) { sim.finish(); resolve(); return; }
      let energy = 0;
      for (let k = 0; k < spf; k++) {
        energy = sim.step();
        i++;
        if (i >= sim.steps || energy < 0.06) break;
      }
      sim.apply();
      if (onFrame) onFrame();
      if (i >= sim.steps || energy < 0.06) { sim.finish(); resolve(); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/* 矩形碰撞分离：沿最小穿透轴推开重叠的节点（迭代收敛）。
 * pos 为中心坐标数组（与节点一一对应），nodes 仅提供尺寸；结果写回 pos。
 * passes：大图留更多收敛趟数（千节点实测 3 趟后仍可残留个位数重叠）。
 * N>300 时对枚举走网格（重叠对必然互为近邻，扫全对 O(n²) 在千节点级是布局耗时主体）。 */
function separateRects(pos, nodes, passes) {
  const N = nodes.length;
  const MAX_PASS = passes || 3;
  const CELL = 220;
  const push = (i, j) => {
    const a = nodes[i], b = nodes[j];
    const dx = pos[j].x - pos[i].x;
    const dy = pos[j].y - pos[i].y;
    const ox = (a.w + b.w) / 2 - Math.abs(dx);
    const oy = (a.h + b.h) / 2 - Math.abs(dy);
    if (ox <= 0 || oy <= 0) return false;
    if (ox < oy) {
      const s = (dx >= 0 ? 1 : -1) * (ox / 2 + 1);
      pos[i].x -= s; pos[j].x += s;
    } else {
      const s = (dy >= 0 ? 1 : -1) * (oy / 2 + 1);
      pos[i].y -= s; pos[j].y += s;
    }
    return true;
  };
  if (N <= 300) {
    for (let pass = 0; pass < MAX_PASS; pass++) {
      let any = false;
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) if (push(i, j)) any = true;
      }
      if (!any) break;
    }
    return;
  }
  // 网格版：趟内用静态格快照（单趟推开位移远小于格宽，跨格漂移下趟自然校正）
  for (let pass = 0; pass < MAX_PASS; pass++) {
    const grid = new Map();
    const key = (x, y) => Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
    for (let i = 0; i < N; i++) {
      const k = key(pos[i].x, pos[i].y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    let any = false;
    for (const [k, arr] of grid) {
      const cxy = k.split(',');
      const gx = +cxy[0], gy = +cxy[1];
      for (let a = 0; a < arr.length; a++) {
        const i = arr[a];
        for (let b = a + 1; b < arr.length; b++) if (push(i, arr[b])) any = true;
        // 近邻格对：前向半空间去重（dx>0 或 dx=0,dy>0），反向由对方格遍历时补齐
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (dx > 0 || (dx === 0 && dy > 0)) {
            const nb = grid.get((gx + dx) + ',' + (gy + dy));
            if (nb) for (let b = 0; b < nb.length; b++) if (push(i, nb[b])) any = true;
          }
        }
      }
    }
    if (!any) break;
  }
}

/* 立即布局（无动画，供 Node 测试 / 快速摆放） */
function layoutNow(nodes, links, steps) {
  const sim = simulate(nodes, links, { steps: steps || 320 });
  if (!sim) return;
  for (let i = 0; i < sim.steps; i++) {
    if (sim.step() < 0.06) break;
  }
  sim.finish();
}

/* ---------- 布局预设（直接设置节点 x/y） ---------- */
function ringLayout(nodes, opts) {
  opts = opts || {};
  const n = nodes.length;
  if (!n) return;
  const R = opts.radius || Math.max(280, Math.sqrt(n) * 150);
  const sorted = [...nodes].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  const cx = opts.cx != null ? opts.cx : 0, cy = opts.cy != null ? opts.cy : 0;
  sorted.forEach((nd, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    nd.x = cx + Math.cos(ang) * R - nd.w / 2;
    nd.y = cy + Math.sin(ang) * R - nd.h / 2;
  });
}

function gridLayout(nodes, opts) {
  opts = opts || {};
  const n = nodes.length;
  if (!n) return;
  const cols = opts.cols || Math.ceil(Math.sqrt(n));
  const gap = opts.gap != null ? opts.gap : 60;
  const sorted = [...nodes].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  const cellW = maxOf(nodes, x => x.w) + gap;
  const cellH = maxOf(nodes, x => x.h) + gap;
  const cx0 = opts.cx != null ? opts.cx - ((cols - 1) * cellW) / 2 : 0;
  const cy0 = opts.cy != null ? opts.cy - (Math.ceil(n / cols) - 1) * cellH / 2 : 0;
  sorted.forEach((nd, i) => {
    nd.x = cx0 + (i % cols) * cellW;
    nd.y = cy0 + Math.floor(i / cols) * cellH;
  });
}

const TYPE_ORDER = ['router', 'switch', 'firewall', 'server', 'pc', 'cloud', 'other'];
function layerLayout(nodes, opts) {
  opts = opts || {};
  const n = nodes.length;
  if (!n) return;
  const gap = opts.gap != null ? opts.gap : 70;
  const groups = new Map();
  for (const nd of nodes) {
    const t = nd.type && TYPE_ORDER.includes(nd.type) ? nd.type : 'other';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(nd);
  }
  const cx = opts.cx != null ? opts.cx : 0;
  const cy0 = opts.cy != null ? opts.cy : 0;
  const cellH = maxOf(nodes, x => x.h) + gap;
  let row = 0;
  for (const type of TYPE_ORDER) {
    const list = (groups.get(type) || []).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    if (!list.length) continue;
    const cellW = maxOf(list, x => x.w) + gap;
    const totalW = (list.length - 1) * cellW;
    list.forEach((nd, i) => {
      nd.x = cx - totalW / 2 + i * cellW;
      nd.y = cy0 + row * cellH;
    });
    row++;
  }
}

/* 三层架构布局：核心层（路由/云）→ 汇聚层（交换/防火墙）→ 接入层（服务器/终端） */
function tierLayout(nodes, opts) {
  opts = opts || {};
  const n = nodes.length;
  if (!n) return;
  const gap = opts.gap != null ? opts.gap : 90;
  const tiers = [
    { name: '核心层', types: ['router', 'cloud'] },
    { name: '汇聚层', types: ['switch', 'firewall'] },
    { name: '接入层', types: ['server', 'pc', 'other'] }
  ];
  const cx = opts.cx != null ? opts.cx : 0;
  const cy0 = opts.cy != null ? opts.cy : 0;
  const cellH = maxOf(nodes, x => x.h) + gap;
  let row = 0;
  for (const t of tiers) {
    // 自定义类型（不在内置 TYPE_ORDER 内）回退归入接入层：否则这些节点不进任何层，
    // 布局后原地不动，与已移动节点错乱重叠（layerLayout 的 'other' 回退同口径）
    const list = nodes
      .filter(nd => t.types.includes(nd.type) || (t.name === '接入层' && !TYPE_ORDER.includes(nd.type)))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    if (!list.length) continue;
    const cellW = maxOf(list, x => x.w) + gap;
    const totalW = (list.length - 1) * cellW;
    list.forEach((nd, i) => {
      nd.x = cx - totalW / 2 + i * cellW;
      nd.y = cy0 + row * cellH;
    });
    row++;
  }
}

/* 拓扑分层布局（Sugiyama 简化版）：BFS 分层 + 重心排序，显著减少连线交叉。
 * 保持各连通分量原有中心，只调整分量内部结构；完成后自动做碰撞分离。 */
function layerTopoLayout(nodes, links, opts) {
  opts = opts || {};
  const n = nodes.length;
  if (!n) return;
  const gapX = opts.gapX != null ? opts.gapX : 300;
  const gapY = opts.gapY != null ? opts.gapY : 170;
  const byId = new Map(nodes.map(nd => [nd.id, nd]));
  const adj = new Map();
  for (const nd of nodes) adj.set(nd.id, []);
  for (const l of links) {
    if (adj.has(l.a)) adj.get(l.a).push(l.b);
    if (adj.has(l.b)) adj.get(l.b).push(l.a);
  }
  for (const [k, v] of adj) adj.set(k, [...new Set(v)]);

  // 连通分量
  const comps = [];
  const seen = new Set();
  for (const nd of nodes) {
    if (seen.has(nd.id)) continue;
    const comp = [];
    const q = [nd.id]; seen.add(nd.id);
    while (q.length) {
      const id = q.shift(); comp.push(id);
      for (const v of adj.get(id) || []) if (!seen.has(v)) { seen.add(v); q.push(v); }
    }
    comps.push(comp);
  }

  const centerOf = (ids) => {
    let sx = 0, sy = 0;
    for (const id of ids) { const nd = byId.get(id); if (nd) { sx += nd.x + nd.w / 2; sy += nd.y + nd.h / 2; } }
    const k = ids.length || 1;
    return { x: sx / k, y: sy / k };
  };

  for (const comp of comps) {
    if (comp.length === 1) continue;
    const cc = centerOf(comp);
    // 根 = 度最大的节点
    let root = comp[0];
    for (const id of comp) if ((adj.get(id) || []).length > (adj.get(root) || []).length) root = id;
    // BFS 分层
    const layer = new Map([[root, 0]]);
    const q = [root];
    while (q.length) {
      const id = q.shift();
      for (const v of adj.get(id) || []) if (!layer.has(v)) { layer.set(v, layer.get(id) + 1); q.push(v); }
    }
    const layers = [];
    for (const id of comp) {
      const L = layer.get(id) || 0;
      if (!layers[L]) layers[L] = [];
      layers[L].push(id);
    }
    // 重心排序：按相邻层邻居序号均值排序，迭代收敛减少交叉
    const order = layers.map(arr => [...arr]);
    const idx = new Map();
    order.forEach((arr, L) => arr.forEach((id, i) => idx.set(id, { L, i })));
    const bary = (id, L) => {
      const ns = (adj.get(id) || []).filter(v => layer.has(v) && layer.get(v) !== L);
      if (!ns.length) return 0;
      let s = 0;
      for (const v of ns) { const r = idx.get(v); if (r) s += r.i; }
      return s / ns.length;
    };
    for (let iter = 0; iter < 6; iter++) {
      for (let L = 0; L < order.length; L++) {
        order[L].sort((a, b) => bary(a, L) - bary(b, L));
        order[L].forEach((id, i) => { idx.get(id).i = i; });
      }
    }
    // 摆放：层 = 列（x），层内按顺序上下排布（y），以连通分量原中心为基准
    order.forEach((arr, L) => {
      const x = cc.x + (L - (order.length - 1) / 2) * gapX;
      arr.forEach((id, i) => {
        const nd = byId.get(id);
        if (!nd) return;
        nd.x = x - nd.w / 2;
        nd.y = cc.y + (i - (arr.length - 1) / 2) * gapY - nd.h / 2;
      });
    });
  }

  // 碰撞分离（防止层内/层间节点重叠）；大图钳制与 simulate/separateOverlaps 同口径（2500）——
  // O(n²)×3 的分离在数万节点工程上会冻结渲染主线程数十秒
  if (nodes.length <= 2500) {
    const pos = nodes.map(nd => ({ x: nd.x + nd.w / 2, y: nd.y + nd.h / 2 }));
    separateRects(pos, nodes);
    nodes.forEach((nd, i) => { nd.x = pos[i].x - nd.w / 2; nd.y = pos[i].y - nd.h / 2; });
  }
}

/* 仅推开重叠节点（不改整体布局）：工程 / 部分坐标表格 / 邻居表导入等加载路径的防重合兜底。
 * 已分离的布局为 no-op（坐标不变）。原地修改 nodes 的 x/y，返回 nodes。 */
function separateOverlaps(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 2) return nodes;
  // 大图钳制（与 simulate 的 heavy 阈值同口径）：O(n²) 三趟分离在超大工程下会阻塞加载线程，跳过
  if (nodes.length > 2500) return nodes;
  const pos = nodes.map(nd => ({ x: nd.x + nd.w / 2, y: nd.y + nd.h / 2 }));
  separateRects(pos, nodes);
  nodes.forEach((nd, i) => { nd.x = pos[i].x - nd.w / 2; nd.y = pos[i].y - nd.h / 2; });
  return nodes;
}

global.TopoLayout = { simulate, runLayout, layoutNow, ringLayout, gridLayout, layerLayout, tierLayout, layerTopoLayout, separateRects, separateOverlaps };
})(typeof globalThis !== 'undefined' ? globalThis : this);
