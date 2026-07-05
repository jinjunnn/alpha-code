---
id: REQ-011
title: 首页 composer 下方项目/会话 chips 移除 —— 预留后续功能入口位
type: ux
priority: P2
status: archived
repo: A
created: 2026-07-03
sprint: —
---

## 背景(为什么)

2026-07-03 用户反馈:AlphaHome 首页 composer(输入框)**下方**当前渲染了一排项目/会话快捷 chips(截图见「alpha-code · REQ-002 代理联调…」「kama-bot-local · Greeting」)。用户明确:**这里不应显示项目**,该位置要**留作后续的一些功能入口**。

判断:非 bug 回归,是**信息架构决策**——项目/会话导航已在左侧栏具备(ADR-008),首页 composer 下方重复陈列项目属冗余;且该黄金位置用户想留给未来功能(候选:云任务派发入口 G4/B3、定制中心快捷、常用命令等,**具体留待拍板**)。

## 目标(做什么)

移除 AlphaHome composer 下方的项目/会话 chips 区;该位置改为**空(预留)**,不引入新功能,只清场 + 留白,为后续功能入口让出位置。

## 验收标准(可验证,逐条)

> [[visual-verify-required]]:真机/CDP 截图核验。

1. 首页(AlphaHome)composer 下方**不再渲染**项目 chip / 会话 chip(截图中被圈两枚 chip 消失)。
2. composer 上方的 workspace chip(`📁 alpha-code`,`a-ws-chip`,当前工作区选择器)**保留不动**——那是有用的工作区切换,不在移除范围。
3. 移除后布局不塌陷、无残留空块/边距异常;首页空态视觉整洁。
4. 左侧栏项目/会话导航功能不受影响(数据源 `useAlphaProjects` 共享 store 不动)。

## 非目标

- **不**在预留位实现任何新功能(那是后续独立需求;此处只清场留白)。
- 不动左侧栏、不动 workspace chip、不改取数逻辑。
- 「预留位放什么」的产品决策**不在本需求内**——进 BACKLOG ⚖️ 待拍板队列,拍板后另立需求。

## 方案 / 关联(designs / ADR / 相关 ID)

- 定位:`packages/ui-mac/src/renderer/alpha-ui/AlphaHome.tsx`(composer 下方 recent chips 渲染区)+ 相应 `home.css`。
- 关联:ADR-008(侧栏已承载项目导航,首页去重);未来功能入口候选关联 G4/B3(云派发)、ADR-014(定制中心)。

## 验证记录(verify 时补:日期 + 方式 + 结果)

- **shipped(PR #83,/loop 2026-07-04)**:代码删除完成(`grep` 无 `RecentPill`/`a-home-recents`/`a-recent`/`newSessionHref`/`hasProjects` 残留),验收①②④满足;`alpha-check` 三关绿(322 tests)。
- **验收③(布局不塌陷/无残留空块)= 待真机视觉核验**:CDP/真机截图首页确认移除后无空块/边距异常([[visual-verify-required]],→ 并入 REQ-016 真机批);离线无法出图故 verified 暂缺。
- **verified(2026-07-05,REQ-016 S16 真机批)**:prod 包首页 chips 已移除、布局不塌陷(02.png,DOM 断言 recents=0)。
- **预留位拍板(2026-07-05,REQ-008 D6 / S17 T1)= 暂空**:黄金位宁缺勿滥;云入口受 B16(parked)牵制不先曝光;⚖️ 队列项划掉;后续放什么由真实需求另立 REQ。
