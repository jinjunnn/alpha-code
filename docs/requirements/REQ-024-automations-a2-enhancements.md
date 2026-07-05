---
id: REQ-024
title: 自动化 A2 增强:standard 可写档 + LLM 辅助解析 + 连败熔断 + 立即运行 + 预算/历史 UI
type: feature
priority: P2
status: registered
repo: A
created: 2026-07-05
sprint: —
source: requirements/REQ-021-automations.md(A2 节)· ADR-022 §6
---

## 背景(为什么)
[[REQ-021]] 按分期拍板只实现了 A1(本地只读 MVP,PR #81 shipped);A2 增强项在原档内与 shipped 状态并存产生「shipped 但有余量」歧义。按 ADR-018 ID 纪律拆为本独立需求(2026-07-05 建档,依 2026-07-04 用户拍板的延后建档待办;拆行为 memory 推荐方案)。UI 现状:standard 档选项灰显「即将推出」(A1 有意为之)。

## 范围(承 REQ-021 A2 原文)
1. **`standard` 权限档**(可写:edit=allow、bash 危险类仍 deny)+ 启用警告与确认;解除 A1 存储层「强制 readonly」硬校验中对应档位。
2. **LLM 辅助解析**:确定性规则解析失败/复杂描述时,经当前会话模型一次性抽取 schedule+prompt,预览确认流不变(A1 明确不引入,归此)。
3. **失败连败熔断**:连败 3 次自动停用 + 通知(与 B 侧 REQ-022 的熔断语义对齐)。
4. **手动「立即运行」**:不干扰排程(不改 next-fire)。
5. **每任务预算 UI**(时长/日次数)+ **历史保留策略**(默认 30 条/任务)。

## 验收标准
1. standard 档任务真机写文件成功,且启用时警告链路完整(确认框 + 详情页档位徽标);
2. 连败 3 次自动停用可复现(构造必败任务),侧栏 badge + 通知可见,详情页显示停用原因;
3. 「立即运行」执行后原 next-fire 不变;
4. LLM 解析:构造规则解析不出的描述(如「每逢工作日饭点前」)→ LLM 抽取 → 预览卡可改可存;规则可解析的输入不走 LLM(省 token);
5. 历史超保留数自动裁剪,run 目录同步清理策略明确(留档说明即可)。

## 非目标
云档位(→ [[REQ-025]]);事件触发/多步 DAG(REQ-021 全期非目标不变)。

## 前置
REQ-021 A1 **verified**(→ [[REQ-016]] 真机批 E 组)后开工;ADR-022 届时转 accepted 并按 §6 修订分期边界。

## 关联
[[REQ-021]](母档)· [[REQ-025]](A3)· [[REQ-016]](A1 verified 门)· ADR-022。
