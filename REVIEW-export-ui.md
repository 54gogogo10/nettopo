# NetTopo 安全审计报告 —— 导出模块 & 终端/Webview UI

**审查范围**：`js/vsdx.js`、`js/visio.js`、`js/pdf.js`、`js/shell-ui.js`、`js/webview-ui.js`、`shell.html`、`webview.html`，及相关支撑 `js/util.js`（escXml/isValidImg/normalizeWebUrl/sanitizeGraph/sanitizeTypeData）与 `electron-main.js`（web:open / shell IPC 信任边界）、`preload.js`。
**方式**：只读静态审查 + 数据流追踪，未修改任何文件。
**总体风险等级**：**B**（低风险，无 Critical/High；防御纵深良好，仅少量加固项）

| 严重级 | 数量 |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 2 |
| Info | 7 |

---

## 一、按任务逐项核查

### 1. vsdx.js（内置 ZIP + XML 导出）
**结论：XML 转义完整、无 XML 注入、无 zip-slip、图片 MIME 校验到位。**

- **XML 转义完整性 — 已核查无问题**
  所有进入 XML 文本节点/属性的用户数据均经 `escXml` 或 `ATTR`。
  - 文本节点统一走 `XRAW = U.escXml`（`vsdx.js:146`），应用于设备名 `:292`、标注 `:382`、画布文本框 `:430`、带宽图例 `:538`。
  - `escXml` 定义（`util.js:48-51`）转义 `& < > " '`，`\n`→`&#10;`，并剔除 XML 1.0 非法控制字符（`\x00-\x08\x0B\x0C\x0E-\x1F`）——既防结构化注入也防导出文件被拒开。
  - 属性值走 `ATTR`（`vsdx.js:148-149`）转义 `& " < > '`；`cell()` 使用凹坑仅接受数值/白名单十六进制色/硬编码公式，用户可控字符串不落属性（`vsdx.js:150` 注释“extra 仅允许硬编码字面量”）。
  - `pageName` 落属性用 `X`（escXml 含 `'`→`&#39;`，`vsdx.js:638`），安全。
  - **XXE/DTD/实体注入：不存在**。设备名如 `<!ENTITY x SYSTEM ...>` 会被 `<-` &lt;-` 转义，无法注入声明；`lib/xlsx` 之外的这些文件在本应用只写不解析，XT/XSD 无解析面。`.vsdx` 被 Visio 打开时无宏载荷注入（下列内容为空、无 `Char` 之外的宏结构），且 Visio 2016+ 默认禁用宏，`DocSecurity>0` 亦可设。

- **ZIP 写入器 / zip-slip（CWE-22）— 已核查无问题**
  `buildZip`（`vsdx.js:34-116`）STORE 模式，flags=0x0800(UTF-8)、method=0(STORE)，CRC32 计算正确。ZIP 条目名全部为硬编码常量（`vsdx.js:679-695`）：`[Content_Types].xml`、`_rels/.rels`、`visio/...`；媒体条目名 `visio/media/image${p.idx}.${p.ext}`（`:692`）中 `ext` 仅可能为 `png`/`jpg`（由 MIME 推导，见下），`idx` 为自增数字。**无任何条目名来自用户输入**，故无 `../`/绝对路径注入。

- **data URL 图片 MIME 校验 — 已核查无问题**
  `parseDataUrl`（`vsdx.js:134-141`）先判 MIME 含 png/jpg 才解码，否则返回 null 不嵌入；上游 `util.js:371 isValidImg` 已把合法图片限制为 `^data:image/(png|jpe?g|gif|webp);base64,`。因此进入 VSDX 的字节与 `ext` 均在白名单内，MIME 与扩展名不随用户自由选择。

### 2. visio.js（VDX XML 导出）
**结论：XML 转义完整 — 已核查无问题。**
所有用户数据经 `X = U.escXml`（`visio.js:25`）：设备名 `:169`、备注 Prop `:167`（经 `cText`，`:50-51`）、标注文本 `:232`、标注形状 Name 属性 `:235`、`pageName` 页名属性 `:350`。属性/文本位置均被正确转义，无笛卡尔注入点。颜色经 `isValidColor`（`util.js:370`）白名单。

### 3. pdf.js（手写 PDF 生成器）
**结论：无 PDF 指令注入风险 — 已核查无问题（设计上规避）。**
`buildImagePDF`（`pdf.js:133-177`）是**纯图片单页 PDF**：内容流仅固定指令 `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`（`:139`），无任何文本运算符；用户备注/设备名等在写入 PDF 前已渲染进 SVG→canvas→JPEG（`app.js:1125-1143`），**用户字符串从不进入 PDF 对象流**。因此即便备注含 `(` `)` `\` 或 PDF 指令串，也无法改变 PDF 结构。
生成文件名固定前缀＋日期 `网络拓扑图_${U.fmtDate()}.pdf`（`app.js:1144`），不含用户输入。

### 4. shell-ui.js（SSH/Telnet 终端）
**结论：终端/UI 的 XSS 面已充分缓解 — 无 innerHTML 吞远程数据路径。**
- 远程会话输出经 `onOutput → term.write(data)`（`:88`），以及重放 `term.write(item[1])`（`:132`）。xterm `write` 仅按文本/ANSI 处理，**未发现以 HTML 字符串调用 `write`、未启用任何 HTML 输出模式**。
- 状态/结束文案经 `term.write('\x1b[...]' + info.text/reason + '\x1b[0m')`（`:43`、`:82`）写为文本——安全；这些 `info` 来自主进程 shell 层（连接状态），非远端裸数据。
- 所有进入 DOM 的远程/用户数据均走安全通道：
  - 标签页标题 `textContent`（`:111-112`）或 `tabEl.title` 属性赋值（`:39`、`:81`）——属性赋值按纯文本处理。
  - 指纹确认框 host/fp 用 `escAttr`（`:57-58`）；连接对话框 saved.username 用 `escAttr`（`:369`）；快捷按钮 label/text 的 input value 用 `escAttr`（`:294-295`）。
  - 右键菜单 `ctxEl.innerHTML`（`:212-214`）的 `${it.label}` 全部为本地硬编码字符串。
  - toast 用 `textContent`（`:433`）。
- **无 document.write / eval / new Function / setTimeout(string)** 在该文件（grep 全 js 目录 `setTimeout` 均为数字回调）。

### 5. webview-ui.js（内嵌设备管理页）
**结论：URL 处理与证书/错误提示均已转义；上游校验权威。**
- **src 赋值前是否校验 http/https**：入口有三条：
  - 打开对话框/地址栏：走 `TopoUtil.normalizeWebUrl`（`:212`、`:246`），`util.js:1714-1724` 只放行 http(s)，`javascript:`/`file:`/`data:`/`vbscript:` 返回 null。
  - `onNewTab → addTab(info.url)`：`info` 由主进程 `web:open`（`electron-main.js:396-405`，`isHttpUrl` 严格校验 + 长度 2048）或 `did-attach-webview`/`setWindowOpenHandler`（`:345-352`，`/^https?:\/\//i`）发出，均为合法 http(s)。
- **错误信息 innerHTML 已转义**：`showErr` 用 `escAttr(msg)`（`webview-ui.js:41`）。
- **标签标题（远程 title）已转义**：`rec.titleEl.textContent = e.title`（`:68`）、标签 `textContent`（`:54`）——`title` 即便含 `<script>` 也只作文本。
- **证书告警** host/url/error 均 `escAttr`（`:165-167`）。
- **window.open 拦截**仅放行 http/https 转标签，其余 deny（`:88-92` + 主进程 `:345-352`）。

### 6. 两窗口 CSP 一致性
`shell.html:6` 与 `webview.html:6` 的 `script-src 'self'`（无 unsafe-eval）、`object-src 'none'`、`base-uri 'none'`、`style-src 'self' 'unsafe-inline'` 一致。差异仅按用途合理扩展：webview.html 的 `connect-src` 额外放开 `http: https:`（外窗不做内联请求，无实际掏出面）、`frame-src http: https:`（供内嵌 iframe）。**未发现 shell.html 遗漏项**；`img-src 'self' data: blob:` 在 shell 收紧，即使误插 `<img src=http://...>` 也会被 CSP 阻断，防外带良好。

### 7. 危险 API 排查
在目标 5 个 js + 2 个 html 内：**无 `document.write`、无 `eval`、无 `new Function`、无 `setTimeout/setInterval(string)`**（全部副作用在 app.js/其它模块，且不属于本审查面）。`webview-ui.js:72 executeJavaScript` 注入的是**静态脚本**（覆盖 alert/confirm/prompt、日志截断 300 字符），运行于 guest 页面、无 preload 桥、不用任何远程数据，无泄露面。

---

## 二、发现清单（按严重级）

### Low

**[L1] webview-ui.js `normUrl` 与 `normalizeWebUrl` 不一致（纵深防御缺口）**
- CWE：CWE-601 / CWE-20
- 位置：`webview-ui.js:14-18` vs `util.js:1714-1724`
- 证据：`const normUrl = (u) => { u = String(u||'').trim(); if (!/^https?:\/\//i.test(u)) u = 'http://'+u; return u; }`
- 影响：`normUrl` 不显式拒绝 `javascript:`/`file:` 等 scheme。当前不可利用——`onNewTab` 的 `info.url` 全由主进程 `isHttpUrl`（https/:-正则）把关，且不匹配 https 时强制前缀 `http://`，`javascript:alert(1)` 会变成 `http://javascript:...`（非可执行 host），`file:///C:/` 变成 `http://file:///...`。故现状安全。
- 修复建议：让 `normUrl` 直接复用 `U.normalizeWebUrl`（返回 null 时拒绝），消除两套逻辑，攻击面收窄到单一实现。

**[L2] 第三方终端库以“未版本化 vendored 拷贝”存在，无法复核 CVE**
- CWE：CWE-1104 / 供应链依赖
- 位置：`lib/xterm.js`（488,664 B）、`lib/xterm-addon-fit.js`（1,522 B）；版本仅隐含于 `package.json` 的 `@xterm/xterm ^6.0.0`。
- 证据：minified 包内无可解析版本标记；`package.json` 声明 `^6.0.0`。
- 影响：xterm 6.x 存在历史终端转义序列 DoS 类 CVE（如 CVE-2020-27567 及相关票据）。本应用把**远端设备输出直接 `term.write`**，恶意/故障设备可发送畸形转义序列造成渲染 DoS 或屏幕内容混淆。因 CSP `script-src 'self'` 阻断脚本执行，且 xterm 无 HTML 逃逸，不升至更高的代码执行级。
- 修复建议：将 vendored 库与 `package.json` 版本锁定到已修 CVE 的版本并同步升级；建立`lib/*.js` 的来源/校验记录；可选在 main 侧对输出做非法/超长转义序列的限流或清洗。

### Info

**[I1] VSDX/VDX/PDF 导出无注入面（正向）**
XML 全量转义（`util.js:48-51`）、ZIP 无 zip-slip、PDF 纯图片化设计使“备注注入 PDF 指令”无从谈起。Visio 打开无宏载荷。

**[I2] 终端 XSS 面充分缓解（正向）**
所有远端/用户数据触点走 `textContent`/`title`/`escAttr`/`term.write(文本)`，未发现未转义 innerHTML 吞远程数据；shell.html CSP `img-src 'self' data: blob:` 阻断 img 外带。

**[I3] shell/w main IPC 信任边界合格（正向）**
`shell:connect/data/resize/trust/open-external` 仅允许主/Shell 窗口来源；`web:open/cert-allow` 校验 sender 与 URL；`shell:data` 限长 1MB 并强类型字符串（`electron-main.js:421-442`）。

**[I4] webview guest 无桥、无远程数据注入（正向）**
`executeJavaScript`（`webview-ui.js:72`）为静态脚本，guest 无 preload，`allowpopups` 弹窗由主进程 http(s) 拦截。

**[I5] 图片 MIME 白名单 + 颜色/字体白名单（正向）**
`isValidImg`（`util.js:371`）、`isValidColor`（`:370`）、`TEXT_FONTS`（`:406`）、`sanitizeGraph`（`:409-481`）在数据进入导出前已做类型/白名单钳制（含坐标 1e6 钳制防超大几何）。

**[I6] 证书误信流程为用户显式选项（正向）**
自签名证书需弹窗人工“继续”，支持本次运行记忆；错误文案 `escAttr`。

**[I7] 待确认项（unverified）**
- `visio.js:167` 备注 `n.note` 长度未在导出侧截断（依赖 `sanitizeGraph` 的 `str`，无字符白名单）——量级仅为文件体积问题，且经 escXml，无法注入；标注为低风险观察项。
- `shell.html` / `webview.html` 的 `style-src 'unsafe-inline'` 是否为必须：因多处内联 `style=` 与 xterm 需要，属合理取舍；若可删可再加一层。

---

## 三、正确性 / 可维护性 / 性能观察
- `vsdx.js` STORE 模式 ZIP：`nameB.length/data.length` 与 UTF-8 标记一致，CRC/central offset 计算正确（`:66-95`）。
- `pdf.js` 手写 PDF：对象偏移/`xref`/`Length` 组装正确；JPEG 以 `DCTDecode` 直嵌，`/Length` 取 `jpegBytes.length` 准确（`:138-170`）。
- 可维护性：`vsdx.js`/`visio.js` 各维护一套 Visio 几何生成，重复度较高，但为“最可靠渲染”作了成本与可读性取舍，可接受。
- 性能：图片 dataURL 每次导出重新 `b64ToBytes` 解码并 CRC（`vsdx.js:119-133,56`），图片较多时重复计算，无缓存；量级小，非瓶颈。

## 四、总体评价
导出链路（VSDX/VDX/PDF）在 XML 转义、MIME 白名单、ZIP 路径与 PDF 内容上均无可利用漏洞，属于防御良好的实现；终端与 webview UI 的远程数据 XSS 面通过 `textContent`/`escAttr`/CSP 多重缓解，未发现未转义注入点，且主进程 IPC 对来源与 URL 做了权威校验。整体为**低风险（B 级）**。剩余 Low 项均为纵深防御加固（统一 URL 校验实现、vendored 依赖版本化与 CVE 复核），建议随迭代处理，不阻塞发布。

**推荐下一步**：① 将 `normUrl` 收敛到 `U.normalizeWebUrl`；② 锁定并升级 vendored xterm 版本、补充第三方库来源记录；③ 对远端终端输出做超长/畸形转义序列的限流；④ 可选复查 app.js（非本次范围）中大量 `innerHTML` 拼接点的转义（如 `webview/html` 之外的设备列表/日志渲染，均已用 `U.escHtml`，但建议统一回归）。
