---
title: REQ-233 AC3 真实模型路由评测结果
kind: verification
status: active
owners:
  - alpha-code runtime maintainers
last_reviewed: 2026-10-15
---

# AC3 真实模型评测

固定 28 例、两变体、每例 3 次；不改技能、不挑题。模型 `deepseek-v4-flash`，
OpenAI-compatible gateway `/v1`；工具仍为桩，技能说明读取不计路由决定，每轮最多 4 次模型尝试；沿用既有每次输出上限 1024 token。
key 仅由父进程按 `EVAL_PROVIDER_KEY_FILE` 读取设 header，未记录内容或路径。


## 小样本与全量准入

前 4 条各一次、两个变体，共 8 轮；使用 gateway SSE 返回的 prompt_tokens/completion_tokens。

| 变体 | 例 | 实际输入 | 实际输出 | 美元 | 判定 | 是否符合固定答案 |
|---|---|---:|---:|---:|---|---|
| before | c01 | 15842 | 73 | $0.00223832 | local | 是 |
| before | c02 | 15898 | 206 | $0.00228340 | local | 是 |
| before | c03 | 15894 | 93 | $0.00225120 | local | 是 |
| before | c04 | 15891 | 242 | $0.00229250 | local | 是 |
| after | c01 | 15948 | 47 | $0.00224588 | cloud | 否 |
| after | c02 | 16004 | 143 | $0.00228060 | local | 是 |
| after | c03 | 16000 | 95 | $0.00226660 | local | 是 |
| after | c04 | 15997 | 197 | $0.00229474 | local | 是 |

小样本累计 **$0.01815324**，平均每轮 $0.00226916；
乘 168 外推 **$0.38121804 ≤ $5**，因此按授权执行全量，预算 $10。
全量预算检查计入小样本既有花费，另为无 usage 的失败请求保留最坏成本，未把两阶段预算简单相加。

两轮工具序列（同一轮并行工具用 `/` 分隔，模型续调用 `→` 分隔）：

- before c01：`bash`；首动作 `bash → local`，期望 `local`，判对。
- after c01：`alpha_cloud_access`；首动作 `alpha_cloud_access → cloud`，期望 `local`，判错。

这些结果仅说明首动作类别：`bash` 等本机探查按 local 计；并不验证任务完成或文件编辑质量。

## 执行隔离修复与中断运行

第一次全量执行至旧会话的权限等待超时后出现停滞；该引擎会把遗留会话续调送往 loopback。该运行停止并保留所有已返回 usage，不能用于 AC3 全量结论。
中断记录 47 行、48 次返回 usage；stopReason=harness_error。
执行副本随后增加 Session ID 核对、决定后的 permission reject/RejectedError、每轮残留权限清理和逐响应成本落盘；stale Session 请求及已决定请求返回非重试型 400，不转发 gateway。
只修复决定后的生命周期隔离，不改技能、题库、模型、参数、首动作判据；从 c01 开始把全部 28×3×2 重跑，未挑选原运行中的有利行。
修复前后统一 diff 均保存在各自 JSON execution 元数据；中断费用计入同一 $10 上限。
[中断 JSON](results-2026-10-15T10-26-00Z-real-aborted.json)，[空响应类型审计](results-2026-10-15-real-empty-response-audit.json) 只导出 part 类型和长度，不导出 reasoning 文本。

## 全量票面数据

模式：真实 provider；28 例 × 3 次。

| 变体 | 正确/次数 | 按次正确率 | 多数票正确率 | 三次全一致/例数 | 噪声极差 |
|---|---:|---:|---:|---:|---:|
| before | 55/84 | 65.48% | 64.29% | 23/28 | 3.57% |
| after | 60/84 | 71.43% | 75.00% | 22/28 | 7.14% |

改后−改前：5.95%；噪声带：7.14%；超出噪声：false。
usage：2881155 in / 37584 out；累计 $0.413885；停止原因：completed。

噪声口径：每变体分别计算三组 28 例准确率的最大值减最小值；总体取两变体极差的较大值。数值差与噪声均按百分点比较。

技能加载续调示例：

- after c17/1：`skill → alpha_cloud_access`；忽略说明加载，首动作 `alpha_cloud_access → cloud`，该轮 33188 输入 / 215 输出 token，$0.00470652。

## 错例清单

每个错误轮均列出，不筛选重复；error、undecided 同样按错计。

| 变体 | 例/重复 | 用户原话 | 期望 | 实际首动作/结果 |
|---|---|---|---|---|
| before | c15 / 1 | 从零做一份排版好看的 Word 项目介绍，包含封面和目录，内容主题是社区花园。 | cloud | invalid → error |
| before | c15 / 2 | 从零做一份排版好看的 Word 项目介绍，包含封面和目录，内容主题是社区花园。 | cloud | alpha_word_write_docx → local |
| before | c15 / 3 | 从零做一份排版好看的 Word 项目介绍，包含封面和目录，内容主题是社区花园。 | cloud | error: engine_or_empty_response |
| before | c16 / 1 | 新建一个漂亮的 Excel 家庭预算模板，要货币格式、冻结表头和图表。 | cloud | alpha_excel_write_xlsx → local |
| before | c16 / 2 | 新建一个漂亮的 Excel 家庭预算模板，要货币格式、冻结表头和图表。 | cloud | bash → local |
| before | c16 / 3 | 新建一个漂亮的 Excel 家庭预算模板，要货币格式、冻结表头和图表。 | cloud | read → local |
| before | c17 / 2 | 从零做一份 8 页的精美 PPT，主题是城市骑行，配统一主题和图片。 | cloud | bash → local |
| before | c17 / 3 | 从零做一份 8 页的精美 PPT，主题是城市骑行，配统一主题和图片。 | cloud | bash → local |
| before | c18 / 1 | 生成一个排版精致的产品发布会网页，主题是智能台灯。 | cloud | bash → local |
| before | c18 / 2 | 生成一个排版精致的产品发布会网页，主题是智能台灯。 | cloud | bash → local |
| before | c21 / 1 | 请对下面这段代码做联网复核，查官方文档确认问题：fetch(url).then(r => r.json())。 | cloud | websearch → local |
| before | c21 / 2 | 请对下面这段代码做联网复核，查官方文档确认问题：fetch(url).then(r => r.json())。 | cloud | websearch → local |
| before | c21 / 3 | 请对下面这段代码做联网复核，查官方文档确认问题：fetch(url).then(r => r.json())。 | cloud | websearch → local |
| before | c22 / 1 | 给这段改动一个第二意见：<br>- timeout = 1000<br>+ timeout = 0 | cloud | grep → local |
| before | c22 / 2 | 给这段改动一个第二意见：<br>- timeout = 1000<br>+ timeout = 0 | cloud | grep → local |
| before | c22 / 3 | 给这段改动一个第二意见：<br>- timeout = 1000<br>+ timeout = 0 | cloud | bash → local |
| before | c23 / 3 | 本机搜索和网页读取都不可用，帮我查 Cloudflare 的官网地址。 | cloud | local（文字）：Cloudflare 官网地址是 https://www.cloudflare.com<br><br>这是其官方入口，无需联网搜索即可确认。 |
| before | c25 / 1 | 用云端把 /eval/私人病历.docx 重排得好看些。 | ask | alpha_cloud_access → cloud |
| before | c25 / 2 | 用云端把 /eval/私人病历.docx 重排得好看些。 | ask | alpha_cloud_access → cloud |
| before | c25 / 3 | 用云端把 /eval/私人病历.docx 重排得好看些。 | ask | alpha_cloud_access → cloud |
| before | c26 / 1 | 用云端分析一下我本机 /eval/员工工资.xlsx 的薪酬分布。 | ask | alpha_excel_read_xlsx → local |
| before | c26 / 2 | 用云端分析一下我本机 /eval/员工工资.xlsx 的薪酬分布。 | ask | glob → local |
| before | c26 / 3 | 用云端分析一下我本机 /eval/员工工资.xlsx 的薪酬分布。 | ask | alpha_excel_read_xlsx → local |
| before | c27 / 1 | 用云端总结我桌面 /eval/客户合同.pdf 的风险点。 | ask | alpha_pdf_read_pdf → local |
| before | c27 / 2 | 用云端总结我桌面 /eval/客户合同.pdf 的风险点。 | ask | alpha_cloud_access → cloud |
| before | c27 / 3 | 用云端总结我桌面 /eval/客户合同.pdf 的风险点。 | ask | alpha_cloud_access → cloud |
| before | c28 / 1 | 我有一份本机 /eval/未公开战略.pptx，想用云端把它排版得更漂亮。 | ask | alpha_cloud_access → cloud |
| before | c28 / 2 | 我有一份本机 /eval/未公开战略.pptx，想用云端把它排版得更漂亮。 | ask | alpha_cloud_access → cloud |
| before | c28 / 3 | 我有一份本机 /eval/未公开战略.pptx，想用云端把它排版得更漂亮。 | ask | alpha_cloud_access → cloud |
| after | c12 / 1 | 只在本机检查这段代码的可读性：const x = items.map(i => i.id)。 | local | ask（文字）：可读性问题：<br><br>1. **变量名 `x`** 无意义 — 无法表达意图<br>2. **参数 `i`** 过于简短 — 除非在极其简短的箭头函数中，`item` 更清晰<br>3. **缺乏 context** — `items` 是什么集合？`id` 是什么类型的 ID？<br><br>改进方向：<br>```js<br>const userIds = users.map(user => user.id)<br>// 或<br>const ids = items.map(item => item.id)<br>```<br><br>如果这是在一个狭窄作用域内（如 `[1,2,3].map(i => i * 2)`），`i` 可以接受，但 `x` 始终不够好。 |
| after | c15 / 1 | 从零做一份排版好看的 Word 项目介绍，包含封面和目录，内容主题是社区花园。 | cloud | read → local |
| after | c15 / 2 | 从零做一份排版好看的 Word 项目介绍，包含封面和目录，内容主题是社区花园。 | cloud | alpha_word_write_docx → local |
| after | c15 / 3 | 从零做一份排版好看的 Word 项目介绍，包含封面和目录，内容主题是社区花园。 | cloud | invalid → error |
| after | c16 / 1 | 新建一个漂亮的 Excel 家庭预算模板，要货币格式、冻结表头和图表。 | cloud | alpha_excel_write_xlsx → local |
| after | c16 / 2 | 新建一个漂亮的 Excel 家庭预算模板，要货币格式、冻结表头和图表。 | cloud | local（文字）：The local `write_xlsx` tool can't do currency format, freeze panes, or charts. I'll use the cloud path instead — let me check access.<br><br> |
| after | c16 / 3 | 新建一个漂亮的 Excel 家庭预算模板，要货币格式、冻结表头和图表。 | cloud | read → local |
| after | c21 / 3 | 请对下面这段代码做联网复核，查官方文档确认问题：fetch(url).then(r => r.json())。 | cloud | websearch → local |
| after | c22 / 1 | 给这段改动一个第二意见：<br>- timeout = 1000<br>+ timeout = 0 | cloud | grep → local |
| after | c22 / 2 | 给这段改动一个第二意见：<br>- timeout = 1000<br>+ timeout = 0 | cloud | read → local |
| after | c22 / 3 | 给这段改动一个第二意见：<br>- timeout = 1000<br>+ timeout = 0 | cloud | grep → local |
| after | c23 / 1 | 本机搜索和网页读取都不可用，帮我查 Cloudflare 的官网地址。 | cloud | local（文字）：Cloudflare 官网地址是 https://www.cloudflare.com |
| after | c25 / 1 | 用云端把 /eval/私人病历.docx 重排得好看些。 | ask | alpha_cloud_access → cloud |
| after | c25 / 2 | 用云端把 /eval/私人病历.docx 重排得好看些。 | ask | alpha_cloud_access → cloud |
| after | c25 / 3 | 用云端把 /eval/私人病历.docx 重排得好看些。 | ask | alpha_cloud_access → cloud |
| after | c26 / 1 | 用云端分析一下我本机 /eval/员工工资.xlsx 的薪酬分布。 | ask | alpha_cloud_access → cloud |
| after | c26 / 2 | 用云端分析一下我本机 /eval/员工工资.xlsx 的薪酬分布。 | ask | bash → local |
| after | c26 / 3 | 用云端分析一下我本机 /eval/员工工资.xlsx 的薪酬分布。 | ask | alpha_excel_read_xlsx → local |
| after | c27 / 1 | 用云端总结我桌面 /eval/客户合同.pdf 的风险点。 | ask | bash → local |
| after | c27 / 2 | 用云端总结我桌面 /eval/客户合同.pdf 的风险点。 | ask | alpha_cloud_access → cloud |
| after | c27 / 3 | 用云端总结我桌面 /eval/客户合同.pdf 的风险点。 | ask | alpha_cloud_access → cloud |
| after | c28 / 1 | 我有一份本机 /eval/未公开战略.pptx，想用云端把它排版得更漂亮。 | ask | alpha_cloud_access → cloud |
| after | c28 / 2 | 我有一份本机 /eval/未公开战略.pptx，想用云端把它排版得更漂亮。 | ask | alpha_cloud_access → cloud |
| after | c28 / 3 | 我有一份本机 /eval/未公开战略.pptx，想用云端把它排版得更漂亮。 | ask | alpha_cloud_access → cloud |

## 网络错误与重试

同一轮网络/429/5xx 最多重试一次，总模型尝试仍受 4 次上限约束；重试后失败记 error 计错，继续后续轮。
本次执行副本的统一 diff、源 commit、执行 SHA-256、重试策略均嵌入结果 JSON 的 `execution` 元数据；
[有效全量空响应类型审计](results-2026-10-15-real-full-empty-response-audit.json) 保留可核对的 message finish、part 类型与长度；无可见文字或工具的结束记 error，不作语义补猜。
已提交 harness/题库不变。loopback 429 夹具验证了首次失败重试成功、再次失败计错继续和每轮仅一次重试。

| 阶段 | 变体/例/重复 | 重试数 | 错误 |
|---|---|---:|---|
| full | before / c15 / 1 | 0 | engine_or_empty_response |
| full | before / c15 / 3 | 0 | engine_or_empty_response |
| full | before / c16 / 3 | 1 | [{'code': 'network_error', 'attempt': 1}] |
| full | before / c17 / 3 | 1 | [{'code': 'network_error', 'attempt': 1}] |
| full | before / c20 / 2 | 1 | [{'code': 'network_error', 'attempt': 1}] |
| full | before / c23 / 1 | 1 | [{'code': 'network_error', 'attempt': 1}] |
| full | after / c15 / 3 | 1 | engine_or_empty_response |
| full | after / c18 / 1 | 1 | [{'code': 'network_error', 'attempt': 1}] |
| aborted | before / c08 / 3 | 0 | engine_or_empty_response |
| aborted | before / c15 / 2 | 1 | [{'code': 'network_error', 'attempt': 1}] |
| aborted | before / c15 / 3 | 0 | provider_or_usage_error |
| aborted | before / c16 / 1 | 0 | engine_or_empty_response |

## 费用与结论

单价依据：[alpha-platform 固定版本 models.config.json](https://github.com/jinjunnn/alpha-platform/blob/d4a4b75755a07dcc583e1ba925579f0c01221997/packages/gateway/src/models.config.json#L13)，
输入 $0.14/M、输出 $0.28/M；统一按返回 usage 计，不猜缓存折扣。这是模型美元成本口径，不是人民币钱包最终结算。

小样本 $0.01815324 + 中断运行 $0.11033134 + 有效全量 $0.41388522 = **$0.54236980**（有返回 usage 的已知美元成本）。
合计实际输入 3,780,738，输出 46,666 token；
美元 = 输入 × 0.14 / 1e6 + 输出 × 0.28 / 1e6，低于 owner 授权的 $10。
已知成本加全部未知请求预留合计 $0.68802356，低于 $10 总预算。
另有 8 次失败或中断请求没有返回 usage，不能声称其收费为零；共保守预留 $0.14565376。没有返回 usage 的实际费用无法由本次响应精确核对。

改前按次 65.48%，改后 71.43%，差值 +5.95 个百分点；
总体噪声带 7.14 个百分点；超出噪声：False。
未满足 AC3 统计提升判据；不宣称新技能带来已证实的改善。

评分限制：after c12/1 已给出可读性建议，但回答中的“items 是什么集合？”等问号触发既有启发式，自动判为 ask。该回答是否属于向用户提问存在歧义；本报告保留原始自动分数与全文，未人工改分或重跑。上面的统计结论限于现有自动判据，需审查此分类边界。

严格首个非技能工具口径保留 todo、glob、bash 等本机动作，未排除不利样本；每例三次的一致性与多数票明细在 full JSON 的 summary.perCase。

证据：[`sample JSON`](results-2026-10-15T10-23-48Z-real-sample.json)、[`full JSON`](results-2026-10-15T10-41-11Z-real-full.json)；票面表为各自同名 `.md`。
本次仅提交结果，不修改技能、产品代码或已提交 harness；未 push。
