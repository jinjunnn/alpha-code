# 问题分级册的核查(audit-of-the-audit)· 2026-07-02

> 对 `docs/plans/2026-07-02-problem-register-sprints-review.md`(59 条)做逐条代码核实 + 独立扫漏。
> 方法:9 路只读 agent 并行,全部 file:line 取证;区分 **ALPHA**(`packages/ui-mac|ext`,可改)与 **UPSTREAM**(`packages/opencode|core|server`,ADR-005 下不可改)。
> 结论先行:**报告可信、质量高**——59 条无一虚报,实质全部成立;但有 **1 处误诊**、**一个系统性归属缺失**、**一个整类盲区(运行时鉴权生命周期)**,足以改变执行计划。

---

## 1. 总评

- **准确性**:P0(A1–A7)7/7 实质命中,零误报;P1/P2/P3 抽查全部实质成立。仅 1 条死引用(A2 的 `bootstrap.ts:312`,符号不存在)、数处行号漂移、几处计数需修正。作为工作清单可直接采信。
- **三个必须先处理的问题**(否则照单执行会出错):
  1. **整类盲区:运行时鉴权/凭证生命周期**(见 §4 NEW-1)——env 一次性派生、respawn 不重导 → 过期重登后代理永久 401、跨账号 token 串台、BYOK 改键不生效。**"分发后必踩",报告零覆盖,应作 P0/P1 立册。**
  2. **一处误诊:B3① + T1.6**——报告说默认端点 `*.workers.dev` "违反 ADR-017 应切 alphacodeone.com";但 `alpha-config.ts` 自己的注释证明 workers.dev 是**唯一实测可用**的 host,旧自定义域 `api.tidelabs.click` **404 所有 /v1**。照 T1.6 改会把模型代理指向不路由 /v1 的 host = **越修越坏**。真问题是 workers.dev 的 GFW 可达性(平台治理缺口),非 alpha 决策违规。
  3. **系统性归属缺失**:B12/B13/B14/C17/C5/C12/D8/D9 + A6 泄漏点 + websearch orDie 均在**上游**;报告未标归属,照 sprint 实施会直接改上游 = 破北极星(NON_GOALS#3)。每条都有 alpha 侧零-fork 杠杆(见 §3)。

---

## 2. 准确性记分卡

| 层级 | 条数 | 核实结论 |
|---|---|---|
| P0 A1–A7 | 7 | **7/7 实质命中**;A4 机制被独立还原得更准(真因是打包 `build-node.ts` 缺 `OPENCODE_VERSION` define + channel=分支名绕过 `InstallationLocal` 豁免,非单纯 `local` 字串) |
| P1 B1–B20 | 20 | 全部实质成立;多条需降/升级或标上游(§3) |
| P2 C1–C22 | 22 | 全部实质成立;C10/C11/C19/D7 过重、C2/C14 过轻、C12 上游、B3①误诊 |
| P3 D1–D10 | 10 | 成立;D9 应限定"仅 dev/多渠道",prod 终端用户单库无累积 |
| 死引用 | 1 | A2 子引用 `bootstrap.ts:312 mcp.status` — 符号不存在,不影响 A2 主机制 |

---

## 3. 对报告的修正

### 3a. 高估,应降级
- **C10** = A6 的"可信 sidecar"一半,重复计数(sidecar 是本地 loopback+密码的一方进程,单独不危险)。
- **C11** 泄漏的是一次性、PKCE 绑定、短命的**授权码**(非 token);且需用户主动分享 debug zip 才外流,届时码已作废。中等,非高危。
- **C19**(Sentry)**当前休眠**:`VITE_SENTRY_DSN` 全仓无赋值 → `Sentry.init` 从不执行、零遥测。仅当发布流水线注入 DSN 才成立。
- **D7**(safeStorage 明文兜底)在 macOS-only 产品上基本是**死分支**(钥匙串恒可用)。
- **B9**(更新链)**当前休眠**:出货的 dev 渠道 `UPDATER_ENABLED=false`,更新器根本不开。= "prod 前不激活"。**但见 §4 的 wrong-owner feed——那才是 B9 真正的尖角。**
- **B13**:`busy_timeout=5000` + WAL + 单实例锁 → 并发写崩溃是低概率;`orDie` 只包 layer-open+migration,非每次写。
- **B1**:`-il` **超时会短路**、不再试 `-l` → 最坏 ~5s(非 5+5=10s);10s 仅在 `-il` 返回 Unavailable 后 `-l` 再超时才达。
- **C15**:观察者其实**全生命周期常开**(比"流式期间"更广),但逐 token 事件命中 switch 默认 no-op、QSA 扫描有 `setTimeout(0)` 去抖 → CPU 影响弱于字面。
- **D9**:是**按渠道**非按分支;prod 用无后缀 `opencode.db` → 终端用户无累积,累积只是 dev 关切。

### 3b. 低估,应升级
- **C2**:真正的尖角不是 env/headers,而是 **`args` 完全不校验** → `persistMcp` 可写入 `["node","-e",<payload>]` 到 `opencode.jsonc` = **配置期 RCE**,渲染层可达。应与 A6 同级。
- **B16**(PIPL 同意):登录**默认 platform-pays**(`alpha-auth.ts:263-268`)→ 登录后**每条 prompt 的代码/上下文**都经模型网关出境、零告知——比"云派发"这一显式动作大得多的**持续出境通道**。PIPL 是法定、中国区是既定市场 → 近硬阻断。
- **C14**(升级静默破坏面):实测 **232 个** `data-slot/aria-controls` 选择器 / 688 处、**16 处 `as any`** 抹 SDK 契约(非"40+/3 处")= 耦合面约 5–6 倍于报告。
- **C20**(i18n):`zht` 18 个 "OpenCode" 精确;但 `zh.ts` 有 19、`en.ts` 有 30 残留——brand transform 在**每个语种**只重写精选少数,爆炸半径大于报告(报告只点了繁中)。文件数 13 非 14(小)。

### 3c. 误诊(唯一实质错误)
- **B3① / T1.6**:见 §1.2。两路 agent(云、代码扫漏)独立判定:endpoint 事实真、但"违反 ADR-017"框定**被推翻**,且 T1.6 的"切 alphacodeone.com"会破坏 /v1 路由。应改为"未决项:workers.dev GFW 可达性 + token 注入时序",不要当替换方案排期。旁证:JWKS/ES256 已上线(`https://alphacodeone.com/api/jwks` 返 ES256),老代理 401 blocker 已解,故对**已登录用户**"endpoint 是 cloud MCP failed 头号嫌疑"很可能不成立,根因更可能在 token 注入时序(呼应 NEW-1)。

### 3d. 归属标注(系统性缺失)
报告把以下派进 sprint 却未标"上游归属",照单实施会破北极星。每条附 alpha 侧零-fork 杠杆:

| 条目 | 归属 | alpha 侧杠杆 |
|---|---|---|
| B12 Instance 无驱逐 / 常驻 watcher | 上游 `instance-store.ts`/`watcher.ts` | **停止在 `ui-mac/src/main/server.ts:58` 强开 `OPENCODE_EXPERIMENTAL_FILEWATCHER`**;+ 删 `/`~`` 垃圾项目、不取数 |
| B13/B14/C17/D8 DB 层 | 上游 `core/database` | 恢复本体改不了;**备份/导出/版本预检可在 ui-mac main 做纯文件操作**落 alpha |
| C5 skills 重复扫描 | 上游 | 减少 Instance 数缓解 |
| C12 CORS 过宽 | 上游 `server/src/cors.ts` | 改不了;**且 alpha 反在 `windows.ts:161-171` 主动注入 `ACAO:*` 放大**——先撤这个 |
| A6 泄漏 SITE(`...process.env` 展开) | 上游 `mcp/index.ts`/`lsp/lsp.ts` | 改不了展开;唯一 in-rule 修点 = alpha 的 `createSidecarEnv`(`server.ts:220`)env 白名单 |
| B20 websearch orDie | 上游 `core/websearch.ts:244`(非 :140) | ADR-009 keyless-for-all 是**放大器**;可 env 关闸或走自建 tool 替代 |

---

## 4. 未发现的问题(独立扫漏)

### 整类盲区:运行时鉴权/凭证生命周期(报告零覆盖)

**NEW-1 [P0/P1,分发后必踩]** 凭证→env 派生**一次性、set-if-unset、respawn 不重导**(`index.ts:213/219/224` 只启动跑一次;`applyAuthEnv` `alpha-auth.ts:142` / `injectByokKeysIntoEnv` `alpha-byok-keys.ts:121` 均 `if(!已存在)`;`respawnSidecar` `index.ts:418-438` 不调它们、`createSidecarEnv` 只快照当前 env):
- **A 过期重登永不恢复代理**:启动持过期 tokenA → 重登存 tokenB 但 `if(!ALPHA_API_KEY)` 已 false → respawn 仍用**过期** tokenA → 代理永久 401,只能退出重开。因无 refresh(B2),过期+重登是常态路径。**B2 隐含的"重登即恢复"是错的。**
- **B 跨账号串台**:`logout()`(`:302-323`)只删 `DEV_PLATFORM_TOKEN`,留 `ALPHA_API_KEY` → 登录 B 后模型代理仍用 A 的 token 计费,cloud-jobs 却用 B 的 → 身份劈裂、账单记 A。
- **C BYOK 改键不达 sidecar**:`setByokKey` 只写钥匙串(`provider-ipc.ts:20`),不重注 env/不 respawn → picker 立刻显"已配置"(读钥匙串),但 `buildAlphaModelConfig` 读 `process.env`(`alpha-models.ts:54`)仍空 → 模型 401 至重启。删键同样留陈旧 env。
- **旁**:`logout()` 后运行中的 sidecar 仍以登出用户的代理 token 全功能运行(只软锁了渲染层行)= 登出不真正停止代理/计费。

### 云路径潜伏 bug(S4 接线渲染层即引爆)
- **NEW-2 [P2]** `alpha-cloud-events.ts:37-77`:200 流无终态帧结束时**无 sleep 直接重连**(2s 退避只在 `!res.ok`/`catch`);终态帧缺 SSE `event:` 字段会被当 `"message"` → `TERMINAL.has` 漏判 → 紧凑重连风暴。`lastId=Number(ev.id)||lastId` 丢非数字 id → 重放/断点错乱。
- **NEW-3 [P2]** `cloud-ipc.ts:23-33`:job 终态后 `subs` 条目不清(仅 destroyed/显式 unsub 清)→ 二次 `cloud-subscribe` 命中 `if(subs.has)return` 空转不重订 → 重开已完成 job 详情永不收事件;map 随窗口生命周期泄漏。
- **NEW-4 [P2]** `respawnSidecar` **无互斥**(`index.ts:418-438`):并发 respawn(双"启用代理"按钮 `model-picker-inject.tsx:246,306`,或登录+改模式)→ 两次 `killSidecar` 后端口竞争 bind 失败。与 B5(20s reload 竞态)是不同机制。

### 安全增补
- **[P2]** **无 CSP**(`renderer/index.html` 无 meta + `onHeadersReceived` 只注 ACAO/ACAH)**叠加 alpha 强制 `ACAO:*`** → 即便 `nodeIntegration:false` 挡住 RCE,token/会话数据 exfil 通道仍开。是 C12 的渲染侧对偶。
- **[P2]** `open-path`(`ipc.ts:188-195`)与 `ext-install-plugin`(`ext-ipc.ts:48` 任意 npm 包入 `plugin[]` 下次启动自动执行)= 与 C2 同类的配置期/exec 触达面,渲染层可达,报告未点。
- **[P2]** `alpha-endpoints.ts` 对 discovered/pinned 端点**无 https/host 校验**(`strip()` 只去尾斜杠)→ 被篡改的 `/auth/token` 响应或 `alpha-endpoints.json` 可把带 bearer 的模型流量导向 `http://`/攻击者 host。
- **[P3]** `store` IPC 的 `name` 未净化 → `../` 可在 userData 外读写(在 C1 伞下,但具体穿越未单列)。

### 分发 / 数据丢失
- **[P1-when-prod,B9 真尖角]** 更新 feed **owner 错**:prod `publish.owner:"anomalyco",repo:"opencode"`(beta 同)→ 一旦落 ADR-012"发布走 prod",本地 `0.0.0 < 上游版本` + `allowDowngrade=true` + 启动即 `updater.start()` → **自动下载上游 OpenCode 覆盖 alpha-code**(第三方控制 payload,alpha 自己无 feed)。这不是"缺签名",是**供应链/身份**错误,应单立一行。**T2.2 必须同步改 feed 或禁更新器。**
- **[P1]** **T2.2 改名 = 数据丢失陷阱**:userData 键在 appId(`index.ts:153-155`)、SQLite 键在 InstallationChannel(`database.ts:48-54`)。改 appId → auth/keys/缓存全孤儿 + 钥匙串解密失效(ADR-017 先例);切 prod 渠道 → 开全新 `opencode.db` → **既有会话/项目全"消失"**。T2.2 验收只有"命名一致",无迁移步 → 首批用户升级即全量丢数据。
- **[P2]** 无 Electron fuses/asar-integrity(`RunAsNode` 常开 = 注入面)+ **entitlements 过宽**(`disable-library-validation`+`allow-dyld-environment-variables` = 经典 dylib 注入组合)。邻接 A7。

### 正确性 / UX
- **[P1]** `message-timeline.tsx:481` **崩溃仍开放**,59 条无一提及。06-30 flag,PR#18/19/20 均未涉;上游 virtualizer memo,疑被 alpha `timeline-inject` DOM 注入扰动 = 会话主界面崩溃级。
- **[P1/P2]** **strict-key 配置致瘫**:`config/parse.ts:40-53` 对未知 top-level key 硬抛 → 全局 `~/.config/opencode/opencode.jsonc` 失败时 `config.ts:281-289` `orElseSucceed({})` → **整份全局配置(5 MCP/模型/plugin)静默清零**,仅一行 log。B11 的 32 失败点不含 config 解析。
- **[P2 UX 诚实]** **placebo 控件**:composer 只读权限映射到 autoaccept-off(opencode 无运行时只读)、effort(低/中/高/超高)按注释"可能不改变模型推理"——用户可见控件静默不做其宣称的事。
- **[P2]** 渲染层**无 `ErrorBoundary`**:overlay 树内一处 throw(如 `ChipPopover` 读 `getBoundingClientRect`)静默白屏。
- **[P2/P3 CI 卫生]** 合并冲突守卫**当前不可达**(sync 在 dev-push 步就死,B10c 启发式根本没跑到);~20+ 继承的上游 cron workflow 在 fork 上误触(`beta`/`publish` 卡 queued = Actions 分钟燃烧 + 潜在误发布);全仓**无 lint gate**;e2e 仅 `packages/app`。

---

## 5. 报告结构性批评(方法论合理性)

- **[确认] 混淆两类证据**:A2"1283 次"、A4"152 次"、B1"267ms"、C3"145MB"、B19"连败计数"是**单机遥测**,不可从仓库复现,与代码级 `[确认]` 不同类;B19 尤其时效敏感。建议加"仓库可复现 vs 单机观测"标签。
- **重复计数(超出已承认的 B20⊂B11)**:"数据出境无同意"散在 C9(技术)/B16(法律)/C19(Sentry)/C11(授权码),"升级静默破坏"散在 C14/B10/C20——均无单一 owner。
- **Sprint 排序倒置**:A6(泄漏,阻断#2)排 S3,但 S1/T1.4-T1.5 先鼓励装/钉 MCP → **在 A6 的 env 白名单落地前扩大正是 A6 描述的攻击面**。A6 应门控 S1 的 MCP 工作。T3.1(refresh)对 NEW-1 必要不充分(不重导 env 则代理仍不恢复),且 NEW-1 的 respawn 重导、BYOK 改键生效均**无任务 owner**。
- **宏观"方向不需要改"**:架构判断对(agency 本地/determinism 上云成立),但把"架构合理"(真)与"愿景已去风险/跑通"(未证)混同——**从未有一次 A→B→A 云闭环被证明**(cloud MCP 每启动 failed、渲染层从不 dispatch、dispatch skill 未建、G4 验收明确未达),且结论依赖 alpha-platform **自述**的 "PA-22/25/26 live"(本仓不可验)。应标为"待 B 仓验证的条件性结论"。
- **§6.6 非问题清单**两条下结论偏快:LGPL(sharp/libvips)挡在产物外"未证"(应对构建后 asar 跑一次 `du`/grep,而非断言);"第三方 MCP 走 npx 不算再分发"——许可上对,但同一 npx 路径正是 A6/C2 的投递向量,归入"非问题"易被误读为"安全已清"。

---

## 6. 执行前建议(改动清单)

1. **立册 NEW-1 auth/凭证生命周期**为 P0/P1 簇,独立 sprint 槽;T3.1 扩为"refresh + 401 拦截 + **respawn 重导 env** + logout 清 ALPHA_API_KEY/停代理 + BYOK 改键触发重注"。
2. **撤回 T1.6**,B3① 改标"未决:workers.dev GFW 可达性 + token 注入时序",不做端点替换。
3. **每条先标 upstream/alpha 归属**再排期(§3d);上游条目只走 env/接缝或"接受"。
4. **重排级**:B9 拆出"wrong-owner feed"单行(prod 前 P1,含 T2.2 改 feed);A6 提前门控 S1;降级 C10/C11/C19/D7/B13(dormant/double-count);升级 C2/B16。
5. **T2.2 加数据迁移验收**(userData + 渠道 DB 一次性迁移或明确提示接受丢失)。
6. **补 P1 两条**:`message-timeline.tsx:481` 崩溃、strict-key 配置清零。
7. **给 [确认] 加证据类标签**;合并重复计数簇并指定 owner。
