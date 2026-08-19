# NetTopo 代码审查报告（R3）— 2026-08-19

## 1. 执行摘要

- **结论：风险等级 B（良好）**。未发现可远程利用的 Critical/High 级漏洞；**1 个 Medium（监控日志路径穿越回归，已实证复现）** + 9 个 Low 加固项 + 若干 Info。建议修复 Medium 项与低垂果实后发布。
- **审查范围**：全部跟踪源码 —— electron-main.js、preload.js、js/ 全部 15 个模块（约 750KB）、3 个 HTML 入口、lib/（SheetJS/xterm）、构建脚本、bump-version、测试基建（run-tests 401 项）、git 历史秘密扫描。方法：本人逐文件深读主进程 + 4 个并行子代理分审渲染层 + 3 个实证 PoC 复现 + 官方源 npm audit + 全量测试基线。
- **基线**：单元测试 **401/401 通过**；`npm audit --registry=https://registry.npmjs.org` **0 漏洞**；git 历史无生产凭据泄露（仅测试 fixture 私钥，见 F-11）。
- **新回归**：`js/monitor.js:20` 的 `sanitizeFilename` 正则在 R3 修复提交（8b49cf4）中被写坏，导致**监控日志目录路径穿越**（Medium，F-1），已用 PoC 实证。上一轮 R2 修复（CSP、escXml、sanitizeCell、导航守卫、web:open 校验等）全部在位并经抽查验证。
- **发现统计**：Critical 0 / High 0 / **Medium 1** / Low 10 / Info 10。

## 2. 安全发现（按严重度）

### F-1【Medium · CWE-22】监控日志目录路径穿越（sanitizeFilename 正则失效）

- **位置**：`js/monitor.js:20`；影响点 `monitor.js:409`（`_deviceDir`）、`:419-424`（日志文件名）、`:346`（`openLogs`）。
- **证据**：`out.replace(/\/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')` —— 正则要求「字面 `/` 后紧跟类内字符」，实际**永不匹配任何字符**（`config-backup.js:21` 的同名函数写法正确）。PoC 实证（`node .review-tmp/path-trav-poc.js`）：
  ```
  sanitizeFilename("..\..\escape") = "..\..\escape"   （原样保留）
  _deviceDir = C:\Users\...\Temp\poc-escape            （逃出 logBaseDir）
  escaped: true
  ```
  设备名 `..\poc-escape` 使日志文件写到了监控目录之外。
- **影响**：设备名（来自导入工程/表格，用户可控）进入 `path.join(logBaseDir, name)`。攻击链：恶意 `.nettopo`/CSV 携带设备名 `..\..\AppData\Roaming\...` → 用户在「设备监控」配置并成功连接后，日志目录与 `<设备>_<主机>.log` 文件被创建在用户配置目录任意位置。读取侧（`electron-main.js:571-633` 的 `safeLogComponent` + 符号链接拒绝）有防护，故为**只写穿越**；文件内容格式为 `[时间戳] 设备输出行`、扩展名 `.log`，不直接可执行，但可在用户目录任意位置种植目录/文件、干扰其它应用、占满磁盘。另含功能性缺陷：设备名含 `:`（Windows 非法字符）时日志写入静默失败。**该 bug 由 R3 修复提交引入**（`git log -S` 确认 8b49cf4）。
- **修复**：改用与 `config-backup.js:21` 相同的正则 `/[\\/:*?"<>|\u0000-\u001f\u007f]/g`，并额外剔除 `..` 与首尾点号；在 `_validate` 对 `name`/`host` 做同款约束；补一条单元回归。

### F-2【Low · CWE-23】配置导出 ZIP 条目名穿越（zip-slip 生成面）

- **位置**：`js/app.js:481` + `js/util.js:85-149`（`U.zipFiles`）。
- **证据**：条目名 = `vendor + '/' + 设备名 + '.txt'`，设备名未经路径消毒。PoC（`node .review-tmp/zip-slip-test.js`）生成的 ZIP 含条目 `"huawei/..\..\..\Users\Public\evil.txt"`。
- **影响**：用户自建的本地 ZIP；用不校验路径的工具解压可能把文件写到目标目录之外。攻击者为导入恶意工程者本身，影响有限，但属不该有的纵深缺口（VSDX 导出无此问题，条目名全为硬编码）。
- **修复**：`U.zipFiles` 内拒绝含 `..`、`/`、`\` 的条目名（或统一走文件名安全化）。

### F-3【Low · CWE-1236】CSV 公式注入防护的零宽字符绕过

- **位置**：`js/util.js:220-225`（`U.sanitizeCell`）。
- **证据**：先剥 `^[\s\uFEFF]+` 再判 `^[=+\-@]`，已修复 R2 的前导空白绕过；但 `\s` 不含零宽空格 `\u200B`，单元格 `\u200B=1+1` 不加前缀（Excel 打开是否 trim 零宽符行为未证实，unverified）。
- **修复**：判定前额外剥离 `\u200B\u200C\u200D\u2060` 等零宽字符。

### F-4【Low · CWE-1321】localStorage 原型污染面（自定义配置模板合并）

- **位置**：`js/util.js:1052-1054`（`loadCustomCfgTemplates`）+ `:1047`（`Object.assign({}, U.CONFIG_TEMPLATES, U.customCfgTemplates)`）。
- **证据**：`JSON.parse` 结果原样赋值；若 localStorage 被本地篡改为含 `{"__proto__": {...}}`，`Object.assign` 会改写合并对象原型。纯本地、需先控制 localStorage（当前无注入入口写入该键），影响低。同类问题在 `subnetNames`（`app.js:1276/2709` 原始引用，仅造成界面文案混淆，textContent 渲染）。
- **修复**：与 `sanitizeTypeData` 同款 `SAFE_KEY` 键白名单重建。

### F-5【Low】`globalThis.__topo` 调试钩子常驻暴露明文监控密码

- **位置**：`js/app.js:4494-4520`。
- **证据**：`globalThis.__topo = { state, ... }`（`:4496` 直接暴露整个 `state`，含 `state.monitorCfg` 明文密码）；`:4513-4519` 单独做了脱敏的 `monitorCfg` getter，但被 `state` 直出绕过。e2e 测试依赖该钩子（`test/e2e.js` 检查 `window.__topo`）。
- **影响**：纵深防御项。渲染层一旦出现 XSS，攻击者本可读同一上下文，但常驻暴露使密码可被任何页面脚本一把抓走。同上下文下 `topoSecure.decryptSecret` 也可解密密文（设计使然）。
- **修复**：钩子挂载条件改为环境变量/查询参数（如 `?__topo=1`）或仅 dev 构建；至少不再直出 `state`。

### F-6【Low】webview 分区下载绕过「另存为」对话框

- **位置**：`electron-main.js:735-740`（`will-download` 仅注册在 `defaultSession`）vs `:743`（webview 使用 `persist:nettopo-web` 分区）。
- **证据**：设备管理页（远程不可信内容）所在分区的会话没有 `will-download` 处理器，下载走 Electron 默认行为（静默保存到系统下载目录，无文件名/类型白名单）。
- **修复**：在 `session.fromPartition('persist:nettopo-web')` 上注册 `will-download`，强制另存对话框或校验扩展名。

### F-7【Low】webview 证书信任按主机名不按证书指纹（TOFU 不固定证书）

- **位置**：`electron-main.js:751`。
- **证据**：`if (allowedCerts.has(host)) { callback(true); return; }` —— 用户「记住」的只是 host。之后该主机**任何**无效证书（含被中间人替换的证书）都被静默接受，与 SSH 侧按指纹固定的 TOFU（`shell.js:127-150`）不一致。
- **修复**：`allowedCerts` 改为记录 `host + certificate.fingerprint`，指纹变化重新询问。

### F-8【Low】vendored xterm 未版本化 + 远程输出直写终端解析器

- **位置**：`lib/xterm.js`（488KB，无可解析版本标记）、`lib/xterm-addon-fit.js`；`js/shell-ui.js:88/132`（远程会话输出 `term.write`）。
- **证据**：xterm 6.x 存在历史转义序列 DoS 类公告（子代理引用 CVE-2020-27567，具体编号 unverified）；恶意/故障设备可发送畸形转义序列造成 Shell 窗口渲染 DoS 或屏幕混淆。CSP `script-src 'self'` 阻断脚本执行，不升至代码执行。
- **修复**：锁定并升级 vendored 版本、建立 `lib/*.js` 来源记录；对终端输出做超长/畸形转义序列限流。

### F-9【Low】`webview-ui.js` 的 `normUrl` 与 `normalizeWebUrl` 双重实现不一致

- **位置**：`js/webview-ui.js:14-18`（`normUrl`）vs `js/util.js:1714-1724`（`normalizeWebUrl`）。
- **证据**：`normUrl` 不显式拒绝 `javascript:`/`file:` 等 scheme，仅"非 http(s) 一律补 `http://` 前缀"。当前不可利用——`onNewTab` 的 `info.url` 全部由主进程 `isHttpUrl`（`electron-main.js:375-377`）把关，且不匹配时强制前缀后 `javascript:alert(1)` 会变成非可执行 host 的 `http://javascript:...`。属"两套逻辑"的纵深缺口。
- **修复**：`normUrl` 直接复用 `U.normalizeWebUrl`（返回 null 时拒绝），攻击面收敛到单一实现。

### F-10【Low】CSV/XLSX 导入路径不经过 `sanitizeGraph`（纵深不一致）

- **位置**：`js/model.js:233-245`（`textToGraph`/`xlsxToGraph`）+ `js/app.js:174-212`（`handleImport`→`loadGraph`）。
- **证据**：工程/备份路径（`applyProjectData` `app.js:1257-1291`）统一 `sanitizeGraph`（ID 白名单、坐标钳 ±1e6、长度截断）；导入路径直接 `state.nodes = graph.nodes`，丢失名称限长、坐标钳制、字段截断。所有渲染点均已转义，XSS 边界仍成立；残留为几何 DoS（CSV `x=1e300`）与超长字段。
- **修复**：`loadGraph` 内统一过 `U.sanitizeGraph`。

### F-11【Low · CWE-835】力导向布局 O(n²) 无节点上限

- **位置**：`js/layout.js:44-56`（斥力 O(n²)）、`:150-157`（`layoutNow` 同步）。
- **证据**：数千节点的工程 → 渲染线程长时间卡死（用户自触发）。`sanitizeGraph` 已钳坐标缓解，未限总数。
- **修复**：装载时设节点/链路总数上限（如 2000）或分批布局。

### F-12【Info】测试私钥提交入库

- **位置**：`test/fixtures/selfsigned.key`（git 跟踪，全部 43 个提交历史可见）。
- **影响**：仅 smoke-shell 测试的本地 TLS 服务器使用，非生产凭据；但提交私钥属不良实践。
- **修复**：文档标注为一次性测试密钥，或改为测试时动态生成。

### F-13【Info】`启动.bat` 以 HTTP 暴露整个项目目录

- **位置**：`启动.bat`（`python -m http.server 8765` / `npx --yes http-server -p 8765`）。
- **影响**：浏览器模式把整个仓库（含 node_modules、dist、源码）暴露到 localhost:8765；仅本机可访问，浏览器模式无 preload 桥，风险低。`npx --yes` 不固定版本（供应链面小）。
- **修复**：限定 `--directory` 只发布 index.html 所需文件；npx 固定版本。

### F-14【Info】键盘交互认证对所有提示回填密码

- **位置**：`js/shell.js:111-113`。
- **证据**：`keyboard-interactive` 对**每个** prompt 都 `respond([o.password])`；若服务器先问密码再问 OTP，OTP 位置也会收到密码。发给目标服务器本身，非外泄，但属凭据处理欠严谨。
- **修复**：仅应答首个密码类提示，其余回空。

### F-15【Info】杂项

- 监控密码明文驻留渲染层内存（`app.js:32/3416`；落盘经 safeStorage 加密，运行需解密，属合理权衡）。
- `shell.js:28-29` port 未钳制 1-65535（monitor.js 有钳制；异常端口仅致连接失败）。
- `package.json` 依赖使用 caret 范围（`^43.3.0` 等；lockfile 已锁定可复现，建议 build 前校验 lockfile）。
- 根目录与 `test/` 下各有一个空的 `NVIDIA Corporation/umdlogs` 目录（未跟踪，疑似误生成）。
- `build/*.ps1` 诊断脚本硬编码旧机器路径 `D:\codex\nettopo`（gitignored）。
- 导入无文件大小上限（本地内存 DoS，用户自触发，R2 已接受）；`shell:connect` 无频率限制（R2 已接受）。
- 配置生成 `{placeholder}` 替换（`util.js:1073`）对含换行/花括号的设备名无输出卫生处理——产物为纯文本 `.txt`/`.zip`（textarea 展示非 HTML），非注入漏洞，仅可能产生行结构错乱的配置文件（可选加固）。
- 无专门 `escAttr` 函数——但全部属性上下文均为双引号 + `U.escHtml`（`& " < > '` 全转义），未发现不可信数据进入单引号/无引号属性，已分析安全（维护提示）。

## 3. 正确性 / 可维护性 / 性能

| 级别 | 位置 | 问题 | 状态 |
|---|---|---|---|
| 低 | js/layout.js:274,298 | BFS `q.shift()` O(n²)（R2 已记录） | 未改 |
| 低 | js/layout.js:49-51 | 抖动同为零理论除零 NaN | 未改（概率近零） |
| 低 | js/render.js:555,588 | 指针捕获失败无 pointercancel 清理 | 未改 |
| 低 | js/vsdx.js:377-378 | 单 `<pp>` 与 VDX 逐行 `<pp>` 不一致 | 未改（需真机验证） |
| Info | js/app.js:176,693,1028 | XLSX 缺失提示「需联网」与本地静态副本事实不符 | 未改（文案） |
| Info | js/visio.js:167 | 备注导出未在导出侧截断（依赖 sanitizeGraph） | 观察项 |
| Info | util.js:1052 | 配置模板自定义 key 未白名单（并入 F-4） | 待修 |

## 4. 正向观察

- **架构级安全**：三窗口 `contextIsolation + sandbox + 无 nodeIntegration`；CSP `script-src 'self'`（无 unsafe-eval，R2 已实证无 eval 依赖）；`object-src 'none'`、`base-uri 'none'`；导航守卫（宿主仅 file:// + window.open deny，webview guest 豁免）。
- **IPC 边界**：`shell:*`/`backup:*`/`monitor:*`/`web:*`/`secure:*` 全量 sender 校验（仅对应窗口 webContents）+ 数据限长 + 字符串类型强制；`web:open` 限 http/https + 2048 长度；`shell:data` 1MB 限长。
- **渲染层转义纪律**：抽查确认监控日志查看器（远程设备输出逐行 `U.escHtml`）、配置备份 diff、监控中心时间线、连接弹窗、面板/选中卡、shell-ui（textContent/escAttr/term.write 文本）、webview-ui（escAttr + URL 白名单）、render.js（createElementNS + textContent，唯一 innerHTML 为静态 ICONS）、pdf/vsdx/visio/报告导出（escXml + 属性 ATTR）**全部正确转义**。
- **SSH TOFU**：SHA256:base64 指纹展示、首连暂停握手、指纹变化拒连（防中间人）、同主机多会话排队；密码仅内存、不落盘、不进日志（grep 实证零密码日志）。
- **凭据落盘**：监控密码经 `safeStorage`（Windows DPAPI）加密后写 localStorage；解密仅按需回内存。
- **备份/日志存储**：文件名白名单 + Windows 保留名拒绝 + 符号链接拒绝 + 大小上限（64MB/8MB/4MB/32MB 各级）+ 临时文件原子改名 + 滚动清理。
- **数据清洗**：`sanitizeGraph`/`sanitizeTypeData` 白名单重建（ID 正则、坐标钳制、颜色/字体/图片 MIME 白名单）；`normalizeWebUrl` 拒绝 javascript:/data:/file:/vbscript:/about:（含大小写变体，实证）。
- **SheetJS**：vendored 0.20.3，原型污染实证免疫（`__proto__` 键被改写为 `__proto___NaN`）。
- **依赖**：官方源 `npm audit` 0 漏洞；install 脚本仅 ssh2/electron-winstaller/cpu-features（知名包）。
- **测试**：401/401 全绿（覆盖 Web Shell、TOFU、备份库、数据清洗、布局、路径、性能、回归）；e2e + 3 个 Electron 冒烟；便携版已重新打包且 asar 与源码同步。

## 5. 建议下一步

1. **优先修复 F-1（Medium 路径穿越）**：monitor.js 正则改回正确写法 + `..` 剔除 + 单元回归；重新打包便携版。
2. 顺手修复低垂果实：F-2（ZIP 条目名消毒）、F-3（零宽字符）、F-4（模板键白名单）、F-10（导入统一 sanitizeGraph）、F-7（证书指纹固定）。
3. 中期：F-5（__topo 钩子收敛）、F-6（webview 分区 will-download）、F-8（xterm 版本锁定/升级）、F-9（normUrl 收敛）、F-11（节点总数上限）。
4. 用真实 Visio 验证 vsdx `<pp>` 一致性；补 smoke-backup/smoke-center 冒烟回归。
5. 保持关注 Electron/ssh2 上游更新节奏。

---

## 6. 修复记录（R3-fix，2026-08-19，用户确认「修改」）

| 编号 | 修复 | 文件 |
|---|---|---|
| F-1 | `sanitizeFilename` 正则改回独立字符类 + 剔除 `..`/首尾点号空白 | js/monitor.js |
| F-2 | 配置 ZIP 条目名源头消毒 + `U.zipFiles` 条目名过滤（拒 `..`、`\`、绝对路径、盘符、NUL） | js/app.js、js/util.js |
| F-3 | `sanitizeCell` 额外剥离零宽字符 `\u200B\u200C\u200D\u2060` | js/util.js |
| F-4 | `loadCustomCfgTemplates` 键白名单 + 危险键黑名单（`__proto__`/`constructor`/`prototype`）；`sanitizeSubnetNames` 新增并用于工程/恢复路径 | js/util.js、js/app.js |
| F-5 | `__topo.state` 经 Proxy 拦截 `monitorCfg` 返回脱敏视图（测试兼容） | js/app.js |
| F-6 | webview 分区 `persist:nettopo-web` 注册 `will-download` 另存对话框 | electron-main.js |
| F-7 | 证书信任改为「主机 + 指纹」（`allowedCerts` Set→Map，指纹变化重新询问） | electron-main.js |
| F-8 | `@xterm/xterm`/`@xterm/addon-fit` 版本精确 pin；lib 增加来源注释 | package.json、package-lock.json、lib/xterm.js、lib/xterm-addon-fit.js |
| F-9 | `normUrl` 收敛复用 `U.normalizeWebUrl`，addTab 拒绝危险协议 | js/webview-ui.js |
| F-10 | `loadGraph` 导入路径统一过 `U.sanitizeGraph` | js/app.js |
| F-11 | `simulate` 大图钳制（>2500 节点跳过 O(n²) 斥力/碰撞分离） | js/layout.js |
| F-13 | 启动.bat 服务器绑定 127.0.0.1（python --bind / http-server -a） | 启动.bat |
| F-14 | keyboard-interactive 仅首个提示回填密码，其余回空 | js/shell.js |
| F-15 | shell.js port 钳制 1-65535；导入文件 20MB 上限；NVIDIA 空目录清理 | js/shell.js、js/app.js |

**回归验证**：单元测试 **417/417 通过**（新增 16 项：sanitizeFilename 路径穿越、sanitizeCell 零宽、ZIP 条目过滤、模板键白名单、subnetNames 清洗、大图布局钳制）；`npm audit`（官方源）**0 漏洞**；全部改动文件 `node --check` 语法通过；路径穿越 PoC 复测确认日志路径不再逃出。

---

*证据与复现：`node .review-tmp/path-trav-poc.js`、`node .review-tmp/zip-slip-test.js`、`node .review-tmp/xlsx-pp-test.js`（审查后已清理临时目录）。*
