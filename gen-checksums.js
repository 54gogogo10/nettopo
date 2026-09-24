/* NetTopo 构建收尾：为打包产物生成 SHA256 清单（<文件名>.sha256，内容为 64 位十六进制）。
 * 用途：在线升级（js/updater.js）下载后按同名 .sha256 校验完整性——发布 Release 时
 * 务必把 exe 与 .sha256 一起上传。由 npm run build 在 electron-builder 之后自动执行。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname);
// 产物目录固定在仓库 dist/ 下：显式校验解析结果仍在仓库根内（纵深，杜绝配置改动引入穿越）
const dirs = ['dist/portable', 'dist/linux']
  .map((rel) => path.resolve(root, rel))
  .filter((d) => d === root || d.startsWith(root + path.sep));
// 产物文件名白名单：不含分隔符/穿越成分的可执行产物（readdirSync 本不含分隔符，显式声明意图）。
// 旧白名单首分支要求日期戳前紧跟「.」，而 electron-builder 实际产物名是
// 「网络拓扑管理软件-1.0.0-<日期戳>-portable.exe」（日期戳前是「-」），首分支恒不命中 →
// 退化成「任意 .exe」，dist/portable 里堆积的历史版本 exe 也各得一份清单：整目录发布时，
// 在线升级（js/updater.js 的 pickAssets 取「第一个 -portable.exe」）会拿到与旧包同名配对的清单。
const NAME_RE = /^[^\\/]+(-portable\.exe|\.AppImage)$/i;
// 再按当前版本收窄：dist/ 是累积目录（每次构建不清理），旧版本便携版同样能过上面的白名单。
// 版本号取 package.json 的 version（npm run build 里 bump-version.js 已先行同步，产物名不含
// 版本号以外的信息无法自证是本次构建），portable.artifactName 含 ${version}，故当前产物必然命中。
let appVersion = '';
try {
  appVersion = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '').trim();
} catch (e) { appVersion = ''; }
if (!appVersion) console.warn('  ! 未读到 package.json 的 version：本轮不做版本收窄（旧版本产物也会生成清单）');

let made = 0;
for (const dir of dirs) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { continue; }
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    // AppImage 由独立配置交叉打包、目录内不堆积多版本，维持结构匹配；只有便携版 exe 按版本收窄
    if (appVersion && /-portable\.exe$/i.test(name) && name.indexOf(appVersion) < 0) {
      console.log('  • 跳过非当前版本产物 → ' + name + '（当前版本 ' + appVersion + '）');
      continue;
    }
    const full = path.join(dir, name);
    if (!full.startsWith(dir + path.sep)) continue; // 目录边界终判
    try {
      const hash = crypto.createHash('sha256');
      hash.update(fs.readFileSync(full));
      fs.writeFileSync(full + '.sha256', hash.digest('hex') + '\n', 'utf8');
      made++;
      console.log('  • SHA256 → ' + name + '.sha256');
    } catch (e) {
      console.warn('  ! 跳过 ' + name + '：' + String((e && e.message) || e));
    }
  }
}
console.log(made ? '校验清单生成完成（' + made + ' 份）' : '未发现打包产物（跳过校验清单生成）');
