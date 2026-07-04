# Sprint 2026-07-04 S13 —— 定制中心 v3-M2:详情页 + 生命周期 + IA 重构

> **给接手的新 session**:这是定制中心 v3 的第 2 阶段(M1 已完成,见下)。开工先读三份:
> ① 方案真源 [designs/2026-07-04-extension-hub-v3-universal.md](../../designs/2026-07-04-extension-hub-v3-universal.md)(§5 UX/UI 规范、§8 M2)· ② 验收真源 [requirements/REQ-019](../../requirements/REQ-019-ext-hub-detail-lifecycle.md)· ③ M1 收尾 [sprints/s12](../2026-07-04-s12-ext-hub-m1/sprint.md) + [audits/s12-verify](../../audits/2026-07-04-s12-ext-hub-m1-verify.md)。
> **别重做 M1**:安装账本 / `.alpha` 落盘桥 / 免重启 dispose / 密钥 file 化 / Agent tab / 全类型卸载 **已 shipped**(PR #66–#71)。M2 是在其上**加详情页 + IA 重排 + 更新/导入**。

## 现状(M1 已交付,可直接消费的地基)

| 能力 | 落点(可直接调用) |
|---|---|
| 数据层 | `renderer/extensions/use-extensions.ts` —— `store.{mcp,receipts,agents}` + `addMcp/uninstall/installSkill/installPlugin/createSkill/createAgent/refreshEngine/reloadAgents/isInstalled` |
| hub UI | `renderer/extensions/extension-hub.tsx`(~1100 行:tab 栏 + 卡片 Grid + 已安装管理列表 + 创建表单 + 安装确认弹窗 + 迁移条) |
| catalog | `renderer/extensions/alpha-catalog.json`(20 条)+ 类型 `catalog-types.ts`(`CatalogEntry/InstallSpec`) |
| 安装账本 | `main/alpha-installs.ts`(receipts)· preload `window.api.ext.listInstalls/uninstall` · 类型 `InstallReceipt/InstallLedgerView` |
| 桥/落盘 | `main/alpha-bridge.ts` · `ext-fs-installer.ts` · `ext-config.ts` · `alpha-mcp-secrets.ts` · `alpha-migrate.ts` |

**关键约束(承 M1,勿破)**:引擎无 MCP tools 查询路由(详情页 tools 列表 = **catalog 元数据**为主,主进程实连探测为 flag 内 V2);已装真相 = receipts ⨝ SDK;免重启走 `refreshEngine()`;上游源码零改(北极星)。

## 目标
把「只能装、装完只有一个确认弹窗」升级为**可浏览、可深读、可维护**:hub 内左栏 IA + **逐类型详情页**(含数据边界/实时依赖)+ **更新通道** + **导入**。直接回答用户诉求 Q2「介绍页」(尤其 plugin 由哪些 hooks/工具组成、MCP 有哪些 tool、套件由哪些子项组成)。

## Task 表(模型档按 PROCESS §4 风险×模糊度)

| Task | 内容 | 对应 | 模型 | 状态 |
|---|---|---|---|---|
| **Track α —— IA + 详情页地基** | | | | |
| T1 | **hub 横向 tab IA(2026-07-04 拍板修订:否决左栏竖栏——应用侧栏旁叠竖栏=双侧栏;定稿=[designs/2026-07-04-ext-hub-m2](../../designs/2026-07-04-ext-hub-m2/design.html))**:9 tab 一行[推荐/连接器/技能/Agent/插件/套件/已安装(角标=可更新数)/创建/云能力占位];有更新并入已安装、导入并入创建;**全局搜索持久** + 跨类目分组结果;记住上次分区(session 内);**「添加」三档分流**(技能直装 / MCP·套件确认框 / 插件详情页先行,Q1/Q2 已批)| REQ-019 T1(修订) | opus | ☑ |
| T2 | **详情页框架**:点卡片主体 → 类目内下钻(tab 栏保持可见+高亮;「‹ 类目名」返回 + Esc 逐级:弹框→详情→列表→关闭,Q3 已批);通用头部(图标/名称/来源/许可证/版本/`_verify` 显式「待核实」+ **主操作在头部右侧**)+ 通用区块骨架(简介 / 类型专属槽 / 数据边界 / 运行时依赖 / 所需密钥) | REQ-019 T2(修订) | opus | ☑ |
| **Track β —— 类型专属 + 边界** | | | | |
| T3 | **六类详情专属区块**:MCP=**提供的工具列表**(catalog 新增 `tools[]` 元数据)+transport+启用范围;Skill=SKILL.md 渲染+触发说明;Agent=系统提示预览(折叠)+model+**权限档摘要**+mode;Plugin=hooks/工具清单+npm@版本+**「插件 vs 套件」澄清文案(D4)**+运行于引擎进程风险;套件=组合清单逐项(类型+状态+optional)+顺序+逐项重试;云=输入契约/预算默认/tier/上行数据(占位,随 M3) | REQ-019 T3 | opus 实现 · fable 审 | ☑ |
| T4 | **数据边界 + 实时依赖检测**:remote MCP 列目的 host、local 命令型标「仅本机」、云条目引 ADR-021;详情页内**实时 which 检测**(复用 `ext.checkRuntime`,不再等点添加才发现缺依赖,缺失给安装指引) | REQ-019 T4 | fable | ☐ |
| **Track γ —— 生命周期** | | | | |
| T5 | **更新通道**:receipts.version < catalog.version → 「有更新」分区;逐条/全部更新(fs 类按 receipt.files 精确替换重装、MCP 重持久新钉版);更新前显示版本 diff 摘要;复用 M1 installer + `refreshEngine` | REQ-019 T5 | fable | ☐ |
| T6 | **导入**:文件夹(校验 SKILL.md/frontmatter → 复制入 `.alpha` + receipt,`origin:"imported"`)、Git URL(浅克隆临时目录 → 同校验);均走 M1 落盘桥;npm 导入并入插件流。替换 M1 的 3 个 `comingSoon` 占位 | REQ-019 T6 | opus | ☐ |
| **Track δ —— 打磨** | | | | |
| T7 | **筛选 + 反馈体系**:category/license/来源筛选(吸收 E11);空态每分区 1 句引导 + 1 推荐动作;骨架屏(catalog/状态加载);**失败一律行内**(卡片错误 chip / 详情页 Banner,toast 仅成功,对齐 B11);键盘 Esc 逐级 | REQ-019 T7 + E11 | fable | ☐ |
| **Track ε —— 供给链(2026-07-04 追加,REQ-023)** | | | | |
| T9 | **官方扩展配置化 + 离线资产通道**:catalog 补 agent 类目 + `vendoredAssetKey`/`downloadUrl` + plugin `hooks[]`;`resources/plugins/` 预打包 opencode-notify(MIT,记 NOTICE)→ 安装=复制入 `~/.alpha/plugins` + plugin[] 写**绝对路径**(零网络,绕引擎 npm 下载);官方 agent 资产 ≥1 条同通道;安装管线状态机(检查中→获取→写入→重载→✓)与 T7 合并落 | REQ-023 | fable | ☐ |
| **验收** | | | | |
| T8 | 六类条目详情页逐一 CDP 截图([[visual-verify-required]])+ 三档安装路径各走通一例 + **断网装 vendored plugin 成功(REQ-023 验收①)** + 更新链路走通一例 + 导入本地 skill 走通(含非法 frontmatter 拒绝)+ 依赖缺失详情页可见(卸 uv 实测)+ 失败零裸 toast → 状态回写(BACKLOG/CHANGELOG/REQ-019+REQ-023 frontmatter/ADR-014 v3 checklist 回勾) | REQ-019/023 验收 | fable | ☐ |

## 依赖与排序

- **T1 → T2 → T3/T4**:IA 先重排(T1),详情页框架挂在新 IA(T2),类型专属区块(T3)与数据边界(T4)填进框架。**起手 = T1**。
- T5(更新)、T6(导入)依赖 M1 receipts/installer(已在),可与 T3/T4 并行;T7 打磨最后铺。
- **撞点**:`extension-hub.tsx` 是 T1/T2/T3/T7 共享大文件 → 建议**串行**(T1→T2→T3→T7)或先 T1 落 IA 骨架再分派;`use-extensions.ts`(T5 更新/T6 导入加方法)、`catalog-types.ts`+`alpha-catalog.json`(T3 加 `tools[]`)可并行。
- PR 粒度:T1+T2 一个(IA+框架)· T3 一个(最大)· T4/T5/T6 各一 · T7 一个 · T8 回写。

## Gates(每个实现 PR)

typecheck ☐ · bun test ☐ · 北极星守卫 ☐ · /app:review ☐ · **visual-verify(每新详情页 CDP 截图)☐**
本批附加:失败路径零裸 toast(行内)☐ · 键盘 Esc 逐级返回 ☐

> **T1+T2 PR 已过全部 gates(2026-07-04)**:typecheck ☑ · 266 tests ☑ · alpha-check(北极星守卫)☑ · /app:review 四线 ☑(代码审 1 Important 已修:关闭重开 stale 详情;合规/DRIFT 两黄已修:REQ-019/BACKLOG 文字回填 + CHANGELOG;安全 0 发现)· visual-verify ☑([audits/2026-07-04-s13-t1t2-visual-verify](../../audits/2026-07-04-s13-t1t2-visual-verify/verify.md),7 截图 + 8 DOM 断言)· Esc 逐级 ☑。DRIFT 蓝项(增量 PR 回写边界写进 PROCESS)记 T8 顺带。

## 拍板记录(2026-07-04,用户,经交互设计稿 [designs/2026-07-04-ext-hub-m2](../../designs/2026-07-04-ext-hub-m2/design.html) 审定)

- **导航 = 横向 tab + 详情页面包屑式返回,否决左栏竖栏**(双侧栏叠加交互差);设计稿视觉语言 = 6-26 原稿 token 零改动。
- **「添加」三档分流批准**:Q1 技能直装(无确认框)✅;Q2 插件详情页先行(页内安装+风险确认)✅;Q3 详情页「‹ 类目名」返回保留 ✅;Q4 云能力 tab 现在挂占位 ✅。
- **REQ-023 追加**(T9):官方扩展配置化 + vendored 离线通道 + 安装管线状态机;不自建 CDN。

## 拍板提醒(执行中撞到必停)

- **MCP tools 列表来源**:引擎无查询路由(M1 已核)→ 详情页 tools = **catalog `tools[]` 元数据**(需给 8 条 MCP 补录);「实时探测」(主进程 MCP client 真连拉 tools/list)是 **flag 内 V2**,不进 M2 主路径。
- **导入安全**:folder/git 导入的 skill 内容是外来物 → 校验 frontmatter + 只复制 SKILL.md 结构、不执行任何脚本(参见 skill-creator XSS 教训 PR #73:vendored 内容也带风险);git 浅克隆到临时目录再校验后才入 `.alpha`。
- **云 tab 占位**:M2 只放「云能力」分区骨架 + 登录门控占位,**真内容归 M3(REQ-020)**;不在 M2 接 dispatch。
- 术语「插件」保名(D4 已定),详情页/tab 副标题澄清「插件=引擎 hooks+工具,非大礼包;套件=组合安装」。

## WIP=1 说明

S12(M1)= shipped,引擎级四步已 verified,真机批残余折进 REQ-016(与 S11 同处置)→ **收尾达标,可开 S13**。S13 完成后 M3(REQ-020 云)/ M4(REQ-021 自动化)择一继续(设计 §8 序:M2→M3→M4;M4 自体独立、可提前,只 M4 云档依赖 M3)。

## 结果 / 回写清单

(执行中填)BACKLOG ☐ · CHANGELOG ☐ · REQ-019 frontmatter ☐ · verify ☐ · retro:—
