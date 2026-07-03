---
id: D3
title: 官方 4 条 Anthropic skills 内容打包 + NOTICE
type: feature
priority: P3
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P3 / T5.3 / E 册 E1b 剩余(a)
---

## 背景/证据
定制中心 4 条 Anthropic Apache-2.0 example-skills 内容未打包,当前**诚实失败**(「技能内容未随此版本打包」,非占位)。E1b 机制(资产打包 + installBuiltinSkill 白名单拷贝)已就绪,只差内容与 NOTICE。

## 验收标准
1. 抓取核验 4 条 skill 内容 → `resources/skills/<key>/`,附 Apache-2.0 NOTICE;
2. 定制中心安装成功率 100%(4/4 装入用户 skills 目录并被 opencode 发现);
3. 许可合规:NOTICE 随包,B15 关于面板可达。

## 关联
E1b(机制已发)、D4(已安装态)、B15(NOTICE 已有落点)。
