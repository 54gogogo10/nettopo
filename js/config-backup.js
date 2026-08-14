/* NetTopo 设备配置备份库 —— 定时抓取的设备 running-config 本地存储（主进程，纯 Node，不依赖 Electron）
 * 由 electron-main.js 通过 IPC 桥接给渲染层；也可在 Node 测试中直接使用。
 *
 * 设计：
 * - 目录结构：<baseDir>/<设备名>/<主机>/cfg_YYYYMMDD_HHMMSS.cfg
 * - 每台设备(主机)保留最近 MAX_KEEP 份，超限滚动清理。
 * - 文件名/路径全部严格白名单校验，杜绝路径穿越。
 * - 提供行级 diff（公共前后缀 + LCS），供界面对比两次备份。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_KEEP = 50;                          // 每台设备保留份数上限
const MAX_BYTES = 8 * 1024 * 1024;            // 单份配置上限 8MB
const NAME_RE = /^cfg_\d{8}_\d{6}(?:_\d+)?\.cfg$/;

/** 文件名/目录名安全化（与 monitor.js 一致） */
function sanitizeFilename(s) {
  let out = String(s == null ? '' : s);
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  if (!out) out = 'device';
  if (out.length > 60) out = out.slice(0, 60);
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
function ts(d) {
  d = d || new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
    + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

class ConfigBackupStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  _hostDir(device, host) {
    return path.join(this.baseDir, sanitizeFilename(device), sanitizeFilename(host));
  }

  static validName(name) {
    return NAME_RE.test(String(name || ''));
  }

  /** 保存一份配置备份。返回 {ok:true, name, first, prev} 或 {ok:false, error}
   *  first: 是否该设备(主机)的第一份备份；prev: 上一次备份文件名（无则 null） */
  save(device, host, content) {
    content = String(content == null ? '' : content);
    if (!content.trim()) return { ok: false, error: '备份内容为空' };
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) return { ok: false, error: '备份内容过大（超过 8MB）' };
    const dir = this._hostDir(device, host);
    let tmpPath = '';
    try {
      fs.mkdirSync(dir, { recursive: true });
      const prevBefore = this.latest(device, host); // 写入前的最近一份（用于 diff 与 first 判定）
      let name = 'cfg_' + ts() + '.cfg';
      let seq = 0;
      while (fs.existsSync(path.join(dir, name))) {
        seq++;
        name = 'cfg_' + ts() + '_' + seq + '.cfg';
      }
      tmpPath = path.join(dir, name + '.tmp-' + process.pid);
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, path.join(dir, name));
      this._trim(device, host);
      return { ok: true, name, first: !prevBefore, prev: prevBefore };
    } catch (err) {
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ } }
      return { ok: false, error: '备份写入失败：' + ((err && err.message) || err) };
    }
  }

  /** 列出某设备(主机)的全部备份（时间倒序） */
  list(device, host) {
    const dir = this._hostDir(device, host);
    const items = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    for (const name of names) {
      if (!ConfigBackupStore.validName(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(full); } catch (e) { continue; }
      if (!st.isFile() || st.isSymbolicLink()) continue;
      items.push({ name, time: st.mtimeMs, size: st.size });
    }
    items.sort((a, b) => (b.time - a.time) || (a.name < b.name ? 1 : -1));
    return { ok: true, items };
  }

  /** 读取一份备份内容 */
  read(device, host, name) {
    if (!ConfigBackupStore.validName(name)) return { ok: false, error: '非法的备份文件名' };
    const full = path.join(this._hostDir(device, host), name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) return { ok: false, error: '备份不存在或读取失败' };
      if (st.size > MAX_BYTES) return { ok: false, error: '备份文件过大' };
      return { ok: true, content: fs.readFileSync(full, 'utf8') };
    } catch (err) {
      return { ok: false, error: '备份不存在或读取失败' };
    }
  }

  /** 删除一份备份 */
  remove(device, host, name) {
    if (!ConfigBackupStore.validName(name)) return { ok: false, error: '非法的备份文件名' };
    try {
      fs.unlinkSync(path.join(this._hostDir(device, host), name));
      return { ok: true, removed: 1 };
    } catch (err) {
      return { ok: false, error: '备份不存在' };
    }
  }

  /** 最近一份备份文件名（无则 null） */
  latest(device, host) {
    const items = this.list(device, host).items || [];
    return items.length ? items[0].name : null;
  }

  /** 汇总全部有备份的设备(主机) */
  hosts() {
    const out = [];
    let devNames = [];
    try { devNames = fs.readdirSync(this.baseDir); } catch (e) { devNames = []; }
    for (const dev of devNames) {
      const devDir = path.join(this.baseDir, dev);
      let st;
      try { st = fs.lstatSync(devDir); } catch (e) { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      let hosts = [];
      try { hosts = fs.readdirSync(devDir); } catch (e) { hosts = []; }
      for (const h of hosts) {
        const hDir = path.join(devDir, h);
        try { st = fs.lstatSync(hDir); } catch (e) { continue; }
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        const items = this.list(dev, h).items || [];
        if (items.length) out.push({ device: dev, host: h, count: items.length, lastAt: items[0].time, last: items[0].name });
      }
    }
    out.sort((a, b) => (b.lastAt - a.lastAt) || (a.device < b.device ? -1 : 1));
    return { ok: true, items: out };
  }

  /** 对比两份备份，返回 {ok, added, removed, changed, hunks}
   *  hunks: [{type:'ctx'|'change', lines:[{type:'ctx'|'del'|'add', aNo, bNo, text}]}] */
  diff(device, host, nameA, nameB) {
    const ra = this.read(device, host, nameA);
    const rb = this.read(device, host, nameB);
    if (!ra.ok || !rb.ok) return { ok: false, error: '读取备份失败：' + ((ra.error || rb.error) || '') };
    return ConfigBackupStore.diffLines(ra.content, rb.content);
  }

  /** 文本行 diff：a 为旧文本，b 为新文本（a→b：add 为新出现行，del 为被删除行） */
  static diffLines(aText, bText) {
    const a = String(aText == null ? '' : aText).replace(/\r\n/g, '\n').split('\n');
    const b = String(bText == null ? '' : bText).replace(/\r\n/g, '\n').split('\n');
    if (!a.length && !b.length) return { ok: true, added: 0, removed: 0, changed: false, hunks: [] };
    if (!a.length) {
      return { ok: true, added: b.length, removed: 0, changed: true,
        hunks: [{ type: 'change', lines: b.map((t, i) => ({ type: 'add', bNo: i + 1, text: t })) }] };
    }
    if (!b.length) {
      return { ok: true, added: 0, removed: a.length, changed: true,
        hunks: [{ type: 'change', lines: a.map((t, i) => ({ type: 'del', aNo: i + 1, text: t })) }] };
    }
    // 公共前缀/后缀裁剪，中间做 LCS（计算量超限退化为整段删+增）
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const am = a.slice(pre, a.length - suf);
    const bm = b.slice(pre, b.length - suf);
    if (!am.length && !bm.length) {
      return { ok: true, added: 0, removed: 0, changed: false,
        hunks: [{ type: 'ctx', lines: a.map((t, i) => ({ type: 'ctx', aNo: i + 1, bNo: i + 1, text: t })) }] };
    }
    const n = am.length, m = bm.length;
    let delIdx = [], addIdx = [];
    if (n * m <= 4 * 1000 * 1000) {
      const dp = new Uint32Array((n + 1) * (m + 1));
      for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
          dp[i * (m + 1) + j] = am[i - 1] === bm[j - 1]
            ? dp[(i - 1) * (m + 1) + (j - 1)] + 1
            : Math.max(dp[(i - 1) * (m + 1) + j], dp[i * (m + 1) + (j - 1)]);
        }
      }
      let i = n, j = m;
      const del = [], add = [];
      while (i > 0 && j > 0) {
        if (am[i - 1] === bm[j - 1]) { i--; j--; }
        else if (dp[(i - 1) * (m + 1) + j] >= dp[i * (m + 1) + (j - 1)]) { del.push(i - 1); i--; }
        else { add.push(j - 1); j--; }
      }
      while (i > 0) { del.push(i - 1); i--; }
      while (j > 0) { add.push(j - 1); j--; }
      del.reverse(); add.reverse();
      delIdx = del; addIdx = add;
    } else {
      delIdx = am.map((_, i) => i);
      addIdx = bm.map((_, j) => j);
    }
    const delSet = new Set(delIdx), addSet = new Set(addIdx);
    const hunks = [];
    const emitRun = () => {
      let i = 0, j = 0;
      while (i < n || j < m) {
        const isDel = i < n && delSet.has(i);
        const isAdd = j < m && addSet.has(j);
        if (isDel || isAdd) {
          const grp = [];
          while (i < n && delSet.has(i)) { grp.push({ type: 'del', aNo: pre + i + 1, text: am[i] }); i++; }
          while (j < m && addSet.has(j)) { grp.push({ type: 'add', bNo: pre + j + 1, text: bm[j] }); j++; }
          hunks.push({ type: 'change', lines: grp });
          continue;
        }
        const run = [];
        while (i < n && j < m && !delSet.has(i) && !addSet.has(j)) {
          run.push({ type: 'ctx', aNo: pre + i + 1, bNo: pre + j + 1, text: am[i] });
          i++; j++;
        }
        if (run.length) hunks.push({ type: 'ctx', lines: run });
      }
    };
    emitRun();
    let added = 0, removed = 0;
    for (const h of hunks) for (const ln of h.lines) {
      if (ln.type === 'add') added++;
      else if (ln.type === 'del') removed++;
    }
    return { ok: true, added, removed, changed: added + removed > 0, hunks };
  }

  /** 滚动清理：每台设备仅保留最新 keep 份 */
  _trim(device, host, keep) {
    keep = Math.floor(Number(keep));
    if (!(keep >= 1)) keep = MAX_KEEP;
    keep = Math.min(keep, MAX_KEEP);
    const items = this.list(device, host).items || [];
    for (const it of items.slice(keep)) {
      try { fs.unlinkSync(path.join(this._hostDir(device, host), it.name)); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { ConfigBackupStore, MAX_KEEP, MAX_BYTES };
