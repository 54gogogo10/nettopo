/* NetTopo 在线升级器 —— 主进程纯 Node 模块（不依赖 Electron）
 * 升级源：GitHub Releases（54gogogo10/nettopo）。发布约定：
 *   - tag/版本：v1.0.0-<YYYYMMDD><字母>（与 package.json / U.APP_VERSION 同源）
 *   - 资产：便携版 exe（*-portable.exe）+ 同名 .sha256（npm run build 后自动生成）
 * 流程：check（版本比对，仅严格更新才提示）→ download（https 下载 exe 与 .sha256，
 *       字节上限 + 清单大小双重校验）→ verify（SHA256 比对）→ apply（改名-复制-换入：
 *       运行中的 exe 允许改名；PowerShell 辅助进程等本进程退出后启动新版并清理备份）。
 * 安全：仅 https；下载内容必须通过 SHA256 校验才可被 apply；资产文件名白名单清洗后落盘；
 *       版本号解析失败不自动升级（只提供发布页链接）；apply 仅接受本模块下载且已校验的文件。
 * 可在 Node 测试中直接使用（parseVersion / compareVersion / pickAssets / verifySha256File / psQuote）。
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// 目录/路径段拼接（平台分隔符；调用点的目录与文件名均来自常量或 sanitizeAssetName 白名单）
const pj = (...segs) => segs.filter(v => v != null && v !== '').join(path.sep);

const MAX_ASSET_BYTES = 400 * 1024 * 1024; // 下载字节数上限（便携版约 90MB，留足余量）
const CHECK_TIMEOUT_MS = 15000;
const DL_IDLE_TIMEOUT_MS = 60 * 1000;

/** 版本字符串 → {major, minor, patch, date, letter}（缺项为 null/空串）。支持
 *  「1.0.0-20260903e」「v1.0.0-20260903e」「1.0.0-20260903」「20260903e」等形态；无法解析返回 null。 */
function parseVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)-(\d{8})([a-z])?$/i);
  if (m) return { major: +m[1], minor: +m[2], patch: +m[3], date: +m[4], letter: m[5] ? m[5].toLowerCase() : '' };
  const t = s.match(/^(?:\d+\.\d+\.\d+-)?(\d{8})([a-z])?$/i);
  if (t) return { major: null, minor: null, patch: null, date: +t[1], letter: t[2] ? t[2].toLowerCase() : '' };
  return null;
}

/** 比较版本：a>b 返回 1，a<b 返回 -1，相等 0；任一无法解析返回 null（调用方不得据此自动升级）。
 *  日期优先于字母（字母为发布日内的递增序号）；任一形态缺 semver 段时只比日期+字母。 */
function compareVersion(a, b) {
  const va = parseVersion(a), vb = parseVersion(b);
  if (!va || !vb) return null;
  if (va.major != null && vb.major != null) {
    for (const k of ['major', 'minor', 'patch']) {
      if (va[k] !== vb[k]) return va[k] > vb[k] ? 1 : -1;
    }
  }
  if (va.date !== vb.date) return va.date > vb.date ? 1 : -1;
  if (va.letter !== vb.letter) return va.letter > vb.letter ? 1 : -1;
  return 0;
}

/** 资产文件名安全化（落盘名）：白名单外字符替换 + 剔除穿越成分（与全库清洗口径一致） */
function sanitizeAssetName(name) {
  let out = String(name == null ? '' : name).trim();
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_');
  out = out.replace(/\.\./g, '_');
  if (out.length > 160) out = out.slice(0, 160);
  return out || 'download.bin';
}

/** 从 release JSON 中挑选升级资产：win32 优先 *-portable.exe（退化唯一 .exe），
 *  linux 取 .AppImage；并找同名 .sha256。返回 { exe, sha|null } 或 null。 */
function pickAssets(release, platform) {
  const assets = (release && Array.isArray(release.assets)) ? release.assets : [];
  const isExe = (n) => /-portable\.exe$/i.test(n) || (platform === 'win32' && /\.exe$/i.test(n));
  const isAppImage = (n) => /\.AppImage$/i.test(n);
  let exe = null;
  for (const a of assets) {
    const n = String((a && a.name) || '');
    if (!a || !n || !a.browser_download_url || !a.size) continue;
    if (platform === 'win32' && isExe(n)) {
      if (!exe || (/-portable\.exe$/i.test(n) && !/-portable\.exe$/i.test(exe.name))) exe = a; // 便携版优先
    } else if (platform === 'linux' && isAppImage(n)) {
      if (!exe) exe = a;
    }
  }
  if (!exe) return null;
  let sha = null;
  for (const a of assets) {
    if (a && String(a.name || '') === String(exe.name) + '.sha256') { sha = a; break; }
  }
  return { exe, sha };
}

/** 校验下载文件与 .sha256 清单（清单取首个 64 位十六进制 token）。任一步失败返回 {ok:false,error} */
function verifySha256File(file, shaFile) {
  return new Promise((resolve) => {
    let expected = '';
    try {
      const raw = fs.readFileSync(shaFile, 'utf8');
      const m = raw.match(/\b([0-9a-fA-F]{64})\b/);
      if (!m) return resolve({ ok: false, error: 'SHA256 清单格式无效' });
      expected = m[1].toLowerCase();
    } catch (e) { return resolve({ ok: false, error: 'SHA256 清单读取失败' }); }
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', () => resolve({ ok: false, error: '升级包读取失败' }));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      const ok = actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
      resolve(ok ? { ok: true, sha256: actual } : { ok: false, error: 'SHA256 校验不符（下载不完整或被篡改）' });
    });
  });
}

/** PowerShell 单引号字面量转义（路径进 PS 命令行用） */
function psQuote(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
}

class Updater extends EventEmitter {
  /** @param opts { repo, currentVersion, platform, updateDir, exePath, isPackaged } */
  constructor(opts) {
    super();
    opts = opts || {};
    this.repo = String(opts.repo || '54gogogo10/nettopo');
    this.currentVersion = String(opts.currentVersion || '');
    this.platform = String(opts.platform || process.platform);
    this.updateDir = String(opts.updateDir || pj(require('os').tmpdir(), 'nettopo-updates'));
    this.exePath = opts.exePath || process.execPath;
    this.isPackaged = !!opts.isPackaged;
    this.state = 'idle';
    this.pendingFile = null; // 已下载且通过校验的升级包路径（apply 只接受它）
    this._dlAbort = null;
  }

  _setState(s, extra) {
    this.state = s;
    this.emit('status', Object.assign({ state: s }, extra || {}));
  }

  /** 检查更新。返回 {ok, update, current, latest?{version,notes,url}, reason?, error?} */
  async check() {
    if (this.state === 'downloading') return { ok: false, error: '正在下载升级包' };
    this._setState('checking');
    try {
      const rel = await this._fetchRelease();
      const tag = String(rel.tag_name || rel.name || '');
      const cmp = compareVersion(this.currentVersion, tag);
      const latest = {
        version: tag.replace(/^v/i, '') || tag,
        tag,
        notes: String(rel.body || '').slice(0, 4000),
        url: String(rel.html_url || ('https://github.com/' + this.repo + '/releases'))
      };
      if (cmp === null) {
        this._setState('idle');
        return { ok: true, update: false, reason: 'version-format', current: this.currentVersion, latest, error: '无法比对版本号，请到发布页手动确认' };
      }
      if (cmp >= 0) {
        this._setState('idle');
        return { ok: true, update: false, reason: 'up-to-date', current: this.currentVersion, latest };
      }
      // 有更新：确认平台资产存在（缺资产只提示去发布页）
      const picked = pickAssets(rel, this.platform);
      this._setState('idle');
      return {
        ok: true, update: true, reason: picked ? 'asset' : 'no-asset',
        current: this.currentVersion, latest,
        assets: picked ? { exe: picked.exe, sha: picked.sha } : null
      };
    } catch (e) {
      this._setState('idle');
      return { ok: false, error: '检查更新失败：' + String((e && e.message) || e) };
    }
  }

  /** GitHub releases/latest（15s 超时；非 200 抛错） */
  _fetchRelease() {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: '/repos/' + this.repo + '/releases/latest',
        method: 'GET',
        headers: {
          'User-Agent': 'NetTopo-Updater',
          'Accept': 'application/vnd.github+json'
        }
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (d) => { size += d.length; if (size > 2 * 1024 * 1024) { req.destroy(); reject(new Error('响应过大')); } chunks.push(d); });
        res.on('end', () => {
          if (res.statusCode === 404) return reject(new Error('发布页暂无正式版本（releases/latest 不存在）'));
          if (res.statusCode === 403) return reject(new Error('访问被限流，请稍后再试'));
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(new Error('响应解析失败')); }
        });
      });
      req.setTimeout(CHECK_TIMEOUT_MS, () => { req.destroy(); reject(new Error('请求超时')); });
      req.on('error', (e) => reject(new Error('网络错误：' + e.message)));
      req.end();
    });
  }

  /** 下载升级包 + .sha256 并校验。成功后 this.pendingFile 就绪，返回 {ok, file, sha256}。
   *  info: { exe, sha|null }（来自 check 的 assets）。 */
  async downloadAndVerify(info) {
    if (!info || !info.exe || !info.exe.browser_download_url) return { ok: false, error: '缺少下载信息' };
    if (this.state === 'downloading') return { ok: false, error: '已在下载中' };
    try { fs.mkdirSync(this.updateDir, { recursive: true }); } catch (e) { /* ignore */ }
    const exeName = sanitizeAssetName(info.exe.name);
    const dest = pj(this.updateDir, exeName);
    this._setState('downloading', { name: exeName });
    try {
      const total = Math.max(0, Math.floor(Number(info.exe.size) || 0));
      if (total > MAX_ASSET_BYTES) return { ok: false, error: '升级包超出大小上限' };
      const got = await this._download(info.exe.browser_download_url, dest, total);
      if (got !== total && total > 0) { try { fs.unlinkSync(dest); } catch (e) { /* ignore */ } return { ok: false, error: '下载不完整（' + got + '/' + total + ' 字节）' }; }
      let shaFile = null;
      if (info.sha && info.sha.browser_download_url) {
        shaFile = dest + '.sha256';
        const shaTotal = Math.max(0, Math.floor(Number(info.sha.size) || 0));
        if (shaTotal > 64 * 1024) return { ok: false, error: 'SHA256 清单异常' };
        const shaGot = await this._download(info.sha.browser_download_url, shaFile, shaTotal);
        if (shaGot === 0) return { ok: false, error: 'SHA256 清单下载失败' };
      }
      if (!shaFile) return { ok: false, error: '发布缺少 SHA256 清单，已取消升级（请到发布页手动下载）' };
      const v = await verifySha256File(dest, shaFile);
      if (!v.ok) { try { fs.unlinkSync(dest); } catch (e) { /* ignore */ } this._setState('idle'); return { ok: false, error: v.error }; }
      this.pendingFile = dest;
      this._setState('verified', { file: dest });
      return { ok: true, file: dest, sha256: v.sha256 };
    } catch (e) {
      try { if (dest) fs.unlinkSync(dest); } catch (e2) { /* ignore */ }
      this._setState('idle');
      return { ok: false, error: '下载失败：' + String((e && e.message) || e) };
    }
  }

  /** https 下载（跟随 ≤5 次重定向）到 dest；返回实际字节数。进度经 emit('progress')。 */
  _download(url, dest, total) {
    return new Promise((resolve, reject) => {
      let redirects = 0;
      const go = (u) => {
        const req = https.get(u, { headers: { 'User-Agent': 'NetTopo-Updater' } }, (res) => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            if (++redirects > 5) return reject(new Error('重定向次数过多'));
            return go(res.headers.location);
          }
          if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
          const len = parseInt(res.headers['content-length'], 10);
          if (Number.isFinite(len) && len > MAX_ASSET_BYTES) { res.resume(); return reject(new Error('文件超出大小上限')); }
          const out = fs.createWriteStream(dest, { flags: 'w' });
          let received = 0, lastEmit = 0, failed = false;
          const fail = (err) => { if (failed) return; failed = true; try { out.destroy(); } catch (e) { /* ignore */ } try { fs.unlinkSync(dest); } catch (e2) { /* ignore */ } req.destroy(); reject(err); };
          res.on('data', (d) => {
            received += d.length;
            if (received > MAX_ASSET_BYTES) { fail(new Error('文件超出大小上限')); return; }
            const now = Date.now();
            if (now - lastEmit > 200 || received === len) { lastEmit = now; this.emit('progress', { received, total: Number.isFinite(len) ? len : total }); }
          });
          res.pipe(out);
          res.on('error', () => fail(new Error('下载中断')));
          res.on('aborted', () => fail(new Error('下载中断')));
          out.on('error', () => fail(new Error('写入失败')));
          out.on('finish', () => { if (!failed) resolve(received); });
        });
        req.setTimeout(DL_IDLE_TIMEOUT_MS, () => { req.destroy(); reject(new Error('下载超时')); });
        req.on('error', (e) => reject(new Error('网络错误：' + e.message)));
        this._dlAbort = () => { try { req.destroy(); } catch (e) { /* ignore */ } };
      };
      go(url);
    });
  }

  /** 应用升级（仅限本模块下载且已通过校验的包）。
   *  portable exe 运行中允许改名：旧 exe → .old-<stamp>，新 exe 复制到原路径，
   *  辅助 PowerShell 进程等本进程退出后启动新版并清理备份。
   *  返回 {ok, restart:true} 或 {ok:false, manual:true}（目标目录不可写时降级手动安装）。 */
  apply() {
    if (!this.isPackaged) return { ok: false, error: '开发环境不支持在线升级（npm start）', manual: false };
    if (!this.pendingFile || !fs.existsSync(this.pendingFile)) return { ok: false, error: '尚未下载升级包' };
    if (this.platform !== 'win32') return { ok: false, error: '当前平台请到发布页手动下载', manual: true };
    const exePath = this.exePath;
    if (!exePath || !fs.existsSync(exePath)) return { ok: false, error: '未找到当前程序文件', manual: true };
    const oldPath = exePath + '.old-' + Date.now();
    try {
      fs.renameSync(exePath, oldPath); // Windows 允许改名运行中的 exe（句柄随文件名，不随路径）
    } catch (e) {
      return { ok: false, error: '程序目录不可写（' + String((e && e.code) || e) + '），请到发布页手动安装', manual: true };
    }
    try {
      fs.copyFileSync(this.pendingFile, exePath);
    } catch (e) {
      // 复制失败必须回滚改名，否则当前 exe“消失”
      try { fs.renameSync(oldPath, exePath); } catch (e2) { /* ignore */ }
      return { ok: false, error: '升级包复制失败：' + String((e && e.code) || e), manual: true };
    }
    // 辅助进程：等本进程退出（单实例锁随之释放）→ 启动新版 → 延迟清理备份
    const ps = [
      '$ErrorActionPreference = "SilentlyContinue"',
      'Wait-Process -Id ' + process.pid,
      'Start-Sleep -Milliseconds 800',
      'Start-Process -FilePath ' + psQuote(exePath),
      'Start-Sleep -Seconds 8',
      'Remove-Item -LiteralPath ' + psQuote(oldPath) + ' -Force'
    ].join('; ');
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
        { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (e) {
      // 辅助进程启动失败：新版已就位，用户手动启动即可；保留 .old 供回退
      return { ok: true, restart: true, warn: '升级包已就位，请手动重新启动程序完成升级' };
    }
    return { ok: true, restart: true };
  }
}

module.exports = { Updater, parseVersion, compareVersion, pickAssets, sanitizeAssetName, verifySha256File, psQuote, MAX_ASSET_BYTES };
