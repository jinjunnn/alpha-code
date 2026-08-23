---
id: ADR-041
title: 工具身份与显示快照收编 —— 来源端建账、权限使用 canonical identity、回放只读首次持久化证据
status: accepted
date: 2026-08-09
kind: adr
owners:
  - alpha-code
last_reviewed: 2026-08-09
review_after: 2027-08-09
related: [ADR-029, ADR-038, "alpha-code:#731", "alpha-code:#878", "alpha-code:#538"]
---

# 工具身份与显示快照收编

## 背景与裁决依据

`docs/design/2026-07-31-tool-identity-baseline.md` 已逐一勘破 V1/V2 的注册、权限、执行与
持久化咽喉；`docs/design/2026-08-08-req125-tool-card-provenance/design.md` 已冻结工具卡
显示快照。`alpha-code#731` 的 owner 裁决批准为这两份已接受合同收编必要的上游 L3 文件，
`alpha-code#878` 负责把该裁决落成。

现有运行时只有 provider technical id/alias。它不足以恢复来源：plugin hook 只交付扁平别名，
MCP 配置不含远端工具名，HTTP MCP 没有可离线枚举的 inventory；同名工具还可能来自 builtin、
plugin、MCP、host 或 V2。因而从 alias、标题、URL、图标或 annotation 反推来源，结构上既不完备
也不唯一。L0/L1/L2 接缝只能在信息丢失后猜测，不能承载 fail-closed 身份与不可变回放证据。

## 决策

1. 工具来源在注册端生成唯一结构 `ToolIdentity = { source, origin, name }`；canonical key 只由
   共享 schema 的百分号转义函数生成。禁止 alias reverse、legacy entries 回退与第二份身份 schema。
2. 每次聚合以 `ToolAliasLedger` 同时检查 alias、canonical identity 与大小写折叠后的 canonical
   identity。碰撞、缺字段、非法 canonical escape 或非规范 canonical 编码一律拒绝，不做 last-wins。
3. ability 与 identity 是两个独立权限轴；任一轴的最终规则是 `deny "*"` 都隐藏工具。E5 workflow
   preapproval 与 E6 直接子任务执行只使用 canonical identity，不再拿 technical id 代替来源身份。
4. 唯一持久化形状是 schema 包的 `ToolDisplaySnapshotV1`，挂在首个 `ToolPart` 写入上：
   `identity + technicalId + authority`。后续 rename/delete/rebind、catalog 不可用或 replay 均不得覆盖。
   历史记录允许缺席，并保持 unknown；不得 live lookup 或推断补写。
5. `alpha-cloud` authority 只可由现有 verified binding graph 的精确 MCP 定义校验产生，并同时持久化
   `bindingId` 与 `sha256:` evidence digest。域名、标题、图标、annotation 或相似 URL 均只能得到
   `not-asserted`。
6. V1、V2 共享上述 schema 与 canonicalizer。V2 不另造兼容表、dual read 或迁移；SDK 只投影同一份
   可选持久化字段。

## 精确 L3 接管面

下列既有上游文件是本 ADR 的完整接管清单；north-star guard 只逐文件排除这些路径：

- `packages/schema/src/v1/session.ts`
- `packages/sdk/js/src/gen/types.gen.ts`（由 schema 生成）
- `packages/sdk/js/src/v2/gen/types.gen.ts`（由 schema 生成；已在 ADR-033 的生成物清单）
- `packages/opencode/src/mcp/index.ts`
- `packages/opencode/src/plugin/index.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/code-mode.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/llm/request.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/test/session/compaction.test.ts`
- `packages/opencode/test/session/processor-effect.test.ts`
- `packages/opencode/test/session/prompt.test.ts`
- `packages/opencode/test/provider/transform.test.ts`（更新直呼 `LLMRequestPrep.prepare` 的测试夹具，并断言 `strict:false` 复制后保留本 ADR 要求的完整 identity）
- `packages/opencode/test/tool/code-mode-integration.test.ts`
- `packages/opencode/test/tool/code-mode.test.ts`
- `packages/opencode/test/tool/registry.test.ts`
- `packages/core/src/tool/application-tools.ts`
- `packages/core/src/tool/registry.ts`

`packages/opencode/src/permission/index.ts` 已由 ADR-038 接管；本 ADR 只在其现有期限语义旁增加正交的
identity deny 判定，不扩大文件面。~~新增文件因 guard 的 DMR 策略不需要排除~~，但同样受本 ADR 所有：
`packages/schema/src/tool-identity.ts`、`packages/plugin/src/alpha-cloud-authority.ts`、
`packages/opencode/src/session/tool-display.ts` 及具名 `alpha-tool-identity` 闸门。

> **订正 · 2026-08-23** —— `#971` 实测 → `#1079` owner 裁决 `CHOICE=2` → `#1085` 落地。
> 上句「新增文件因 guard 的 DMR 策略不需要排除」按**永久**解读不成立，已划掉。
>
> 那句话把**一次性的**豁免写成了永久规则。守卫看的是 `--diff-filter=DMR`：新增确实是 `A`、不触发
> ——**但只在落地那一次**。文件一旦进了 `origin/alpha`，以后任何修改都是 `M`，守卫当场红。
> `#971` 的只读实测（2026-08-14）：
>
> ```
> $ sha=$(git log --diff-filter=M --format=%h -1 -- packages/opencode/test/tool/alpha-tool-identity.test.ts)
> 98acf36f8
> $ git diff --diff-filter=DMR --name-only ${sha}^..${sha} -- $UPSTREAM_PATHS "${EX[@]}"
> packages/opencode/test/tool/alpha-tool-identity.test.ts
> ```
>
> 后果落在最坏的位置：本 ADR 点名的 `alpha-tool-identity` 闸门与 `tool-identity.ts` 本体，是我们
> 最需要维护、却最难改的那批文件；而门红时最省事的反应是 `--no-verify`，那会把**所有**门一起关掉。
>
> **现在的规则**（[[ADR-043]]）：守卫用一条结构性谓词识别 UPSTREAM_PATHS 里的 alpha 自有文件 ——
> ①路径不在上游镜像 `origin/dev` 里 **∧** ②自报家门（basename 以 `alpha-` 开头，**或**文件里写着
> `north-star:alpha-owned`）。据此：
>
> - 本 ADR 的 `alpha-tool-identity` 闸门走①∧②的命名分支，**零登记**；「不需要排除」对它自本次
>   订正起才是永久为真的。
> - `packages/opencode/src/session/tool-display.ts` 与 `packages/schema/src/tool-identity.ts` 名字
>   不合约定，已各自写上 `north-star:alpha-owned` 一行；删掉那一行，对它们的每一次修改都会重新变红。
> - `packages/plugin/src/alpha-cloud-authority.ts` 不在 `UPSTREAM_PATHS` 内（`packages/plugin`
>   从来不在守卫辖区），与本条无关。
>
> 本订正**不改变**本 ADR 的任何接管决定：下方「精确 L3 接管面」那张表一条未动，它仍是逐文件的、
> 每条都受 `UPSTREAM_EXCLUDES` 与 ADR-029 §3 管辖。谓词管的是**从来不是上游的**文件，不是收编。

守卫实现在 `scripts/alpha-check.sh` 与 `.github/workflows/alpha-ci.yml`，两张精确表必须保持 1:1。
不得以目录级排除覆盖未来文件。

## 被否决的方案

- **从 alias 或 legacy entries 反查来源。** 信息已经丢失，碰撞时无法诚实裁决。
- **回放时查询 live catalog/MCP。** 会让历史展示随删除、改名、重绑或故障漂移。
- **用 URL/标题/图标声明 Alpha Cloud。** 这些字段可由不受信来源伪造，无法绑定审核证据。
- **V1/V2 各持一份 schema 或做 dual read。** 会制造第二权威与迁移债，违背本期裁决。
- **只在 UI 修 badge。** UI 位于持久化之后，拿不到已经丢失的来源或首次执行证据。

## 后果、升级与回滚

正面结果是身份从注册到执行、权限、SDK 与 replay 使用同一条可审计证据链；错误绑定宁可缺席，
也不会显示假云权威。代价是 Alpha 持有上述 L3 fork 面，未来同步上游时必须逐文件人工复核身份不变量。

回滚顺序：先回滚消费与写入代码，再移除两张 guard 表中的 ADR-041 精确排除，最后回滚 schema/SDK。
`display` 是可选字段，无数据库迁移、无历史回填，旧记录仍可读取。回滚会失去来源级权限、可信工具卡
与不可变显示证据，但不会要求伪造 legacy 值或改写既有会话。

任何新增 source、authority kind、L3 路径或历史回填都必须另开 owner 裁决；本 ADR 不授权扩面。
