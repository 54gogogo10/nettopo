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
console.log(`版本：${curVer} → ${nextVer}${dry ? '（dry-run，未写入）' : '，已写入 ' + changed + ' 个文件'}`);
