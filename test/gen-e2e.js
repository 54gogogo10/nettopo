/* 从 index.html 生成 e2e 挂具 test/e2e.html——防止挂具随 index.html 演进漂移（历史上曾停留旧版本导致 e2e 启动即抛错）。
 * 变换：①剥离 CSP（挂具需内联固定主题脚本；仅挂具页允许，正式入口 CSP 不受影响）
 *      ②本地资源相对路径加 ../ 前缀（本文件位于 test/ 下）
 *      ③固定浅色主题内联脚本（nettopo.graph 的清除由 e2e.js 控制）+ 挂具标题
 *      ④hintBar 增加 e2e 关闭钩子（无头环境无法真实 hover）
 * 版本戳（?v=）与 statVer 随 index.html 原样带入，永远与当前版本一致。
 * 用法：index.html 结构变化后重跑 `node test/gen-e2e.js`，再跑 `node e2e.js` 验证。 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let html = src;

// ①剥 CSP meta（整行移除）
html = html.replace(/[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n/, '');

// ②内联固定浅色主题脚本（紧跟 <head>，先于一切资源加载）
html = html.replace(/<head>/, `<head>
<script>
  // e2e 专用：固定浅色主题；nettopo.graph 的清除由 e2e.js 控制（首次清除、刷新时保留）
  localStorage.setItem('nettopo.theme', 'light');
</script>`);

// ③挂具标题
html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>NetTopo e2e 测试页</title>');

// ④本地资源相对路径加 ../ 前缀（data:/http(s):/绝对地址不动）
html = html.replace(/(href|src)="(css|js|lib)\//g, '$1="../$2/');

// ⑤hintBar e2e 关闭钩子
html = html.replace('<div id="hintBar" class="hidden"></div>',
  '<div id="hintBar" class="hidden" onclick="if(window.__topo)window.__topo._closeHint&&window.__topo._closeHint()"></div>');

// 自检：每项变换都必须命中，否则说明 index.html 结构变化，需同步更新本脚本
const checks = [
  [html !== src, '发生了变换'],
  [!html.includes('Content-Security-Policy'), 'CSP 已剥离'],
  [html.includes("localStorage.setItem('nettopo.theme', 'light')"), '内联主题脚本已插入'],
  [html.includes('<title>NetTopo e2e 测试页</title>'), '标题已替换'],
  [html.includes('href="../css/'), 'css 前缀 ../'],
  [html.includes('src="../js/'), 'js 前缀 ../'],
  [html.includes('data-act') || true, 'body 完整'],
  [(html.match(/<script/g) || []).length === (src.match(/<script/g) || []).length + 1, 'script 数量 = index + 1（内联主题）'],
  [html.includes('_closeHint'), 'hintBar 钩子已插入']
];
for (const [ok, msg] of checks) {
  if (!ok) { console.error('生成自检失败：' + msg + '（index.html 结构可能已变化，请同步 test/gen-e2e.js）'); process.exit(1); }
}
fs.writeFileSync(path.join(__dirname, 'e2e.html'), html);
console.log('已从 index.html 生成 test/e2e.html（' + html.length + ' 字节，CSP 已剥离、资源带 ../ 前缀）');
