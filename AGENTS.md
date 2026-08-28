# AGENTS.md — NetTopo 工作区指引

## 项目定位
纯本地、零后端的网络拓扑设计与管理软件：Electron 桌面版为主，同一套前端代码可直接用浏览器打开 `index.html` 运行。功能包括 CSV/Excel 导入导出、PDF/PNG/Visio(VSDX) 导出、拓扑编辑校验、Web Shell（SSH/Telnet 多标签）、设备静默监控与配置备份、托盘常驻。
UI 文案、代码注释、commit 信息均为中文，请保持一致。

## 常用命令
```bash
npm start                          # 开发运行（Electron）
node test/run-tests.js             # 单元测试（纯 Node，当前 433 项；改动后必跑且须全绿）
cd test && npm i && node e2e.js    # 无头 Chrome e2e（需本机 Chrome）
node test/smoke-shell.js           # Electron 冒烟（需桌面环境）：另有 smoke-backup / smoke-center / smoke-monitor
npm run build                      # bump-version.js 自动升版本 + electron-builder 便携版打包（dist/portable）
node bump-version.js --dry-run     # 预览版本变更不写入
```
Linux 包由 `build/electron-builder-linux.yml` 交叉打包（产物不入库）。

## 架构边界
- **渲染层**（浏览器兼容）：`index.html` 按 util→model→layout→visio→vsdx→pdf→render→app 顺序以普通 `<script>` 加载；**无 ES modules、无打包器**，模块间靠全局对象（`js/util.js` 的 `U`）。画布/交互在 `render.js`，业务在 `app.js`，数据转换/校验在 `model.js`。
- **主进程纯 Node 模块**（头部注明「不依赖 Electron」，可在 Node 测试中直接调用）：`js/shell.js`（SSH/Telnet ShellManager）、`js/monitor.js`（定时采集/日志归档）、`js/backup-store.js`（工程备份库）、`js/config-backup.js`（设备配置备份库）。这些模块不得 `require('electron')`，仅由 `electron-main.js` 经 IPC 桥接给渲染层。
- `preload.js` 是渲染层↔主进程的唯一 contextBridge 安全桥。
- `shell.html`+`shell-ui.js` = Web Shell 独立窗口；`webview.html`+`webview-ui.js` = 设备管理页窗口（三页面各有 CSP）。
- `lib/` 为内置离线第三方库（xlsx/xterm），勿修改。

## 硬性约束
- **CSP 无 'unsafe-eval'**：三个页面的 script-src 仅 'self'——任何代码禁用 eval / new Function，禁止引入外网 CDN 资源（一律本地化进 lib/）。
- **版本号唯一来源**是 `js/util.js` 的 `U.APP_VERSION = 'v<YYYYMMDD><字母>'`。不要手改其他文件里的版本令牌：`bump-version.js` 会全局替换 index/shell/webview 三份 HTML 中的日期字母戳（含 `?v=` 缓存参数）并同步 package.json/package-lock.json；因此勿把该日期戳写进这三份 HTML 作他用。
- 渲染层代码保持浏览器降级可用：Web Shell/监控/备份等属桌面专属能力，须经 preload 暴露的 API 探测判断，不可在浏览器路径直接调用。
- 所有本地文件/日志/备份路径必须走白名单式文件名清洗（见 `monitor.js` 的 sanitizeFilename），杜绝路径穿越；正则字符类必须独立匹配。
- 密码经 safeStorage(DPAPI) 加密落盘；SSH 主机指纹首连展示 SHA256 并记忆、变化即拒连——改动监控/备份逻辑时不得破坏这些语义。
- Linux 下 root 运行自动追加 `--no-sandbox`（electron-main.js 兜底），勿移除。

## 测试与提交惯例
- 交付前跑 `node test/run-tests.js` 全绿；UI 改动截图走查。
- commit 用中文一句话描述行为变化；一次修复/功能收尾时运行 `npm run build` 升版本，并单独提交「版本升级 vA → vB …」。
- `test/_*.js` 及 debug/repro 脚本为临时调试产物（多已 gitignore），不是正式测试用例。

## 参考
`README.md` 是完整的功能清单、表格格式与项目结构说明，改敏感区域前先读对应章节。
