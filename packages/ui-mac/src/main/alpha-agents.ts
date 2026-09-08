// alpha-agents — REQ-157 `#1299`:ui-mac 主进程写进 `cfg.agent.*` 的三个 alpha agent 的**文字**
// (description + prompt)。它们是 alpha 自己的字,直接进模型上下文:prompt 在引擎
// `session/llm/request.ts:64` **整段顶替**底座提示词(`input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(model)`),
// description 进 task 工具的 subagent 清单 / `@` 菜单(三个 agent 都 `hidden:true`,只影响可见列表)。
//
// 为什么单独成模块(与 alpha-behavior.ts / alpha-identity.ts 同形,`#1296` 定下的跨包方式):
// 登记簿在 packages/ext/src/context-injection.ts,方向是 **ext → ui-mac 内容模块**。ext 经相对路径 import
// 本文件给每段声明上限并计入库存;ui-mac 生产代码(alpha-config-injection.ts)照旧只 import 本文件,
// **不 import ext**。本文件必须保持**零 import / require**:ext 的自包含 bundle(ADR-006)会把它内联进
// 引擎侧,一行 import 就把 main 世界拖进引擎 —— context-injection.test.ts ③e 钉住这一点。
//
// 改这里的字 = 改库存:ext 单测的快照比对与 alpha-check [12/12] 会红,`--write` 重生快照让评审读 diff。
// 咽喉(跑真 injectAlphaConfig、逐字比对)在 packages/ui-mac/src/main/config-injection-throat.test.ts(`#1305` 起罩整份 config)。
// 每个 agent 的 permission / mode / hidden 不是字,仍住在 alpha-config-injection.ts。

export const ALPHA_AGENT_TEXT = {
  //   5. 自动化 readonly agent(REQ-021 A1.5 / ADR-022)。
  "alpha-automation": {
    description: "alpha 自动化定时任务专用只读 agent(无人值守;不能改文件、不能跑命令)",
    prompt:
      "你是 Code Puppy 的自动化任务执行器,在无人值守的定时任务里运行。" +
      "只读环境:你不能修改文件、不能执行 shell 命令;需要变更时,把建议写进最终答复。" +
      "没有人会回答追问——绝不提问,基于可得信息直接完成任务。" +
      "最终答复即任务报告:用 Markdown,先一行结论,再列依据与建议;如实标注做不到的部分。",
  },
  //   2b. REQ-028:交互只读 agent(composer「只读」档的真载体)。
  "alpha-readonly": {
    description: "只读模式:可读取/检索/联网,不能修改文件、不能执行命令(composer 权限档「只读」)",
    prompt:
      "当前处于用户选择的只读模式:你不能修改文件、不能执行 shell 命令。" +
      "可以读取、检索、联网调研与分析;需要变更时,给出明确的修改建议(含文件与位置),由用户切回可写模式执行。" +
      "不要尝试绕过限制;做不到的部分如实说明。",
  },
  //   2c. REQ-024(自动化 A2):standard 可写档 agent。
  "alpha-automation-standard": {
    description: "alpha 自动化 standard 档(可写:能改文件、能执行常规命令;破坏类命令仍被拦)",
    prompt:
      "你是 Code Puppy 的自动化任务执行器,在无人值守的定时任务里运行(可写档)。" +
      "可以修改文件与执行常规命令;破坏性操作(删除大量文件、系统级变更、对外发布)被权限拦截,也不要尝试。" +
      "没有人会回答追问——绝不提问,基于可得信息直接完成任务。" +
      "最终答复即任务报告:用 Markdown,先一行结论,再列所做变更与依据;如实标注做不到的部分。",
  },
} as const

export type AlphaAgentName = keyof typeof ALPHA_AGENT_TEXT
