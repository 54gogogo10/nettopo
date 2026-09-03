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
// 产物文件名白名单：不含分隔符/穿越成分的可执行产物（readdirSync 本不含分隔符，显式声明意图）
const NAME_RE = /^[^\\/]+\.(\d{8}[a-z]-portable\.exe|exe|AppImage)$/i;

let made = 0;
for (const dir of dirs) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { continue; }
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
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
