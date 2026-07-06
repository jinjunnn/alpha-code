# Sprint 2026-07-06 S22 —— REQ-044 迁移 provenance + catalog 撤无资产条目

> **抽取(2026-07-06,S21 收批后顺承)**:REQ-044(快车道 bug,S21 真机批 M1 当场发现,验收自明)。上批 S21 已收尾(PR #118),WIP=1 满足。
> **背景**:① `scanMigration` 候选 = 旧 XDG 根名字 ∩ catalog 名字,`runMigration` 用 catalog 版重装后**删除旧位**——同名**用户自建**技能会被覆盖销毁(ADR-019 §4「只迁 alpha 自装」意图未落实);② catalog `skill:mcp-builder` / `skill:canvas-design` / `skill:brand-guidelines` 的 builtinAssetKey 资产从未随 app 打包 → 安装恒失败(诚实失败但不可用),且 `bundle:design` 成员**全部**是这两条 → 空壳套件。
> **修向(REQ-044 登记行)**:① 迁移候选加 provenance 判据;② 撤条目(补货正道 = REQ-032 远程 catalog,上架不需发版)。
> **纪律**:零改上游;判据逻辑 electron-free 可单测;排除必留痕(B11 反静默);证据即单测 + gates,真机复验并入下一真机批。

## Task 表

| # | 项 | 验收 | 状态 |
|---|---|---|---|
| T1 | ① provenance 判据:`alpha-migrate.ts` 增 `verifyLegacyProvenance`(注入 resourcesRoot,electron-free)——skill=旧位目录与打包资产**逐字节递归比对**(pre-T2 alpha 装的 builtin skill 是资产逐字节拷贝;不符/资产缺失=排除);mcp=runner+包基名(去版本钉)+参数数一致 + 无白名单外键 + env 名 ⊆ requiredEnvVars;plugin=基名等且(未钉版 ∨ 与 catalog 同钉版);IPC `ext-migrate-verify` + preload/types + `scanMigration` 按 verdict 过滤;排除项 `[req044-provenance]` main.log 留痕 | 单测:相同拷贝→候选;SKILL.md 改一字节→排除;资产未打包→排除;用户自建同名→排除;mcp 版本钉差异→仍候选;mcp 自定义 env/外来键→排除;plugin 异钉版→排除;fail-closed(比对异常=排除) | ✅(+7 单测,合计 15) |
| T2 | ② catalog 撤 `skill:mcp-builder` / `skill:canvas-design` / `skill:brand-guidelines` 三条目;`bundle:design` 整体撤(成员全空);`bundle:dev` 摘除 mcp-builder 成员;ext-presentation 映射清理;`_comment` 更新(补货走远程 catalog) | catalog JSON 无三条目引用残留;bundle:dev 余 3 成员;typecheck 绿 | ✅(20 entries,bundle 引用零悬空) |
| T3 | 回写:BACKLOG REQ-044 翻 shipped(+PR)· sprint.md 勾选 · CHANGELOG [Unreleased] | 四件套齐(快车道无需求档) | ✅(PR #119) |

## Gates
- 北极星守卫 + typecheck + 单测全绿(`scripts/alpha-check.sh`);
- ship gate:PR merge 前询问用户,**同场再附 B16 PIPL go/no-go 决策请求**(S21 遗留待拍板);
- 真机递延:真实根迁移开门(用户自建内容在场)+ 迁移条像素 → 下一真机批(REQ-044 verified 门)。

## 明确不做
- 不打包 mcp-builder 等三资产(供应链动作:需 NOTICE/来源核验,且远程 catalog 已是补货正道 → 资产就绪后经 C 侧上架,零发版);
- 不做迁移前 diff 预览 UI(provenance 判据已消除覆盖风险;diff UI 属增强,需求出现再立项);
- 不动 MCP/plugin 迁移之外的安装链路。

## 结果(2026-07-06 回填)

**REQ-044 两半边全落(PR #119)= shipped**:
- ①:provenance 终审下沉 main(electron-free,resourcesRoot 注入),链路 = 名字匹配(定位)→ `ext-migrate-verify`(终审)→ 裁决过滤;排除留痕 `[req044-provenance]`。判据取「结构证明」而非账本(pre-T2 安装无 receipt,账本判据先天不可用——修向两选一中账本路线被事实淘汰,取逐字节/形状比对);**fail-closed 语义**:宁可漏迁真 alpha 安装(用户可手动处理),绝不触碰用户内容。
- ②:三无资产条目 + 空壳 bundle:design 撤下,bundle:dev 摘成员(余 3);`_comment` 钉死「不再内置无资产条目,补货走远程 catalog」。

**gates 全绿**:北极星守卫 ✓ typecheck ✓ 455 单测 ✓(448 + 7 新增)。catalog 完整性:20 entries、bundle 引用零悬空、无第二份拷贝。

**verified 门(真机递延)**:真实根迁移开门演练——用户自建 `mcp-builder` 在场时迁移条**不再列它**且 main.log 见排除留痕;S21 留的「真实根迁移留用户批」由本修复解锁(候选已消毒,开门风险消除)→ 下一真机批。

**待用户拍板(随本 PR ship gate 再提)**:B16 PIPL 告知门 go/no-go(S21 遗留;GOALS 已判「重启条件临近」,ADR-021 §4 挂钩点已备)。
