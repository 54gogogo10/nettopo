/* NetTopo 配置变更下发记录库 —— 变更单、逐行结果与回滚留痕（主进程，纯 Node，不依赖 Electron）
 * 由 electron-main.js 经 IPC 桥接给渲染层；也可在 Node 测试中直接使用。
 *
 * 设计：
 * - 目录结构：<baseDir>/deploy/YYYYMMDD/deploy_YYYYMMDD_HHMMSS_<rand>.json（按天分目录）
 * - 每次下发一条记录：设备/主机/厂家/账号名/变更集/逐行结果/前置备份文件名/保存与回采结论
 * - **口令打码**：`password` / `community` / `key` 等凭据类关键字之后的内容一律打码后才落盘，
 *   与 shell-ui.js 命令历史同一口径（凭据绝不进审计文件）；打码行数写入记录供界面提示
 * - 文件名/路径严格白名单 + 原子写 + 符号链接拒绝 + 总量保留最近 MAX_KEEP 条（与 config-backup.js 同口径）
 * - 记录里只存**备份文件名**，变更前配置正文留在配置备份库（那里已有访问控制与清理策略）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_KEEP = 500;                          // 记录总数上限（超出滚动清理最旧）
const MAX_BYTES = 2 * 1024 * 1024;             // 单条记录上限 2MB
const NAME_RE = /^deploy_\d{8}_\d{6}(?:_\d+)?_[a-z0-9]{4}\.json$/;
const SECRET_RE = /((?:^|[\s;"'])(?:password|passwd|secret|community|passphrase|psk|token|api-?key|private-key|encryption-key|auth-key)\b[\s:=]+).*/gi;

/** 厂家配置模式口径（**主进程权威副本**）：渲染层只传一个厂家键，
 *  真正下发的「关分页/取配置/进配置模式/退出/保存」命令一律由主进程按此表决定——
 *  渲染层即使被注入也无法借这套通道下发任意模式控制命令。
 *  键与 js/util.js 的 U.DEPLOY_VENDORS（渲染层用于预览与回滚生成）保持一致。 */
const DEPLOY_VENDORS = {
  huawei: {
    label: '华为 VRP', enter: 'system-view', exit: 'return', save: 'save', negate: 'undo',
    screen: 'screen-length 0 temporary', showCfg: 'display current-configuration'
  },
  h3c: {
    label: 'H3C Comware', enter: 'system-view', exit: 'return', save: 'save force', negate: 'undo',
    screen: 'screen-length disable', showCfg: 'display current-configuration'
  },
  cisco: {
    label: '思科 IOS', enter: 'configure terminal', exit: 'end', save: 'write memory', negate: 'no',
    screen: 'terminal length 0', showCfg: 'show running-config'
  },
  ruijie: {
    label: '锐捷', enter: 'configure terminal', exit: 'end', save: 'write memory', negate: 'no',
    screen: 'terminal length 0', showCfg: 'show running-config'
  }
};
const deployVendor = (key) => DEPLOY_VENDORS[String(key || '')] || DEPLOY_VENDORS.huawei;

/** 文件名/目录名安全化（与 monitor.js / config-backup.js 一致）：剔除穿越成分与首尾点号 */
function sanitizeFilename(s) {
  let out = String(s == null ? '' : s);
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  out = out.replace(/\.\./g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!out) out = 'device';
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(out)) out = '_' + out;
  if (out.length > 60) out = out.slice(0, 60);
  return out;
}

/** 凭据打码：命中关键字后整段余文替换为 ****（`password cipher %^%#...` 这类链式写法一并覆盖）。
 *  返回 {text, masked}。 */
function maskSecrets(line) {
  const s = String(line == null ? '' : line);
  let masked = false;
  const out = s.replace(SECRET_RE, (m, p1) => { masked = true; return p1 + '****'; });
  return { text: out, masked };
}
/** 批量打码（记录里所有要落盘的文本都过这一道），返回 {lines, maskedCount} */
function maskAll(lines) {
  let n = 0;
  const out = (Array.isArray(lines) ? lines : []).map(x => {
    const r = maskSecrets(x);
    if (r.masked) n++;
    return r.text;
  });
  return { lines: out, maskedCount: n };
}

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
const tsKey = (d) => dayKey(d) + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());

class DeployStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  _dirOf(name) {
    // 记录按天分目录：从文件名解析日期，路径最终必须仍落在库内
    const m = /^deploy_(\d{8})_/.exec(String(name || ''));
    const day = m ? m[1] : '';
    const dir = path.resolve(this.baseDir, day);
    const base = path.resolve(this.baseDir) + path.sep;
    return dir.startsWith(base) ? dir : path.resolve(this.baseDir, '_');
  }

  static validName(name) {
    return NAME_RE.test(String(name || ''));
  }

  /** 写入一条下发记录。rec 由渲染层/主进程组装，此处只做白名单化与打码。
   *  返回 {ok:true, name, maskedCount} 或 {ok:false, error} */
  save(rec) {
    rec = rec && typeof rec === 'object' ? rec : {};
    const now = new Date();
    let name = 'deploy_' + tsKey(now) + '_' + Math.random().toString(36).slice(2, 6) + '.json';
    const dir = this._dirOf(name);
    try { if (fs.lstatSync(path.resolve(this.baseDir)).isSymbolicLink()) return { ok: false, error: '下发记录目录异常（符号链接）' }; }
    catch (e) { /* 不存在则照常创建 */ }
    const lines = Array.isArray(rec.lines) ? rec.lines.map(x => String(x == null ? '' : x)).slice(0, 400) : [];
    const applied = Array.isArray(rec.applied) ? rec.applied.slice(0, 400).map(a => ({
      line: String((a && a.line) || ''),
      ok: !!(a && a.ok),
      error: (a && a.error) ? String(a.error).slice(0, 400) : null
    })) : [];
    const planMask = maskAll(String(rec.plan == null ? '' : rec.plan).replace(/\r\n?/g, '\n').split('\n').slice(0, 400));
    const linesMask = maskAll(lines);
    const appliedMask = maskAll(applied.map(a => a.line));
    const out = {
      v: 1,
      at: now.toISOString(),
      ts: now.getTime(),
      device: String(rec.device == null ? '' : rec.device).slice(0, 120),
      deviceId: String(rec.deviceId == null ? '' : rec.deviceId).slice(0, 64),
      host: String(rec.host == null ? '' : rec.host).slice(0, 120),
      port: parseInt(rec.port, 10) || 0,
      protocol: String(rec.protocol || 'ssh').slice(0, 8),
      vendor: String(rec.vendor || '').slice(0, 32),
      vendorLabel: String(rec.vendorLabel || '').slice(0, 32),
      user: String(rec.user == null ? '' : rec.user).slice(0, 128),
      kind: rec.kind === 'rollback' ? 'rollback' : 'change',   // 变更下发 / 回滚下发
      lineCount: lines.length,
      plan: planMask.lines.join('\n'),
      lines: linesMask.lines,
      applied: appliedMask.lines.map((t, i) => ({ line: t, ok: applied[i].ok, error: applied[i].error })),
      result: {
        ok: !!(rec.result && rec.result.ok),
        appliedCount: parseInt(rec.result && rec.result.appliedCount, 10) || 0,
        failedAt: parseInt(rec.result && rec.result.failedAt, 10) || 0,
        remaining: parseInt(rec.result && rec.result.remaining, 10) || 0,
        error: (rec.result && rec.result.error) ? String(rec.result.error).slice(0, 400) : null
      },
      backup: {
        ok: !!(rec.backup && rec.backup.ok),
        file: (rec.backup && rec.backup.file) ? String(rec.backup.file).slice(0, 80) : '',
        error: (rec.backup && rec.backup.error) ? String(rec.backup.error).slice(0, 400) : null
      },
      saved: { ok: !!(rec.saved && rec.saved.ok), error: (rec.saved && rec.saved.error) ? String(rec.saved.error).slice(0, 400) : null },
      verify: { ok: !!(rec.verify && rec.verify.ok), error: (rec.verify && rec.verify.error) ? String(rec.verify.error).slice(0, 400) : null },
      maskedCount: planMask.maskedCount + linesMask.maskedCount + appliedMask.maskedCount
    };
    let tmpPath = '';
    try {
      fs.mkdirSync(dir, { recursive: true });
      let n = 0;
      while (fs.existsSync(path.join(dir, name))) {
        n++;
        name = 'deploy_' + tsKey(now) + (n ? '_' + n : '') + '_' + Math.random().toString(36).slice(2, 6) + '.json';
        if (n > 50) break;
      }
      const body = JSON.stringify(out, null, 2);
      if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return { ok: false, error: '下发记录过大（超过 2MB）' };
      tmpPath = path.join(dir, name + '.tmp-' + process.pid + '-' + Date.now());
      fs.writeFileSync(tmpPath, body, 'utf8');
      fs.renameSync(tmpPath, path.join(dir, name));
      const trimFailed = this._trim();
      if (trimFailed) console.warn('[config-deploy] 记录滚动清理失败：' + trimFailed);
      return { ok: true, name, maskedCount: out.maskedCount };
    } catch (err) {
      if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ } }
      return { ok: false, error: '下发记录写入失败：' + ((err && err.message) || err) };
    }
  }

  /** 列出全部记录摘要（时间倒序）。limit 默认 200 */
  list(limit) {
    const cap = (function () { const n = parseInt(limit, 10); return (n >= 1 && n <= 1000) ? n : 200; })();
    const base = path.resolve(this.baseDir);
    const items = [];
    let days = [];
    try { days = fs.readdirSync(base); } catch (e) { return { ok: true, items: [] }; }
    for (const day of days) {
      if (!/^\d{8}$/.test(day)) continue;
      const dir = path.join(base, day);
      let names = [];
      try { if (fs.lstatSync(dir).isSymbolicLink()) continue; names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const name of names) {
        if (!DeployStore.validName(name)) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.lstatSync(full);
          if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES) continue;
          const rec = JSON.parse(fs.readFileSync(full, 'utf8'));
          items.push({
            name, ts: rec.ts || st.mtimeMs, at: rec.at || '',
            device: rec.device || '', host: rec.host || '', vendorLabel: rec.vendorLabel || '',
            kind: rec.kind || 'change', lineCount: rec.lineCount || 0,
            ok: !!(rec.result && rec.result.ok), appliedCount: (rec.result && rec.result.appliedCount) || 0,
            failedAt: (rec.result && rec.result.failedAt) || 0, error: (rec.result && rec.result.error) || null,
            backupFile: (rec.backup && rec.backup.file) || '', saved: !!(rec.saved && rec.saved.ok),
            maskedCount: rec.maskedCount || 0
          });
        } catch (e) { /* 坏记录跳过（不阻断整个列表） */ }
      }
    }
    items.sort((a, b) => (b.ts - a.ts) || (a.name < b.name ? 1 : -1));
    return { ok: true, items: items.slice(0, cap), total: items.length };
  }

  /** 读取一条记录的完整内容 */
  read(name) {
    if (!DeployStore.validName(name)) return { ok: false, error: '非法的记录文件名' };
    const dir = this._dirOf(name);
    if (!dir.startsWith(path.resolve(this.baseDir) + path.sep)) return { ok: false, error: '非法的记录文件名' };
    const full = path.join(dir, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) return { ok: false, error: '记录不存在或读取失败' };
      if (st.size > MAX_BYTES) return { ok: false, error: '记录文件过大' };
      return { ok: true, rec: JSON.parse(fs.readFileSync(full, 'utf8')) };
    } catch (err) {
      return { ok: false, error: '记录不存在或读取失败' };
    }
  }

  /** 删除一条记录 */
  remove(name) {
    if (!DeployStore.validName(name)) return { ok: false, error: '非法的记录文件名' };
    const full = path.join(this._dirOf(name), name);
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: '记录不存在' };
      fs.unlinkSync(full);
      return { ok: true };
    } catch (err) { return { ok: false, error: '删除失败' }; }
  }

  /** 清空全部记录（含空目录） */
  clear() {
    const base = path.resolve(this.baseDir);
    try {
      const days = fs.readdirSync(base);
      for (const day of days) {
        if (!/^\d{8}$/.test(day)) continue;
        const dir = path.join(base, day);
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { continue; }
        for (const name of names) { if (DeployStore.validName(name)) { try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* ignore */ } } }
        try { fs.rmdirSync(dir); } catch (e) { /* 非空或不存在则留 */ }
      }
      return { ok: true };
    } catch (err) { return { ok: false, error: '清空失败：' + ((err && err.message) || err) }; }
  }

  /** 实时修剪：总数超过 MAX_KEEP 时按时间删最旧；返回错误说明（无错返回空串） */
  _trim() {
    try {
      const all = this.list(1000);
      if (!all.ok || (all.total || 0) <= MAX_KEEP) return '';
      const excess = all.items.slice(MAX_KEEP);
      for (const it of excess) this.remove(it.name);
      return '';
    } catch (e) { return String((e && e.message) || e); }
  }
}

module.exports = { DeployStore, DEPLOY_VENDORS, deployVendor, maskSecrets, maskAll, sanitizeFilename: sanitizeFilename };
