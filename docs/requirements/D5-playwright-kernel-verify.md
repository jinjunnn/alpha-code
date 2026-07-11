---
id: D5
title: playwright MCP 浏览器内核来源实测拍板(=E14 遗留)
type: spike
github_issue: https://github.com/jinjunnn/alpha-code/issues/222
repo: A
created: 2026-07-03
source: 册 §一 P3 / T5.5 / ADR-014 修订(E14)
---

## 背景/证据
`mcp:playwright` 已上架(catalog,已钉 @0.0.77);未决:首次 navigate 的浏览器内核来源——默认下载 Chromium(~150MB,中国区 egress 慢)vs `--browser chrome` 复用系统已装 Chrome;`runtimeDep` 仅 which node,内核非安装期可检。ADR-014 留 `_verify`。

## 验收标准
1. 桌面真机实测两种模式的首次 navigate 行为(下载量/时长/失败态);
2. 拍板 catalog 默认 args(是否加 `--browser chrome`)+ 依赖预检提示文案;
3. ADR-014 `_verify` 关闭(修订记录);
4. 中国区网络下的降级提示(下载失败时不静默)。

## 关联
E14、REQ-006(ADR-014 转正同场)、B20(弱网)。
