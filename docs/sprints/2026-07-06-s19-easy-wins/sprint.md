# Sprint 2026-07-06 S19 —— 简单需求收口批(easy wins)

> **背景**:S18(REQ-022~038 全量批)2026-07-06 收批 13/13。用户拍板 S19「起手做一些简单需求,不要做太难的」——即低风险、自包含、可在会话内(typecheck + 单测 + 走查)验证完的卫生/债务项;**不含**真机批(需签名包 + 真机点验)、跨仓 prod(REQ-039)、需真机复现的崩溃类(B22)、大体量(REQ-005/C20)。
> **启动前置**:用户报「无法启动」→ 排查确认 = 陈旧构建产物(上一工作分支遗留的 ext/node bundle),`bun run dev` 的 predev 已按 `alpha` HEAD 重生;dev 起窗 + 首页/定制中心/自动化 三界面 CDP 截图无崩,安装版 0.1.0 正常。**判定:非代码 bug,已恢复**(用户确认「重建后已恢复」)。

## 目标
从 silent-failure 复扫(`audits/2026-07-04-silent-failure-rescan.md`)与 B20 余项里抽**确定性简单项**,一次清掉,收窄「⏭ 后续」尾巴。

## Task 表

| Task | 项 | 类 | 状态 |
|---|---|---|---|
| T1 | B11 行13:会话 rename/share/delete 失败静默 → 接 pushToast(share 顺带修「丢弃 URL」真 bug) | ux/bug | ☑ 代码完成(working tree)——`use-projects.ts` rename/delete 返 boolean;`alpha-sidebar.tsx` 三处 onClick/onKeyDown/onBlur 接 toast;share 复制链接到剪贴板;gate 绿(typecheck + 415 单测) |
| T2 | B20 行20:`Skeleton.tsx` 死代码(零引用)去留 → 删 | debt | ☑ 代码完成——`git rm Skeleton.tsx skeleton.css`(仅 self-import,零外部引用实证);typecheck 绿证无漏引 |
| T3 | B11 延伸:治理面板(REQ-037)静默失败 —— `apply()` 有 try/finally **无 catch**(`void apply()` 调用 → throw 成静默 unhandled rejection);`govRead()` 失败静默显示空 DEFAULT_GOV(有 apply 覆写真配置之虞) | bug | ☑ `governance-panel.tsx`:apply 加 catch → setErr + flash error;`!r.ok` 也补 flash;govRead 失败 → setErr(loadFailed);+2 i18n key(zh/en) |
| T4 | B11 延伸:自动化面板(REQ-024/025)静默失败 —— `save()` try/finally **无 catch**;`remove()` 无 try/catch 无反馈 | bug | ☑ `automation-panel.tsx`:save 加 catch → setFErr + toast;remove 加 try/catch → toast(列表视图无 form 错误位);+2 i18n key(zh/en) |
| T5 | 复扫行14:`createSession` 失败静默回退草稿(侧栏 startChat) | bug | ☑ 回退保留(草稿可用)+ error toast「会话创建失败,已打开草稿」;首页路径早有 toast;顺带把 T1 的硬编码 toast 文案(重命名/删除/分享)收进 i18n(zh/en),不给 C20 添存量 |
| T6 | 复扫行16:登录整链失败静默(alpha-auth 只 warn 日志)→「点了没反应」 | bug | ☑ main 四失败点(provider error/回调残缺/state 不匹配/兑换失败)推 `auth-error` code(main 无 i18n,只送 code)→ preload `auth.onError` → sidebar toast 按 code 映射文案;已知边界=深链冷启动窗口未建成事件丢失(与成功路径同界,ADR-017,注释留档);+5 i18n key(zh/en) |
| T7 | 复扫行11 残余:sidecar 连崩自愈停手只写日志(引擎死了 UI 无表示) | bug | ☑ give-up → `sidecar-fatal` 事件 → 侧栏常驻 error Banner(header 下,Banner=持久态分工)+ toast(侧栏收起也可见)+「重试」action(新 IPC `sidecar-retry`:阶梯清零 + 复用既有互斥 respawn 入口);+3 i18n key(zh/en) |
| T8 | D10 子项:index.ts 陈旧 Electron 版本注释(写 41.2,实际 42.3.3) | docs | ☑ 注释去版本化改写(「内置 Node 领先于已发布 @types/node,故 cast」)——不再随升级过期;D10 验收①②③全达成 |

## Gates
- 北极星:零改上游(guard 绿 ✔)。
- typecheck + 单测:415 pass ✔(每 task 后复跑)。
- 四件套回写:CHANGELOG [Unreleased].Fixed ✔ · 本表 ✔ · rescan audit 行13/20 翻 ✅ + 记账刷新 ✔ · BACKLOG B11/B20备注 ✔。
- [[visual-verify-required]]:**失败态 toast**(T1/T3/T4)与 **share 链接复制**(T1)= 需真机(强制 SDK/IPC 失败 + 真实会话/任务)→ 记真机批残单;happy 渲染(侧栏/首页/hub/自动化无崩)本会话 CDP 已验。

## 残单(真机批)
- 失败态 toast/err 实拍:会话操作(T1)、治理 apply/govRead(T3)、自动化 save/remove(T4)、createSession 失败(T5)、登录链四失败态(T6,需伪造回调/断网;深链路由到安装版故 dev 不可代验)——均需强制对应 IPC/SDK 失败;share happy-path(真实创建分享链接 + 剪贴板)→ 并入 REQ-016 真机批。
- **T7 已在 dev 真实全链 E2E PASS(2026-07-06 本会话)**:真杀 sidecar 监听进程 6 次 → 阶梯 5 次自愈(日志证)→ 第 6 次 give-up(`attempts:5` 日志)→ 侧栏红色常驻 Banner 上屏(截图)→ 点「重试」→ respawn(新监听 PID)+ renderer 重载 + banner 清除 + 项目列表恢复。真机批仅余打包态复验(utilityProcess 行为一致性)。

## 主题
统一收「**静默失败**」:第一批(T1–T4)= renderer 侧 `void asyncFn()` fire-and-forget 里 **try/finally 缺 catch** 或裸 `.catch(()=>{})`;第二批(T5–T7)= **main 侧只 warn 日志、renderer 无从知晓**的跨进程静默(登录链/连崩停手)+ 最后一个 renderer 静默回退(createSession)。补 catch/事件 → 用户可见反馈(toast/Banner)。T2/T8 = 顺带清死代码与陈旧注释。**复扫矩阵 20 项就此 ⏭ 清零(✅14 + 🆗6 = 100% 有反馈或有意降级)。**

## 结果
_T1–T8 代码完成 + 文档回写;gate 全绿(北极星守卫 + typecheck + 415 单测);dev 窗 CDP 冒烟:happy 渲染无回归(侧栏/新 preload API 三件在位)+ **T7 连崩→banner→重试→恢复真实全链 PASS**(见残单节);其余失败态实拍归真机批残单。_
