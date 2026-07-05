---
id: C28
title: placebo 控件诚实化 + 崩溃屏接管设计(边界下沉)
type: ux
priority: P2
status: shipped
repo: A
created: 2026-07-03
sprint: 2026-07-05-s17-deep-decisions
source: 册 §7b / §7h(顶层边界已证伪撤回)/ §7i
---

## 背景/证据
① placebo 控件:composer「只读」映射到 autoaccept-off(opencode 无运行时只读)、effort(低/中/高/超高)按注释可能不改推理——用户可见控件静默不做其宣称的事;② 崩溃屏:顶层 ErrorBoundary 方案**已实测证伪撤回**(上游 `@opencode-ai/app` 自带更内层边界,alpha 顶层永不生效,册 §7h);品牌部分已由 C29 修。剩余=若要 alpha 分支型崩溃恢复,边界须下沉到 AppInterface 内紧裹 alpha children。

## 验收标准
1. 「只读」「effort」两控件:行为与宣称一致(真实现/改文案/移除,三选一,逐个决策记录);
2. 崩溃屏接管出设计结论:下沉边界方案(位置/恢复交互)或「接受上游边界(已去品牌)」,二选一记录;
3. 若做下沉边界:强制 throw 注入实测 alpha 边界先于上游命中(册 §7h 的失败教训 = 必须比上游更内层)。

## 关联
C29(已修品牌角)、upstream-crash-screen-errorboundary(memory)、A5(版本显示已修)。

## 拍板与实施记录(2026-07-05,S17 T4 shipped)
- **验收① 控件三选一(用户拍板,brief=[debates/c28-brief](../debates/2026-07-05-c28-honest-controls-brief.md))**:「只读」= **移除**(实证与 ask 引擎行为完全相同——都只触发 `permissions.autoaccept.disable`;真只读载体=引擎 plan agent → [[REQ-028]]);「effort」= **改文案保留**(实证纯本地 signal 零接线;popover 现明示「预设 · 暂未接入模型推理」,chip title 同步;真接入=model variants → [[REQ-029]];此项与建议不同,按用户拍板执行)。落点 `composer-controls.tsx`(home+in-session 共享一套,一处改两面生效)。
- **验收② 崩溃屏二选一(设计拍板)= 下沉边界**:新增 `alpha-ui/alpha-boundary.tsx`(SolidJS ErrorBoundary 薄封装)逐个紧裹 10 个 alpha 注入件(`renderer/index.tsx`)——比上游 AppBaseProviders 边界(冻结 `app.tsx:274`)更内层 → alpha 崩溃 = 右下浮条局部降级(「重载此区域」可恢复),app 其余存活;上游子树崩溃仍走上游边界(归属正确);TimelineInject(B22 疑源)自此有降落伞。
- **验收③ throw 实测 = PASS**:`window.__alphaCrashProbe`(常驻探针,dev/打包同在)触发 AlphaSidebar throw → alpha 浮条命中 + 上游 ErrorPage 未出 + app 其余存活 + reset 复活;截图与断言 [audits/2026-07-05-s17-t4-c28/verify.md](../audits/2026-07-05-s17-t4-c28/verify.md)。**verified 待打包态复验**(探针打包同在,真机批一条命令)。
- 顺带:实测中活捉 REQ-014 家族崩溃(整屏形态 + 毒源 + ②修法实证),证据同 audits §2。
