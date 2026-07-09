---
id: REQ-082
title: 内置技能基线补全 — cloud-dispatch 云派发出厂技能(ADR-021 契约模板兑现)+ customize-alpha 增连接器/套件安装章节
type: feature
priority: P1
repo: A
created: 2026-07-09
status: shipped
source: 用户拍板方向(2026-07-09):「云派发的应该也作为内置提供」;议题⑥裁定 = 扩 customize-alpha 章节、独立安装 skill 暂不立
---

## 背景(实查,2026-07-09)

1. **云派发教学 skill 从未建过**:ADR-021 §1 写明「dispatch skill 的 contract 模板按此写死」,但 grep resources/ext/catalog 零命中——空头承诺。今天会话内的云能力 = 登录代付 + `ALPHA_CLOUD_MCP_URL`/token 就位时注入的裸 cloud_* MCP 工具(sidecar.ts:366-370),**无任何使用指引**(模型不知道 diff-only 契约、denied_paths、预算档位、回流落点)。
2. **customize-alpha 缺连接器/套件章节**:它教 `.alpha` 布局 / `alpha_register` / `alpha.jsonc`,但把连接器安装明确指去定制中心(SKILL.md:34-36),不教 catalog 选型、套件概念、钉版/镜像纪律、runtimeDep 预检、密钥边界。
3. **独立「安装 skill」暂不立的机制依据**(议题⑥裁定):密钥采集只在 main(A6 `{file:}` 通道,skill 写明文 env 违反密钥纪律)、会话内安装绕过 receipts 账本(hub「已安装」失明)、catalog 未向会话暴露(模型看不到精选钉版)——三缺口补齐前独立 skill 只能半吊子;待「catalog-to-session + receipts 写路径」立项再议。

## 交付物与验收标准

1. **出厂技能 `cloud-dispatch`**(alpha 自写,经 `skills.paths` 随包注入,REQ-065 纯度通道):
   - 教 diff-only 契约模板(ADR-021 §1)、denied_paths 默认加固、体积/secrets 前置校验会拒什么、预算/档位、run 回流落点 `.alpha/runs/<runId>/`(ADR-019)与 `~/Alpha/Outputs` 可见副本(ADR-025 T2 落地后);
   - **前置如实声明**:仅登录代付 + cloud MCP 就位时可用(BYOK/登出态技能文案引导而非装作可用);数据边界(ADR-021)与 consent 门如实提及;
   - 验收:登录态会话内触发该技能 → 产出的 contract 能被 `cloud.dispatch` schema 校验接受并真实派发一单(research 管线即可);登出态触发 → 诚实引导不谎称可用。
2. **customize-alpha 扩「连接器/套件」章节**:hub 为主路径、`alpha_register type=mcp` 为项目级次路径(信任门语义如实)、密钥/receipts 诚实边界、uvx/npx runtimeDep 说明;验收 = 章节问答实测准确、不与 hub 行为矛盾。
3. **基线盘点落档**:出厂技能清单 = 7 件(skill-creator / agent-creator / customize-alpha / integrate-project / alpha-workspace + 本项 cloud-dispatch + [[REQ-080]] office-docs),写入 GLOSSARY 或 hub 文档一处,防止再次「建没建过」靠考古。

## 非目标

- 独立「连接器/套件安装」skill(三机制缺口先补,另立项);
- catalog-to-session 暴露 / receipts 会话写路径(REQ 级管道,不在本项);
- 自动化云档(A3/REQ-025)行为变更;B 侧任何改动。

## 关联

- [[ADR-021]](契约模板承诺来源 + 数据边界)· [[ADR-025]](alpha-workspace 出厂技能先例)· [[REQ-065]](纯度通道)· [[REQ-080]](office-docs 同批出厂件)· [[REQ-079]](精选清单)
