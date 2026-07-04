---
id: REQ-014
title: 悬空会话路由致「Not found」白屏 — 路由恢复前校验会话存在
type: bug
priority: P2
status: registered
repo: A
created: 2026-07-03
sprint: —
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
_verify 时补。_

## 调查记录(2026-07-04,/loop 自动批 —— 为何本轮**跳过**,待拍板)
勘察结论:**本需求预设的「alpha renderer 路由恢复逻辑」杠杆并不存在**,故不是干净的决策无关小修,自动批不代拍。
- **事实**:alpha `renderer/index.tsx:411` 以 `<AppInterface router={MemoryRouter}>` 挂载,**未传 initialEntries** → MemoryRouter 初始在 `/`。**路由恢复(读 `tabs.recent` → `navigate`)由上游冻结的 `packages/app/src/context/tabs.tsx` 主理**(`useNavigate`/`persisted(tabs.recent)`),alpha 侧无恢复层可插。REQ-014「落点=alpha 路由恢复层」的假设不成立。
- **「Not found」来源**:非 `entry.tsx:99`(那是 DEV 专用 root-element 缺失错误),而是 router 级未匹配/会话 404 呈现。
- **修法二选一(= 需拍板的方案决策)**:
  1. **renderer 重定向守卫**:新增一个 AppInterface 子组件(仿 AlphaHome 路由感知),`useLocation` 观察到悬空会话路由则 `navigate("/")`。**前提**:该守卫在悬空态下**仍被挂载**。
  2. **main 预清 store**:启动待 sidecar ready 后,读 `opencode.global` 的 `tabs`/`tabs.recent`,解出会话 id,SDK 校验存在性,重写剔除悬空项。**代价**:需解析上游 tab-key 格式 `sidecar\n/server/<b64>/session/<id>`(base64 路由编码 = ADR-008 标注的**易碎耦合点**)+ 时序竞态(须早于上游 tabs.tsx 恢复导航)+ 从外部改上游持久 store 有冲突风险。
- **决定二者的关键未知**:悬空「Not found」是**整屏替换**(alpha 子组件全未挂 → 守卫①无效,只能走②)还是**布局内**(子组件在挂 → 守卫①可行)?req 描述「无侧栏、无首页」倾向整屏替换,但**须真机复现确认**——决定用①还是②。
- **裁决(/loop 批)**:方案取决于无法离线确认的运行时行为 + 触碰易碎上游耦合 → **deferred**。建议并入 [[REQ-016]] 真机批:先**复现**(造悬空 `tabs.recent` → 冷启动)观察 Not found 呈现层级,再定①/②。届时①若成立即为低风险小修;若须②则单独评估耦合。
