# S48 REQ-088 收官取证:Electron 真机视觉验收 + T6 探针矩阵 P1–P8(2026-07-13)

- Issue:jinjunnn/alpha-code#181(REQ-088);任务 = T6 审计 §5 探针清单(P1–P6)+ T2 §4 视觉验收
  + 主会话中途增补 P7(审查面板空 body 复现)与 P8(整页布局同构对照,最高优先)。
- 环境:ui-mac Electron dev 真机(CDP 9222,裸 WebSocket);双闸 = `ALPHA_SURFACE_SESSION=alpha`
  (env-override,`01-gates.json`)+ localStorage `ALPHA_SESSION_SPIKE=1`;`ALPHA_GLOBAL_DIR` 重定向到
  会话 scratchpad 隔离 alpha 全局态;LLM 面 = 本地 scripted fixture(`harness/model-fixture.ts`,
  127.0.0.1:14930,经隔离 alpha.jsonc 注册为 "scripted" provider)——**全程零真实 LLM/网关调用**;
  auth/BYOK 文件取证期间移出、结束已还原(见「残留与偏差」)。
- 种子:git 化长名项目(scratchpad)+ 引擎 API 建会话;bash/read/edit 轮次 = scripted fixture 发真实
  tool_call、真实引擎工具执行(`notes.txt` 实际被 edit,`20-p2-sends.json`);turn 分隔/装饰全部真 DOM。
- 基点:worktree `feat/181-req088-session-adapter`;P1–P7 取证于 3e73a2da,P8 修复态验收于 af894fc8。

## 判定总表

| 项 | 判定 | 关键证据 |
|---|---|---|
| **P8 整页布局同构(修复前)** | **FAIL(已修)** | 外框收缩:workspace 1158px vs main 2304px,审查面板坍缩 111px,右侧死区 ≈1154px(`80-p8-adapter-measure.json`/`80-*.png`);legacy 同窗口审查面板 1257px、死区 0(`81-*`) |
| **P8(af894fc8 修复后验收)** | **PASS** | workspace=leaf=main=2304px、审查面板 1257px(与 legacy 逐 px 相等)、死区 0、侧栏在场、P1 保持全绿(`86-p8-postfix.json`/`86-*.png`);与用户 legacy 基准图逐区一致,仅 +30px chrome |
| **P7 审查面板空 body** | **非 adapter 回归(双模式同现上游 UX)+ 宽度坍缩放大** | ①per-file 折叠行**默认收起**是上游缺省(SessionReview `open=[]`,packages/ui session-review.tsx:173/184;legacy 同样折叠,`84-*.png` 与 adapter `50-*.png` 面板文本逐字相同);②点击行展开后 diff 双模式都渲染(adapter 修复前挤成竖排单字符 `51-*.png`,legacy 正常 `81-*.png`,adapter 修复后正常 `87-*.png`);③全程 console 0 error(`50-p7-review-adapter.json`/`81-p8-p5-p7-legacy.json` consoleEvents);④「看起来空」= 默认折叠 + P8 宽度坍缩同根,修复后消失 |
| P1 ComposerTakeover 四断言 | **PASS**(adapter=legacy) | flag/host=1/display:none/alpha-composer-in-host 全 true:adapter `10-p1-adapter.json`、快切后与 reload 后 `60-p6-stability.json`、修复后 `86-p8-postfix.json`;legacy `81-p8-p5-p7-legacy.json` p1 |
| P2 发送链路 | **PASS** | 3 次经 alpha composer 输入+Enter:user-message 恒 +1、焦点全部回 alpha 输入框(focusAfterSend true×3),`20-p2-sends.json`;真实引擎工具执行(notes.txt 落盘 edit) |
| P3 TimelineInject 装饰 | **PASS(dirgrid 除外,见 O3)** | adapter=legacy 逐数相等:tc-ico 6>0、a-exit[data-ok]=1≥1(需先展开 bash 卡,defer 行为见下注)、turn-div=轮次−1(2/3→4/5 随 O2 轮次同步)、cmd-chip 0(`30-p3-adapter.json` vs `81-p8-p5-p7-legacy.json` p3) |
| P4 ModelPickerInject | **PASS** | mod+' → `[role=dialog] [data-alpha-picker]` true;native 行在且被盖(同环境复检 adapter 15 行 = legacy 15 行,`44-*.json`);经 alpha 行点选未锁模型 → 上游 model.set 真走到(data-selected scripted-2→scripted-1,`40/42-*.json`;legacy 同证 `81-*.json`)。注:上游 dialog 点选后自关,选中态经重开核验 |
| P5 模式对照 | **PASS** | P1 逐位相等;P3 逐数相等;P4 行为/行数相等(见上);P7/P8 双模式对照即本档主体 |
| P6 切换/reload 稳定性 | **PASS** | A↔B 快切×3:violations 0→0、acc flags 全 false、P1 全绿;reload 后 fresh window violations=0(pendingSamples 新口径下 0ms 采样不再恒 +1,`60-p6-stability.json`,pendingSamples=1 如实上报) |
| O1(picker 锚定,T6 §2.2) | **证实 + 升级发现:R4 已现实发生** | 会话内开 native picker 命中锚定分支(`data-alpha-home-anchor` 打上、`--a-pick-tf` 已计算);但**当前上游 DOM 里 `[data-popper-positioner]` 为 0 个**(Kobalte 内部锚点漂移 = T6 §3 R4),JS 走 `?? dlg.parentElement` 兜底打属性,而 CSS 规则是复合选择器 `[data-popper-positioner][data-alpha-home-anchor]`(model-picker-reskin.css:764)→ **transform 永不生效(computed none),锚定特性全局静默失效(home+session、双模式同现)**,弹层回落上游默认位置(`43-o1-anchor-forensics.json`、`40-*.png`)。处置建议:按 T6 §3 R4 归 ModelPickerInject 维护修(选择器兜底与 JS 同步用 parentElement,或改属性选择器单键),在 #181 记录;非 REQ-088 adapter 回归,不阻塞 |
| O2(cmd chip 捕获,T6 §2.3) | **证实失效** | 经 alpha composer 发真实 `/probe hello-o2-args`(项目命令,session.command 路径,展开文案落 timeline)→ `.a-cmd-chip` 0→0(`30-p3-adapter.json` o2)。根因即 T6 猜想:captureSend 读的是被 takeover 隐藏的上游 composer(空),`data-slash-id` 点击路径也在隐藏树内不可达。**建议处置:归 TimelineInject 迁移清单先摘捕获监听(keydown/click capture 两处),保留 localStorage 折叠渲染**(既有 alpha-cmd:* 条目仍渲染)——与 T6 §4.3 cmd chip 行一致,不在本任务改码 |
| O3(新发现:dirgrid 死路径) | **双模式同现,装饰不可达** | 当前冻结上游 read/glob/grep/list 一律折叠进 context-tool-group,组内只渲染标题行、**无 tool-output**(packages/ui message-part.tsx:1015-1049);read 独立渲染器也不渲染 output。live 目录 read 轮次与 DB 种子 legacy `list` 部件(`35-dirgrid-seed.json`)均复现 toolOutputs=0 → dirgrid 无法诱发(`36-dirgrid-verdict.json`)。建议:TimelineInject 迁移清单中把 dirgrid 行标记「上游改版后已不可达,可提前摘除」 |

注(P3/a-exit):上游 BasicTool 对内容 defer —— 折叠态 bash-output 不在 DOM,`退出 0` 徽标只在卡片展开后出现(双模式同现,非 adapter 差异;TL-17 设计时 bash-output 非 defer)。

## 视觉验收清单(T2 §4)

| 项 | 结论 | 证据 |
|---|---|---|
| chrome 亮态 | PASS —— 30px 上下文条:圆点 + 项目名 + / + 会话尾 8 位 + ALPHA 徽标,浅灰底、不入侵叶内排版 | `71-v1-chrome-light.png`(同 `10/20-*.png` 全景) |
| chrome 暗态 | PASS —— root `data-color-scheme=dark` 下 chrome bg rgb(14,15,17)/fg rgb(250,250,250),徽标与分隔正常,与叶暗色一致;取证后已复原 light(root 钉 light 时纯 prefers-color-scheme 模拟不接管,经 root 属性切换取证) | `72-v1-chrome-dark.png`、`70-visual-adapter.json` |
| 超长项目名截断 | PASS —— 88 字符项目名在 680px 窗口 clientW 497 < scrollW 586,ellipsis 生效不换行不挤压徽标;900px 视口宽度足够未触发(如实记录) | `73b-v2-truncation-realwindow-680.png`、`73-v2-truncation.json` |
| 无 id「新会话」态 | PASS(附定性)—— `/dir/session`(无 id)在 alpha 发布态由专职 newSession surface 接管(「新会话 — 项目名」hero + alpha composer),workspace 不挂载 ⇒ chrome「新会话」fallback 为防御态、正常动线不可达(session-workspace-core 单测已钉);无异常中间态 | `74-v3-draft-new-session.png`、`70-visual-adapter.json` v3 |
| CrossServerGuard 引导卡 | PASS —— 服务器侧删除会话后经 topbar 后退回其路由(与 C4 S5 跨 server 同一 `Session not found` 错误族,T3 live 已证等价):引导卡居中、标题/说明/两按钮(重新加载(回到本地引擎)/ 返回首页)完整,**未落 SurfaceBoundary fallback**;经「返回首页」正常离开 | `75-v4-cross-server-guard.png`、`70-visual-adapter.json` v4 |
| 探针 overlay 与 chrome 同屏 | PASS —— overlay 右下(y1276-1316)与 chrome 顶部(y36-66)矩形不相交,无遮挡;overlay 显示 pend 计数(新口径) | `70-v5-overlay-with-chrome.png`、`70-visual-adapter.json` geo |

## P8 量测对照(核心数字)

| 量测(同窗口 2560×1410,真窗口非模拟) | adapter(修复前 3e73a2da) | legacy | adapter(修复后 af894fc8) |
|---|---|---|---|
| 侧栏在场 | ✅ | ✅ | ✅ |
| `main` 可用宽 | 2304 | 2304 | 2304 |
| 叶列(workspace / 上游叶根) | **1158(flex 0 1 auto,无 width)** | 2304(`size-full`) | **2304(width:100%)** |
| `#review-panel` 宽 | **111** | 1257 | **1257** |
| 右侧死区 | **≈1154** | 0 | **0** |
| 面板结构(审查 tab/Git changes 头/统一拆分/文件行) | 结构在、被挤压 | 完整 | 完整 |
| 文件行展开 → diff body | 渲染但竖排单字符(宽度挤压) | 正常 | 正常 |

根因(主会话已修,af894fc8):`.a-swk-root` 只有 `height:100%`,缺横向填充;上游 Session 页根是
`relative size-full overflow-hidden flex flex-col`,在上游 `main`(flex row)槽位下 `flex:0 1 auto`
的外框收缩为内容宽。用户报的「侧栏消失」未复现(双模式侧栏均在场,`sidebarVisible:true`;推测为
侧栏折叠 toggle 所致——本取证未主动折叠过侧栏)。

## 残留与偏差(如实记录)

1. **取证环境被用户中途接管两次**:①18:38 用户退出 dev 实例并启动 /Applications 打包实例(期间其以
   登出态运行——auth 文件当时在取证备份里,已于 18:47 还原,打包实例下次启动即恢复登录态);
   ②18:36 用户在 dev 实例 draft 里手动发送 "hi" 产生一条会话(scripted 回复,已删)。打包实例启动时
   REQ-014 preclean 顺带清掉了本取证的 dangling tabs(日志证据)。取证结束时打包实例为用户自行退出
   状态,未代为重启。
2. **auth/BYOK 隔离窗口**:取证期间 `alpha-auth.json`/`alpha-byok-keys.json` 移至会话 scratchpad
   备份(`visual/backup/`,原件已还原、字节未变)。取证前半段(隔离态)native picker 只有 scripted
   2 行,后半段(还原后)15 行——P4 已在同环境复检对齐(`44-*.json`)。
3. **localStorage 清理的一处过度**:清理脚本按前缀移除 `alpha-cmd:*` 时删掉了 2 条**先前既有**的
   历史 cmd-chip 折叠记录(`alpha-cmd:msg_f172…`/`msg_f0d5…`,非本取证产生;`90-cleanup.json`)。
   影响:对应旧消息回退为全文渲染,纯外观、不可逆。本取证自身未产生任何 alpha-cmd 条目(O2 证实
   捕获路径失效)。
4. `alpha.composer.model` 曾被(推测用户交互)显式改为 scripted-2,已按 `01-gates.json` 快照还原为
   原值 Claude Opus 4.8(`91-cleanup-model-restore.json`);localStorage 全键扫描 scripted 残留 0。
5. 首次种子项目(无 .git)被引擎归入 "global" 项目导致侧栏不显示 —— 换 git 化目录重种;首版两条
   会话已删(`harness/lib.ts` 注)。
6. 引擎/数据残留:分支专属 dev DB(opencode-feat-181-…db)session/message/part 均 0;本取证项目行
   与 project_directory 行已删;C4 时期的 proj-a/b 项目行为先前既有残留,未触碰。userData 内
   `req088-visual|ses_0a501e7c|ses_0a4f3080` 引用扫描 0 命中(cache/log 除外);本取证 workspace
   .dat 已删,global.dat 的 tabs(151→143)/notification(231→222)/layout 中本取证条目已剔除。
7. 进程/端口:dev 实例、scripted fixture 均已关闭;9222/5173/14930 全空。上游 model.set 在 legacy
   复检时点过一次 `alpha:deepseek-v4-flash`(用户代理目录中的真实条目,仅选中、未发送、会话已删)。
8. P4/O1 截图中弹层位置 = 上游默认定位(锚定 CSS 失效,见 O1)——不代表锚定特性的设计位置。

## 证据索引

| 文件 | 内容 |
|---|---|
| `00-setup.json` / `01-gates.json` | 会话种子(A/B id、probe 命令注册)/ 双闸与初始态快照(含 composer model 原值) |
| `10-*.json/png` | P1 adapter 四断言 + 基线全景 |
| `20-*.json/png` | P2 三次发送(user-message +1、焦点回归)+ bash/read/edit 轮次全景 |
| `30/31/32-*.png`、`30-p3-adapter.json` | P3 装饰断言 + O2(/probe 发送后 chip 0→0) |
| `35/36-*.json` | dirgrid 种子(legacy list 部件)与 O3 判定 |
| `40/41/42/43/44-*` | P4 native picker 断言、选中迁移核验、O1 锚定取证、同环境复检 |
| `50/51-*.png`、`50-p7-review-adapter.json` | P7 adapter:面板骨架 dump、折叠/展开对照、console 采集 |
| `60/61-*.png`、`60-p6-stability.json` | P6 快切×3 + reload 稳定性 |
| `70–75-*` | 视觉清单 V1–V5(亮/暗、截断、新会话、引导卡、overlay 几何) |
| `80-*` | **P8 修复前 adapter 量测(回归实证)** |
| `81-*` | **P8 legacy 基准量测** + P5(P1/P3/P4)+ P7 legacy(console 0 error) |
| `86/87-*` | **P8/P7 修复后(af894fc8)验收正本** |
| `90/91-*.json` | 清理台账与 composer model 还原 |
| `harness/` | 全部取证脚本(lib/model-fixture/step1–15;bare-WebSocket CDP,C4 同款形态) |
