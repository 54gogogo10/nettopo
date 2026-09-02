/* NetTopo 正则安全执行器 —— 主进程纯 Node 模块（不依赖 Electron）
 * 背景：告警关键字/合规规则是用户可配置的正则，文本来自不可信的设备输出。V8 正则引擎无
 * 内置超时，灾难性回溯（如 (a?)+x 对长 aa… 串）会在主进程同步执行中永久挂起事件循环。
 * 方案：把正则执行放进工作线程（js/regex-lab-worker.js），主进程以超时兜底：
 *   - 超时 → 终止工作线程（主进程事件循环无感）、拉黑该模式（本轮及之后一律不命中）、
 *     按每个 item 的 begin 报号定位元凶后重启线程续跑剩余项；
 *   - 静态启发式（monitor.js 编译期）只是第一道过滤，本模块是运行时兜底，二者缺一不可。
 * 每次执行拉起独立线程、用完即弃：无并发状态机，失败路径简单可控。
 * 可在 Node 测试中直接使用。
 */
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_TIMEOUT_MS = 5000;

class RegexLab {
  constructor(opts) {
    opts = opts || {};
    this.timeoutMs = Math.max(200, Math.floor(opts.timeoutMs || DEFAULT_TIMEOUT_MS));
    this.blocked = new Set(); // 被超时处决的模式（永久拉黑：进程内不再执行）
  }

  isBlocked(pattern) { return this.blocked.has(String(pattern)); }

  /**
   * 执行一批正则。items: [{ pattern, flags?, op:'test'|'scan', text?, lines?, maxHits? }]
   * 返回与 items 等长的结果数组：
   *   test → { ok, hit:boolean, line:string|null }
   *   scan → { ok, hits:number[] }
   *   被拉黑/线程失败 → { ok:false, blocked:true, hit:false, hits:[] }
   * 单个模式超时只拉黑该模式，其余结果仍然返回。
   */
  async run(items, timeoutMs) {
    const list = Array.isArray(items) ? items : [];
    const out = list.map(() => ({ ok: false, blocked: false, hit: false, line: null, hits: [] }));
    // 已拉黑模式直接标记，不进线程
    let remaining = [];
    list.forEach((it, i) => {
      if (it && this.isBlocked(it.pattern)) out[i].blocked = true;
      else remaining.push(i);
    });
    const budget = Math.max(200, Math.floor(timeoutMs || this.timeoutMs));
    // 超时会逐个淘汰元凶；最多淘汰 remaining.length 轮
    for (let guard = 0; guard <= remaining.length && remaining.length; guard++) {
      const res = await this._runOnce(remaining.map(i => list[i]), budget);
      if (!res) break; // 线程异常启动等致命错误：剩余项按失败处理
      const nextRemaining = [];
      for (let k = 0; k < remaining.length; k++) {
        const outIdx = remaining[k];
        const r = res.results[k];
        if (r) {
          out[outIdx] = { ok: true, blocked: false, hit: !!r.hit, line: r.line || null, hits: r.hits || [] };
        } else if (k === res.badIndex) {
          // 该项执行超时被处决：拉黑并标记
          this.blocked.add(String(list[outIdx].pattern));
          out[outIdx] = { ok: false, blocked: true, hit: false, line: null, hits: [] };
        } else {
          nextRemaining.push(outIdx); // 元凶之前的项没跑到：重试
        }
      }
      remaining = nextRemaining;
      if (!res.timedOut) {
        // 正常完成但可能仍有失败项（如正则构造失败）：不再重试，按失败标记
        for (const outIdx of remaining) out[outIdx] = { ok: false, blocked: false, hit: false, line: null, hits: [] };
        remaining = [];
      }
    }
    return out;
  }

  /** 拉起一个工作线程跑一批 items；返回 { results, badIndex, timedOut } 或 null（线程启动失败）。
   *  results 与入参等长，未执行到的项为 undefined；badIndex 为超时时正在执行的下标。 */
  _runOnce(items, budget) {
    return new Promise((resolve) => {
      let worker = null;
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
        resolve(val);
      };
      const timer = setTimeout(() => finish({ results: [], badIndex: this._curIndex, timedOut: true }), budget);
      try {
        worker = new Worker(path.join(__dirname, 'regex-lab-worker.js'));
      } catch (e) { finish(null); return; }
      let id = 0;
      worker.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'begin' && msg.id === id) this._curIndex = msg.index;
        else if (msg.type === 'done' && msg.id === id) {
          const results = Array.isArray(msg.results) ? msg.results : [];
          finish({ results, badIndex: -1, timedOut: false });
        }
      });
      worker.on('error', () => finish(null));
      worker.on('exit', () => { /* terminate/正常退出都经由 finish 收尾 */ });
      id++;
      worker.postMessage({ id, items });
    });
  }

  dispose() { /* 每次执行线程即弃，无需清理 */ }
}

module.exports = { RegexLab };
