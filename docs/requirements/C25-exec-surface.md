---
id: C25
title: open-path / ext-install-plugin exec 触达面收紧
type: security
priority: P2
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-03-s11-cloud-loop
source: 册 §7b / 核查 §4
---

## 背景/证据
`open-path`(`ipc.ts:188-195`)渲染层可达、无约束;`ext-install-plugin`(`ext-ipc.ts:48`)可把任意 npm 包写入 `plugin[]`,下次启动自动执行 —— 与 C2 同类的配置期/exec 触达面(C2 的 persistMcp 已修,此两处未收)。

## 验收标准
1. `open-path`:路径白名单(userData/项目目录)或用户确认,防任意路径打开;
2. `ext-install-plugin`:包名格式校验(复用 C2 的 shell-metachar/白名单逻辑)+ 安装确认弹窗(明示「下次启动将执行该包代码」);
3. 渲染层可达的 exec/写配置 IPC 面复扫一遍,清单化(含新增项防回归);
4. 单测进 ui-mac test(延续 T7.4 模式)。

## 关联
C2(同伞已修)、C1(IPC 硬化已修)、A6(秘钥面,叠加降险)。
