---
id: REQ-014
title: 悬空会话路由致「Not found」白屏 — 路由恢复前校验会话存在
type: bug
priority: P2
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-06-s21-realmachine-vnext2
source: REQ-002 联调 BP-3(audits/2026-07-03-req002-proxy-e2e.md)
---

## 背景(为什么)
`opencode.global` store 的 `tabs.recent`(`{key:"sidecar\n/server/<b64>/session/<id>"}`)与 `tabs[]` 持久化上次打开的会话路由。当被指向的会话 id 已不存在(用户删会话、DB 换库、会话 GC)时,冷启动 alpha 恢复该路由 → 整个 app 卡在左上角纯文字「Not found」白屏:**无侧栏、无首页、无任何恢复入口**,只能手工摘除 store 里的悬空指针才能救回。REQ-002 联调删测试会话后稳定复现。

## 目标(做什么)
路由恢复(读 `tabs.recent`/`tabs`)时,对每个待恢复的会话路由校验其会话是否仍存在(经 SDK `session.list`/`session.get` 或既有 projects store);不存在则跳过该条并回退首页(AlphaHome),而非把整个 renderer 渲成上游 `Not found`。

## 验收标准(可验证,逐条)
1. 构造悬空 `tabs.recent`(指向不存在会话 id)→ 冷启动 app **正常起到首页/有效会话**,不再白屏 Not found;
2. 悬空条目被静默剔除或降级(不复活死路由),有效 tab 不受影响;
3. 无悬空时行为不回归(截图核验既有会话恢复正常);
4. 关联 B11:若选择呈现「上次会话已不存在」提示,走统一错误面而非死屏。

## 非目标
- 不改上游 `Not found` 组件本身(上游只读);兜底在 alpha 路由恢复层。
- 不做会话软删除/回收站(另议)。

## 方案 / 关联
- 落点:alpha renderer 路由恢复逻辑(`ui-mac/src/renderer/*`,消费 `window.api.storeGet("opencode.global", "tabs.recent"/"tabs")`);
- 关联 [B11](B11-unified-error-surface.md)(呈现面)、REQ-002 audit BP-3。

## 验证记录
_verify 时补(S21 Track B:植形态 B 毒键 + 形态 A 悬空 id → 打包冷启动正常起屏 + main.log 预清留痕;无毒态零回归)。_

## 实现记录(2026-07-06,S21 Track A —— 方案② main 预清,两级全做)
challenge 裁决:只修格式级 = 对验收①的 placebo(Skeptic),两级全做:
- **tier-1 格式级(同步,createMainWindow 前)**:`main/tabs-preclean.ts` 清洗 `opencode.global.dat` 的 `tabs`/`tabs.recent`——session 缺 server/dirBase64/sessionId(= S17 形态 B 毒源,旧版序列化)、draft 缺 draftID、非对象条目即剔;**未知 type fail-open 保留**;recent key 不指向任何幸存 tab 即清(与上游 tabs.tsx:102 清理语义一致)。**`worktree "/"`(dirBase64="Lw")shape-only 放行**(ADR-008 全局约定,绝不按解码值剔)。
- **tier-2 存在性(serverReady 后,治形态 A)**:按 dir 经 SDK `session.list` 查证,悬空 session tab 剔 + recent 联动清;等 server 5s / 查询总预算 2.5s,**超时/查询失败/分页未尽一律 fail-open**(保持原样,绝不越修越坏)。
- **store-get gate(实现级新决策)**:ipc.ts 对该 store 的 tabs 两键首读 `await` 预清 done(promise 保证 resolve,有硬时限)→ renderer 首读必为清洗后数据;**A1 window-first 不回退**(窗口/splash/语言键不受 gate 影响)。
- 留痕:每次剔除 `[req014-preclean]` 行入 main.log(B11 反静默);16 单测(毒键样本=S17 证据原件形状/根 worktree 存活/合法态零改动/各 fail-open 路径/编排端到端)。
- 契约锚(冻结上游面,re-freeze 复查):`GLOBAL_STORAGE`(persist.ts:26)、`tabKey` 形状(tabs.tsx:36-39)、URL-safe base64(core/util/encode.ts)。

## 复现记录(2026-07-05,S17 T4 顺带活捉 —— 拍板输入就绪)
dev 实例(dev channel store)开局即循环崩溃,全链取证(证据 [audits/2026-07-05-s17-t4-c28/verify.md §2](../audits/2026-07-05-s17-t4-c28/verify.md) + `req014-poisoned-tabs-evidence.json` + store 原件备份):
- **变体形态 B(本次)**:`tabs.recent` 为**旧格式路由**(`/server/<b64>/session/<id>`,**无 dir 段**)→ 新格式解析 `route.dir=undefined` → 上游 `titlebar.tsx createDirSyncContext(route.dir)` → `pathKey(undefined)` throw → **整屏**上游 ErrorPage 循环(连带盘上有 `opencode.workspace.undefined.*.dat` 历史痕迹)。与原形态 A(悬空会话 id → Not found)同毒源(`opencode.global` 的 `tabs`/`tabs.recent`)。
- **对调查记录「关键未知」的回答**:整屏形态下 alpha 子组件全部未挂(上游边界吞掉全部 children,AlphaBoundary 也不例外)→ **方案①(renderer 守卫)对形态 B 无效**;**方案②(main 预清 store)实证可达**——删 global store 两键即完全恢复(本次手工执行即①愈)。
- **建议(待拍板)**:方案② main 预清,分两级:格式级校验(key 无 dir 段/dir 非法即剔,启动同步可做、无需 SDK)+ 存在性校验(sidecar ready 后 SDK session 查证,治形态 A);耦合面 = 上游 tab-key/base64 编码(ADR-008 已标注),须契约锚+失败 fail-open(剔不动就保持原样,绝不越修越坏)。
- **prod 风险评估待做**:本次是 dev 态旧数据;prod 用户 store 是否携带旧格式 key 待查(store 格式随版本演化,老用户可能命中形态 B)。

## 调查记录(2026-07-04,/loop 自动批 —— 为何本轮**跳过**,待拍板)
勘察结论:**本需求预设的「alpha renderer 路由恢复逻辑」杠杆并不存在**,故不是干净的决策无关小修,自动批不代拍。
- **事实**:alpha `renderer/index.tsx:411` 以 `<AppInterface router={MemoryRouter}>` 挂载,**未传 initialEntries** → MemoryRouter 初始在 `/`。**路由恢复(读 `tabs.recent` → `navigate`)由上游冻结的 `packages/app/src/context/tabs.tsx` 主理**(`useNavigate`/`persisted(tabs.recent)`),alpha 侧无恢复层可插。REQ-014「落点=alpha 路由恢复层」的假设不成立。
- **「Not found」来源**:非 `entry.tsx:99`(那是 DEV 专用 root-element 缺失错误),而是 router 级未匹配/会话 404 呈现。
- **修法二选一(= 需拍板的方案决策)**:
  1. **renderer 重定向守卫**:新增一个 AppInterface 子组件(仿 AlphaHome 路由感知),`useLocation` 观察到悬空会话路由则 `navigate("/")`。**前提**:该守卫在悬空态下**仍被挂载**。
  2. **main 预清 store**:启动待 sidecar ready 后,读 `opencode.global` 的 `tabs`/`tabs.recent`,解出会话 id,SDK 校验存在性,重写剔除悬空项。**代价**:需解析上游 tab-key 格式 `sidecar\n/server/<b64>/session/<id>`(base64 路由编码 = ADR-008 标注的**易碎耦合点**)+ 时序竞态(须早于上游 tabs.tsx 恢复导航)+ 从外部改上游持久 store 有冲突风险。
- **决定二者的关键未知**:悬空「Not found」是**整屏替换**(alpha 子组件全未挂 → 守卫①无效,只能走②)还是**布局内**(子组件在挂 → 守卫①可行)?req 描述「无侧栏、无首页」倾向整屏替换,但**须真机复现确认**——决定用①还是②。
- **裁决(/loop 批)**:方案取决于无法离线确认的运行时行为 + 触碰易碎上游耦合 → **deferred**。建议并入 [[REQ-016]] 真机批:先**复现**(造悬空 `tabs.recent` → 冷启动)观察 Not found 呈现层级,再定①/②。届时①若成立即为低风险小修;若须②则单独评估耦合。
