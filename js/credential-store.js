/* NetTopo 统一凭据库 —— 设备访问凭据的集中管理（主进程，纯 Node，不依赖 Electron）
 * 由 electron-main.js 经 IPC 桥接给渲染层；也可在 Node 测试中直接使用。
 *
 * 设计（与项目既有安全语义对齐）：
 * - 存储：<baseDir>/credentials.json，单文件原子写入（tmp + rename，权限 0600），符号链接拒写。
 * - 机密：口令 / 私钥口令的加解密由宿主注入适配器完成（Electron 侧为 safeStorage，前缀 enc1:）。
 *   本模块自身不做密码学，也**不允许明文落盘**：适配器缺失时拒存口令、只存其余字段并回报告警，
 *   与「浏览器路径密码不持久化」的既有口径一致。
 * - 出口：list() 只吐元数据（hasPassword / hasKey 布尔），密文与明文都不进渲染层；
 *   resolve()/resolveMany() 供主进程内部（以及需要在一个会话里试多组凭据的探测流程）使用。
 * - 选取：pick() 是纯函数——显式指定 > 厂家精确匹配 > 默认项。**不隐式遍历全部凭据**：
 *   拿一库口令挨个去试会把设备账号锁死，代价远大于省一次点击。
 * - 解析失败不静默重建：保留原文件、进入只读态并如实回报错误（凭据不可再生，宁可让人来处理）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'credentials.json';
const FORMAT = 1;
const MAX_ENTRIES = 50;      // 凭据条目上限（超出报错，不静默丢弃）
const MAX_NAME = 40;
const MAX_USER = 128;
const MAX_SECRET = 512;
const MAX_PRECMD = 256;
const MAX_VENDOR = 24;
const MAX_NOTE = 200;
const ID_RE = /^c[a-z0-9]{4,24}$/;
const PROTOCOLS = { ssh: 22, telnet: 23 };

/** 文本清洗：剔除控制字符（含 \r\n\t）与首尾空白；凭据字段一律单行 */
function cleanText(s, max) {
  let out = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (max && out.length > max) out = out.slice(0, max);
  return out;
}

let seq = 0;
function newId(now) {
  seq = (seq + 1) % 1000;
  return 'c' + (now || Date.now()).toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 6);
}

class CredentialStore {
  /** @param {string} baseDir 库目录（Electron 侧为 userData）
   *  @param {object} [opts] {encrypt(text)->cipher, decrypt(cipher)->text} 机密适配器（由宿主注入） */
  constructor(baseDir, opts) {
    this.baseDir = baseDir;
    this.file = path.join(baseDir, FILE_NAME);
    const o = opts || {};
    this.encrypt = typeof o.encrypt === 'function' ? o.encrypt : null;
    this.decrypt = typeof o.decrypt === 'function' ? o.decrypt : null;
    this.readOnly = false;   // 解析失败置位：拒绝写入，避免覆盖掉可能还能人工挽救的原文件
    this.loadError = '';
  }

  static cleanText(s, max) { return cleanText(s, max); }

  /** 读取并规范化磁盘内容。返回 {ok, entries, error} */
  _load() {
    let raw;
    try {
      const st = fs.lstatSync(this.file);
      if (st.isSymbolicLink() || !st.isFile()) {
        this.readOnly = true; this.loadError = '凭据库文件异常（符号链接或非普通文件），已进入只读保护';
        return { ok: false, entries: [], error: this.loadError };
      }
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') { this.readOnly = false; this.loadError = ''; return { ok: true, entries: [] }; }
      this.readOnly = true; this.loadError = '凭据库读取失败：' + ((err && err.message) || err);
      return { ok: false, entries: [], error: this.loadError };
    }
    let data;
    try { data = JSON.parse(raw); } catch (e) {
      this.readOnly = true; this.loadError = '凭据库文件已损坏（JSON 解析失败），未做任何改动';
      return { ok: false, entries: [], error: this.loadError };
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
      this.readOnly = true; this.loadError = '凭据库文件结构异常，未做任何改动';
      return { ok: false, entries: [], error: this.loadError };
    }
    const entries = [];
    for (const it of data.entries) {
      const e = CredentialStore._normalizeStored(it);
      if (e) entries.push(e);
    }
    this.readOnly = false; this.loadError = '';
    return { ok: true, entries };
  }

  /** 磁盘条目规范化（缺字段/类型不符即丢弃；id 非法一律丢弃——id 是渲染层寻址凭据的唯一键） */
  static _normalizeStored(it) {
    if (!it || typeof it !== 'object') return null;
    const id = String(it.id || '');
    if (!ID_RE.test(id)) return null;
    const name = cleanText(it.name, MAX_NAME);
    if (!name) return null;
    const protocol = Object.prototype.hasOwnProperty.call(PROTOCOLS, String(it.protocol)) ? String(it.protocol) : 'ssh';
    let port = parseInt(it.port, 10);
    if (!(port >= 1 && port <= 65535)) port = PROTOCOLS[protocol];
    return {
      id,
      name,
      username: cleanText(it.username, MAX_USER),
      pwdEnc: typeof it.pwdEnc === 'string' ? it.pwdEnc : '',
      keyEnc: typeof it.keyEnc === 'string' ? it.keyEnc : '',
      keyPassEnc: typeof it.keyPassEnc === 'string' ? it.keyPassEnc : '',
      protocol,
      port,
      preCmd: cleanText(it.preCmd, MAX_PRECMD),
      vendor: cleanText(it.vendor, MAX_VENDOR),
      note: cleanText(it.note, MAX_NOTE),
      isDefault: !!it.isDefault,
      updatedAt: Number(it.updatedAt) || 0
    };
  }

  /** 落盘（原子写）。entries 已是规范化形态 */
  _persist(entries) {
    if (this.readOnly) return { ok: false, error: this.loadError || '凭据库处于只读状态' };
    const tmp = this.file + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      try { if (fs.lstatSync(this.file).isSymbolicLink()) return { ok: false, error: '凭据库文件异常（符号链接），已拒绝写入' }; }
      catch (e) { /* 不存在则照常创建 */ }
      fs.writeFileSync(tmp, JSON.stringify({ format: FORMAT, entries }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch (e) { /* Windows 上忽略 */ }
      return { ok: true };
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      return { ok: false, error: '凭据库写入失败：' + ((err && err.message) || err) };
    }
  }

  /** 渲染层可见形态：**不含任何机密**（含密文），只给「有没有设口令」的布尔 */
  static _publicView(e) {
    return {
      id: e.id, name: e.name, username: e.username,
      hasPassword: !!e.pwdEnc, hasKey: !!e.keyEnc,
      protocol: e.protocol, port: e.port,
      preCmd: e.preCmd, vendor: e.vendor, note: e.note,
      isDefault: !!e.isDefault, updatedAt: e.updatedAt
    };
  }

  /** 凭据清单（默认项在前，其次按名称） */
  list() {
    const r = this._load();
    const items = r.entries.slice().sort((a, b) => (Number(b.isDefault) - Number(a.isDefault)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return r.ok ? { ok: true, items: items.map(CredentialStore._publicView) } : { ok: false, error: r.error, items: [] };
  }

  count() {
    const r = this._load();
    return r.ok ? r.entries.length : 0;
  }

  /** 新增或更新一条凭据。input.id 存在即更新。
   *  password / keyPassphrase / privateKey：undefined = 保持不变（编辑时不回显口令的语义），'' = 清空。
   *  返回 {ok, item} 或 {ok:false, error}；口令因加密不可用而未保存时附 warn。 */
  save(input) {
    const p = input || {};
    const name = cleanText(p.name, MAX_NAME);
    if (!name) return { ok: false, error: '请填写凭据名称' };
    const username = cleanText(p.username, MAX_USER);
    const protocol = Object.prototype.hasOwnProperty.call(PROTOCOLS, String(p.protocol)) ? String(p.protocol) : 'ssh';
    let port = parseInt(p.port, 10);
    if (!(port >= 1 && port <= 65535)) port = PROTOCOLS[protocol];
    const vendor = cleanText(p.vendor, MAX_VENDOR);
    const note = cleanText(p.note, MAX_NOTE);
    const preCmd = cleanText(p.preCmd, MAX_PRECMD);

    const loaded = this._load();
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const entries = loaded.entries;
    const id = p.id == null ? '' : String(p.id);
    let entry = null, isNew = false;
    if (id) {
      if (!ID_RE.test(id)) return { ok: false, error: '非法的凭据标识' };
      entry = entries.find(e => e.id === id) || null;
      if (!entry) return { ok: false, error: '凭据不存在（可能已被删除）' };
    } else {
      if (entries.length >= MAX_ENTRIES) return { ok: false, error: '凭据数量已达上限（' + MAX_ENTRIES + ' 条）' };
      entry = { id: newId(), name: '', username: '', pwdEnc: '', keyEnc: '', keyPassEnc: '', protocol, port, preCmd: '', vendor: '', note: '', isDefault: false, updatedAt: 0 };
      isNew = true;
    }
    // 名称唯一（大小写与首尾空白不敏感）：重复名会让「从凭据库选择」出现两条无法分辨的选项
    const clash = entries.find(e => e.id !== entry.id && e.name.toLowerCase() === name.toLowerCase());
    if (clash) return { ok: false, error: '凭据名称已存在：' + clash.name };

    entry.name = name;
    entry.username = username;
    entry.protocol = protocol;
    entry.port = port;
    entry.vendor = vendor;
    entry.note = note;
    entry.preCmd = preCmd;
    entry.updatedAt = Date.now();

    // 机密：undefined 保持不变；'' 清空；有值则必须能加密（加密不可用时拒存并告知，绝不退化成明文落盘）
    let warn = '';
    const secretFields = [['password', 'pwdEnc'], ['privateKey', 'keyEnc'], ['keyPassphrase', 'keyPassEnc']];
    for (const [inKey, storeKey] of secretFields) {
      if (!Object.prototype.hasOwnProperty.call(p, inKey) || p[inKey] === undefined || p[inKey] === null) continue;
      const val = String(p[inKey]);
      if (!val) { entry[storeKey] = ''; continue; }
      if (!this.encrypt) { warn = '系统加密不可用：口令未保存（其余字段已保存）'; continue; }
      const cipher = this.encrypt(val.slice(0, MAX_SECRET));
      const c = String(cipher == null ? '' : cipher);
      if (!c) { warn = '系统加密失败：口令未保存（其余字段已保存）'; continue; }
      entry[storeKey] = c;
    }
    if (p.isDefault) {
      // 默认项唯一：新默认设定时清掉旧默认（否则「默认凭据」在界面上自相矛盾）
      for (const e of entries) if (e.id !== entry.id) e.isDefault = false;
      entry.isDefault = true;
    } else if (Object.prototype.hasOwnProperty.call(p, 'isDefault')) {
      entry.isDefault = false;
    }

    const next = isNew ? entries.concat([entry]) : entries.map(e => (e.id === entry.id ? entry : e));
    const w = this._persist(next);
    if (!w.ok) return { ok: false, error: w.error };
    const out = { ok: true, item: CredentialStore._publicView(entry) };
    if (warn) out.warn = warn;
    return out;
  }

  /** 删除一条凭据 */
  remove(id) {
    const key = String(id == null ? '' : id);
    if (!ID_RE.test(key)) return { ok: false, error: '非法的凭据标识' };
    const loaded = this._load();
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const entries = loaded.entries;
    const idx = entries.findIndex(e => e.id === key);
    if (idx < 0) return { ok: false, error: '凭据不存在' };
    entries.splice(idx, 1);
    const w = this._persist(entries);
    return w.ok ? { ok: true, removed: 1 } : { ok: false, error: w.error };
  }

  /** 解析单条凭据为可连接形态（明文只在主进程内存中短暂存在）。返回 {ok, cred} */
  resolve(id) {
    const key = String(id == null ? '' : id);
    if (!ID_RE.test(key)) return { ok: false, error: '非法的凭据标识' };
    const loaded = this._load();
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const e = loaded.entries.find(x => x.id === key);
    if (!e) return { ok: false, error: '凭据不存在（可能已被删除）' };
    const dec = (v) => {
      const raw = String(v || '');
      if (!raw) return '';
      if (!this.decrypt) return '';
      try { return String(this.decrypt(raw) || ''); } catch (err) { return ''; }
    };
    return {
      ok: true,
      cred: {
        id: e.id, name: e.name, username: e.username,
        password: dec(e.pwdEnc), privateKey: dec(e.keyEnc), keyPassphrase: dec(e.keyPassEnc),
        protocol: e.protocol, port: e.port, preCmd: e.preCmd, vendor: e.vendor
      }
    };
  }

  /** 批量解析（按给定顺序，忽略不存在项）。供「一个会话里按顺序试多组凭据」的探测流程使用 */
  resolveMany(ids) {
    const out = [], missing = [];
    for (const id of (Array.isArray(ids) ? ids : [])) {
      const r = this.resolve(id);
      if (r.ok) out.push(r.cred); else missing.push(String(id));
    }
    return { ok: true, items: out, missing };
  }

  /** 选取凭据 id 顺序（纯函数）：显式 ids 优先 → 厂家精确匹配 → 默认项。不隐式遍历全部凭据（防账号锁定） */
  static pick(entries, opts) {
    const list = Array.isArray(entries) ? entries : [];
    const o = opts || {};
    const out = [];
    const push = (id) => { if (id && out.indexOf(id) < 0) out.push(id); };
    for (const id of (Array.isArray(o.ids) ? o.ids : [])) {
      const e = list.find(x => x && x.id === String(id));
      if (e) push(e.id);
    }
    const vendor = cleanText(o.vendor, MAX_VENDOR).toLowerCase();
    if (vendor) for (const e of list) if (e && cleanText(e.vendor, MAX_VENDOR).toLowerCase() === vendor) push(e.id);
    for (const e of list) if (e && e.isDefault) push(e.id);
    return out;
  }

  /** 按厂家/显式 id 选取（读盘后套用 pick），返回 {ok, ids} */
  pickFor(opts) {
    const loaded = this._load();
    if (!loaded.ok) return { ok: false, error: loaded.error, ids: [] };
    return { ok: true, ids: CredentialStore.pick(loaded.entries, opts) };
  }
}

module.exports = { CredentialStore, MAX_ENTRIES, MAX_NAME, FILE_NAME, FORMAT };
