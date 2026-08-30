# NetTopo 代码审查报告（R4）— 2026-08-30

## 1. 执行摘要

- **结论：风险等级 B（良好）**。未发现 Critical/High；**3 个 Medium（区域拖动撤销判定、邻居表解析两处格式缺口）+ 11 个 Low + 若干 Info**。安全面干净：XSS 全量转义、CSP、IPC 守卫、路径清洗、指纹校验全部核查通过。
- **审查范围**：R3（2026-08-19）基线 commit ae1a994 → 当前 HEAD 6e3ac3c，28 文件 +6405/-368。新增功能：邻居表导入（LLDP/CDP）、链路聚合、接口总表、配置合规基线（模板/自定义/自动合规）、SNMP 重启检测与 CPU·内存采集、监控中心性能页、单点故障/故障影响分析、网段分析、区域分组、群发广播、跳板机、审计日志等。主进程安全模块、渲染层新增功能、周边与测试基建三路并行深审 + 关键发现主审逐条复核实证。
- **基线**：单元测试 **773/773 通过**（两次独立运行确认）；npm 依赖自 R3 后零变化。
- **R3 回归检查**：`monitor.js` sanitizeFilename 路径穿越**已修复且未回潮**（PoC：`..\`、UNC、绝对路径、20 万次变异 fuzz 全部零逃逸；`shell.js`/`config-backup.js` 同款实现同结论）；R2/R3 各修复项（CSP、导航守卫、web:open 校验、CSV 公式注入等）全部在位。
- **发现统计**：Critical 0 / High 0 / **Medium 3** / Low 11 / Info 13。

## 2. Medium 发现

### M-1【Medium · 正确性】区域拖动 `moved` 判定用「单事件增量」而非「累计位移」

- **位置**：`js/render.js:708`（`_startRegionDrag`）；对照同文件 `_startDrag`（`:650`）节点拖动用 `this._drag.orig[id]` 固定起点的正确口径。
- **证据**：`if (!moved && (Math.abs(nx - r.x) > 2 || ...)) moved = true;` 检查之后才执行 `r.x = nx`，比较的是相对上一次事件位置的增量。放大倍数高时（zoom→4，阈值 2 世界单位 ≈ 8 屏幕像素/事件），慢速拖动每步增量都 ≤ 2，`moved` 永不置位。
- **影响**：区域和框内设备**实际已被移动**（`r.x = nx` 与 `onDrag` 均已生效），但松手走「单击」分支调用 `onBgClick` 清除选中，且不调 `onDragEnd` → `app.js:73` 不入撤销栈。数据被改、无法一键撤销、且误清选中。
- **修复**：拖拽开始记录 `rx0 = r.x`，用 `Math.abs(nx - rx0) > 2` 判定（与 `_startDrag` 口径一致）。已复核 `app.js:55/73` 确认区域拖拽的撤销快照机制本身完整，仅 `moved` 判定失效。

### M-2【Medium · 功能缺陷】CDP detail 块的对端接口（Port ID）全部丢失

- **位置**：`js/util.js:1959-1965`（parseBlocks 的 KV 解析 else-if 链）。
- **证据**：真机 `show cdp neighbors detail` 关键行为 `Interface: GigabitEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/24`——Interface 与 Port ID **同行**。KV 正则惰性截到第一个冒号，key=`interface` 命中 `localIf` 分支后消费整行，`nbFirstToken` 取逗号前本端接口即返回；`port id` 分支永远轮不到。实测输出 `{localIf:"GigabitEthernet0/0/1", peer:"SW2.lab", peerIf:""}`。
- **影响**：commit 7365d19 声称支持「show cdp neighbors detail」，但思科 detail 的对端接口 100% 解析为空；导入弹窗「对端接口未识别也创建连线」默认勾选，生成一批对端接口留空的连线需逐条手补。
- **修复**：`interface` 键命中后对 value 再做一次 `[,，]\s*Port ID \(outgoing port\)\s*[:：]` 二次提取。建议补真机输出格式的回归测试。

### M-3【Medium · 功能缺陷】华为段头「GE0/0/1 has N neighbor(s)」第 2 个及以后邻居被静默丢弃

- **位置**：`js/util.js:1952-1956`（DEV_START 分支）。
- **证据**：段头块内两个 `Device ID:`，第一个经 `cur.localIf && !cur.peer` 填入 peer；第二个到达时 `cur.peer` 已非空，走 `flush(); cur = { localIf:'', peer:v, ... }` 新建记录，而华为段头块内没有 `Interface:` 行可回填 localIf，flush 时 `!cur.localIf` 直接丢弃——且不计入 `skipped`，预览/导入无任何提示。
- **影响**：堆叠/挂 hub 场景邻居关系静默缺失，用户以预览条数判断「解析正常」，实际拓扑不完整。
- **修复**：段头行把本段 localIf 记入 `segLocal`，flush 后新建 cur 时继承 `localIf: segLocal`；或丢弃时计入 skipped 提示用户。

## 3. Low 发现

### 主进程与安全模块

- **L-1 跳板机备份把跳板指纹记到目标主机名下**（`js/monitor.js:1454`）：`_runBackupOwn` 的 fingerprint 处理固定 `const host = job.host`，未取 `info.host`（对照 `:1230-1232` `_handleFingerprint` 的正确实现）。配置跳板机时跳板指纹写入 `monitor-trust.json` 目标主机名下，之后对目标的所有连接永久「指纹变化」fatal 拒连（fail-closed，破坏信任库完整性与备份可用性）。**一行修复**：`const host = String((info && info.host) || job.host);`
- **L-2 SNMP 响应不校验 request-id/community/来源**（`js/monitor.js:206-224`）：收到任何可解析 0xa2 PDU 即采信；rid 顺序可预测、UDP 无连接。同网段攻击者可抢答伪造 CPU/内存/sysUpTime → 假「设备重启」事件、假告警轰炸。仅数据完整性/可用性面，无代码执行。建议校验 rid 与 community 一致后再采信。
- **L-3 合规规则编译无灾难性回溯防护 + 主进程同步扫描**（`js/monitor.js:284-314`）：规则来自渲染层 localStorage，`(a+)+$` 类规则对 8MB 配置备份（`config-backup.js:15` 上限）同步逐行 test，可阻塞主进程事件循环（监控/SSH 全卡）。同文件告警关键字（`:552-553`）已有嵌套量词启发式 + 64KB 上限，建议复用。
- **L-4 sanitizeFilename 未拦 Windows 保留设备名**（monitor/shell/config-backup 三处，对照 `backup-store.js:31` 白名单）：设备名 CON/NUL 等时 mkdir/write 失败被 try-ignore 静默吞掉，监控日志永久静默丢失。建议补同款保留名拦截或失败时记可见告警。

### 渲染层新增功能

- **L-5 合规规则 `transport input ssh telnet` 混合词序漏报**（`js/util.js:896`）：规则要求 telnet/all 紧跟 `input `，真实违规配置 `transport input ssh telnet` 不命中（`telnet ssh` 词序可命中）。建议放宽为词序容忍。
- **L-6 思科 `show lldp neighbors` 标准表格不识别**（`js/util.js:1903`）：表头门槛要求含 "neighbor" 字样，思科 IOS 表头（Device ID / Local Intf / Port ID）不含 → 整表 fail-safe 拒绝。列头定位逻辑已具备，仅放宽表头条件即可。
- **L-7 H3C `display lldp neighbor-information verbose` 不识别**（`js/util.js:1933,1963`）：段头 `LLDP neighbor-information of port` 与键名 `Neighbors' system name`（带 `'s`）均不匹配现有模式。commit 声称支持 H3C，list 简表可解析、verbose 不行。
- **L-8 CDP 表格超长 Device ID 换行时整表中断**（`js/util.js:1882`）：带域名的设备 ID 独占一行时 `cells.length < 3` 即 break，实测解析 0 条（fail-safe）。建议限 1 次续行拼接。
- **L-9 separateOverlaps 无大图保护 + 收敛不足**（`js/layout.js:350`）：布局引擎 simulate 有 `N > 2500` 跳过保护，separateOverlaps 在 4 条加载路径无条件 3 pass O(n²)，实测 20000 节点约 1.7s 阻塞渲染线程；200 个完全重合节点 3 pass 后仍残留大量重叠。建议与 simulate 同口径加保护。正常规模实测正确（no-op 验证通过、重合两点正确推开）。

### 周边与性能

- **L-10 update() 每帧全量重建区域层 DOM**（`js/render.js:352,239`）：节点拖拽等高频路径每帧 `regionLayer.innerHTML = ''` 重建，O(区域数×节点数)/帧，区域多时掉帧。建议几何/zoom 未变时跳过。
- **L-11 暗色描边修复依赖同特异性源码顺序**（`css/style.css:111-115`）：`[data-theme="dark"] .node .shape` 与状态规则同特异性靠顺序获胜，当前正确；日后追加同特异性暗色规则会再次覆盖。建议状态规则提级或暗色规则用 `:where()` 包裹。

## 4. Info 发现

1. **邻居解析支持面**：思科 LLDP 表格（L-6）、H3C verbose（L-7）外，`banner motd` 含 `telnet server enable` 字样会误报禁止类规则（扫描不理解 banner 块结构）。
2. **subnetCalc 掩码越界不一致**（`js/util.js:1223`）：数字 33 → null，字符串 '33' → 回退 /24；UI 全走字符串路径无实际影响，建议统一越界即 null。
3. **sanitizeGraph aMask/bMask 未钳制**（`js/util.js:492`）：999 可通过；已核查全部下游消费点均有 0-32 钳制，建议 sanitize 层补（纵深）。
4. **applyNeighbors 新建节点 id 用全局计数器**（`js/util.js:2010`）：当前所有载入路径已 seedCounters 无冲突；建议改 used-set 式 fresh id 防未来路径遗漏。
5. **接口总表同会话勾二层+改 IP 时 IP 保留**（`js/app.js:466`）：与连线弹窗「勾二层清空 IP」口径细微出入，边角交互。
6. **合规自定义正则 UI 自伤**（`js/util.js:1040`）：渲染层逐行 test 无时限，超大配置 + 回溯正则可致 UI 长时间无响应（同信任域，非注入面）。
7. **监控首连静默 TOFU**（`js/monitor.js:1246`）：弱于 Web Shell 人工确认，属文档声明的设计；渲染层传入 expectFp 严格比对，双信任库互为补强。
8. **secure:decrypt 解密 oracle**（`electron-main.js:568`）：仅主窗口可调，明文永不落盘，架构固有边界；主窗口内 XSS 可解密全部密码。
9. **shell.js 直连参数无长度上限、会话 id 可预测**（`js/shell.js:79-99`）：monitor 路径有钳制、直连没有；会话 id `s1,s2...` 且监控与 Web Shell 共享 ShellManager 会话，shellWin 可按猜测 id 操作监控会话（同机同信任域）。
10. **监控/审计日志明文记录命令与输出**：用户把密码写进命令会落盘（功能设计）。
11. **test/e2e.html 挂具版本戳滞后**（v20260829d）：当前元素无差集可用；下次 index.html 增删 DOM 后忘记再生会复发 null 错误（449154e 修过），建议加自动生成脚本。
12. **js/visio.js（VDX）死代码**：无任何调用点（app.js:1886 实际走 VSDX），仍在 index.html 加载，建议确认废弃后移除。
13. **bump-version.js 建议加 bump 后一致性校验**（新戳计数/旧戳残留），防三份 HTML 戳与 util.js 漂移时漏替换。

## 5. 已核查无问题（安全面）

- **路径穿越**：R3 的 sanitizeFilename 已修复未回潮（PoC + 20 万次变异 fuzz 零逃逸）；config-backup `_hostDir` resolve+startsWith 兜底、`cfg_` 白名单、全路径 lstat 反 symlink、tmp+rename 原子写；日志浏览器逐级白名单；ZIP 条目名防穿越（util.js:89）。
- **XSS（重点逐点核查）**：新增全部 innerHTML/insertAdjacentHTML 使用点（邻居表预览、接口总表、网段分析、单点故障列表、故障影响弹窗、合规编辑器/模板下拉/扫描结果、监控中心性能页、事件时间线、快搜、群发对比）逐一追踪数据来源与转义——含设备输出、CSV 导入、SNMP 值等**设备侧可控数据**在内全部经 escHtml/textContent/纯数值运算；画布全 textContent；导出链路 escXml/sanitizeCell 全覆盖（聚合组新用户可控数据全链路核过）。**未发现注入点。**
- **原型污染**：合规模板 localStorage 白名单重建（Array.isArray + 逐字段重建，无递归合并），污染载荷实测无残留，未重现历史同类面。
- **CSP 与依赖**：三页 `script-src 'self'` 无 unsafe-eval/unsafe-inline、object-src 'none'；无外网资源；npm 依赖自 R3 零变化。
- **IPC**：43 个 handler/on 逐一核对，web:open/shell:open-external 限 http(s)、shell:data 1MB 限长、backup/monitor/secure 分守卫、新增 uptime/ifhistory/perfhistory 均有 monitorGuard、test-close 仅测试环境注册。
- **指纹与凭据**：TOFU 排队、SHA256 标准格式、expectFp 严格相等、变化即 fatal 拒重连；keyboard-interactive 4 轮上限且密码仅回填口令类提示；safeStorage(DPAPI) 语义未破坏；纯 Node 模块零 require('electron')。
- **参数钳制与限长**：_validate 全面钳制、ifHist/perfHist 120、告警缓冲 20000 行、单日志 32MB 滚动、BER/tlvWalk/IAC 状态机越界防护、ping 走 spawn 数组参数无 shell。
- **图算法对抗验证**：Tarjan 割点/割边迭代实现（5000 节点无爆栈）、平行链路折叠冗余、BFS 绕行、并列区域拆分口径、CIDR /0//31//32 与重叠检测、separateOverlaps no-op——全部正确。
- **浏览器降级**：合规/监控/性能订阅均探测桌面 API，纯函数功能不触碰；测试基建：773 项抽查无空跑、异步套件 catch 收尾、e2e/smoke 不入构建产物（files 白名单确认）。
- **文档同步**：README/AGENTS 抽查一致；版本戳四文件一致 v20260830b。

## 6. 修复优先级建议

1. **L-1**（一行）：`monitor.js:1454` 跳板指纹归属改用 `info.host`——性价比最高，防信任库污染。
2. **M-1**：区域拖动 moved 改累计位移口径（记录拖拽起点）。
3. **M-2 / M-3**：邻居表解析补 CDP detail Port ID 二次提取与段头 segLocal 继承，配真机输出回归测试。
4. **L-3**：合规规则编译复用同文件告警关键字的回溯启发式 + 行长/耗时上限。
5. **L-2**：SNMP 响应校验 rid/community。
6. 其余 Low/Info 随迭代处理（L-6/L-7 解析支持面、L-9 大图保护、L-10 性能）。

## 7. 结论

本批新增约 6400 行代码整体质量良好：安全纪律（转义、白名单、钳制、探测降级）执行到位，R3 问题零回潮，测试从 401 项扩至 773 项且质量扎实。扣分项集中在**邻居表解析器的格式覆盖缺口**（与 commit 声称的支持范围不符且用户无感知）与**区域拖动的撤销判定口径**。修复 3 个 Medium 后可到 A。
