---
id: C16
title: 卸载残留含凭证清理 + app 内数据清除入口
type: debt
priority: P2
status: shipped
repo: A
created: 2026-07-03
sprint: S23(2026-07-06,PR #120)
source: 册 §6.3
---

## 背景/证据
拖 app 进废纸篓只删 bundle:≈0.8GB 残留——5 个分支 DB(全量会话)+ `auth.json`/`alpha-auth.json`(token)+ `alpha-byok-keys.json` + 145M 日志 + 61M node_modules,零清理;无卸载 hook、无 app 内数据清除。**凭证残留是安全面,不只卫生。**

## 验收标准
1. app 内「清除数据」入口:分级(仅凭证 / 全部数据),清 userData + 钥匙串项;
2. 卸载指引文档(残留路径清单,dmg/关于页可达);
3. 残留清单可复核:执行清除后 `du` 实测归零(除保留项);
4. 与 B14(备份/导出)同屏:清除前提示先导出。

## 关联
B14、C3(日志大头)、D9(分支 DB)、ADR-017(钥匙串项)。
