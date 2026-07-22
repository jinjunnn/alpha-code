---
title: D5 — Playwright MCP 浏览器内核来源与弱网行为实测（研究计划）
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-22
review_after: 2027-01-16
---

# D5 Playwright-kernel 实测计划（light）

关闭 ADR-014 遗留 `_verify`：Playwright MCP 首次 `browser_navigate` 在真机上用哪一个浏览器内核起来、内核从哪下、弱网/中国区下是响亮失败还是静默假成功。这是**真机执行计划**——本目录（`verify.md`）即最终证据落地处。

## 与现状/上一稿的关系（relationship-to-incumbent）

优化现状，不重画。现有实现已完整、且已判定「零代码新增」（ADR-014 E14）：

- `alpha-catalog.json:178-201` 已登记 `mcp:playwright`，`installSpec.command = ["npx","-y","@playwright/mcp@0.0.77"]`，`runtimeDep = ["node"]`。安装/持久/启停复用既有 MCP 路径（`npx` 已在命令白名单，ADR-014 §8）。
- 安装预检 = `checkRuntime(tool)`（`ext-ipc.ts:65-76`）：对每个 `runtimeDep` 逐个 `which/where`。playwright 只 which 到 `node`，**内核不在预检范围**。
- 详情页运行时依赖块（`extension-detail.tsx:249-262`、`:1003-1012`）进页即 live which——同样只覆盖 `node`，看不到内核。
- 结论:**代码路径无需改动即可完成本验证**。唯一未决是运行时事实（首个 navigate 拉哪个内核），这只能桌面实测。ADR-014 把它挂在 `alpha-catalog.json:200` `_verify` + ADR-014 E14「待 A6 桌面实测」。本计划就是那次实测。

> Live-path honesty:以上「预检只 which node、内核运行时下载」全部从代码核实（`ext-ipc.ts:72`、`alpha-catalog.json:197-200`）。「首个 navigate 触发 ~150MB Chromium 下载」是 `_verify` 的**断言**，尚未在本 portfolio 真机确认——正是本计划要拍板的对象,勿当既定事实引用。

## ① 现行真实行为（只读勘破，已核实）

| 事实 | 出处 | 证据 |
| --- | --- | --- |
| install command 走 `npx -y @playwright/mcp@0.0.77` | `alpha-catalog.json:191-195` | 读到 |
| 预检只 `which node`（逐 runtimeDep） | `ext-ipc.ts:65-76`（`execFile(probe.cmd,[tool])`），`catalog.json:197-199` | 读到 |
| 内核**不**在安装/预检时下载 | `_verify`（`catalog.json:200`）+ 预检代码无内核逻辑 | 推断已核实（代码里无内核字样） |
| 内核在**首次 navigate 运行时**拉取 | `_verify`（`catalog.json:200`） | **未证**——本计划实测 |
| `--browser chrome` 复用系统 Chrome、免下载但需已装 | `_verify`（`catalog.json:200`） | **未证**——本计划实测 |

## ② OUTCOME（要产出的结论）

对每个矩阵单元记录:首个 `browser_navigate` 在**哪个内核**下启动、**下载来源**（域名/CDN）、**体积**、**耗时**、**成功或失败**及失败态形状。两条主问：

- (a) 默认 `npx @playwright/mcp@0.0.77`:首个 navigate 落在 bundled Chromium，若缺则从何处拉、多大、多久。
- (b) 追加 `--browser chrome`:是否真复用系统 Chrome、是否零下载、系统无 Chrome 时如何失败。

## ③ METHOD — 可跑的 2×2 矩阵

内核维度 × 网络维度,四格:

| | 正常网络 | 受限/弱网(china-region 模拟) |
| --- | --- | --- |
| **默认 Chromium**(`npx -y @playwright/mcp@0.0.77`) | C1 | C2 |
| **`--browser chrome`**(command 末尾加 `"--browser","chrome"`) | C3 | C4 |

执行环境铁律:

- **真 macOS 机**。不可用 sandbox/CI——沙箱**无网络**（见 MEMORY:codex-sandbox-bundle-land），跑不出下载行为,任何沙箱结果无效。
- 每格执行:装 playwright MCP → 首次发 `browser_navigate`（如 `https://example.com`）→ 抓内核进程、网络请求、耗时、结果。
- **执行顺序铁律:C1 必须先跑。** C1(默认内核 × 正常网络)是唯一能观测**真实下载来源**的格子——弱网阻断表(C2/C4)的域名不得凭空硬编码,必须从 C1 实测抓到的下载域名派生。先 C1 → 记录真实下载域名 → 再据此配 C2/C4 的阻断表 → 最后跑 C2/C4。C3(`--browser chrome` × 正常网络)可与 C1 并/后行,C4 依赖 C1 的域名清单。
- **弱网/中国区模拟(C2/C4)的 egress 阻断法**——从 C1 观测域名派生阻断表,三选一,记录所用法:
  1. 首选 `pfctl` 封 **C1 实测抓到的**内核下载域名出站(macOS 原生):对 C1 网络日志里真实命中的下载主机丢包或超时,模拟"能连但内核源拉不动"。阻断表**只列 C1 观测到的域名**,不预设 CDN 常量。
  2. 或 Network Link Conditioner(Apple 附加工具)设高延迟+低带宽+丢包。
  3. 兜底:先清 `~/Library/Caches/ms-playwright`(删已缓存内核逼真下载),再断整机 Wi-Fi 触发彻底 egress 失败。
- **阻断生效前置校验(block-bites precheck):** C2/C4 的结果只有在证明阻断真的咬住时才算数。配好 pfctl/NLC 后,先对 C1 观测到的下载域名发一次探针(如 `curl`/`nc` 到该主机),**必须 FAIL(超时/被丢包)**,才继续跑该格;若探针仍通,说明阻断没落到真实下载源(如 CDN 换了主机/走了另一域名),该格作废、回到 C1 重新观测域名。没有这道前置,「china-region OK」可能是阻断根本没咬住导致的假绿——直接违反本计划的响亮失败不变量。
- C3/C4 前需系统已装/未装 Chrome 两态各记一次(验证"需已装"分支的失败态)。

## ④ 安全面 — 失败模式(class-first 不变量)

按类枚举,非逐实例(MEMORY:instance-vs-class):

**类 A — 运行时供应链未证物。** ~150MB Chromium 在首个 navigate 运行时拉取,`which node` 预检**够不着**。安装成功 ≠ 内核可信/可用。风险:预检绿灯给用户"已就绪"的错觉,内核却在首次真用时才失败或才引入未审字节。

**类 B — 中国区 egress 失败被掩成假成功(AC 明令禁止)。** 内核下载或浏览器启动失败,而 MCP 工具调用返回貌似成功——这正是 AC「不伪装成功」要堵的静默假成功反模式。风险:agent 以为浏览器起来了,实际全空/超时。

**类 C — `--browser chrome` 换了信任面。** 该分支执行**用户系统 Chrome**(用户扩展、已登录 profile、Keychain),信任边界与 bundled Chromium 完全不同。得如实标注,不能默认静默切过去。

**必守不变量(每格实测都要判这四条):**

1. **响亮失败** — 内核缺失/下载失败/启动失败必显式报错,绝不静默降级。
2. **可诊断** — 失败带来源、字节、退出码/超时因,足以定位。
3. **绝不假成功** — 下载或启动失败时,MCP 调用不得返回成功状。
4. **预检文案诚实** — 面向用户的文案必须讲清「内核在首次使用时运行时下载」,不得让 `which node` 绿灯冒充「内核已就绪」。

## PREFLIGHT-COPY 决策(喂给后续 CODE 子票)

判定现行文案是否够诚实,给出精确改法。**先厘清「改什么/不改什么」以消歧:**

- **默认安装参数 = 确认现状(confirm-as-is 决策,非改动)**:`command = ["npx","-y","@playwright/mcp@0.0.77"]`,`runtimeDep = ["node"]`(`catalog.json:191-199`)。这是**决策**层面「维持现状不改结构」,不是 CODE 子票要动的东西——`installSpec` 结构、命令、runtimeDep 一律不碰。CODE 子票**不得**改这些参数;它们只被登记为「实测后确认无需变更」。
- **现行预检文案真相**:详情页依赖块(`extension-detail.tsx:1003-1012`)只对 `node` 显 ✓/✗;**全程不提内核**。用户看到「node ✓」极易误读为「浏览器就绪」。
- **判据 + CODE 子票唯一范围**:若实测证内核确为运行时下载(预期),现行文案**不足**。CODE 子票的**唯一交付** = 在 playwright 详情页**只补一段面向用户的诚实文案**(内核在首次使用时下载、体积、弱网可能较慢、或用系统 Chrome 免下载),**不改安装参数、不改预检结构、不新增内核预检逻辑**。默认参数保持不变属该子票内明确记载的 confirm-as-is 决策,不产生任何结构 diff。是否落此文案 → 取决于实测结论(内核确为运行时下载才落)。文案措辞禁夹 REQ 号/票号/开发术语(MEMORY:no-dev-jargon-in-ui)。

**[D5][CODE] playwright 详情页补内核下载诚实文案(子票四行体,落库时分配 REQ 号):**

- 负责哪些 AC:不变量 4(预检文案诚实)——playwright 详情页补一段面向用户的文案:浏览器内核在首次使用时自动下载(体积/来源以 C1 实测为准)、网络受限时可能较慢或失败、可改用系统已装 Chrome 免下载;文案内无任何开发术语/编号。
- 边界:仅 `extension-detail.tsx` 详情呈现层(运行时依赖块附近,`:1003-1012` 一带)+ i18n 字典;默认安装参数(`command`/`runtimeDep`,`catalog.json:191-199`)为 confirm-as-is 决策,只登记不改。
- out-of-scope:不改 `installSpec` 结构/命令/`runtimeDep`;不新增内核预检逻辑;不动 `ext-ipc.ts` 探针;ADR-014/`_verify` 改写归实测后的更新计划,不在此票。
- 退出条件:C1 实测确认内核为运行时下载后文案落地、详情页可见该段且措辞无编号/术语;若实测证内核并非运行时下载,本票以「无需变更」关闭,不产生 diff。

## ADR-014 更新计划(实测完成后)

从「待 A6/桌面实测」改写为带证据的定论:

- `alpha-catalog.json:200` `_verify`:把「A6 必须桌面实测…」替换为结论句(默认内核 = X、来源 = Y、`--browser chrome` 行为 = Z、弱网失败态 = 响亮/可诊断),并把证据指针指向本 `verify.md`。若结论稳定,可从 `_verify`(待核实)降级为普通说明。
- ADR-014 E14 修订段(文件第 36 行「未决项留 `_verify`…待 A6 桌面实测拍板」):追加一条 `修订(2026-07-xx,D5 实测)`,记四格结论 + 证据链接本 verify.md,`_verify` 关闭。

## CROSS-TICKET

- **#222(本票)**:AC「Source: `docs/requirements/D5-playwright-kernel-verify.md`」是**失效指针**——该文件不存在。权威内容 = `alpha-catalog.json:200` `_verify` + ADR-014 E14。以 issue 评论订正(见交付物),勿在关闭前留假指针。
- **#198(REQ-106)**:当前 body 已正确——写「D5 verification pending」且「本 Issue 在实测证据完成前保持 blocked-by D5」。**无需改动**,只需在 D5 落地前**维持** blocked-by、不得被误标为「D5 verified」。D5 关闭后方可解此 blocked-by。

## EVIDENCE 落地

本 `verify.md` 同目录承载四格证据:每格的截图 + 网络请求日志 + 内核进程快照 + 耗时。打包件日志须去密后附。四格齐全且不变量逐条判定,方可关 #222 / 改 ADR-014。
