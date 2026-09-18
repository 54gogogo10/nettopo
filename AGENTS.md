# AGENTS.md — NetTopo 工作区指引

## 项目定位
纯本地、零后端的网络拓扑设计与管理软件：Electron 桌面版为主，同一套前端代码可直接用浏览器打开 `index.html` 运行。功能包括 CSV/Excel 导入导出、PDF/PNG/Visio(VSDX) 导出、拓扑编辑校验、Web Shell（SSH/Telnet 多标签）、设备静默监控与配置备份、托盘常驻。
UI 文案、代码注释、commit 信息均为中文，请保持一致。

## 常用命令
```bash
npm start                          # 开发运行（Electron）
node test/run-tests.js             # 单元测试（纯 Node，当前 2159 项；改动后必跑且须全绿）
cd test && npm i && node e2e.js    # 无头 Chrome e2e 集成测试（需本机 Chrome）
node test/gen-e2e.js               # 从 index.html 再生 e2e 挂具（index.html 结构变化后重跑，再跑 e2e.js 验证）
NETTOPO_LAB_HOST=<实验机IP> node test/live.js   # 真机集成测试：自动在实验机部署多台 FRR 设备后跑全链路（未设变量则打印说明并跳过）
NETTOPO_LAB_HOST=<实验机IP> node test/gui-live.js  # 真机 GUI 集成测试：同一实验环境上驱动 Electron 界面（未设变量则跳过）
node test/smoke-shell.js           # Electron 冒烟（需桌面环境）：另有 smoke-backup / smoke-center / smoke-monitor / smoke-cred（统一凭据库）/ smoke-alertdeps（告警依赖抑制）/ smoke-backupignore（配置变更忽略规则）/ smoke-teampack（团队基线包）/ smoke-sla（可用性报表）/ smoke-l2（二层推断）/ smoke-underlay（平面图底图）/ smoke-eventack（事件确认）/ smoke-alertsound（告警等级与分级提示音）
npm run build                      # bump-version.js 自动升版本 + electron-builder 便携版打包（dist/portable）
node bump-version.js --dry-run     # 预览版本变更不写入
```
Linux 包由 `build/electron-builder-linux.yml` 交叉打包（产物不入库）。

## 架构边界
- **渲染层**（浏览器兼容）：`index.html` 按 util→model→layout→visio→vsdx→pdf→render→app 顺序以普通 `<script>` 加载；**无 ES modules、无打包器**，模块间靠全局对象（`js/util.js` 的 `U`）。画布/交互在 `render.js`，业务在 `app.js`，数据转换/校验在 `model.js`。
- **主进程纯 Node 模块**（头部注明「不依赖 Electron」，可在 Node 测试中直接调用）：`js/shell.js`（SSH/Telnet ShellManager）、`js/monitor.js`（定时采集/日志归档）、`js/backup-store.js`（工程备份库）、`js/config-backup.js`（设备配置备份库）、`js/credential-store.js`（统一凭据库：口令经宿主注入的 safeStorage 适配器密文落盘，明文不回渲染层）、`js/alert-deps.js`（告警依赖抑制：按拓扑邻接与探测状态裁决根因，归并下游离线通知）、`js/alert-level.js`（告警等级与分级提示音：四级等级表、事件默认等级、音型规格与设置归一化，双形态导出，渲染层经 globalThis.TopoAlertLevel 使用）、`js/event-ack.js`（事件时间线确认：确认留痕/备注清洗/未确认计数）、`js/sla-report.js`（可用性 SLA 报表：区间统计、中断切分、日汇总降级口径）、`js/l2-topo.js`（二层拓扑推断：BRIDGE-MIB varbind 解析与转发表交集推断，双形态导出，渲染层经 globalThis.TopoL2 使用）、`js/svc-tftp.js` / `js/svc-ftp.js` / `js/svc-syslog.js`（内置 TFTP/FTP/Syslog 服务器）、`js/net-services.js`（网络服务管理器）。这些模块不得 `require('electron')`，仅由 `electron-main.js` 经 IPC 桥接给渲染层。
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
- 改动涉及真实设备互操作（SSH/SNMP/Syslog/Trap/TFTP/FTP/配置备份）时，另跑 `test/live.js` 真机集成测试：
  它会在 `NETTOPO_LAB_HOST` 指定的实验机上自动部署多台 FRR 设备（netns + sshd + snmpd + telnet vty，见
  `test/live-lab.sh` 头部注释）并跑 A–E 五组全链路；实验环境自建自拆，不动系统策略（AppArmor 用 aa-exec 局部绕过）。
- 改动涉及**界面**与真实设备的联动（Web Shell/设备监控/监控中心/配置备份/网络服务/诊断工具箱）时，再跑
  `test/gui-live.js`：同一实验环境上启动 Electron 并用 CDP 驱动界面，验证「界面 → 主进程 → 真实设备」整条链路（G1–G18）。
  两者共用 `test/lab-lib.js`（环境部署与控制通道）；界面逻辑本身的回归仍由 `test/smoke-*.js`（mock 服务器）覆盖。
- commit 用中文一句话描述行为变化；一次修复/功能收尾时运行 `npm run build` 升版本，并单独提交「版本升级 vA → vB …」。
- `test/_*.js` 及 debug/repro 脚本为临时调试产物（多已 gitignore），不是正式测试用例。

## 参考
`README.md` 是完整的功能清单、表格格式与项目结构说明，改敏感区域前先读对应章节。
