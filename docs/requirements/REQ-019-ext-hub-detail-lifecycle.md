---
id: REQ-019
title: 定制中心 v3-M2:hub 横向 tab IA + 逐类型详情页(数据边界/实时依赖检测)+ 更新通道 + 导入(2026-07-04 拍板:横向导航,否决左栏)
type: feature
priority: P2
status: archived
repo: A
created: 2026-07-04
sprint: 2026-07-04-s13-ext-hub-m2
source: designs/2026-07-04-extension-hub-v3-universal.md(§5、§8 M2)
---

## 背景/证据
现状无任何详情页(卡片主体不可点,唯一信息面 = 安装确认 Dialog `extension-hub.tsx:809-876`);7 个横向 tab 已到极限而 Agent tab 还要加;无更新机制(catalog 钉版 bump 后存量安装成孤儿,A2 备注 T1.5 旧账);导入三卡 comingSoon 占位;错误呈现依赖瞬态 toast。**依赖 REQ-018**(receipts/`.alpha` 落盘先行,详情页的状态与操作才有真相源)。

## 任务拆分(按优先级序)
> **2026-07-04 拍板修订**:用户否决左栏竖栏(应用侧栏旁叠竖栏 = 双侧栏),定稿 = **横向 tab + 详情页下钻 + 「添加」三档分流**(技能直装 / MCP·套件确认框 / 插件详情页先行);交互定稿见 [designs/2026-07-04-ext-hub-m2](../designs/2026-07-04-ext-hub-m2/design.html),拍板记录见 [sprints/s13](../sprints/2026-07-04-s13-ext-hub-m2/sprint.md)。以下 T1/T2 按修订后语义执行。
1. **T1 IA 重构(修订:横向)**:9 tab 一行(推荐/连接器/技能/Agent/插件/套件/已安装[角标=可更新数]/创建/云能力占位);有更新并入已安装、导入并入创建;全局搜索持久(不随 tab 清空)+ 跨类目分组结果;session 内记住分区;「添加」三档分流。**✅ shipped(T1+T2 PR)**
2. **T2 详情页框架(修订)**:点卡片主体 → 类目内下钻(tab 栏保持可见+高亮;「‹ 类目名」返回 + Esc 逐级:弹框→详情→列表→关闭);通用头部(图标/来源/许可证/版本/`_verify` 显式「待核实」+ **主操作在头部右侧**)+ 通用区块(简介/类型专属槽/数据边界/运行时依赖/所需密钥)。**✅ shipped(T1+T2 PR)**
3. **T3 类型专属区块**:MCP=工具列表(catalog 元数据 `tools[]`)+transport+启用范围;Skill=SKILL.md 渲染;Agent=提示词预览+model+权限档摘要+mode;Plugin=hooks/工具+npm 包@版本+「需重载」徽标+风险说明+**「插件 vs 套件」澄清文案(D4 拍板)**;套件=组合清单逐项状态+optional 勾选+逐项重试。
4. **T4 数据边界 + 实时依赖检测**:remote MCP 列目的 host、local 命令型标「仅本机」、云条目引 ADR-021;详情页内实时 which 检测(不再等点添加才发现缺依赖)。
5. **T5 更新通道**:receipts.version < catalog.version → 「有更新」分区;逐条/全部更新(fs 类按 receipt.files 精确替换,MCP 重持久新钉版);更新前显示版本 diff 摘要。
6. **T6 导入**:文件夹(校验 SKILL.md/frontmatter → 复制入 `.alpha` + receipt)、Git URL(浅克隆临时目录 → 同校验);npm 导入并入插件流。
7. **T7 筛选与打磨**:category/license/来源筛选(吸收 E11);空态引导;骨架屏;失败一律行内(卡片错误 chip/详情页 Banner),toast 仅成功。
8. **T8(可选,feature-flag)MCP 实时探测**:主进程 MCP client 真连拉 tools/list(引擎无此路由,已核 `mcp/index.ts` 仅 status/add/connect/disconnect 暴露 HTTP)。

## 验收标准
1. 六类条目(MCP/skill/agent/plugin/套件/云占位)详情页逐一截图核验([[visual-verify-required]]);
2. 更新链路真机走通一例(改 catalog 钉版 → 「有更新」出现 → 更新 → receipts/引擎一致);
3. 导入本地文件夹 skill 真机走通(含非法 frontmatter 拒绝路径);
4. 依赖缺失在详情页即可见(卸掉 uv 实测);
5. 搜索/筛选/空态/骨架按 §5 规范;键盘 Esc 逐级返回;
6. 失败路径零裸 toast(行内呈现),对齐 B11。

## 非目标
远程 catalog 刷新(REQ-020/E10)、npm 任意包导入白名单外放宽、MCP 实时探测转正(T8 仅 flag 内)、命令(command)独立 tab(自动由 skill/MCP 生成,详情页内说明即可)。

## 关联
依赖 REQ-018;吸收 E11(已标 dup);D5(playwright `_verify`)可随 T2 详情页「待核实」标注一并消化;B8 终态视角。
