---
id: REQ-061
title: 统一 composer 弹层 click-outside 竞态:点击同步卸载被点按钮 → 整层弹窗误关,已配置供应商改键表单入口不可达
type: bug
priority: P1
status: shipped
repo: A
created: 2026-07-07
---

## 背景(为什么)

B21 真机批场中发现(2026-07-07,装机 v0.1.2 + PR #141/#142,**3 次稳定复现**;证据 [audits/2026-07-07-b21](../audits/2026-07-07-b21-byok-realkey/verify.md) §REQ-061)。用户可感症状:ModelPickPop 里点「已配置供应商」行想改 key → 整个弹层直接关闭,改键表单永远进不去(改 key 的 UI 主路径硬断;IPC 层改键语义本身不受影响,B21 已 verified)。

编号说明:本 bug 原登记 REQ-060,与并行 session 的「项目级扩展 .alpha-only」撞号,让位改 REQ-061。

## 根因(已定位)

`alpha-composer.tsx` `useChip.onDoc`(document 级 click listener)以 `e.target.closest(".a-pop")` 判定点击在弹层内/外。Solid 委托事件下,点击处理器**同步重渲染**会把被点的按钮从 DOM detach → 事件冒泡到 document 时 `e.target` 已脱离文档树 → `closest(".a-pop")` 返回 null → 误判为「外部点击」→ 关闭整层。`.a-pop` 内部的 `stopPropagation` 拦不住同节点(document)上的另一个 listener。

**影响面**(点击会触发自身/祖先卸载的交互):
① step1 预设行 → 改键表单(主路径,硬断);② 表单「返回」→ step1;③「其他/自定义端点」入口(推定同因)。
**不受影响**(点击不卸载自身):需 KEY 行、添加供应商行、测试连接、保存。

## 修法(已定)

`onDoc` 改用 `e.composedPath()` 做包含判定——composedPath 在事件 dispatch 时快照,对后续 detach 免疫;判定「路径中含 `.a-pop` 根节点」即视为内部点击。快车道单点修复,不动弹层结构。

## 验收标准(可验证,逐条)

1. 已配置供应商行点击 → 进入改键表单(原 3 次复现场景不再复现);
2. 表单「返回」→ 回到 step1,整层不关;「其他/自定义端点」入口同验;
3. 回归:需 KEY 行 → 表单、添加供应商、测试连接、保存全部正常;**真正的外部点击**(弹层外空白处)仍正常关层;Esc 行为不回退;
4. 组件级/单测:模拟「点击处理器同步卸载目标节点」场景,composedPath 判定通过、旧 closest 判定失败(红绿对照);
5. 真机批补「已配置行改键」端到端 UI 走查(B21 行既有承诺,修后下一真机批执行)。

## 非目标

- 不重构弹层/chip 体系(REQ-055 刚收口,单点修);
- 不动 BYOK 改键的 IPC/respawn 语义(B21 已 verified)。
