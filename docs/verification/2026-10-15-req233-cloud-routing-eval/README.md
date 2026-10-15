---
title: REQ-233 本机与云端首动作评测工具及固定题库
kind: verification
status: active
owners:
  - alpha-code runtime maintainers
last_reviewed: 2026-10-15
---

# 本机与云端首动作评测

[alpha-code#1520 AC3](https://github.com/jinjunnn/alpha-code/issues/1520) 的第 1 步：
固定题库、真实引擎、全工具桩和免费假 provider。本目录的结果只证明链路、分类和统计可运行，
**不证明 #1536 提升了真实模型正确率，不满足 AC3 的真实比较结论**。
文档影响为 verification evidence；产品、出厂技能、门和登记表均未修改。

## 题库与来源

[`cases.json`](cases.json) 共 28 条：local 12、cloud 12、ask 4，反例 11。
这是基于需求和规则编写的用户话语回归集，不冒充生产聊天记录。
每条包含用户原话、期望类别、理由、覆盖标签、反例标记和来源说明。
`/eval/*` 为虚拟文件路径，URL 也只作为桩输入，不打开用户文档或网页。

判据来自 [alpha-work §2.8 固定版本](https://github.com/jinjunnn/alpha-work/blob/02c1aed231211e26dff654694576656e3aba8641/governance/customization-center-target-architecture.md#28-本机还是云端判断规则)，
以及 `026553ad0` 的 `cloud-capabilities` 判断表和 `office-docs` 云分支。
前后变体均使用同一题库、工具定义、引擎和模型配置，唯一切换项是完整出厂技能目录：

| 变体 | factory-skills 来源 | 路由技能 |
|---|---|---|
| before | `133f463d9` | `cloud-dispatch` |
| after | `026553ad0` | `cloud-capabilities`（含 `/cloud` 子目录） |

| 判断表行 | 覆盖案例 |
|---|---|
| 用户明确选择云端 | c13–c14；隐私优先边界 c25、c27 |
| 读改本机 Word / Excel / PPT / PDF | c01–c04、c11 |
| 从零生成排版 Word / Excel / PPT / 网页 | c15–c18；普通文本反例 c10 |
| 生成图片 | c19 |
| 单事实、单网页，本机不可用再回退 | c05–c06、c09；回退 c23 |
| 多来源深度调研 | c20 |
| 默认本机代码审查、联网复核或第二意见用云 | c07–c08、c12；c21–c22 |
| 私有本机文件上传前先问 | c25–c28 |
| 收费前检查登录与账户 | c13–c24；明确只预检、不派发 c24 |

c23 在模型请求中同时隐藏 `websearch`、`webfetch`，其余案例均提供二者。
“云”仅指首动作的方向；本评测在第一次工具选择就截停，不验证后续登录、报价、上传、派发顺序。

## 执行与隔离

从已安装依赖的此 worktree 的 `packages/opencode` 目录运行，使用仓内 Bun 和 SDK，无新依赖：

```sh
bun ../../docs/verification/2026-10-15-req233-cloud-routing-eval/run.ts --self-test
bun ../../docs/verification/2026-10-15-req233-cloud-routing-eval/run.ts
bun ../../docs/verification/2026-10-15-req233-cloud-routing-eval/run.ts --sample 2 --out /tmp/routing-sample.json
```

[`run.ts`](run.ts) 每个变体用 `git archive` 提取对应目录到临时目录，再启动真正的
`packages/opencode/src/index.ts serve`。使用与 CLI `run` 等价的
`POST /session`、`POST /session/:id/message`，每轮新建 Session。
引擎版本、技能 commit/tree、题库及三个脚本和工具快照的 SHA-256 都写入结果。

[`plugin.ts`](plugin.ts) 加载实际 `AlphaExt`，由其 config hook 注入
`ALPHA_FACTORY_SKILL_DIRS`；模型请求断言技能目录、ext 工具、本机工具及 10 个云工具均已广告。
技能正文保持引擎原生按需加载，**不预载、不改写、不添加路由教学**。
按题面严格计第一次工具；若模型先调用 `skill`，即记 local 并结束，保存工具名供审查。

[`mcp.ts`](mcp.ts) 通过真实 MCP SDK 的 stdio 传输提供四个 Office 桩和 Cloud 桩。
Office 8 个工具的元数据直接从仓内 `office-mcp/server.py` 的 `tools_for()` 导出，未运行文件处理器。
Cloud 10 个工具的元数据取自 alpha-platform 固定版本 `60ad2df511d813bf9dda948365601470e06d5a89`：
从 `cloud-mcp.ts` 的 `mount` 调用中提取配置 AST，执行原始 description/schema 表达式，
使用原始纯注册表和 Zod 导出 JSON Schema，未装载服务处理器或调用服务。
[`tool-snapshot.json`](tool-snapshot.json) 保存来源，运行时集合必须等于
[`cloud-mcp-tools.ts`](../../../packages/ui-mac/src/main/fixtures/cloud-mcp-tools.ts)。
快照保留真实工具文法，两变体共用，不从模型回答手写或猜测 schema。

所有工具（含 `alpha_cloud_access`、本机搜索、read/bash/skill/question 等内建工具）在
`tool.execute.before` 记录首动作，返回固定 `EVAL_STUB` 错误并中止 Session，实际工具体不执行。
若引擎先发出 identity `permission.asked`，从真实 identity 记录已经选定的工具并中止，
不批准任何权限；这不是 agent 主动向用户提问，不能记 ask。
MCP 处理器本身也只有固定字符串响应，无真实文档或云服务实现。

引擎使用临时 XDG/config/global/workspace，禁用外部技能、Claude 配置、默认插件、
模型目录刷新和自动下载；仅继承 PATH/TMPDIR，不继承模型凭证或 Alpha 云配置。
npm 限定离线且 user/global npmrc 指向临时不存在的路径。
引擎初始化可能记录离线依赖安装失败；其后真实插件、模型及工具表断言必须通过才计轮次。
本步没有读取 key 文件、触达真实 Cloud MCP、打开用户文件或发出付费模型请求。

## 假 provider、分类与统计

默认 provider 是当前进程中的 `127.0.0.1` HTTP 桩，使用仓内
`packages/opencode/test/lib/llm-server.ts` 同款 Chat Completions SSE chunk 形状。
按 case ID 与 repeat 的固定序列循环：本机 Word、云访问、question、本机搜索、直接答、文本提问。
不读取 expected，也不随 before/after 改答案，故意产生错误、三票平局及不一致，验证计分确实工作。
fake usage 是 `ceil((promptBytes + toolBytes) / 3)` 输入、固定 32 输出的合成读数；不是模型实测 token。
默认单价为零，实际费用为 $0。

分类仅有三种：`alpha_cloud_access`、10 个 `cloud_*`（含连接器前缀）记 cloud；
`question` 记 ask；其余首工具记 local。无工具结束时，根据问号或“请确认/请提供/是否允许”等
显式询问短语判 ask，否则记 local。空响应、无效工具、引擎错误或缺 usage 保留为错误轮并停止，
不把基础设施失败包装成完整结论。
文本询问判定是可审查的启发式，真实模型评测时必须审阅结果里的原文，尤其是没有问号的间接授权请求。

正常模式每例每变体重复 3 次，`--sample N` 是前 N 例、每变体 1 次。
每完成一轮即写 `results-<timestamp>.json` 和同名 `.md` 票面表，预算或错误也保留部分结果。
结果包括每轮 expected/observed、首工具或结束文本、字节数、usage、成本，及每例三次选择：

- 按次正确率：正确轮数 / 已运行轮数。
- 多数票正确率：每例至少两票同类别才有多数；三类各一票按无多数、不正确处理。
- 每例一致性：最高票数 / 3，另给三次全一致标记和总例数。
- 噪声：同一变体三次重复各自正确率的最大值减最小值；总体噪声带取两变体极差的较大者。
- 提升条件：`after.accuracy - before.accuracy > 0` 且严格大于总体噪声带。

不足 3 次、少例、错误或预算中止时，不输出有效多数票/噪声比较。
`comparison.ac3Evidence` 只有真实 provider、完整 28×3×2 且超出噪声时才可能为 true；
fake 模式始终为 false。这是首动作统计标记，仍需编排器审查原文与票面证据。

## 第 2 步的模型配置与花费护栏

真实模型需显式 `--real`，支持提供 `usage` 的 OpenAI-compatible Chat Completions SSE 接口。
模型 id 和 provider base URL 从下列变量读取，不使用开发机已有登录态。

| 环境变量 | 含义 |
|---|---|
| `EVAL_MODEL_ID` | provider 的实际模型 id |
| `EVAL_PROVIDER_BASE_URL` | 包含 `/v1` 的兼容 API base URL；不能含账号、密码或 query |
| `EVAL_PROVIDER_KEY_FILE` | key 文件绝对路径；仅真实模式在请求时读取，结果中不记录内容或路径 |
| `EVAL_INPUT_USD_PER_MILLION` | 每百万输入 token 的美元单价，必须显式传入 |
| `EVAL_OUTPUT_USD_PER_MILLION` | 每百万输出 token 的美元单价，必须显式传入 |
| `EVAL_BUDGET_USD` | 正的有限美元预算，真实模式必填 |

真实调用命令形状为上面的变量加 `bun .../run.ts --real --sample N`，
由编排器提供配置并决定何时执行。本步未执行 `--real`；云工具始终保持桩，无需真实云任务账户。

Loopback 代理每轮只接受一次模型请求，后续 continuation/retry 不转发上游。
流式响应先完整收齐并累计 `prompt_tokens`、`completion_tokens`，再交给引擎解析首动作，
防止中止时丢掉流末 usage。费用为 `(input × inputPrice + output × outputPrice) / 1e6`；
缓存输入按传入的统一输入价计，不另猜折扣。
累计费用严格超过预算立即停发，保存当前已计费用和此前结果；缺 usage、HTTP 失败或超时也停发。
预算是调用完成后的计费护栏，不能撤销当前响应已产生的费用，可能超出一个响应的费用。
若上游失败且没有 usage，未知费用不能据此视作零。
每轮最大输出 1024 token；真实输出（包括推理 token）仍以 provider usage 为准。

免费预算验证可运行：

```sh
EVAL_INPUT_USD_PER_MILLION=1 EVAL_OUTPUT_USD_PER_MILLION=2 EVAL_BUDGET_USD=0.001 \
  bun ../../docs/verification/2026-10-15-req233-cloud-routing-eval/run.ts --sample 2 --out /tmp/routing-budget.json
```

这只是给假 usage 套单价：第一次响应后停止，`usage.calls=1`、after 无调用，
当前轮 input/output/usd 已写入，`stopReason=budget_exceeded`，多数票及噪声结论为空。

## 验证记录

`--self-test` 验证三类判定、无工具结束、三票计分、重复极差、不完整运行、费用计算及云工具集合。
另通过实际引擎完成两变体 `--sample 2`、完整 28×3×2 和上述预算停止测试。
完整假模型输出应为每变体 28/84（33.33%），多数票 21.43%，一致 0/28，噪声极差 28.57%，
改后减改前为 0，超噪声为 false。此处的错误与波动来自固定脚本。

最终证据：[完整 JSON](results-2026-10-15T10-01-09-000Z.json) 和
[可贴票面的表](results-2026-10-15T10-01-09-000Z.md)。两变体各 84 轮，共 168 次免费模型桩请求，
ext 加载回执 2 次，`blockedFollowups=0`，合成 usage 为 3,471,591 输入 / 5,376 输出，实际费用 $0。

`promptBytes` 为完整 messages JSON 的 UTF-8 字节，`toolBytes` 为工具定义 JSON，
`responseBytes` 为响应 delta JSON。字节除以 3 可作量级估计，不可充当真实模型账单。
本次实测：before 的 messages 13,546–13,612 B、after 13,898–13,964 B；
工具定义 45,134–48,353 B（c23 隐藏本机搜索后较小），总输入 58,722–62,317 B。
按 UTF-8 字节 / 3 粗估，**每轮约 2 万输入 token**；响应 delta 53–333 B，
约 20–110 输出 token。真实模型的提示词底座、工具参数及推理输出可能改变这个数；
第 2 步先 sample，按实际 usage 估价，输出仍有 1024 token 的单轮上限。

文档合同检查使用当前 worktree 的只读 checkout 映射；另运行 `git diff --check`。
合同检查报 35 条既有 `docs/evidence/2026-10-10-req229-230-visual/` 的 `layout.role-alias`，
这些路径在基线 HEAD 已存在，本次新增目录无错误；按允许范围不修改既有证据。
三个 harness 文件还通过 `packages/opencode` 下的 `bun typecheck --project <临时配置>`，
临时配置继承该包 tsconfig，include 本目录三个脚本和包的类型声明，不修改产品 tsconfig。
仓库没有 `bin/check` 且未配置 `gate.command`；不新增或改写质量门。
