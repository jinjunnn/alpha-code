---
id: REQ-036
title: 创建技能化:移除定制中心交互式创建表单,skill/agent 创建统一走技能(skill-creator 出厂化 + agent-creator 新技能 + alpha_reload 生效闭环)
type: feature
priority: P1
status: verified
repo: A
created: 2026-07-05
---

## 背景(为什么)

用户拍板(2026-07-05):**去掉交互式创建,只通过技能来创建 skill 和 agent**。

现状核查(2026-07-05,三线勘探,证据 file:line):

1. **定制中心「创建」tab 是裸表单**:只能建 skill/agent 两类(`extension-hub.tsx:182`,表单 `:1262-1312`),Body(SKILL.md 正文 / system prompt)要求用户**手写 markdown**,无 LLM 辅助——对已入画像的非技术用户(REQ-008 D3)不可用;Agent tab 另有内联「创建 Agent」CTA(`extension-hub.tsx:1045-1053`)。
2. **skill-creator 已随包但要手动装**:Anthropic 官方 skill-creator(Apache-2.0)真打包在 `resources/skills/skill-creator/`(catalog `skill:skill-creator`),但只是 catalog 可安装项,非出厂即有。
3. **上游已有「LLM 生成 agent」的成熟能力但桌面无入口**:CLI `opencode agent create`(`cli/cmd/agent.ts:33-232`)用 LLM 生成 frontmatter+prompt 写 `.md`,生成提示词在 `agent/generate.txt`;引擎另内嵌 `customize-opencode` skill(教模型 agent/command/skill 格式,`skill/index.ts:278-283`)。
4. **生效闭环缺口**:会话内模型写盘创建的 skill/agent,引擎**不会自动重扫**——GUI 安装链路由 main 调 `POST /dispose`(ADR-014 v3),但会话内模型无此手段,建完须重启才生效。
5. **对标**:Claude Code 亦无创建表单,创建 = 对话式 + skill-creator/plugin-dev 官方技能——本档方向与业界形态一致。

## 目标(做什么)

1. **删除创建表单**:移除「创建」tab 的 skill/agent 表单与 Agent tab 内联 CTA(纯 alpha 代码);**「导入」(folder/git/npm)保留**(搬运≠创作,且为 [[REQ-033]] 开放安装面的既有通道),tab 语义相应调整(如更名「导入」)。
2. **skill-creator 出厂即有**:`injectAlphaConfig` 把打包的 `resources/skills` 目录注入 `config.skills.paths`(上游支持绝对路径,ADR-019 已实证)——零安装,所有用户开箱即可"帮我创建一个技能";加逃生开关(`ALPHA_FACTORY_SKILLS_DISABLE`)。
3. **新增 alpha 自写 `agent-creator` skill**:教模型 opencode agent frontmatter 规范(`v1/config/agent.ts:12-41`:mode/model/permission/color/hidden/steps…),方法论对齐上游 `agent/generate.txt`;默认写**项目级** `.opencode/agent/`(免 external_directory 弹窗),用户要求全局时落 `~/.alpha/agents` + 桥(ADR-019)。
4. **`alpha_reload` ext 工具(生效闭环)**:在 `@alpha-code/ext`([[B6]] 接缝)新增工具,调上游 `POST /instance|global/dispose`;两个创建技能的收尾步骤调它,实现「创建完当前会话下一条消息即可用」(ADR-014 v3 dispose 语义)。

## 验收标准(可验证,逐条)

1. 定制中心无 skill/agent 创建表单(导入功能保留且可用);相关 i18n/死代码清理,像素核验([[visual-verify-required]]);
2. 全新环境(清 `~/.alpha`)会话内说「帮我创建一个技能」:模型经 skill-creator 完成访谈→生成→写盘,产物 SKILL.md frontmatter 合规(name 小写连字符≤64 + description)且被引擎发现;
3. 会话内说「帮我创建一个 agent」:经 agent-creator 产出合规 agent `.md`,`alpha_reload` 后 agent 出现在选择器,**全程无重启**;
4. `alpha_reload` in-session 实测:写盘 → 调用 → 下一条消息新 skill 可调用(顺带兑现 B6 的 alpha_ping 同类验收);
5. 默认项目级落点不触发 external_directory 权限弹窗;全局落点走 `~/.alpha` 桥并在 `~/.opencode` 可见;
6. 逃生开关生效:置 `ALPHA_FACTORY_SKILLS_DISABLE` 后出厂技能不注入;
7. 零改上游(north-star guard 绿)。

## 非目标

- **不做 command-creator**:command 创建/管理随 [[REQ-019]] V2 与 [[REQ-037]] 治理层一并考虑,本档不引入;
- 不改 hub 既有安装/卸载/更新链路与 receipts 语义(会话内创建物 = 用户自建物,不入账本,ADR-019 §4 边界);
- 不做存量迁移(既有表单创建的产物已在 `~/.alpha`,继续有效);
- 不重做表单的「LLM 辅助增强」变体——方向已被本档取代。

## 方案 / 关联

- 决策依据与机制证据:本轮分析(2026-07-05 会话,三份勘探 + Claude Code 对标);
- [[REQ-033]](开放安装面:导入通道并存)、[[REQ-037]](上游治理层,同为「上游能力面」孪生档)、[[B6]](ext 接缝,alpha_reload 落点)、ADR-014 v3(dispose 免重启)、ADR-019(`.alpha` 落点与桥)、ADR-015 Tier-2(能力扩展走 harness 接缝,不写提示词)。
