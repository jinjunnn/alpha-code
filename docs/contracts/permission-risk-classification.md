---
title: 授权提示的风险分类(v1 `metadata.alphaRisk`)
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-09-09
review_after: 2027-03-09
---

# 授权提示的风险分类

*REQ-158 · [`#1285`](https://github.com/jinjunnn/alpha-code/issues/1285) · 接缝勘破见
[`architecture/2026-09-08-permission-prompt-classification-seam.md`](../architecture/2026-09-08-permission-prompt-classification-seam.md)*

每一条弹到用户面前的 v1 授权请求(`PermissionV1.Request`,`permission.asked` 事件与 `GET /permission`
的每一项)都携带一个**规则式**分类结论,住在 `metadata.alphaRisk`。它在
`packages/opencode/src/permission/index.ts` 的 `Permission.ask` 里产生 —— 那是 v1 Request 的唯一构造点、
`permission.asked` 的唯一发布点,且在 `Deferred.await`(等待用户应答)之前。分类器本体是
`packages/opencode/src/permission/alpha-risk-classification.ts`(纯函数、零 IO、零模型调用)。

## 它保证什么、不保证什么

| 保证 | 不保证 |
| --- | --- |
| 每条 v1 授权请求都带 `metadata.alphaRisk`,且在动作被放行之前就带着 | **不产生任何否决/放行通道**:`evaluate()` 的 deny/allow/ask 判定在分类之前完成且不读它(`#1291` 决定书 §2.2:分类是输入、cap 是上限、审批是待裁决态) |
| 未被任何规则覆盖的请求落在最保守档 `critical` / `unknown`(`rules: ["fallback:unknown"]`);分类器抛异常同样落到这一档 | 不保证分类**正确**到能替代人的判断 —— 它只用规则与上游已派生的事实,词法探针是 raise-only |
| 入参 `metadata` 里的同名键被**无条件覆盖**(工具 / MCP 自报的低档不算数) | 不重画授权框:今天的 `PermissionDialog` 不读 `metadata`,呈现层改动另立票 |
| 远端 MCP 的身份轴提示上带 `args`(载荷)、`transport`(目的地)、`identity`、`authority` | v2 审批引擎(`PermissionV2`)那条通道**没有**分类 —— 今天产品到不了它(见「前提」) |

## 形状

```ts
metadata.alphaRisk = {
  version: 1,
  level: "low" | "medium" | "high" | "critical",   // 序:low < medium < high < critical
  kind:  "workspace-read" | "workspace-write" | "external-path" | "network-read" | "network-egress"
       | "exfiltration" | "credential-probing" | "security-weakening" | "destructive" | "shell"
       | "third-party-tool" | "delegation" | "session-internal" | "unknown",
  rules: string[],          // 命中的规则 id,有序;level 取其中最高者,kind 取最高者的类别
  facts: {
    destinations: string[], // 观察到的目的地(完整 URL / transport URL)
    paths: string[],        // 路径与探针命中的片段
    programs: string[],     // shell 程序名(能力轴取自上游 `always` 命令头;身份轴取自词法回退)
    signals: string[],      // "credential-path" | "secret-shaped" | "url-credentials" | "persistence-path"
  },
}
```

档位词表与四类高危(数据外发 / 凭据探测 / 持久化削弱安全 / 破坏性)借自 openai/codex guardian 策略
(本机实读 `codex-cli 0.144.1` 二进制内嵌文本);**不借**它的 `user_authorization` 评分与任何模型复审。
借来的两条边界照抄:「路径在工作区之外本身不构成 high」、「`rm -rf` 一个具体本地路径通常是 low/medium」——
所以外部路径只到 `medium`,而 `rm` 落 `high` 是因为这里看不见目标是否窄。

## 事实从哪来

分类器**不手写别人的文法**。它消费的全部是上游工具已经派生好的事实:

| 请求 | 事实来源 |
| --- | --- |
| `edit` / `read` | `patterns` = 上游 `path.relative(worktree, …)`;`..` 开头或绝对路径 = 工作区之外 |
| `bash` | `patterns` = tree-sitter 按命令切好的原文;`always` = `BashArity.prefix` 算出的命令头 ⇒ 程序名 |
| `webfetch` | `patterns[0]` / `metadata.url` 交给平台 `URL` 解析(scheme / userinfo / query) |
| `external_directory` / `glob` / `grep` / `websearch` / `task` / `doom_loop` / `workflow_tool_approval` / … | 各自的 `patterns` 与 `metadata` |
| 身份轴(`gateToolExecution`) | `metadata.identity` / `authority` / `transport` / `args`,由 `alpha-tool-policy-gate.ts` 写入 |

词法探针(凭据路径、秘密形状 token、URL 抽取、持久化落点)一律 raise-only:命中只抬档,未命中不降档。
输入有上限(每段文本 200 000 字符、512 个字符串叶子)。

## 规则表(摘要;权威是源码里的 `rules` id)

| 请求 | 结论 |
| --- | --- |
| `edit` 工作区内 | low / workspace-write(`edit.workspace-path`) |
| `edit` 工作区外 | medium / external-path |
| `edit` 命中凭据或持久化落点(`.env`、`~/.ssh/authorized_keys`、`.bashrc`、`crontab`…) | high / security-weakening |
| `read` 凭据来源(`~/.ssh`、`.aws/credentials`、`.netrc`、钥匙串…) | high / credential-probing;`mcp:…` 资源 ⇒ medium / third-party-tool |
| `bash` 表内 egress 程序(curl/wget/ssh/scp/rsync/aws/gh api/git push/npm publish/wrangler…) | high / network-egress;**同时**命中凭据路径或秘密形状 ⇒ critical / exfiltration |
| `bash` 破坏性(rm/rmdir/shred/dd/mkfs/…)/ 提权(sudo/su/doas)/ 钥匙串(`security`) | high;git reset/clean/branch/rebase、kill、chmod/chown/launchctl/crontab ⇒ medium |
| `bash` 未命中任何表 | **medium / shell(`bash.opaque`,显式规则不是兜底)** |
| `webfetch` | medium / network-read;URL 带 userinfo 或 query 含秘密形状 ⇒ high / exfiltration;解析不了 ⇒ critical / unknown |
| MCP 身份轴,远端 transport + 非空 args | high / exfiltration;载荷含秘密形状或凭据路径 ⇒ critical;空 args ⇒ medium / third-party-tool |
| MCP 身份轴,`authority.kind === "alpha-cloud"`(已核验) | medium / third-party-tool(受信目的地) |
| MCP 身份轴,本地 stdio | medium;transport 不明 ⇒ high |
| plugin 身份轴 | medium / third-party-tool;args 含 URL ⇒ high / network-egress |
| `task` / `doom_loop` / `workflow_tool_approval` | medium(workflow 预批载荷含秘密 + 目的地 ⇒ critical) |
| `glob` / `grep` / `lsp` / `skill` / `todowrite` | low |
| 其它 | **critical / unknown(`fallback:unknown`)** |

## 前提:产品仍在 v1

「每条授权请求都带分类」由 `Permission.ask` 一处覆盖是完整的,**当且仅当**产品里没有任何 v2 会话发送 /
v2 审批建单的调用方(勘破 §9:今天为 0,由 ADR-036 选定、非结构性不可能)。这条前提由两处守着:

- `test/permission/alpha-risk-classification.test.ts` 的 D 组:扫描 `packages/{ui-mac,app,ui,desktop}/src`
  非测试源码,`v2.session.prompt(` / `v2.session.permission.create(` 零命中(带正样本自证与枚举自检);
- `scripts/gate-files.tsv` 把该闸的 `delegates_to` 指向 `#652 单一代次棘轮`
  (`takeover-adapter-coexistence.test.ts`,行为半场再委派 `session-second-send.test.ts`)。

代次若按 ADR-037 独立成票切走,第二处接缝已定位:`packages/core/src/permission.ts` 两个 `Event.Asked`
发布点(勘破 §9.7);届时 v2 那一问可用的事实更少(`write`/`edit` 无 `metadata`),分类能力会下降。

## 闸门

| 文件 | 守什么 |
| --- | --- |
| `packages/opencode/test/permission/alpha-risk-classification.test.ts` | 分类法 / 生产引擎落点 / AC3 源码级 + 运行时 / v1 前提 |
| `packages/opencode/test/permission/alpha-risk-classification-throat.test.ts` | 生产 `SessionTools.resolve().execute()` 上「弹出来的那一问」带分类且先于副作用;远端 MCP 供数 |
| `packages/opencode/test/tool/alpha-code-mode-child-policy.test.ts`(`#1285` 一条) | E4 子工具的身份轴请求带 `args` / `identity` |

变异实测(2026-09-09):identityGate 不传 `args` ⇒ 2 红;gate 不合并 `transport` ⇒ 2 红;`Permission.ask`
不写分类 ⇒ 7 红(引擎组 2 + 咽喉 5);code-mode 不传 `args` ⇒ 1 红;兜底改 `medium` ⇒ 4 红。
