---
name: cloud-capabilities
description: 判断任务该用本机还是 Code Puppy 云端。用户说用云端、从零生成网页、生成图片、多来源深度调研、请求联网复核或第二意见时使用；Word/Excel/PPT/PDF 文档、读改本机已有文件、简单查询和默认代码审查优先本机。也可用 /cloud 调用。
license: MIT (Code Puppy original)
---

# Code Puppy 本机与云端

先选择执行位置，再调用工具。下文是 Cloud MCP 的远端工具名；实际调用要选工具表中对应的 ID，宿主可能再加连接器前缀。只调用当前可用工具，不编造工具或结果。

## 选择执行位置

| 情况 | 执行位置与动作 |
| --- | --- |
| 用户明确说「用云端」 | 用云（Word/Excel/PPT/PDF 除外，见下），仍须先检查登录、费用和上传授权。 |
| 生成、读、改 Word/Excel/PPT/PDF | 一律用本机 MCP（按 `office-docs` 技能）；文件写进项目目录、不出本机，无云端费用。 |
| 从零生成要排版好看的网页 | 用云端固定模板与自动校验；派发前告知估价或费用未知。 |
| 生成图片 | 用云；本机没有图片生成能力。 |
| 查一个事实、读一个网页 | 先用本机搜索/读取；本机不可用才用 `cloud_web_search` / `cloud_web_fetch`。 |
| 多来源深度调研 | 用云端 `research`，做多轮检索与综合。 |
| 代码审查 | 默认本机 agent；用户要求「联网复核」或「第二意见」时用云。 |
| 要把本机私有文件传云 | 先问用户，获得上传授权后才发送内容；不能把选用云端当作上传私有文件的授权。 |

云端 Word/Excel/PPT 生成（`office-report`）已停用：不要派发它，用户明确要求云端时也如实说明，改用本机 `mcp:alpha-word`、`mcp:alpha-excel`、`mcp:alpha-powerpoint`、`mcp:alpha-pdf`，按 `office-docs` 技能执行。
代码审查一旦要求联网复核或第二意见，选择云端 `code-review`；先加载本技能并检查云端准入，不先改成本机搜索或本机代码审查。

## 调用云端前

1. 先调用本机工具 `alpha_cloud_access`，查询登录状态、云工具可用性与登录入口。未登录时按返回入口引导登录并停止；Cloud MCP 此时可能整体停用，不能靠云工具查登录。已登录但工具不可用时如实说明。
2. 调用任何收费云能力之前，先用免费的 `cloud_account_status` 查询会员额度、钱包可用余额和「额度用完后用余额付」开关。传入目标 `task`。区分账户数字、估价、预留额和第一步准入结论：预留额不是报价，也不是费用上限；第一步通过不保证整个任务付得起。
3. 派发前告诉用户返回的估价；无法估价时明说「费用事先算不准」，不拿预留额充当估价。不使用「会员或余额满足其一就能调用」的规则：有些费用必须走钱包，额度不足时还取决于余额支付开关。服务端决定最终准入和结算。
4. 预检、派发或后续步骤拒绝时，按返回的拒绝码解释缺什么、怎么解决，例如 `allowance_exhausted` 对应额度耗尽，`wallet_insufficient` 对应钱包不足；按返回建议指向充值或余额支付设置，不反复重试。实际已产生的服务方费用仍可能结算，不承诺失败免费。
5. 上传前确认私有文件授权。代码审查只发送相关 diff，不发送整个仓库；排除密钥、令牌、`.env*`、私钥以及 `.git/`、`.code-puppy/` 的内容，发现凭证先脱敏并告知用户。

## 派发与取回

优先用 `cloud_dispatch` 的固定流水线（`autonomy: "pipeline"`），按当前工具 schema 提供 `kind` 与 `input`：

| kind | input |
| --- | --- |
| `research` | `{question}` |
| `code-review` | `{diff}` |
| `html-generate` | `{prompt}` |
| `image-generation` | `{prompt}` |

HTML 使用托管执行、固定模板和自动校验。不要按任意沙箱脚本任务派发它。

1. `cloud_dispatch` 返回任务 ID 后，用 `cloud_await` 等待，或用 `cloud_status` 查状态；未终结可继续等待。
2. 完成后用 `cloud_artifacts` 获取产物描述符（ID、MIME、size、sha256、provenance、contentRef）。产物字节不内联返回；需由宿主通过 `contentRef.url` 鉴权下载。不要读取登录令牌，也不要把该地址当公开下载链接。
3. 下载成功后才声称文件已保存，并给出实际路径。只有描述符时如实说明尚未下载；失败、取消或超时要报告真实状态与错误，不虚构产物。
