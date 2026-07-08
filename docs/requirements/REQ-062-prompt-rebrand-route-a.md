---
id: REQ-062
title: 去 opencode 化·路线A:系统提示词品牌转写(transform hook)+ identity 措辞 + /init /review 同名覆盖 + customize-alpha 接替 + general/explore 子 agent 同名重写
type: feature
priority: P1
status: ready
repo: A
created: 2026-07-08
---

## 背景(为什么)

用户拍板(2026-07-08,GOALS G6 / [[ADR-015]] 2026-07-08 修订):项目层级尽量去 opencode,系统提示词由 alpha 承载;**先路线A(品牌转写),后评估路线B(受控替换,[[REQ-064]] parked)**。

根因(2026-07-08 源码盘点,证据链在 ADR-015 修订节):模型自称「alpha code (opencode)」有两个来源——

1. **8 个 provider 底座 .txt 首行全部自称 OpenCode**(`packages/opencode/src/session/prompt/anthropic.txt:1` "You are OpenCode, the best coding agent on the planet.";beast/codex/gpt/gemini/kimi/trinity/default 同);anthropic.txt 另带 opencode.ai 文档指引与 `github.com/anomalyco/opencode` 行(:10,:12,:21),default.txt 同类(:6,:7,:9)。
2. **`alpha-identity.md` 自己写了 "built on opencode"**(alpha-identity.ts:17-42),模型照实转述。

机制事实(已源码钉死):instructions 通道是**纯叠加**(`config.ts:47` 并集;`request.ts:58-66` 底座在前同条 system message)→ identity 只能软压制底座首行,不保证赢;`OPENCODE_*` flag 全表**没有**底座禁用开关;`experimental.chat.system.transform`(`packages/plugin/src/index.ts:291-296`,`output.system: string[]` 可原地改写,`request.ts:69` 触发)是**唯一**能触及底座 + environment 的零-fork 接缝。

## 目标(做什么)

1. **T1 转写 hook**:`@alpha-code/ext` 挂 `experimental.chat.system.transform`,对 system 段做**精选子串转写**(ADR-007 brand-i18n 同款纪律):
   - 8 底座首行自指句 → alpha-code 自指;正文 "OpenCode/opencode" **自我指代**同转;
   - 剔除/改写 opencode.ai 文档指引与 GitHub 仓库指引行;
   - **真实事物名不转**(转了 = 对模型撒谎):`opencode.json(c)` 文件名、`.opencode` 路径、`@opencode-ai/*` 包名、Zen/CLI 等实体引用;
   - 漏改 `warn` 兜底,不静默(ADR-007 同款)。
   - 逃生 `ALPHA_PROMPT_REBRAND_DISABLE=1`;hook 签名漂移/失效最坏退化 = 品牌未转写(外观级,不伤功能)。**NON_GOALS#4 风险标注随 ADR-015 修订已成文。**
2. **T2 identity 措辞**:`alpha-identity.ts` 删 "built on opencode",改纯 alpha-code 自述(不再向模型披露底层引擎名);behavior 层不动。
3. **T3 `/init` `/review` 同名覆盖**:经 `injectAlphaConfig`(G1 通道)注入 `command.init` / `command.review` = alpha 自有模板——init 改写为面向 AGENTS.md + `.alpha` 约定、零 OpenCode 字样(上游 `initialize.txt` 含 3 处自指);review 沿用语义仅去品牌。**须核对治理优先级**:用户治理(REQ-037)对同名 command 的 override 必须仍压过 alpha 出厂覆盖。
4. **T4 customize-alpha skill**:alpha 自写 skill(教 `~/.alpha/alpha.jsonc`、项目 `.alpha`、治理面板、定制中心约定),经出厂技能通道(factory-skills)落地;已禁 customize-opencode 的治理占位 command 指向新 skill。
5. **T5(可后置,P3 顺带)**:`tool/lsp.txt:22` 一处经稳定 hook `tool.definition` 转写(lsp 工具默认实验关闭,量级最小)。
6. **T6 子 agent 内容接管(用户追加拍板,2026-07-08)**:general / explore 两个上游 subagent 经 config `agent.general.prompt` / `agent.explore.prompt` **同名覆盖**为 alpha 自写文本(`agent.ts:283` 实证 config 优先)——**同名接管而非禁用+另建**:名字与 task 委托接线全保留,内容 100% alpha;explore 当前用户已治理禁用,恢复启用时即用 alpha 文本。**agent 内容接管全景**(与 [[REQ-064]] 的分工):build/plan 自身无 prompt、其内容 = provider 底座 → A 期由 T1 转写覆盖其可见面,**内容替换**归路线B;compaction/title/summary 自有 prompt 已无品牌残留、属引擎机件 → prompt 同名覆盖归路线B 按质量评估决定;general/explore 是单一任务型 prompt(无逐模型调优负担)→ **本期直接重写**。A 期收口时:会话内全部 agent 的 LLM 可见文本零 opencode 痕迹(build/plan 靠转写、general/explore 靠重写、内部三件本就干净)。

## 验收标准(可验证,逐条)

1. 真机会话(claude 系 + 非 claude 系模型各一)问「你是什么产品/工具」→ 稳定自称 alpha-code,回答中不出现 opencode 自指;
2. **转写审计**:dev 侧抓取实际发出的 system 内容(hook 内 dump 或引擎日志),确认①底座首行已转写②文档/GitHub 指引行已剔除③真实事物名(opencode.jsonc / @opencode-ai / .opencode 路径)**未被误转**;
3. `ALPHA_PROMPT_REBRAND_DISABLE=1` 启动 → system 恢复上游原样(开关可证、可回退);
4. `/init` 真机执行 → 产出面向 AGENTS.md/`.alpha` 约定的初始化文档、零 OpenCode 字样;`/review` 语义不回退;治理面对 init/review 的用户 override 仍优先生效;
5. customize-alpha 在技能列表可见可触发;customize-opencode 保持禁用、占位指引指向新 skill;
6. 上游 sync 触碰 `prompt/*.txt` 时,转写子串清单复核进 ADR-015 合并验证(tripwire 已接线,REQ-012 verified);北极星守卫零波动(全程零改上游文件);
7. 单测:转写纯函数——子串清单 × 8 底座真实样本 + 反例集(真实事物名不转);
8. **T6 验收**:general 经 task 工具真实委托一次 → 走 alpha 自写 prompt(dev 抓 system 证)且委托结果正常回流;explore 恢复启用时同验;agent 列表/选择器无接线回退(名字不变)。

## 实现注记(2026-07-08,PR 实现随记)

- **T1 通道事实**:transform 到手的 system 是「底座 + environment + 用户 instructions + skills」join 后的**单串**(request.ts:58-66)→ 全局词替换会篡改用户文本,故严格精选子串对(13 条,`packages/ext/src/prompt-rebrand.ts`),含 copilot-gpt-5.txt(盘点补遗,原档只数了 8 底座);残留审计 warn 去重每进程一次。
- **drift 锁机械化**:`prompt-rebrand.test.ts` 逐条断言 from 子串仍在上游 .txt;ext 测试随本 PR 进 alpha-check + alpha-ci 两道门 —— 上游 sync 改写底座即红,ADR-015 合并验证不再靠人肉。
- **T3 review 刻意不覆盖**:上游 review.txt 逐字节零品牌痕迹(grep 实证)→ 换芯零收益且丢上游语义演进;init 正常接管。验收④的 review 半边自然成立。
- **T3/T6 落点**:ext 插件 config hook 尾部 set-if-absent(引擎装配完才通知 → 用户治理/项目/全局任何层同名配置天然优先),非 OPENCODE_CONFIG_CONTENT(该通道最后 merge、会压过治理)。
- **T5(lsp.txt)后置**:lsp 工具默认实验关闭、量级最小,归下一顺带批(档案原文即允许)。
- **逃生门**:`ALPHA_PROMPT_REBRAND_DISABLE=1` 统一关 T1+T3+T6(路线A 一键回退);已入 sidecar env 白名单。

## 非目标

- 不替换底座(build/plan 的**内容**接管 = 路线B = REQ-064,parked,另有激活条件;A 期它们的可见面已由 T1 转写覆盖);
- 不禁用 build/plan/compaction/title/summary(默认主档 + 引擎机件;「重写」一律走同名 prompt 覆盖,不走禁用+另建——接线按名字焊死,禁用后果未经验证且无收益);
- 不动 environment 块(本就无品牌,且无 flag 可禁);
- 不移除 `/init` `/review` 菜单条目(schema 无 disable 字段,机制不可行,只换芯);
- 不为任何模型撰写 alpha 自有完整系统提示词(那是路线B)。

## 风险与回退

- experimental hook 依赖(NON_GOALS#4):逃生开关 + sync 合并验证 + 失效退化仅外观级;
- 转写子串清单是新增维护面:底座改版需随 sync 复核(tripwire 覆盖,ADR-015 纪律);
- 治理层 × 出厂覆盖 × 上游内置的三层 command 优先级交互需实测(预期:用户治理 > alpha 出厂 > 上游)。
