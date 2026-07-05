# Sprint 2026-07-05 S17 —— 深度决策与设计批

> **给接手的新 session**:本批由用户 2026-07-05 拍板重排(「优先处理更需要深度思考的任务」,effort=max),取代此前口头拟、未落盘的 S17(真机残单式)。原则:**先分析/设计文档,后代码**;拍板项未决不代决(ADR-018)。
> 各任务验收真源 = 对应 `requirements/` 档(status 已翻 in-sprint)。

## 目标
S16 已把真机债清账,本批清**思考债**:⚖️ 待拍板队列整批出决策包并拍板落 rules;三个因需深度分析而被 /loop 反复 defer 的架构/设计项(REQ-015 / C17+B14 / C28)出结论并落地;B4+B12 性能治理随拍板收尾。不含机械真机项。

## 抽取(含与 ADR-018 抽取规则的偏离说明)
- **抽**:REQ-008(headline)· REQ-015 · C17+B14 · C28 · B4+B12;⚖️ 队列全量(REQ-008 五连拍 / REQ-011 预留位 / C28 控件 / B12 filewatcher;B16 仅重启时机提醒,尊重 parked)。
- P0 无开放项(A6 verified;A2 余真机迁移演练=用户批)。
- 发布短名单残余不抽:B11 ⏭4 / B9 需真发版或真机,非深度型 → 残单/下批;短名单陈旧行(B9/B11 与 P1 表已不一致)随 T6 修正。
- **用户指令「深度思考优先」为本批第一排序键**(对 ADR-018 默认序的显式覆盖,记录在此)。
- REQ-024(A2)前置今日已满足,但 A1 verified 当天不叠新面 → **S18 headline 候选**(standard 可写档的无人值守安全设计正是深度型);跨仓 B 线(REQ-022/PA-27/PA-28)独立节奏不进本批;B22/REQ-014 复现前置(真机),若 T4/T5 勘探产生新复现假说则回填残单。

## Task 表

| Task | 内容 | 对应 | 状态 |
|---|---|---|---|
| T1 | **决策包+拍板(headline)**:REQ-008 五连拍(团队协作/企业租户/用户下沉/后端前3收口/前端余项)+ REQ-011 预留位,每条 brief(现状/选项/后果/建议)→ 拍板 → POSITIONING/GOALS/NON_GOALS〔待补〕清除 + 队列划掉 + E13 处置;B16 仅附重启时机提醒 | REQ-008、⚖️队列 | ☑ 六条全拍板(briefs+结论 [debates/2026-07-05-req008](../../debates/2026-07-05-req008-positioning-briefs.md));**D3=正式下沉·分期文档先行(反建议,按用户拍板执行)→ 新立 REQ-026**;rules 三文件+GLOSSARY 回写、〔待补〕全清;E13 rejected;B12/C28 控件留 T5/T4 |
| T2 | **REQ-015 pre-push 根治**:已预核 hooksPath=`.husky/_`(本地 config)+ enterprise/storybook 同吃 session-ui+ui(方案1删包连坐三包、方案4扩冻结≈删包);评估**方案5「alpha 自有 hooksPath(pre-push=alpha-check.sh,与 CI 1:1)+ 自愈重挂(husky prepare 会改回,需对策)」** vs 档内菜单 1–4 → 选定落地 + ADR-020 修订 + memory [[local-prepush-session-ui-skew]] 更新;验收=`git push` 免 `--no-verify` 且本地门≡CI | REQ-015 | ☑ 方案5 落地(`.githooks` 转默认 + alpha-check 自愈重挂;根因=husky prepare 每次 install 重置 hooksPath;方案1/2/4 结构性否决入 ADR-020 修订);实测=交付 PR push 免 `--no-verify` 经 hook 三关绿放行 |
| T3 | **C17+B14 DB 安全带**:内省 `core/src/database/migration.ts` 水位机制(app 支持面=`migration.gen.ts` 编译期已知)→ 设计:启动只读预检(勿引原生依赖;候选系统 `/usr/bin/sqlite3` 或纯文件读,WAL 语义要过)+ 水位超前诚实拦截 UX + 滚动备份(checkpoint 后复制,N 份)+ DB 打不开指向最近备份;实现+单测+mini 设计文档;降级场景(新 DB × 旧支持面)构造测试 | C17、B14 | ☑ 设计([designs/db-safety-belt](../../designs/2026-07-05-db-safety-belt.md),F1–F7 全实证:含「`-readonly .backup` 静默假成功 → 唯一可靠形态=VACUUM INTO+必验」)→ `db-safety.ts`/`db-safety-boot.ts`/`gen-db-expected.ts`+「数据」菜单;34 单测含真 sqlite3 集成(降级 fixture/损坏签名/恢复往返);原生对话框演练 → 真机批残单 |
| T4 | **C28 崩溃屏边界下沉**:设计+原型实测(强制 throw;§7h 教训=alpha 边界必须比上游 `@opencode-ai/app` 内层边界更内层才命中)→「下沉边界 / 接受上游边界」二选一记录;控件诚实化:先代码实证「只读/effort」真实接线,再出三选一 brief → 拍板 → 实施 | C28 | ☑ 控件拍板+实施(只读移除→REQ-028 / effort 改文案保留→REQ-029,后者反建议按用户拍板);AlphaBoundary 紧裹 10 注入件 + throw 实测 PASS(CDP 截图 [audits/s17-t4](../../audits/2026-07-05-s17-t4-c28/verify.md));**顺带活捉 REQ-014 复现**(整屏形态+毒源+②修法实证,REQ-014 翻 ready);打包态复验→真机批 |
| T5 | **B4+B12 治理**:`OPENCODE_EXPERIMENTAL_FILEWATCHER` 关闭的功能影响清单(代码实证)→ 拍板;隐藏/归档项目**数据层**零请求(现仅 `alpha-sidebar.tsx:506` 渲染层 skip)+ 垃圾项目(`~`、`~/Documents` 级)引导/默认不纳入;冷启动 bootstrap 日志复核 | B4、B12 | ☑ 影响清单实证(watcher 只供外部变更感知,agent 自身修改由工具主动发事件不受影响;硬覆盖矛盾抓出)→ 拍板=默认开+可关(set-if-unset);B4 数据层过滤(worktree-filter 谓词+11 测)——"/"+home 默认不纳入、hidden 零请求、事件循环守卫、归档即时生效;冷启动日志复核→真机批 |
| T6 | **S12–S16 arc 收尾**:retro(质疑证实/证伪、rules 现势)+ Done 区批量 verified→archived + 发布短名单 B9/B11 行修正 + GOALS「当前周期」段刷新 | ADR-018 §6 | ☑ retro [retros/2026-07-05-s12-s17-arc](../../retros/2026-07-05-s12-s17-arc.md)(证实×4/证伪×5,「静默假成功一日三抓」教训入册);21 项 verified→archived(BACKLOG Archived 段+20 档 frontmatter);短名单 B9/B11 陈旧行修正 + 队列过期 ADR-014 行划掉;GOALS 当前周期刷新 |

**Stretch**(顺带才做,不占核心预算):C16 数据清除入口(与 B14 同屏,本批先留挂点)· REQ-024 standard 档安全设计先行。

## Gates
- **先文档后代码**:每 task 的分析/设计先落 docs(designs/debates/audits),结论进 ADR/需求档,再动实现——本批存在理由即深度思考,反 quick-hack;
- 拍板项未决不代决;撞到即停、brief 附建议(ADR-018);
- 北极星:全部 alpha 自有文件;T2 明确不改 `.husky/`、`turbo.json`;T5 落点 `ui-mac/src/main/server.ts` 为 alpha 自有文件;
- UI 触点遵守 [[visual-verify-required]]:T4 throw 实测、T5 引导 UX 须 CDP 截图才翻状态;本批做不到的如实残单;
- WIP=1:S16 已收尾(残余=用户批残单在 REQ-016 档)。

## 结果(2026-07-05 回填)
- **T1–T6 全 ☑,6 PR**:#88(开批+T1 定位五连拍)· #89(T2 REQ-015 方案5 + **REQ-027 typecheck 双假绿事故修复**)· #90(T3 DB 安全带,C17+B14)· #91(T4 C28 诚实化+AlphaBoundary,throw 实测 PASS)· #92(T5 B4+B12)· #93(T6 retro+归档)。
- **拍板 9 项**:定位五连拍(D3 反建议:小白正式入画像·分期文档先行)+ 预留位暂空 + C28 只读移除 + C28 effort 改文案保留(反建议)+ B12 默认开可关。
- **新立**:REQ-026(小白文档)/ REQ-027(已修)/ REQ-028(真只读)/ REQ-029(effort=variants);REQ-014 复现达成翻 ready(整屏形态+②修法实证)。
- **意外收获(证据纪律产出)**:静默假成功一日三抓——bun `--cwd run` placebo(local+CI 双假绿)、`-readonly .backup` 不写文件、composer placebo 控件;全部修复或诚实化。
- **残单(→ 下一真机批)**:C17/B14 原生对话框演练 · C28 打包态复验(`__alphaCrashProbe`)· B4 冷启动日志/watcher 数 · B22/REQ-014 · S16 遗留用户批项。**stretch 未抽**:C16、REQ-024 设计(S18 候选)。
