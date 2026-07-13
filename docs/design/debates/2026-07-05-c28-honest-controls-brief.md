# C28 brief:placebo 控件三选一 + 崩溃屏边界下沉(S17 T4)

> 2026-07-05。控件三选一 = ⚖️ 用户拍板项(逐个);崩溃屏二选一 = 技术设计结论(本文拍板并记录,验收②)。
> 以下事实全部当日代码实证(file:line),非推断。

## 实证事实

| # | 事实 | 证据 |
|---|---|---|
| F1 | 两控件在 **alpha 自有** `composer-controls.tsx`(home + in-session 共享一套),非冻结上游 —— 三选一实施自由度完全在我方 | `alpha-ui/composer-controls.tsx:1-9` |
| F2 | **「只读」与「请求审批」引擎行为完全相同**:两者都只触发 `permissions.autoaccept.disable`(full→enable);UI 宣称「禁止写/执行」不成立(写/执行照样走审批,不被禁止)。注释自认「opencode has no runtime read-only command」 | `composer-controls.tsx:170-178,26-27` |
| F3 | **EffortChip 纯本地 signal,零引擎接线**:选低/中/高/超高只改本地状态;UI 宣称「更深推理」「最强·最慢」不成立。注释自认「effort is local intent」 | `composer-controls.tsx:88-96,222-263` |
| F4a | 「只读」**真实现通道存在但脆**:引擎内置 `plan` agent(`edit "*": deny` + task deny = 真禁改档);alpha 可达通道仅 `command.trigger("agent.cycle")`(循环切换,无直设命令)+ DOM 观察判停;cycle 受 `settings.visibility.customAgents()` 门控,且 alpha-automation(primary)也在循环序列里 | `opencode/src/agent/agent.ts:157-175`;`app/src/pages/session/use-session-commands.tsx:544-551` |
| F4b | 「effort」**真实现通道存在但为 feature 级**:引擎 variant 机制真实(`llm/request.ts:80-91` 把 `model.variants[user.model.variant]` merge 进请求 options);上游有 `model.variant.cycle` 命令 + picker variant 层。**但当前 alpha 代理/BYOK 模型的 provider config 未定义 `variants`** → cycle 对这些模型空转。真实现 = alpha 自建 provider config 逐模型定义 variants(低/中/高/超高 → thinking/reasoning 参数)× **B 侧网关是否透传该参数需核实** = 独立 feature | `opencode/src/session/llm/request.ts:80-91`;`app/src/pages/session/use-session-commands.tsx:523`;`app/src/context/model-variant.ts` |
| F5 | 「后台静默设置」路线**不可行**:上游 submit 每次显式带 `draft.agent`/`draft.variant`(frozen 内部 store,alpha 无 provider 通道,[[alpha-composer-provider-topology]])—— session 级设置会被每次提交覆盖 | `app/src/components/prompt-input/submit.ts:158-165` |

## 三选一(逐控件,待拍板)

### 控件 1:「只读」(PermChip 第三档)
- **A 移除该选项(建议)**:PermChip 收敛为「完全访问 / 请求审批」两档真实项(两档接线是真的);「真只读」另立 REQ(载体=引擎 plan agent 或 config 静态权限档,含切换 UX 设计)。诚实且最小;真只读需求由新 REQ 正名。
- **B 改文案**:「只读」改成与行为一致的描述 → 它会变成「请求审批(同款)」——与第二档重复,失去存在意义,不建议。
- **C 现在真实现**:cycle+DOM 观察切到 plan;脆(label 文本耦合 + customAgents 门控 + 循环序列含 alpha-automation),失败态难诚实呈现。

### 控件 2:「effort」(EffortChip)
- **A 移除该 chip(建议)**:当前它对任何模型都无效果;「effort = model variants」另立 REQ(feature:alpha provider config 定义 variants + 网关透传核实 + chip 驱动 `model.variant.cycle`)——那才是真通道,且工程量/跨仓面(B 侧)配得上独立立项。
- **B 改文案**:保留 chip 但标注「预设·暂未接入」——诚实但等于自曝占位,视觉噪音。
- **C 现在真实现**:F4b 全链(含 B 侧核实)塞进 T4——超预算,且网关不透传时全部白做。

## 崩溃屏二选一 —— 设计结论(本文拍板):**做下沉边界**

**现状**:上游 `AppBaseProviders` 的 ErrorBoundary(`app/src/app.tsx:274-289`,冻结)包住全部 children —— alpha 的 **10 个注入件**(Inner/AlphaSidebar/AlphaHome/AlphaOnboarding/ExtensionHub/AutomationPanel/ComposerInject/ModelPickerInject/TimelineInject/CloudRunWatcher/ToastViewport,`renderer/index.tsx:412-422`)任一 render throw → **整屏被上游 ErrorPage 顶掉**(已去品牌 C29,但工作区全没)。§7h 已证伪「alpha 顶层边界」(永远比上游外层,永不命中)。

**决策**:新增 `AlphaBoundary`(SolidJS `ErrorBoundary` 薄封装,alpha-ui 设计系统 fallback)**逐个紧裹每个 alpha 注入件** —— 比上游更内层 → alpha 组件崩溃时**局部降级**(该区域显示紧凑错误卡 + 「重载此区域」reset;app 其余部分照常活着),上游组件崩溃仍走上游边界(其子树,合理归属)。

**理由**:① alpha 面是厚定制层、迭代最频繁 = 最可能 throw 的代码;② 一处 throw 全屏坠毁对用户 = 丢掉整个工作区视图,局部降级把爆炸半径缩到单区域;③ **B22 降落伞**:TimelineInject(B22 崩溃头号疑源)被包住后,即使触发也只是该注入件退出而非全屏;④ 成本极低(SolidJS 原生 ErrorBoundary)。

**验收③ throw 实测计划**:dev-only 强制 throw 探针(`window.__ALPHA_CRASH_PROBE = "<注入件名>"` → 对应 AlphaBoundary 子组件 render 时 throw)→ CDP 截图证明 alpha 错误卡出现、app 其余存活、上游 ErrorPage 未出现;探针零成本常驻(打包态同样可用,供真机批复验)。

## 拍板记录(2026-07-05,用户在会话内拍板)

| 控件 | 拍板 | 执行 |
|---|---|---|
| 「只读」档 | **A 移除选项**(按建议) | PermChip 收敛两档;真只读另立 [[REQ-028]](plan agent 通道) |
| 「effort」chip | **B 改文案保留**(与建议 A 不同,按用户拍板执行) | popover 明示「预设 · 暂未接入模型推理 —— 当前选择不影响请求」+ chip title 同步;档位效果宣称文案(更深推理/最强最慢)全部移除;真接入另立 [[REQ-029]](model variants + B 侧透传核实) |

崩溃屏(设计拍板,本文 §崩溃屏):**下沉边界已实施** —— `AlphaBoundary` 紧裹 10 注入件,throw 实测 PASS(证据 [audits/2026-07-05-s17-t4-c28/verify.md](../../audits/2026-07-05-s17-t4-c28/verify.md));实测过程顺带活捉 REQ-014 家族整屏崩溃(同 audits §2)。
