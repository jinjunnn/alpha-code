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
| T6 | REQ-072 实现(T1 行为修复 + T2 按定稿设计 + /agents B 案)| 072 | ☑ PR #161 |
| T7 | REQ-073 统一装配弹窗(@/+ 合一)+ 模式收编(去 AgentChip / 计划 chip / Shift+Tab)| 073 | ☑ PR #162 |

## Gates

- REQ-072 代码 gate = 用户审核通过 HTML 设计稿(T2);
- push gate = `scripts/alpha-check.sh`(北极星守卫 + typecheck + 单测);
- 真机 gate = 真机批(chip 默认/目录供给/技能生效/菜单键盘导航截图),verified 由实测翻。**✅ 已过(2026-07-09 下午)**

## 结果(随执行回写)

- **REQ-071 shipped(PR #160,T1+T2 全量)**:新增 `alpha-user-workspace.ts`(lazy 供给仅对默认目录成立 + Outputs 可见副本守卫,12 单测)、IPC/preload 双通道、home chip 回退链 + 弹层常驻入口、use-projects 开会话前供给、目录选择器 defaultPath 单点兜底、自动化默认目录 + save 前供给、出厂技能 `alpha-workspace`、「每日总结」模板(预填不自启)、云任务(即时/定时拉回)与自动化 run 的 Outputs 镜像;factory-skills 测试夹具改名单派生。alpha-check 全绿(698 tests)。
- **REQ-072 shipped(PR #161)**:设计稿 v1 → 用户拍板(个人签淡 indigo/选中态淡底不加条/混排接受/**B 案 /agents 单条入口**;/ vs @ 语法分工固化 GLOSSARY)→ v2 定稿 → 按稿实现:三根因修复(active 内容签名归零 + 去 12 条帽全量滚动 scrollIntoView + rankSlashMatch 名称前缀>包含>简介中英搜 + 空态)+ 分节/类型 icon/来源四档右缘(出厂技能真源 = ext.factorySkillIds)/中文映射(SLASH_DESC_ZH)/键位页脚;core 新增 20 单测。**CDP 实机核验 6 场景全过**(截图 cdp/):默认分组 21 条全量、↓×3 选中=3(根因①实证修复)、/wr 前缀优先、/审查 中文命中、空态保留、/agents 就位。
- **REQ-073 shipped(PR #162,设计稿 v1 过审 + 7 拍板点全清)**:统一装配弹窗(@ 与 + 同一组件,四节 添加/AGENT/文件/扩展;buildAssembleRows 纯核 5 单测)+ 模式收编(AgentChip 移除、agent 参数缺省=build、计划 chip 左侧簇、Shift+Tab、会话级 home 重置、readonly 联动、第三方主档动态项、扩展节收敛单行)。**顺手根治一个通用 bug**:Chromium 列表重渲染时在光标原地合成 mousemove 会劫持键盘选中(hover 拽回)——坐标校准守卫落 Row 层,/ 菜单同受益。**CDP 实机核验全过**(截图 cdp-073/):四节渲染/键盘含取模回绕/计划行点选→chip+placeholder 切换/重开见「关闭计划模式」/chip 点击关/Shift+Tab 双向/+ 按钮同弹窗/@探索 中文命中/AgentChip 消失。
- 残单 → 真机批(打包安装后):~/Alpha 全链路 + 斜杠菜单像素/滚动手感 + 装配弹窗/计划 chip 手感 + REQ-069 复验(用户机器包仍为 7-08 19:23 旧包)。

## 真机批收尾(2026-07-09 下午,用户下令「archived 真机验证收尾」)

新包(prod 渠道本地打包 12:19)装机,正式 app + 真实 profile CDP 走查(全只读):**REQ-069/070/071/072/073 五项全 PASS → verified → archived**(用户授权当轮归档)。证据 = [audits/2026-07-09-s33-realmachine/verify.md](../../audits/2026-07-09-s33-realmachine/verify.md)(12 截图)。遗留三条小项(引擎就绪前 / 菜单首开不全的加载态观感、REQ-070 存量 pin 待下次登录刷新、REQ-069 Image#4 未复现关闭)记录在 audit,不阻断。**S33 全部收口。**
