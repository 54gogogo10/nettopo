/* NetTopo 备份库 —— 工程 .nettopo 备份的本地存储管理（主进程，纯 Node，不依赖 Electron）
 * 由 electron-main.js 通过 IPC 桥接给渲染层；也可在 Node 测试中直接使用。
 *
 * 设计：
 * - 所有备份保存在单一目录（桌面版为用户数据目录 backups/），文件名 自动备份_YYYYMMDD_HHMMSS.nettopo
 *   或 备份_YYYYMMDD_HHMMSS.nettopo（手动备份）。
 * - 每次保存后按「保留最近 N 份」滚动清理最旧的备份。
 * - 所有读取/删除操作都严格校验文件名，杜绝路径穿越。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_CONTENT_BYTES = 64 * 1024 * 1024;   // 单份备份内容上限 64MB（含自定义设备图片）
const MAX_KEEP = 200;                          // 保留份数上限
const SAFE_NAME = /^[\u4e00-\u9fa5A-Za-z0-9_.-]+\.nettopo$/;

class BackupStore {
  constructor(dir, opts) {
    opts = opts || {};
    this.dir = dir;
    this.maxBytes = opts.maxBytes || MAX_CONTENT_BYTES; // 单份内容上限（测试可调小）
  }

  /** 文件名白名单校验：格式合法且不含路径成分 */
  static validName(name) {
    name = String(name || '');
    if (!SAFE_NAME.test(name)) return false;
    if (name.includes('..')) return false;
    return path.basename(name) === name;
  }

  _ts() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** 保存一份备份。label: 'auto'|'manual'；keep: 保留最近 N 份（1..MAX_KEEP）。
   *  返回 {ok:true, name, count} 或 {ok:false, error} */
  save(content, label, keep) {
    content = String(content == null ? '' : content);
    if (!content.trim()) return { ok: false, error: '备份内容为空' };
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) return { ok: false, error: '备份内容过大（超过 64MB）' };
    const prefix = label === 'auto' ? '自动备份_' : '备份_';
    let n = Math.floor(Number(keep));
    if (!(n >= 1)) n = 30;
    n = Math.min(n, MAX_KEEP);
    let tmpPath = '';
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // 同秒多次备份时追加序号，避免覆盖
      let name = `${prefix}${this._ts()}.nettopo`;
      let seq = 0;
      while (fs.existsSync(path.join(this.dir, name))) {
        seq++;
        name = `${prefix}${this._ts()}_${seq}.nettopo`;
      }
      tmpPath = path.join(this.dir, name + '.tmp-' + process.pid);
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, path.join(this.dir, name));
      this._trim(n);
      return { ok: true, name, count: this._countFiles() };
    } catch (err) {
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ } }
      return { ok: false, error: '备份写入失败：' + (err && err.message || err) };
    }
  }

  /** 列出全部备份（时间倒序）。返回 {ok:true, items:[{name,time,size}]} */
  list() {
    try {
      const items = [];
      let names = [];
      try { names = fs.readdirSync(this.dir); } catch (e) { names = []; }
      for (const name of names) {
        if (!BackupStore.validName(name)) continue;
        const full = path.join(this.dir, name);
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (!st.isFile()) continue;
        items.push({ name, time: st.mtimeMs, size: st.size });
      }
      items.sort((a, b) => (b.time - a.time) || (a.name < b.name ? 1 : -1));
      return { ok: true, items };
    } catch (err) {
      return { ok: false, error: '读取备份列表失败：' + (err && err.message || err) };
    }
  }

  /** 读取一份备份内容。返回 {ok:true, content} */
  read(name) {
    if (!BackupStore.validName(name)) return { ok: false, error: '非法的备份文件名' };
    const full = path.join(this.dir, name);
    try {
      const st = fs.statSync(full);
      if (st.size > this.maxBytes) return { ok: false, error: '备份文件过大' };
      const content = fs.readFileSync(full, 'utf8');
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: '备份不存在或读取失败' };
    }
  }

  /** 删除一份备份 */
  remove(name) {
    if (!BackupStore.validName(name)) return { ok: false, error: '非法的备份文件名' };
    const full = path.join(this.dir, name);
    try {
      fs.unlinkSync(full);
      return { ok: true, removed: 1 };
    } catch (err) {
      return { ok: false, error: '备份不存在' };
    }
  }

  /** 清空全部备份 */
  removeAll() {
    let removed = 0;
    const names = this.list().items || [];
    for (const it of names) {
      try { fs.unlinkSync(path.join(this.dir, it.name)); removed++; } catch (e) { /* ignore */ }
    }
    return { ok: true, removed };
  }

  /** 滚动清理：仅保留最新的 keep 份（按修改时间倒序） */
  _trim(keep) {
    const items = this.list().items || [];
    for (const it of items.slice(keep)) {
      try { fs.unlinkSync(path.join(this.dir, it.name)); } catch (e) { /* ignore */ }
    }
  }

  _countFiles() {
    return (this.list().items || []).length;
  }
}

module.exports = { BackupStore, MAX_CONTENT_BYTES, MAX_KEEP, SAFE_NAME };
