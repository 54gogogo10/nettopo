/* NetTopo 构建前自动升级版本号
 *
 * 版本规则：U.APP_VERSION = v<YYYYMMDD><字母>（如 v20260813c）
 * - 与今天同日期 → 字母 +1（c → d）
 * - 跨天 / 首次构建 → 今天日期 + 'a'
 *
 * 同步更新（同一版本令牌）：
 * - js/util.js            U.APP_VERSION（版本唯一来源）
 * - index.html / shell.html / webview.html  标题、状态栏、缓存参数 ?v=
 *
 * 用法：node bump-version.js [--dry-run]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FILES = ['js/util.js', 'index.html', 'shell.html', 'webview.html'];
const PKG_FILE = 'package.json';   // 构建产物文件名依赖其 version 字段（electron-builder ${version}）
const PKG_VERSION = '1.0.0';       // 固定的主版本基座；build 版本号以 semver 预发布形式附加（1.0.0-20260814f）
const dry = process.argv.includes('--dry-run');

const utilSrc = fs.readFileSync(path.join(ROOT, 'js/util.js'), 'utf8');
const m = utilSrc.match(/U\.APP_VERSION\s*=\s*'v(\d{8})([a-z])'/);
if (!m) { console.error('[bump-version] 无法解析 js/util.js 中的 U.APP_VERSION'); process.exit(1); }
const curStamp = m[1] + m[2];       // 20260813c
const curVer = 'v' + curStamp;      // v20260813c

const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const today = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;

let nextStamp;
if (m[1] === today) {
  if (m[2] === 'z') { console.error('[bump-version] 版本字母已达 z，请人工调整版本号'); process.exit(1); }
  nextStamp = today + String.fromCharCode(m[2].charCodeAt(0) + 1);
} else {
  nextStamp = today + 'a';
}
const nextVer = 'v' + nextStamp;

// 替换版本令牌：不含 v 前缀（同时命中 v20260813c 与 ?v=20260813c）
const re = new RegExp(curStamp, 'g');
let changed = 0;
for (const f of FILES) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const out = src.replace(re, nextStamp);
  if (out === src) continue;
  changed++;
  console.log(`  ${f}: ${curVer} → ${nextVer}`);
  if (!dry) fs.writeFileSync(path.join(ROOT, f), out);
}
if (!changed) { console.log(`[bump-version] 未找到可替换的版本令牌（当前 ${curVer}）`); }

// 同步 package.json version → 构建产物文件名携带版本号（网络拓扑管理软件-1.0.0-<stamp>-portable.exe）
(() => {
  const pkgPath = path.join(ROOT, PKG_FILE);
  if (!pkgPath.startsWith(ROOT + path.sep)) throw new Error('路径异常：' + PKG_FILE); // 边界终判（PKG_FILE 为常量，纵深）
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { console.warn('[bump-version] 读取 package.json 失败，跳过版本写入'); return; }
  const curPkgVer = (pkg && pkg.version) || '';
  const nextPkgVer = PKG_VERSION + '-' + nextStamp;
  if (curPkgVer === nextPkgVer) return; // 幂等
  if (pkg) pkg.version = nextPkgVer;
  console.log(`  ${PKG_FILE}: ${curPkgVer} → ${nextPkgVer}`);
  if (!dry) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  // 同步 package-lock.json 根版本，避免 lockfile 与 package.json 漂移
  const lockPath = path.join(ROOT, 'package-lock.json');
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock && lock.packages && lock.packages[''] && lock.packages[''].version !== nextPkgVer) {
      lock.packages[''].version = nextPkgVer;
      if (typeof lock.version === 'string') lock.version = nextPkgVer;
      if (!dry) fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
      console.log(`  package-lock.json: → ${nextPkgVer}`);
    }
  } catch (e) { console.warn('[bump-version] 同步 package-lock.json 失败，跳过'); }
})();

console.log(`版本：${curVer} → ${nextVer}${dry ? '（dry-run，未写入）' : '，已写入 ' + (changed + 1) + ' 个文件及 package.json'}`);
