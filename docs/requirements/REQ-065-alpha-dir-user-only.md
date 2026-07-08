---
id: REQ-065
title: "`.alpha` 纯度反向收口:出厂/系统件退出 `~/.alpha/skills`,`.alpha` 只承载用户自有内容"
type: debt
priority: P1
status: archived
repo: A
created: 2026-07-08
---

## 背景(为什么)

用户点名(2026-07-08):skill-creator / agent-creator 两个**出厂技能**的真源 symlink 落在 `~/.alpha/skills/<name>`(→ app Resources)——系统级内容出现在用户目录,混淆所有权口径。

**是否 bug 的裁定:不是 bug,是失效不变量的遗留。** REQ-052 不变量「内容本体(含仅指向 app 资产的链)一律先落 `.alpha` 中转一跳」是 `.opencode` 桥时代的产物——目的是保证 `.opencode` 内的 alpha 条目只指向 `.alpha`。REQ-059「全面零 `.opencode`」之后,桥没了,该不变量对出厂件的存在理由随之消失;出厂链继续留在 `~/.alpha/skills` 只剩历史惯性。

**新口径(用户 2026-07-08 拍板,ADR-019 同日修订)**:`.alpha`(全局与项目级)**只承载用户自有内容**——凡有用户动作(安装/创建/导入)且 receipts 可溯者;**出厂/系统件(零用户动作预置)不落 `.alpha`**,经 config 通道直指 app 资源。alpha 注入的系统级 agent(alpha-automation 系)本就只在 config 里、不落盘 `.alpha`,天然合规;唯出厂技能通道需改。

## 目标(做什么)

1. **T1 出厂技能注册通道改直指**:`~/.alpha/alpha.jsonc` 的 `skills.paths` 直接指向 app Resources 内的出厂技能目录(绝对路径);启动 reconcile 每次重写该组条目(跟随 app 安装路径/版本变化,现有 factory-skills reconcile 职责平移)。
2. **T2 存量清理**:reconcile 拆除 `~/.alpha/skills/` 下 `isAlphaFactoryLink` 判定为我方的出厂链(用户自装/自建技能一概不碰,ADR-019 §4 边界);拆后若目录为空且为我方所建,顺手移除。
3. **T3 约定成文**:将来一切「零用户动作」预置内容(出厂 agent、vendored 预置件等)同守此约——不落 `.alpha`,走 config 通道直指随包资产;写入 ADR-019 修订(已同步)。
4. **T4 呈现不回退**:定制中心「已安装」中出厂技能的「出厂」徽标与可用态照旧(数据源 = 内置清单/receipts 逻辑,不依赖 `.alpha` 落盘)。

## 验收标准(可验证,逐条)

1. 全新环境首启:`~/.alpha/skills/` 无出厂链(不存在或不含 factory 条目);skill-creator / agent-creator 在引擎技能列表可见、会话内可触发;
2. 存量环境升级首启:出厂链被 reconcile 拆除(main.log 留痕),用户自装技能与目录原样保留;
3. app 更新(Resources 路径随版本变化)后出厂技能仍可用(reconcile 重写 skills.paths 实证);
4. **`~/.alpha` 全目录树内容 100% 可追溯到用户动作**(逐项对 receipts/创建记录核对,零系统件)——本条是验收核心;
5. 单测:reconcile 幂等 + 只拆我方链(异源链/真实目录不碰)。

## 非目标

- catalog 安装物(含 vendored 插件安装、内置技能一键安装)**仍落 `.alpha`**——那是用户动作,属「你装的」;
- 不动项目级 `.alpha`(REQ-060 落的都是用户/模型显式动作产物,本就合规);
- 不动 alpha 内部产物的 userData 落点(identity/behavior/secrets,ADR-019 既有边界)。

## 风险与回退

- `skills.paths` 指向 per-skill 目录的扫描语义需实测(SKILL.md 在目录根的 pattern 匹配;REQ-059 T3 已用同通道,风险低);
- app 路径含空格/本地化名的 jsonc 转义;
- 回退 = 保留现两跳态(reconcile 行为由开关门控,异常时不拆不改)。
