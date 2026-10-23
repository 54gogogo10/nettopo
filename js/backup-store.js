/* NetTopo 备份库 —— 工程 .nettopo 备份的本地存储管理（主进程，纯 Node，不依赖 Electron）
 * 由 electron-main.js 通过 IPC 桥接给渲染层；也可在 Node 测试中直接使用。
 *
 * 设计：
 * - 所有备份保存在单一目录（桌面版为用户数据目录 backups/），文件名 自动备份_YYYYMMDD_HHMMSS.nettopo
 *   或 备份_YYYYMMDD_HHMMSS.nettopo（手动备份）。
 * - 每次保存后按「保留最近 N 份」滚动清理最旧的备份；另有全库字节配额兜底（超限先淘汰最旧，
 *   仍不够则如实拒绝保存，见 _evictOldest）。
 * - 所有读取/删除操作都严格校验文件名，杜绝路径穿越。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { DiskQuota } = require('./disk-quota.js');

const MAX_CONTENT_BYTES = 64 * 1024 * 1024;   // 单份备份内容上限 64MB（含自定义设备图片）
const MAX_KEEP = 200;                          // 保留份数上限
const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 全库字节配额默认 2GB（此前只按份数滚动：200 份 × 64MB
                                              // 理论上限 12.8GB，磁盘可被写满；2GB ≈ 30 余份满额工程备份，
                                              // 常规拓扑工程远小于 64MB，历史深度充足，与 config-backup 同口径）
const SAFE_NAME = /^[\u4e00-\u9fa5A-Za-z0-9_.-]+\.nettopo$/;

class BackupStore {
  constructor(dir, opts) {
    opts = opts || {};
    // 统一绝对路径：read/remove 的边界终判按 resolve 比较，dir 为相对路径时
    // 「相对拼接 vs 绝对前缀」恒不匹配会被全拒（save 却能写），行为分裂
    this.dir = path.resolve(dir);
    this.maxBytes = opts.maxBytes || MAX_CONTENT_BYTES; // 单份内容上限（测试可调小）
    // 全库字节配额（与 config-backup 同款三件套）：启动实扫校准，此后 save/remove/trim 增量记账
    this.quota = new DiskQuota({ maxBytes: opts.maxTotalBytes > 0 ? opts.maxTotalBytes : DEFAULT_QUOTA_BYTES });
    this.quota.scan(this.dir);
  }

  /** 文件名白名单校验：格式合法、不含路径成分、非 Windows 保留设备名 */
  static validName(name) {
    name = String(name || '');
    if (!SAFE_NAME.test(name)) return false;
    if (name.includes('..')) return false;
    const base = name.replace(/\.nettopo$/i, '');
    if (/^(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/i.test(base)) return false; // Windows 设备名
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
      // 全库字节配额：超限时先淘汰最旧备份腾空间，仍不够则如实拒绝（磁盘满是比「保留最近 N 份」
      // 更硬的约束；淘汰与滚动清理同口径——按修改时间最旧优先，份数滚动 _trim 仍照常生效）
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > this.quota.maxBytes) {
        return { ok: false, error: '单份备份（' + Math.round(bytes / 1024 / 1024) + 'MB）超过备份库字节配额（' + Math.round(this.quota.maxBytes / 1024 / 1024) + 'MB）：请调大配额' };
      }
      if (!this.quota.check(bytes)) {
        const need = bytes - (this.quota.maxBytes - this.quota.usedBytes);
        const ev = this._evictOldest(need);
        if (!this.quota.check(bytes)) {
          return { ok: false, error: '备份库字节配额不足（上限 ' + Math.round(this.quota.maxBytes / 1024 / 1024) + 'MB）：已先淘汰最旧 ' + ev.count + ' 份仍不够，请手动清理备份库或调大配额' };
        }
      }
      // 同秒多次备份时追加序号，避免覆盖
      let name = `${prefix}${this._ts()}.nettopo`;
      let seq = 0;
      while (fs.existsSync(path.join(this.dir, name))) {
        seq++;
        name = `${prefix}${this._ts()}_${seq}.nettopo`;
      }
      tmpPath = path.join(this.dir, name + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, path.join(this.dir, name));
      this._trim(n);
      return { ok: true, name, count: this._countFiles() };
    } catch (err) {
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ } }
      try { this.quota.release(Buffer.byteLength(content, 'utf8')); } catch (e) { /* ignore */ } // 写入失败回滚配额记账
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
        try { st = fs.lstatSync(full); } catch (e) { continue; }
        if (!st.isFile() || st.isSymbolicLink()) continue; // 忽略目录与符号链接（防链接指向任意文件）
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
    const full = this.dir + path.sep + name;
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) return { ok: false, error: '非法的备份文件名' }; // 边界终判（name 已过 validName 白名单，纵深）
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) return { ok: false, error: '备份不存在或读取失败' };
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
    const full = this.dir + path.sep + name;
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) return { ok: false, error: '非法的备份文件名' }; // 边界终判（name 已过 validName 白名单，纵深）
    try {
      let size = 0;
      try { size = fs.lstatSync(full).size || 0; } catch (e) { /* 取不到按 0 释放记账 */ }
      fs.unlinkSync(full);
      this.quota.release(size);
      return { ok: true, removed: 1 };
    } catch (err) {
      // 如实区分「不存在」与真实失败（Windows 句柄占用 EBUSY 等谎报会误导排查）
      if (err && err.code === 'ENOENT') return { ok: false, error: '备份不存在' };
      return { ok: false, error: '删除失败：' + ((err && err.code) || '') + ((err && err.message) || err || '') };
    }
  }

  /** 清空全部备份。返回 {ok:true, removed, failed:[{name, code}]}：
   *  部分失败（如文件被占用）仍如实保留 failed 明细，UI 可据此提示残留 */
  removeAll() {
    let removed = 0;
    const failed = [];
    for (const it of (this.list().items || [])) {
      try { fs.unlinkSync(path.join(this.dir, it.name)); removed++; this.quota.release(it.size || 0); }
      catch (err) { failed.push({ name: it.name, code: (err && err.code) || String(err) }); }
    }
    return { ok: true, removed, failed };
  }

  /** 滚动清理：仅保留最新的 keep 份（按修改时间倒序）。删除失败不静默：记日志 */
  _trim(keep) {
    const items = this.list().items || [];
    for (const it of items.slice(keep)) {
      try { fs.unlinkSync(path.join(this.dir, it.name)); this.quota.release(it.size || 0); }
      catch (err) { console.warn('[backup-store] 滚动清理失败:', it.name, (err && err.code) || err); }
    }
  }

  /** 字节配额超限时全库淘汰最旧备份（与滚动清理同口径：list 为时间倒序，从最旧开始删），
   *  直到释放够 needBytes 或删完。返回 {count, freedBytes}；单份删除失败跳过继续更旧的下一份。 */
  _evictOldest(needBytes) {
    const items = (this.list().items || []).slice().reverse(); // 时间倒序 → 反转后从最旧开始
    let freed = 0, count = 0;
    for (const it of items) {
      if (freed >= needBytes) break;
      try {
        fs.unlinkSync(path.join(this.dir, it.name));
        freed += it.size || 0;
        count++;
        this.quota.release(it.size || 0);
      } catch (err) { console.warn('[backup-store] 配额淘汰失败:', it.name, (err && err.code) || err); }
    }
    return { count, freedBytes: freed };
  }

  _countFiles() {
    return (this.list().items || []).length;
  }
}

module.exports = { BackupStore, MAX_CONTENT_BYTES, MAX_KEEP, SAFE_NAME, DEFAULT_QUOTA_BYTES };
