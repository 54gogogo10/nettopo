/* ============================================================
 * NetTopo layout.js —— 力导向自动布局（rAF 动画，可在 Node 中单步测试）
 * ============================================================ */
(function (global) {
'use strict';

/* 力导向模拟：斥力 + 弹簧 + 弱重力，返回每一步的节点位置回调。
 * opts: { steps=520, stepsPerFrame=12, restLen=300, cancel:()=>bool }
 */
function simulate(nodes, links, opts) {
  opts = opts || {};
  const steps = opts.steps || 520;
  const restLen = opts.restLen || 360;

  const N = nodes.length;
  if (N === 0) return null;
  const pos = nodes.map(n => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 }));
  const vel = nodes.map(() => ({ x: 0, y: 0 }));

  // 邻接表
  const adj = new Map();
  for (const l of links) {
    if (!adj.has(l.a)) adj.set(l.a, []);
    if (!adj.has(l.b)) adj.set(l.b, []);
    adj.get(l.a).push(l.b);
    adj.get(l.b).push(l.a);
  }

  // 初始：圆环分布（避免初始重叠）
  const cx = pos.reduce((s, p) => s + p.x, 0) / N;
  const cy = pos.reduce((s, p) => s + p.y, 0) / N;
  const R = Math.max(260, Math.sqrt(N) * 150);
  pos.forEach((p, i) => {
    const ang = (i / N) * Math.PI * 2;
    p.x = cx + Math.cos(ang) * R;
    p.y = cy + Math.sin(ang) * R;
  });

  const idIndex = new Map();
  nodes.forEach((n, i) => idIndex.set(n.id, i));

  const step = () => {
    // 斥力（O(n²)，节点数通常 < 200）
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let dx = pos[j].x - pos[i].x;
        let dy = pos[j].y - pos[i].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (Math.random() - .5) * 4; dy = (Math.random() - .5) * 4; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const f = Math.min(180000 / d2, 40) / d;
        const fx = dx * f, fy = dy * f;
        vel[i].x -= fx; vel[i].y -= fy;
        vel[j].x += fx; vel[j].y += fy;
      }
    }
    // 弹簧
    for (const l of links) {
      const i = idIndex.get(l.a), j = idIndex.get(l.b);
      if (i == null || j == null) continue;
      let dx = pos[j].x - pos[i].x;
      let dy = pos[j].y - pos[i].y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - restLen) * 0.018;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      vel[i].x += fx; vel[i].y += fy;
      vel[j].x -= fx; vel[j].y -= fy;
    }
    // 弱重力（回中）
    for (let i = 0; i < N; i++) {
      vel[i].x += (cx - pos[i].x) * 0.004;
      vel[i].y += (cy - pos[i].y) * 0.004;
    }
    // 积分 + 阻尼
    let energy = 0;
    for (let i = 0; i < N; i++) {
      vel[i].x *= 0.84; vel[i].y *= 0.84;
      pos[i].x += vel[i].x;
      pos[i].y += vel[i].y;
      energy += Math.abs(vel[i].x) + Math.abs(vel[i].y);
    }
    // 矩形碰撞分离：保证节点之间绝不遮挡
    separateRects(pos, nodes);
    return energy;
  };

  const apply = () => {
    nodes.forEach((n, i) => {
      n.x = pos[i].x - n.w / 2;
      n.y = pos[i].y - n.h / 2;
    });
  };

  return { step, apply, steps, energy: () => vel.reduce((s, v) => s + Math.abs(v.x) + Math.abs(v.y), 0) };
}

/* 运行布局动画。返回 Promise；onFrame 每帧回调（用于重绘）。 */
function runLayout(nodes, links, onFrame, opts) {
  opts = opts || {};
  const sim = simulate(nodes, links, opts);
  if (!sim) return Promise.resolve();
  return new Promise((resolve) => {
    let i = 0;
    const spf = opts.stepsPerFrame || 12;
    const frame = () => {
      if (opts.cancel && opts.cancel()) { resolve(); return; }
      let energy = 0;
      for (let k = 0; k < spf; k++) {
        energy = sim.step();
        i++;
        if (i >= sim.steps || energy < 0.06) break;
      }
      sim.apply();
      if (onFrame) onFrame();
      if (i >= sim.steps || energy < 0.06) { resolve(); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/* 矩形碰撞分离：沿最小穿透轴推开重叠的节点（迭代收敛） */
function separateRects(pos, nodes) {
  const N = nodes.length;
  for (let pass = 0; pass < 3; pass++) {
    let any = false;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const ox = (a.w + b.w) / 2 - Math.abs(dx);
        const oy = (a.h + b.h) / 2 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        any = true;
        if (ox < oy) {
          const s = (dx >= 0 ? 1 : -1) * (ox / 2 + 1);
          pos[i].x -= s; pos[j].x += s;
        } else {
          const s = (dy >= 0 ? 1 : -1) * (oy / 2 + 1);
          pos[i].y -= s; pos[j].y += s;
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
  sim.apply();
}

global.TopoLayout = { simulate, runLayout, layoutNow };
})(typeof globalThis !== 'undefined' ? globalThis : this);
