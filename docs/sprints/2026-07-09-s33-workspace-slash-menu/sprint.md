# S33 — ~/Alpha 用户工作目录 + 斜杠菜单可用性(2026-07-09)

> 抽取:REQ-071(ready,ADR-025 accepted)+ REQ-072(ready,3 拍板点已清)。
> 用户开工指令:「开 sprint 处理 071 072」(2026-07-09)。

## 目标

1. **REQ-071**:`~/Alpha` 默认用户工作目录全量落地(T1 基础供给 + T2 契约配套:alpha-workspace 出厂技能 / 每日总结模板 / Outputs 白名单)。
2. **REQ-072**:斜杠命令菜单三根因修复 + 展示重设计。**⛔ 设计门(用户 2026-07-08 追加指令)**:先出 HTML 设计稿交用户审核,**通过后才动代码**;同轮追加拍板:来源标识**行尾右对齐**(替代原"名字后跟随"式,对齐乱)。

## Task 表

| # | 任务 | REQ | 状态 |
|---|---|---|---|
| T1 | sprint 契约 + BACKLOG 翻 in-sprint + REQ-072 档补设计门/行尾拍板 | — | ☑ |
| T2 | 斜杠弹窗 HTML 设计稿(icon/行尾来源/分组/中文名/键盘态/空态/页脚)→ 用户审核 | 072 | ☐ **gate** |
| T3 | `~/Alpha` lazy 供给(main 单点)+ chip 默认 + 选择器 defaultPath + 无项目态自动化/云任务接线 | 071-T1 | ☑ PR #160 |
| T4 | alpha-workspace 出厂技能 + 每日总结自动化模板(默认不开)+ 云可见副本 Outputs 白名单 | 071-T2 | ☑ PR #160 |
| T5 | alpha-check 全绿 + 四件套回写 + PR(REQ-071);REQ-072 待设计审核后另批实现 | 071 | ☑ |
| T6 | REQ-072 实现(T1 行为修复 + T2 按定稿设计)— **设计审核通过后启动** | 072 | ☐ blocked by T2 |

## Gates

- REQ-072 代码 gate = 用户审核通过 HTML 设计稿(T2);
- push gate = `scripts/alpha-check.sh`(北极星守卫 + typecheck + 单测);
- 真机 gate = 真机批(chip 默认/目录供给/技能生效/菜单键盘导航截图),verified 由实测翻。

## 结果(随执行回写)

- **REQ-071 shipped(PR #160,T1+T2 全量)**:新增 `alpha-user-workspace.ts`(lazy 供给仅对默认目录成立 + Outputs 可见副本守卫,12 单测)、IPC/preload 双通道、home chip 回退链 + 弹层常驻入口、use-projects 开会话前供给、目录选择器 defaultPath 单点兜底、自动化默认目录 + save 前供给、出厂技能 `alpha-workspace`、「每日总结」模板(预填不自启)、云任务(即时/定时拉回)与自动化 run 的 Outputs 镜像;factory-skills 测试夹具改名单派生。alpha-check 全绿(698 tests)。
- **REQ-072**:设计稿 v1 已出(docs/designs/2026-07-09-slash-menu/design.html + Artifact),含可操作实机模拟(键盘/搜索/空态/分组)、行解剖、拍板对照;**等用户审核**,3 个关注点(个人签色/选中态指示条/中英混排)在稿内。
- 残单 → 真机批:~/Alpha 全链路截图核验 + REQ-069 一并复验(用户机器包仍为 7-08 19:23 旧包)。
