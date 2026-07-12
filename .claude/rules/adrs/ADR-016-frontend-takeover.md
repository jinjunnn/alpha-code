---
id: ADR-016
title: 前端全面接管 —— alpha 自有组件重建整个前端,复用 opencode 重型引擎,放弃前端升级隔离北极星
status: accepted
date: 2026-06-24
supersedes: ADR-003
related: ADR-005, ADR-007, ADR-008, ADR-015
---

## 背景
ADR-003 选了 B+A(复用 opencode `AppInterface` + token 换肤 + 自有组件按需替换),刻意**不**重写前端,以守 ADR-005 的北极星(升级隔离 / 薄定制层 / 白嫖上游 UI 升级)。但实际使用中,opencode 前端的展示/交互「非常粗糙」,token+CSS 换肤只能改外观、改不动布局与信息架构;上游弹窗/页面布局无法重排(重排=改 `pages/*`=破北极星)。用户(2026-06-24)明确决策:**全面重构整个前端,用自有组件,不再用「原来的 token + CSS」换肤,可以破北极星**;在 opencode 后端不变的前提下,**整个前端 UX/UI 由 alpha 接管 + 经后端接口(SDK)取数**。并补充:连复用的重型组件也要做视觉优化,**与 opencode 前端「断链」,后续 alpha 完全接管前端**。

## 决策
1. **alpha 自有所有用户可见界面**:首页、侧栏、会话列表、输入框(composer)、全部弹窗、设置外观、空状态——全部为 `packages/ui-mac/src/renderer/alpha-ui/*` 的自有 SolidJS 组件,消费**自有设计系统**(`alpha-ui/tokens.css` 的 `--a-*` 变量,黑白中性 + 单一克制 indigo 强调色),不再走 opencode 的 token+css 换肤。
2. **复用 opencode 重型引擎,但重新换肤**:终端(ghostty-web)、diff/代码视图、流式 markdown/消息渲染、权限流——**不重写**,经其 `data-slot`/`data-component` 钩子做 CSS-only 视觉优化(零 JS 风险),嵌进 alpha 自有的会话布局。
3. **后端只走 SDK**:`@opencode-ai/sdk/v2/client`(session/provider/file/permission + `/global/event` 流),沿用 `use-projects.ts` 既有模式(ADR-002/008)。
4. **接管接缝(经架构勘探确认,取 Strategy A)**:alpha 屏幕作 `AppInterface` 的 route-aware children 挂载(沿用 AlphaSidebar/ExtensionHub 模式),**保留** opencode 的 provider 栈,从而无需自建 8+ 内部 context 即可复用重型组件;复杂会话页保持 `/:dir/session/:id` 路由形状,使 `MessageTimeline` 等可零改复用。
5. **北极星调整**:**前端**的「升级隔离 / 薄定制层 / 白嫖上游 UI 升级」**正式放弃**(本 ADR 取代 ADR-003,放宽 ADR-005 对前端的约束)。**后端侧**仍守「只增不改 opencode 源码、只走 SDK/接缝」(ADR-002/005 对后端继续有效)。CI 的 file-diff 守卫对**上游源码**仍要求零改动——前端接管是**新增** alpha 文件,不编辑 `packages/{app,ui,opencode}` 源码。

## 后果
- ✅ 前端获得完全设计自由(布局/IA/弹窗可任意重排),解决「粗糙」根因;自有设计系统统一全局质感。
- ✅ 不重写终端/diff/流式等硬骨头(复用 + 换肤),工作量与风险可控。
- ✅ 第一批已落地并截图核验:`alpha-ui` 设计系统(tokens/base/Button/Input/Dialog)、定制中心弹窗迁移到 `--a-*`、**AlphaHome 自有首页**(空状态 + 项目/会话卡片,经 SDK 取数)。
- ⚠️ **升级耦合上移**:复用重型组件 + 借用 opencode 内部 provider(非 public exports)→ 上游重命名内部 context/hook 会在升级时**静默或 loud 失败**。对策:把借用的内部 provider 收敛成 `alpha-ui/providers/*` 薄 re-export(一处断,集中暴露);`data-slot` CSS 换肤是最稳的耦合面。
- ⚠️ **厚定制层**:自有前端体量将远超原「<5%」目标——这是放弃北极星的直接代价,已被用户接受。
- ⚠️ 失去「白嫖上游前端升级」:upstream 前端改进不再自动继承;只继承后端/引擎层。
- 🔭 待办:① 收敛内部 provider 借用为薄 re-export 层;② 继续 build order(composer → 会话页复用 MessageTimeline → 设置/模型选择弹窗 → 重型引擎换肤);③ ✅ **已完成(2026-07-03,C6)**——据本 ADR 修订 POSITIONING/GOALS/NON_GOALS/ARCHITECTURE/GLOSSARY 的前端北极星表述:「薄定制层<5%」拆为**后端守 / 前端接管**,submodule 陈述改 fork。

## 修订(2026-07-12,ADR-027 —— 接管接缝升级:typed surface seam 成为正式通道)

§4 的 Strategy A(route-aware children / Portal 叠加)只能把 alpha 屏幕**叠在**上游页面之上,
双页面生命周期无法证明 upstream 叶页面无隐藏副作用。[[ADR-027]](经 [[ADR-029]] L3 通道)
在冻结的 `AppInterface` 上开出**中性 typed surface seam**(`home`/`newSession`/`session`
三个窄叶 override,保留全部既有 Provider 包装):

1. 叶页面所有权诉求(REQ-085/086/088/090)一律走 surface seam,不再新增 Portal/DOM
   takeover;既有 Portal 形态随各 REQ 迁移逐个退役。
2. Strategy A 对**非叶区域**(sidebar、children 注入)继续有效;本修订不改变重型引擎
   复用与 `data-slot` 换肤路径。
3. 冻结纪律与写通道见 [[ADR-020]] 2026-07-12 修订段(基点更新为 `frontend-freeze-base-2`)。
