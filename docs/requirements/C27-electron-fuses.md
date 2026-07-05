---
id: C27
title: Electron fuses + asar-integrity + entitlements 收紧
type: security
priority: P2
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-03-s11-cloud-loop
source: 册 §7b / 核查 §4
---

## 背景/证据
无 Electron fuses/asar-integrity(`RunAsNode` 常开 = 注入面);entitlements 过宽:`disable-library-validation` + `allow-dyld-environment-variables` = 经典 dylib 注入组合。邻接 A7(签名已 verified,但纵深防御未收)。

## 验收标准
1. fuses:关 `RunAsNode`(评估 utilityProcess/sidecar 依赖后),开 `EnableEmbeddedAsarIntegrityValidation`;
2. entitlements 逐项收紧或记录必要性(ghostty/native 模块是否真需要 library-validation 豁免);
3. 打包全回归:签名 + 公证复验(`stapler validate` / `spctl`)+ 真机功能走查(终端/sidecar/更新器);
4. 变更记入 DISTRIBUTION.md。

## 关联
A7、B9(更新链)、C24(纵深防御同批)。
