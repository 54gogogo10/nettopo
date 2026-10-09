# 第三方组件许可清单（THIRD-PARTY NOTICES）

本软件集成了以下第三方组件，在此保留其版权与许可声明。各组件按其原有许可证授权，
本项目对其的使用方式与项目整体的 **GNU AGPL-3.0 + 附加条款**（见根目录 `LICENSE`）兼容。

## 一、内置进发行产物的组件（lib/ 与运行时依赖）

| 组件 | 版本 | 许可证 | 用途 | 声明位置 |
|---|---|---|---|---|
| SheetJS Community Edition（xlsx） | 0.20.3 | Apache-2.0 | Excel/CSV 导入导出 | `lib/LICENSE.xlsx.txt` |
| @xterm/xterm | 6.0.0 | MIT | Web Shell 终端 | `lib/LICENSE.xterm.txt` |
| @xterm/addon-fit | 0.11.0 | MIT | 终端自适应尺寸 | `lib/LICENSE.xterm.txt` |
| @xterm/addon-search | 手工内置 | MIT | 终端搜索 | `lib/LICENSE.addon-search.txt` |
| Electron | 43.3.0 | MIT | 桌面运行时 | 产物内 `LICENSE.electron.txt` |
| Chromium 及其捆绑组件 | 随 Electron | BSD-3/Apache-2.0/MPL 等宽松许可 | 渲染引擎 | 产物内 `LICENSES.chromium.html` |
| ssh2 | 1.17.0 | MIT | SSH/Telnet（Telnet 为本模块自实现） | `node_modules/ssh2/package.json`（licenses 字段） |
| asn1（ssh2 依赖） | 0.2.x | MIT | SSH ASN.1 解析 | 随源分发 |
| bcrypt-pbkdf（ssh2 依赖） | 1.x | BSD-3-Clause | SSH 密钥口令派生 | 随源分发 |
| nan / cpu-features（ssh2 可选依赖） | — | MIT | 原生加速（可选，缺失时回落 JS 实现） | 随源分发 |

## 二、构建与开发依赖（不进入发行产物）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| electron-builder | 26.15.3 | MIT | 便携版打包（其捆绑的 NSIS/7-Zip/app-builder 等工具均为 zlib、MIT、Unlicense 类宽松许可） |
| @electron/fuses | 2.1.3 | MIT | Electron 运行时特性开关 |
| @xterm/xterm / @xterm/addon-fit（npm 源） | 6.0.0 / 0.11.0 | MIT | `lib/` 内置副本的升级来源 |

## 三、测试依赖（不进入发行产物）

| 组件 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| puppeteer-core | 24.43.1 | Apache-2.0 | e2e 集成测试（无头 Chrome） |

## 说明

- `lib/` 下的组件为内置离线副本（项目约束：不引用外网 CDN 资源），升级时保持与
  `package.json` 中对应 devDependencies 的版本一致。
- 全部依赖经扫描（374 个包）无 GPL/LGPL/AGPL/SSPL/MPL 类许可证，均为宽松许可，
  可被本项目的 AGPL-3.0 + 附加条款整体再分发，条件为保留上述各组件的版权与许可声明。
- 本清单与实际打包内容不一致时，以仓库内各声明文件为准。
