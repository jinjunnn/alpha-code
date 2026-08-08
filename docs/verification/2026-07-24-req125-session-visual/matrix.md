---
title: "REQ-125 V1 seam 会话页明暗视觉矩阵 — 终判记录"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-06
---

# REQ-125 #547 V1 · seam 会话页与时间线组件 明暗视觉矩阵(采集总表)

本表是 #547 的终判记录。74 行均已按 `PASS` / `FAIL(票号)` / `N/A(依据)` 裁决;
72 行具备明暗双主题证据,2 行因生产数据面明确不存在而判 N/A。现行复跑方式见同目录
`harness-plan.md`,证据摘要见 `README.md`,不变量抽查见 `invariant-checks.md`。

对照基线(已批稿,受保护资产,零回写):

- SW = `docs/design/current/session-workspace/design.html`(整页 / 顶栏 / 右栏四面板 / 状态帧)
- CT = `docs/design/current/conversation-timeline/design.html`(时间线组件全量活稿 §①–⑦)
- 40 构件完备性清单 = `docs/audits/2026-06-28-timeline-overhaul.md` +
  `docs/archive/assets/design-program/2026-06-28-timeline-overhaul/tasks.md`(TL-01–TL-40,
  冻结历史档,仅作完备性对照;其 CSS/INJECT 接缝口径已被
  `docs/design/2026-07-24-session-seam-baseline.md` 取代)

裁决顺位:两稿冲突时组件形态以 CT 为准(CT 帧外声明);dock/审批挂载位以 SW 为准
(CT §③ 渲染位注记);实现边界以方案基线 rev2 为准。

采集状态列约定:填 `PASS` / `FAIL(bug 票号)` / `N/A(依据)`。
FAIL 转 bug 票挂父票 #538。

## 批1 采集记录(2026-07-24,#547 第一批)

- 基点:alpha@`0061eec19`(采集中途 #575「单一顶栏」落主线,全部帧已在该基点重采)。
- 环境:dev app(`OPENCODE_TEST_ONBOARDING=1` 隔离根)+ CDP :9222,窗幅 1440×900@2x;
  明暗 = CDP 置 `data-color-scheme` + emulated media 双通道。截图 `shots/<行ID>-<light|dark>.png`;
  `*-partial-*` = 局部证据帧(该行未达帧规格,不作 PASS/FAIL 判定依据)。
- **环境断点(阻断大半矩阵,待 owner 决策)**:隔离根无模型凭据(平台模型需登录、BYOK 需密钥),
  且 `OPENCODE_TEST_ONBOARDING=1` 强制 `OPENCODE_DB=:memory:`,fixture 落盘路径也不存在 ——
  凡需要「代表性回合 / 运行态 / 审批 / 时间线组件」的行(A1–A4 主体、B2、C2、C3、D1、D2、D8、
  E1–E11、F1–F11、G1–G18、H1–H5、I1–I3、J1–J7)本批受阻。解锁三选一:提供 BYOK key /
  在隔离实例登录 / 认可组件 harness(harness-plan 既定后备)为主证据路径。
- **环境事故(疑真实缺陷,建议排查)**:dev 启动后 sidecar generation 恒 `recovering`——
  boot 健康门从未发布 `ready`(引擎 `/global/health` 实测 200 健康),renderer 数据层整体闲置
  (侧栏项目空、模型列表卡「正在同步」无限重试)。两次冷启均复现。本批以合成
  `alpha:runtime-recovery` ready 事件解锁采集(与引擎真实状态一致)。疑点在
  `packages/ui-mac/src/main/index.ts` boot fork 的 health race(既未打 "loading task finished"
  也未打 "sidecar health check failed")。
- 视觉发现(不修只记,判定/开票归 owner):
  1. **终端输出区浅色主题为白底** —— 违反「始终深底」合同(SW §term 帧外说明、本表 A3 备注)。
     证据:`shots/A3-partial-light.png`、`shots/D6-partial-light.png` vs 设计 §term。
  2. **工作区树含 `.git` 目录**(设计帧不含;树噪音)。证据:`shots/D5-partial-light.png`。
  3. **终端脚条只有「运行中」**,缺环境名 + 尺寸段(SW §term 元素解剖:脚条 = 运行状态+环境+尺寸,
     mono 小字)。证据:`shots/D6-partial-*.png`。
  4. (隐私噪音,非视觉缺陷)PTY 提示符暴露本机主机名;后续批次采集前建议 PS1 化妆。

## 批2 采集记录(2026-07-24,#547 第二批 · 组件 harness 路径)

- 基点:alpha@`7281627ed`(#576 终端深底/.git 过滤已合)。证据等级:**组件级(-harness 后缀)**,
  按 harness-plan「组件 harness」章执行 —— 真组件挂载(dev Vite server + 生产
  `SessionTimelineView`/`tool-cards` + 生产 CSS + `MarkedProvider` 同产装配),fixture 对齐
  CT 帧内演示值;harness 本体在同目录 `harness/timeline-harness.tsx`(不进生产 bundle,不改生产代码)。
  截图 `shots/<行ID>-<light|dark>-harness.png`,900px 容器,明暗双通道
  (`data-color-scheme` + emulated `prefers-color-scheme` 同置,批1 纪律)。
- 复跑法:dev app 起(Vite :5173)→ 同源页 `import("/@fs/<repo>/docs/verification/2026-07-24-req125-session-visual/harness/timeline-harness.tsx")`
  → `window.__harness.show(<state>)` / `.theme(light|dark)` → 截 `.a-tl-column`。
- 覆盖:E1–E11(除 E8)、F1–F11、G1–G18、H1–H5、I1 = 45 行 × 明暗 = 90 帧;另
  `C6-unknown-*-harness.png` 2 帧为未知工具 fail-closed 卡回归档(不入矩阵判定,判定走
  `invariant-checks.md`)。**判定注**:harness 帧为形态证据;单元格「偏差(harness·发现N)」
  = 形态与对照稿有出入,PASS/FAIL 终判与开票归 owner。
- **真机重采(#576 回执,基点 7281627ed)**:A3-partial/D6-partial/D5-partial 四主题帧全部重采 ——
  批1 发现1(终端浅色白底)**已修复**(双主题恒深底);发现2(树含 `.git`)**已修复**;
  发现3 **部分**:尺寸段代码已落(`terminal-rail-panel.tsx` foot)但真机未出值
  (engine pty 无 cols/rows,契约=缺失即整段省略 —— 是否达 #576 AC 归 owner),环境段已拆 #579;
  发现4(PTY 提示符主机名)仍在。
- 仍受阻(harness 不覆盖,等模型凭据/真机构造):A1–A4 主体、B2、C2、C3、D1、D2、D8、
  E8(组件缺席,见发现9)、I2、I3、J1–J7。
- 批2 视觉发现(只记不修,承接批1 编号;判定/开票归 owner): 5. **E1 展开体形态**:实现为展开区内再包一层用户气泡;设计 = 中性灰 pre-wrap 面板(CT ① `.cmd-body`)。6. **斜杠 chip 无类型分型**(E3/E4):技能/MCP 均渲染为通用「运行命令」chip;设计有橙色技能、紫色 MCP 变体(TL-05 分类)。7. **用户脚注无 hover 操作钮**(E5):复制/编辑重发缺席;另 agent/model 显示原始 id(`build`/`deepseek-reasoner`),设计为显示名。8. **轻微一组**:附件卡角标无类型着色、元信息行仅扩展名(E6);提及 chip 无图标(E9/E10);已探索行图标无淡染底(H2);read 卡头无文件计数(G5);bash 卡头带 `bash` 工具名而设计仅命令(G2);webfetch URL 非强调色且未省略缩短(G13)。9. **连接器 chip(TL-06)未实现**(E8):时间线行模型无此形态,harness 无法构造。10. **推理折叠卡头无摘要**(F2):仅「思考 · N 秒」;设计 = 时长 + 摘要文案。11. **Markdown 引擎层与稿差**(F3/F4/F5):表格无表头底色/斑马纹;代码块无语言标签+复制头条;链接与内联 code 配色走引擎(teal/绿)非 `--a-accent`,hr 极淡。另:引擎内容主题通道 = `prefers-color-scheme`,alpha 令牌 = `data-color-scheme`,两通道不同步时正文明暗错拍(采集必须双通道同置)。12. **助手富脚注缺段**(F6):无 provider 图标、效率段、重试/分支钮(复制钮在,hover 出)。13. **中断态形态**(F9):居中 warning 色 pill「已由你停止」,无「继续生成」动作;设计 = 左对齐安静行 + 续钮。14. **工具级错误卡无动作**(G4):无「模型网关错误」类标题行、无复制/重试/换模型钮;仅红框卡 + 错误正文。15. **list 卡无目录网格**(G6):纯文本输出体,无网格/图标/「共 N 项」计数(状态徽亦为「完成」)。16. **grep 结果无高亮**(G7):无文件名/行号分色、无命中高亮,纯 mono 文本。17. **技能执行卡形态**(G15):整宽工具卡,非设计的内联 chip(`.skill-chip`)形态。18. **websearch 结果为裸 URL**(G17):无 favicon/标题/域名分列,头部无「来源 · N 条」。19. **MCP 卡无分层**(G18):走 fail-closed 通用卡,mono 直出 `mcp__server__tool` 全名;设计 = 「MCP · server」+ tool 分层。20. **task v2 细部**(G16,轻微):「打开子会话」在头下动作行非头内同排;环形为定态圆环非进度环。21. **压缩分隔胶囊**(H4,轻微):无图标、无「保留要点」后缀、无展开指示。22. **产物链接行 parquet 无中性态**(I1):六行全强调色,设计 parquet = 中性色同形态。23. **重试卡文案结构**(F10,轻微):「自动重试中(第 N 次)… + message」两段式;设计单句内嵌。

## 批3 采集记录(2026-07-24,#547 第三批 · BYOK 真回合 — 中止,零帧)

- 目标:用 owner 提供的智谱 BYOK key 在隔离根构造真回合,补采批2 仍受阻的 20 行
  (A1–A4、B2、C2、C3、D1、D2、D8、D9 余项、I2、I3、J1–J7;E8 组件缺席不采)。
- 结果:**中止,新增 0 帧;智谱 key 零真实调用,token 消耗 = 0**。四次拉起隔离 dev 实例
  (`OPENCODE_TEST_ONBOARDING=1` + env 注入 ZHIPU_API_KEY,`alpha-secrets sync: wrote
[ZHIPU_API_KEY]` 实证 BYOK env→secret-file 通道可用),每次实例在 1–2 分钟内被外部
  关闭 —— 本机处于 owner 活跃使用状态,采集窗口与真机使用互相干扰(期间 dev 实例的
  登录跳转还把 /Applications 正式版 alpha-code 经 deep-link 拉起)。owner 指示停止采集、
  收尾登记。
- 凭据卫生(已核验):四个含 key 的隔离根已整体删除(alpha-secrets/ZHIPU_API_KEY 全清,
  无 alpha-byok-keys.json 落盘 —— 本批只走 env 通道,未写钥匙库/钥匙串);scratchpad
  env 文件已删;仓库工作树零 key 残留、零 commit;dev 进程/5173/9222 端口全停。
- 批3 环境发现(承接批1 环境事故,只记不修):#577 sidecar `recovering` 竞态复现
  (合成 ready 事件解锁法仍有效);`OPENCODE_TEST_ONBOARDING=1` 下 OPENCODE_DB=:memory:
  意味着实例被关即丢全部会话 —— 真回合采集对「实例存活整个采集窗口」硬依赖,与 owner
  同机使用互斥。
- 处置建议(归 owner/编排者):剩余 20 行改约「机器空闲窗口」重跑批3(方法与脚本已
  就绪:scratchpad `cdp.ts`/`capture-run.ts` 形态 + 本记录),或按 harness-plan 后备
  口径逐行裁决。J4(followup)/J7(handoff)另有 #558/PR#571 票面裁定「数据面缺失」,
  建议直接判 `N/A(组件缺席)` 而非继续挂受阻。

> 2026-08-06 复核更正:批3 所称「剩余 20 行」漏算 D5/D6 两个只有局部帧的行;
> 当时真正缺完整明暗对的是 22 行。D9 虽有双主题文件,但判定仍为「部分」,故也需要
> 新证据才能终判。

## 批4 采集记录(2026-08-06,#547 收口 · production-component headless harness)

- 基点:alpha@`d3790e90b1e815001f8bb40f4ce8d15573c5de89`(#860 merge)。
- 环境:同仓 production Solid 组件 + production CSS 由 loopback-only Vite 装配;
  `/Applications/Google Chrome.app` 以 `--headless=new` 运行,1440×900,明暗双通道同置。
  未启动 Electron/Alpha Code,前台应用启动数 0,未读取账号或 API key。完整机读记录与每帧
  sha256 在 `harness/capture-metadata.json`;驱动为 `harness/capture.mjs`。
- 覆盖:此前缺完整明暗对的 22 行中,J4/J7 按 #558/PR#571 明确的数据面缺席判 N/A;
  其余 20 行全部采集。另补 D9 的完整终判证据。合计 21 行 × 明暗 = 42 帧,
  文件名 `shots/<ID>-<light|dark>-headless.png`。
- 结果:本批 21 行全部 PASS。D1 以已交付的行内评论入口(hover `+`)为合同边界;
  D6 验证终端外壳能呈现运行态、`zsh` 与 `120×32`,生产 PTY 数据同步缺口仍由 #579 承接;
  E8 当前生产组件已由 #588 实现,历史发现9被本批证据取代。
- 进程卫生:采集后 headless Chrome、loopback server 与 4173 listener 均为 0;未留下
  owner 桌面进程或前台窗口。

## A · 整页 × 右栏四 tab(SW §full,1440 页幅)

| ID  | 验证帧                       | 对照稿锚点      | 实现票         | 浅             | 暗             | 备注                                                                         |
| --- | ---------------------------- | --------------- | -------------- | -------------- | -------------- | ---------------------------------------------------------------------------- |
| A1  | 整页 · 右栏=审查(主帧)       | SW `#full` fitA | #539 #540      | PASS(headless) | PASS(headless) | 五大块齐+代表性回合+审查计数;`A1-*-headless.png`                             |
| A2  | 整页 · 右栏=文件             | SW `#full` fitB | #539 #541      | PASS(headless) | PASS(headless) | 树类别标+已打开页签组;`A2-*-headless.png`                                    |
| A3  | 整页 · 右栏=终端             | SW `#full` fitC | #539 #550 #554 | PASS(headless) | PASS(headless) | 双主题恒深底,运行态+环境+尺寸;`A3-*-headless.png`;生产 PTY 数据同步另见 #579 |
| A4  | 整页 · 右栏=产物(链接行联动) | SW `#full` fitD | #539 #542      | PASS(headless) | PASS(headless) | 点 office 产物后右栏聚焦且左侧行保持高亮;`A4-*-headless.png`                 |

## B · 顶栏两态(SW §wtopsec)

| ID  | 验证帧                  | 对照稿锚点        | 实现票    | 浅             | 暗             | 备注                                                                               |
| --- | ----------------------- | ----------------- | --------- | -------------- | -------------- | ---------------------------------------------------------------------------------- |
| B1  | 顶栏 · 空闲态           | SW `#wtopsec` 帧1 | #539      | PASS           | PASS           | 面包屑+改名笔+中性状态胶囊+两开关;`B1-{light,dark}.png`(改名笔为悬停显现,静帧未验) |
| B2  | 顶栏 · 运行态(正在生成) | SW `#wtopsec` 帧2 | #539 #543 | PASS(headless) | PASS(headless) | 强调色+呼吸点;`B2-*-headless.png`                                                  |

## C · 整页状态变体(SW §states)

| ID  | 验证帧                                     | 对照稿锚点                                                                                          | 实现票    | 浅             | 暗             | 备注                                                                                            |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------- | -------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| C1  | 变体一 · 右栏收起(时间线回中)              | SW `#states` fitE                                                                                   | #539      | PASS(布局)     | PASS(布局)     | 时间线 760 上限居中;开关退未激活;`C1-{light,dark}.png`(时间线内容缺席=A1 同因,布局不变量全成立) |
| C2  | 变体二 · 审批呈现(独立 Permission surface) | REQ-090 已批 Dialog(`docs/verification/2026-07-21-req090-permission-l2/`);SW `#states` 变体二已作废 | #545 #619 | PASS(headless) | PASS(headless) | 恰一个五栏 PermissionDialog,dock 无审批卡;`C2-*-headless.png`                                   |
| C3  | 变体三 · 会话运行中(顶栏+尾部+停止键)      | SW `#states` 变体三                                                                                 | #543 #545 | PASS(headless) | PASS(headless) | 三层指示成立;`C3-*-headless.png`                                                                |

## D · 右栏面板细部(SW §review/§files/§term/§arts/§railsec)

| ID  | 验证帧                                | 对照稿锚点                             | 实现票        | 浅             | 暗             | 备注                                                                                     |
| --- | ------------------------------------- | -------------------------------------- | ------------- | -------------- | -------------- | ---------------------------------------------------------------------------------------- |
| D1  | 审查 · 统一视图+行内评论              | SW `#review` 帧1                       | #540          | PASS(headless) | PASS(headless) | 摘要/文件卡/改动块/折叠条成立,hover 行显示 `+` 评论入口;`D1-*-headless.png`              |
| D2  | 审查 · 拆分视图                       | SW `#review` 帧2                       | #540          | PASS(headless) | PASS(headless) | 左旧右新+斜纹占位;`D2-*-headless.png`                                                    |
| D3  | 审查 · 空态「还没有版本管理」         | SW `#review` 空态×2 左                 | #540          | PASS           | PASS           | `D3-{light,dark}.png`(非 git 目录会话);图标+双行措辞逐字对齐设计                         |
| D4  | 审查 · 空态「没有未提交的变更」       | SW `#review` 空态×2 右                 | #540          | PASS           | PASS           | `D4-{light,dark}.png`;图标+双行措辞逐字对齐设计                                          |
| D5  | 文件面板(过滤+已打开+工作区树)        | SW `#files`                            | #541          | PASS(headless) | PASS(headless) | 过滤+已打开+类别标+展开树成立且无 `.git`;`D5-*-headless.png`                             |
| D6  | 终端面板(页签+输出区+脚条)            | SW `#term`                             | #550 #554     | PASS(headless) | PASS(headless) | 双实例+运行点+恒深底+`zsh`+`120×32`;`D6-*-headless.png`;生产同步缺口 #579 不改本视觉判定 |
| D7  | 终端面板 · 空态                       | SW `#term` 帧外注记(**无帧**,文字规格) | #550          | PASS           | PASS           | 「还没有终端…」+新建按钮;`D7-{light,dark}.png` 与文字合同逐字相符                        |
| D8  | 产物面板(列表卡+预览面)               | SW `#arts`                             | #542          | PASS(headless) | PASS(headless) | workbench 列表卡+office 预览面成立;`D8-*-headless.png`                                   |
| D9  | 右栏 tab 条(计数徽章+运行点)+拖宽热区 | SW `#railsec`                          | #539 各面板票 | PASS(headless) | PASS(headless) | 46px tab 条、审查计数、终端运行点及 hover 拖宽强调线同框;`D9-*-headless.png`             |

## E · 时间线 §① 用户输入侧(CT `#user`)

| ID  | 验证帧                                  | 对照稿锚点                    | 实现票    | 浅                  | 暗                  | 备注                                                                                   |
| --- | --------------------------------------- | ----------------------------- | --------- | ------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| E1  | 命令 chip · 内置(含展开体)              | CT `#user` 帧1                | #544 #545 | FAIL(#861)          | FAIL(#861)          | 现行 CT 为权威;实现展开区内嵌套用户气泡,未达中性 `.cmd-body`                           |
| E2  | 命令 chip · 配置命令带 args             | CT `#user` 帧1                | #544 #545 | PASS(harness)       | PASS(harness)       | 「运行命令 · review pr 12」                                                            |
| E3  | 技能 chip(用户侧)                       | CT `#user` 帧1                | #544 #545 | FAIL(#582)          | FAIL(#582)          | 与 G15 执行态技能卡分处两回合                                                          |
| E4  | MCP chip                                | CT `#user` 帧1                | #544 #545 | FAIL(#582)          | FAIL(#582)          | 紫;name+args                                                                           |
| E5  | 用户文本气泡+脚注(发往·model·时间+操作) | CT `#user` 帧2                | #543 #862 | PASS(harness)       | PASS(harness)       | 可读显示名;hover 显复制/编辑重发;`E5-*-harness.png`                                     |
| E6  | 附件卡 · 文件(v2 双行)                  | CT `#user` 帧2                | #544      | PASS(harness·发现8) | PASS(harness·发现8) | 由 v1 内联 chip 重锚(帧外注记)                                                         |
| E7  | 附件卡 · 图片                           | CT `#user` 帧2                | #544      | PASS(harness)       | PASS(harness)       | 缩略图+名+元信息                                                                       |
| E8  | 连接器 chip(GH GitHub)                  | CT `#user` 帧2                | #544 #588 | PASS(headless)      | PASS(headless)      | 当前生产 resource segment 渲染 GitHub chip;`E8-*-headless.png`;历史发现9已由 #588 修复 |
| E9  | 内联文件提及                            | CT `#user` 帧2                | #543      | PASS(harness·发现8) | PASS(harness·发现8) | m-file chip                                                                            |
| E10 | 内联 agent 提及                         | CT `#user` 帧2                | #543      | PASS(harness·发现8) | PASS(harness·发现8) | m-agent chip                                                                           |
| E11 | 内联代码评论卡(用户消息内)              | CT `#user` 帧3(2026-07-23 补) | #544      | PASS(harness)       | PASS(harness)       | CommentCardV2 对应形态                                                                 |

## F · 时间线 §② 助手输出侧(CT `#ai`)

| ID  | 验证帧                                                 | 对照稿锚点              | 实现票    | 浅                   | 暗                   | 备注                                                    |
| --- | ------------------------------------------------------ | ----------------------- | --------- | -------------------- | -------------------- | ------------------------------------------------------- |
| F1  | Thinking 流式态(pill+三点)                             | CT `#ai`                | #543      | PASS(harness)        | PASS(harness)        |                                                         |
| F2  | 推理折叠卡(思考·时长·摘要)                             | CT `#ai`                | #543 #863 | PASS(harness)        | PASS(harness)        | 完成态起始标题+时长;缺标题稳定省略摘要;`F2-*-harness.png` |
| F3  | 助手 Markdown 正文+表格                                | CT `#ai`                | #543      | FAIL(#592)           | FAIL(#592)           | 820 测量;表格边框/表头/斑马                             |
| F4  | 代码块(语言标签+复制头条)                              | CT `#ai`                | #543      | FAIL(#592)           | FAIL(#592)           | 白名单 Markdown 引擎差异由 #592 承接                    |
| F5  | Markdown 富元素(标题/列表/引用/hr/链接)                | CT `#ai`                | #543      | FAIL(#592)           | FAIL(#592)           | 白名单 Markdown 引擎差异由 #592 承接                    |
| F6  | 助手富脚注(provider+agent+model+效率+时长+tokens+操作) | CT `#ai`                | #543 #591 | PASS(resolved #591)  | PASS(resolved #591)  | 批2发现12由 #591 修复;无对应数据时重试/分支安全省略     |
| F7  | 媒体预览行(缩略图+文件名+尺寸)                         | CT `#ai`(2026-07-24 补) | #544 #542 | PASS(harness)        | PASS(harness)        | 点击→右栏产物聚焦(联动同 ⑥)                             |
| F8  | 流式输出光标                                           | CT `#ai`                | #543      | PASS(harness)        | PASS(harness)        |                                                         |
| F9  | 中断态(已由你停止 · 继续生成)                          | CT `#ai`                | #543 #589 | PASS(resolved #589)  | PASS(resolved #589)  | 视觉形态由 #589 修复;resume 语义副作用另由 #620 承接    |
| F10 | 重试卡(429 自动重试)                                   | CT `#ai`                | #543      | PASS(harness·发现23) | PASS(harness·发现23) |                                                         |
| F11 | 回合级错误卡(全宽,无动作钮)                            | CT `#ai`(2026-07-23 补) | #544      | PASS(harness)        | PASS(harness)        | 与工具级错误卡是两组件;未知 code 原样 mono(fail-closed) |

## G · 时间线 §③ 工具卡(CT `#tools`)

| ID  | 验证帧                                               | 对照稿锚点                 | 实现票    | 浅                   | 暗                   | 备注                                                       |
| --- | ---------------------------------------------------- | -------------------------- | --------- | -------------------- | -------------------- | ---------------------------------------------------------- |
| G1  | 工具卡 · 通用运行态                                  | CT `#tools` 帧1            | #544      | PASS(harness)        | PASS(harness)        | 强调边框+spinner chip(四态之一)                            |
| G2  | bash · 完成态(退出0徽+描述行+输出体)                 | CT `#tools`                | #544      | PASS(harness·发现8)  | PASS(harness·发现8)  | TL-17/18                                                   |
| G3  | bash · 流式运行态(实时增行+尾行光标)                 | CT `#tools`(2026-07-24 补) | #544      | PASS(harness)        | PASS(harness)        | 完成即翻「退出 N」,卡体不换                                |
| G4  | 工具级错误卡(重试/换模型)                            | CT `#tools`                | #544 #590 | PASS(resolved #590)  | PASS(resolved #590)  | 批2发现14由 #590 修复                                      |
| G5  | read 卡(折叠头「读取 · N 个文件」)                   | CT `#tools`                | #544      | PASS(harness·发现8)  | PASS(harness·发现8)  | 展开列表**无独立帧**,形态对齐 G8 的 .loaded 列表(锚点借用) |
| G6  | list 目录网格(共 N 项)                               | CT `#tools`                | #544      | FAIL(#583)           | FAIL(#583)           |                                                            |
| G7  | grep 检索卡(文件:行+命中高亮+计数)                   | CT `#tools`                | #544      | FAIL(#584)           | FAIL(#584)           |                                                            |
| G8  | glob 匹配文件卡                                      | CT `#tools`(2026-07-23 补) | #544      | PASS(harness)        | PASS(harness)        |                                                            |
| G9  | write 紧凑卡(+N·在面板打开·2 行预览)                 | CT `#tools`                | #544      | PASS(harness)        | PASS(harness)        | TL-21/22                                                   |
| G10 | edit 紧凑 diff 卡(+N/−N)                             | CT `#tools`                | #544      | PASS(harness)        | PASS(harness)        |                                                            |
| G11 | apply_patch 多文件卡(新增/修改/删除标)               | CT `#tools`                | #544      | PASS(harness)        | PASS(harness)        |                                                            |
| G12 | 文件行徽章 · 六态一览(读取/写入/移动/新增/修改/删除) | CT `#tools`(2026-07-24 补) | #544      | PASS(harness)        | PASS(harness)        | 徽章只表动作类别                                           |
| G13 | webfetch 触发行(链接 subtitle)                       | CT `#tools`                | #544      | PASS(harness·发现8)  | PASS(harness·发现8)  |                                                            |
| G14 | 诊断列表(ERR loc msg)                                | CT `#tools`                | #544      | PASS(harness)        | PASS(harness)        |                                                            |
| G15 | 技能工具卡(执行态 · 已加载)                          | CT `#tools`                | #544      | FAIL(#585)           | FAIL(#585)           |                                                            |
| G16 | 子任务卡 v2(色点+环形进度+打开子会话,运行态)         | CT `#tools`                | #544      | PASS(harness·发现20) | PASS(harness·发现20) | 由 v1 重锚(帧外注记)                                       |
| G17 | websearch 结果列表(favicon+标题+域名)                | CT `#tools`                | #544      | FAIL(#586)           | FAIL(#586)           |                                                            |
| G18 | MCP 通用工具卡(MCP · server · tool 分层)             | CT `#tools`                | #544      | FAIL(#587)           | FAIL(#587)           |                                                            |

## H · 时间线 §④ 结构(CT `#struct`)

| ID  | 验证帧                               | 对照稿锚点                  | 实现票    | 浅                  | 暗                  | 备注                                                                                                                                                                     |
| --- | ------------------------------------ | --------------------------- | --------- | ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | 回合分隔条(HH:MM · 新一轮)           | CT `#struct`                | #543      | PASS(harness)       | PASS(harness)       | ⚠ 条件项:帧为设计意图;帧外注记定 v2 真机=不可见间隔,落地与否归 seam 实现。若 C5 实现为不可见间隔,判 `N/A(实现合同)`;批2:实现=可见分隔条,与设计意图帧一致,N/A 条款不触发 |
| H2  | 已探索分组(头+计数+展开行)           | CT `#struct`                | #544      | PASS(harness·发现8) | PASS(harness·发现8) | TL-30;TL-31 计数动画静帧仅验配色                                                                                                                                         |
| H3  | 本回合改动汇总 diffsum(头+文件行+徽) | CT `#struct`                | #543 #544 | PASS(harness)       | PASS(harness)       | 行模型归属以实现为准                                                                                                                                                     |
| H4  | 上下文压缩分隔(居中胶囊)             | CT `#struct`                | #543 #864 | PASS(harness)       | PASS(harness)       | 图标+「保留要点」+展开指示;键盘/鼠标展开引擎既有 summary;`H4-*-harness.png`                                                                                              |
| H5  | 回到底部按钮(s2b)                    | CT `#struct` 帧右下         | #543      | PASS(harness)       | PASS(harness)       | 滚动锚定配套                                                                                                                                                             |
| H6  | 会话内空态(会话名+一句引导)          | CT `#struct`(2026-07-24 补) | #543      | PASS                | PASS                | 与首页问候面分工(帧外注记);`H6-{light,dark}.png` 与 CT 帧逐字/逐元素对齐(会话名+引导句+下箭头)                                                                           |

## I · 时间线 §⑥ 产物链接行与联动(CT `#artifacts`)

| ID  | 验证帧                               | 对照稿锚点                       | 实现票    | 浅             | 暗             | 备注                                                          |
| --- | ------------------------------------ | -------------------------------- | --------- | -------------- | -------------- | ------------------------------------------------------------- |
| I1  | 产物链接行(6 类型含 parquet 中性态)  | CT `#artifacts` 帧1              | #542 #544 | FAIL(#865)     | FAIL(#865)     | 承接 REQ-124 #454;当前行不区分可否预览                        |
| I2  | 产物点击联动 · 可预览(office)        | CT `#artifacts` frameD office 态 | #542      | PASS(headless) | PASS(headless) | 点击真实 timeline 产物行后右栏聚焦 office;`I2-*-headless.png` |
| I3  | 产物点击联动 · 暂不支持预览(parquet) | CT `#artifacts` frameD other 态  | #542      | PASS(headless) | PASS(headless) | 文件信息+有界 fallback,不称“预览”;`I3-*-headless.png`         |

## J · 停靠区卡片各状态(挂载位以 SW 为准;CT §③ 只定卡片形态;审批不属 dock 集合,J1 走独立 Permission surface)

| ID  | 验证帧                                    | 对照稿锚点                                                                | 实现票    | 浅               | 暗               | 备注                                                                            |
| --- | ----------------------------------------- | ------------------------------------------------------------------------- | --------- | ---------------- | ---------------- | ------------------------------------------------------------------------------- |
| J1  | 审批呈现(独立 Permission surface;非 dock) | REQ-090 已批 Dialog(`docs/verification/2026-07-21-req090-permission-l2/`) | #545 #619 | PASS(headless)   | PASS(headless)   | 恰一个 PermissionDialog;`J1-*-headless.png`;同场闸门继续覆盖生产 watcher × dock |
| J2  | todo 任务清单卡(三态+进度)                | CT `#tools` todos 帧(渲染位=dock)                                         | #545      | PASS(headless)   | PASS(headless)   | `J2-*-headless.png`                                                             |
| J3  | question 提问卡(选项 A/B)                 | CT `#tools` qa 帧(渲染位=dock)                                            | #545      | PASS(headless)   | PASS(headless)   | `J3-*-headless.png`                                                             |
| J4  | followup dock 态                          | **设计稿无帧**(CT §⑦ 索引无此类型;SW 只画审批停靠)                        | #558      | N/A(#558/PR#571) | N/A(#558/PR#571) | followup 数据面不存在,不得合成虚假生产态                                        |
| J5  | revert dock 态                            | **设计稿无帧**(同上)                                                      | #558      | PASS(headless)   | PASS(headless)   | 生产 dock 组件确定性态;`J5-*-headless.png`                                      |
| J6  | child-session dock 态                     | **设计稿无帧**(同上)                                                      | #558      | PASS(headless)   | PASS(headless)   | 生产 dock 组件确定性态;`J6-*-headless.png`                                      |
| J7  | handoff dock 态                           | **设计稿无帧**(同上)                                                      | #558      | N/A(#558/PR#571) | N/A(#558/PR#571) | handoff 数据面不存在,不得合成虚假生产态                                         |

## 统计

- **终判 74/74 行**:PASS 60 行,FAIL 12 行,N/A 2 行。没有留空、受阻、部分或待 owner
  判定的单元格。
- 72 个可达行均有明暗双主题证据 = **144 个终判帧**;J4/J7 因 #558/PR#571 已确认
  生产数据面不存在而 N/A,不制作虚假截图。另有 C6 未知工具回归档 2 帧及历史局部帧。
- FAIL 12 行全部路由到父票 #538 下的 9 张实现票:E1→#861,E3/E4→#582,
  F3–F5→#592,G6→#583,G7→#584,G15→#585,G17→#586,G18→#587,I1→#865。
- 历史发现9/12/13/14 已分别由 #588/#591/#589/#590 修复;批4 E8 新证据取代旧的
  「组件缺席」判断。F9 的无副作用 resume 语义仍由 #620 承接,不改变本视觉终判。
- 现行无开放口径冲突:C2/J1 按 #619 的独立 Permission surface 判定;E1 按现行 CT
  设计判 FAIL(#861),冻结历史稿不再作为待 owner 决策。

## 40 构件清单逐条映射(TL-01–TL-40 → 矩阵行)

| TL    | 构件                    | 映射行                                    | 缺口/依据                                                                                     |
| ----- | ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| TL-01 | 文件附件 pill           | E6                                        | 已重锚 v2 双行附件卡(CT ① 帧外注记)                                                           |
| TL-02 | 图片附件缩略图          | E7                                        |                                                                                               |
| TL-03 | 内联文件提及            | E9                                        |                                                                                               |
| TL-04 | 内联 agent 提及         | E10                                       |                                                                                               |
| TL-05 | 斜杠命令 chip 分类      | E1–E4                                     | 现行 CT 为权威;E1→#861,E3/E4→#582                                                             |
| TL-06 | 连接器/资源提及 chip    | E8                                        |                                                                                               |
| TL-07 | 助手脚注                | F6                                        |                                                                                               |
| TL-08 | Markdown 表格           | F3                                        |                                                                                               |
| TL-09 | Markdown 富元素         | F5                                        |                                                                                               |
| TL-10 | 代码块复制+语言标签     | F4                                        |                                                                                               |
| TL-11 | Thinking 流式态         | F1                                        |                                                                                               |
| TL-12 | 中断态                  | F9                                        |                                                                                               |
| TL-13 | 重试态卡                | F10                                       |                                                                                               |
| TL-14 | reasoning 折叠+时长     | F2                                        |                                                                                               |
| TL-15 | 工具运行/完成状态       | G1 + 各完成态行(G2/G5–G8/G13/G15/G17/G18) | 四态横切,逐卡行判定                                                                           |
| TL-16 | 折叠箭头统一            | 横切:G1–G11/H2/F2 判定项                  | **无独立帧**;并入各折叠卡行的判定清单                                                         |
| TL-17 | bash 退出码徽标         | G2                                        |                                                                                               |
| TL-18 | bash 描述行             | G2                                        |                                                                                               |
| TL-19 | read 已读文件行         | G5                                        | **展开列表无独立帧**,锚点借用 G8 .loaded 形态                                                 |
| TL-20 | glob/grep 输出          | G7 / G8                                   |                                                                                               |
| TL-21 | 结构化文件卡头          | G9 / G10                                  |                                                                                               |
| TL-22 | +N/−N 改动徽标          | 横切:G9/G10/G11/G12/H3/D1                 | **无独立帧**;共享原语,在各出现处判一致性                                                      |
| TL-23 | apply_patch 多文件 diff | G11                                       |                                                                                               |
| TL-24 | todos 项状态            | J2                                        | 渲染位=dock(CT ③ 渲染位注记)                                                                  |
| TL-25 | 子任务卡                | G16                                       | 已重锚 v2 形态                                                                                |
| TL-26 | 联网结果列表            | G17                                       |                                                                                               |
| TL-27 | webfetch 触发行         | G13                                       |                                                                                               |
| TL-28 | MCP/通用工具文案分层    | G18                                       |                                                                                               |
| TL-29 | 诊断列表                | G14                                       |                                                                                               |
| TL-30 | 已探索分组标题/计数     | H2                                        |                                                                                               |
| TL-31 | 计数动画换肤            | H2                                        | **动画时序静帧不可验**,仅验配色;动效归真机目检,不入截图判定                                   |
| TL-32 | 本回合改动汇总          | H3                                        |                                                                                               |
| TL-33 | 上下文压缩分隔          | H4                                        |                                                                                               |
| TL-34 | 回合分隔                | H1                                        | ⚠ 条件项:实现合同=不可见间隔(CT ④ 帧外注记)                                                  |
| TL-35 | 审查面板头/标题/操作    | D1(+A1 整页语境)                          | CT ⑤ 为历史参照,现行锚点=SW §review                                                           |
| TL-36 | 统一/拆分切换           | D1 / D2                                   | 同上                                                                                          |
| TL-37 | 视图模式 select         | **不适用 — 设计稿无帧**                   | SW §review 重构后无 select 控件,该能力被「统一/拆分 seg + 全部展开」吸收(SW §review 元素解剖) |
| TL-38 | 审查文件行              | D1(+A1)                                   |                                                                                               |
| TL-39 | 终端外框                | D6(+A3)                                   | ENGINE:只验外框,不判内核渲染                                                                  |
| TL-40 | scroll-to-bottom 按钮   | H5                                        |                                                                                               |

40 条全部映射:39 条落到采集行(含 3 条横切 TL-15/16/22、2 条锚点借用/条件
TL-19/TL-34、1 条降级判定 TL-31 仅配色)、1 条不适用(TL-37)。已优化存量构件(audit ✅ 集:用户气泡、
脚注、reasoning、bash 输出、目录网格、在面板打开、技能 chip、错误卡等)均已由
E5/F2/G2/G4/G6/G9/G15 等行覆盖 —— 全组件类型无漏。

## 40 清单之外的已知缺口(非 TL)

1. dock followup/revert/child-session/handoff 四态:设计稿无帧(J4–J7)。J5/J6 已以生产
   dock 组件的确定性态建立回归证据;J4/J7 按 #558/PR#571 的数据面缺席判 N/A。
2. 终端面板空态:无帧(D7),SW §term 帧外文字规格。
3. 消息导航(上一条/下一条):CT §⑦ 明确「待补,代码未接线」——**不采集,不入矩阵**。
4. 审批挂载位:口径冲突**已裁决**(owner 2026-07-25,#619)——审批统一走独立
   Permission surface,SW 变体二 dock 停靠帧作废;C2/J1 按独立 PermissionDialog 判定。
