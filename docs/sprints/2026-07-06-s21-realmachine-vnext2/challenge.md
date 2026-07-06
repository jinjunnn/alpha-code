# S21 challenge(2026-07-06,四视角并行)

> 提案:「真机批 vNext-2 + REQ-014 修法」。用户已拍板方向;本档记录四线质疑与综合裁决。

## 四线要点

**CEO**:① 批次不动北极星但兑现 GOALS「发布深化」当前阶段,80% 是必要收尾非浪费卫生;② REQ-014 headline 排序正确——冷启动白屏对 D3 非技术画像 = 零恢复的首屏死亡,战略高于 C16/E2/E6;③ **[DRIFT] B16 被动 parked 与 GOALS「重启条件临近」主动判定冲突** → 本批必须产出 B16 go/no-go 决策请求逼拍板(不实现,只逼决策)。

**Skeptic**:① 最弱假设 = 把 REQ-014 偷换成只修形态 B(格式毒键);验收① 是形态 A(悬空会话 id → Not found)——**只修 B 就翻 REQ-014 = placebo(违 C28/ADR-018)**;② 「无 dir 段即剔」须防误杀合法 `worktree "/"` 全局键(ADR-008 白纸黑字);③ C17/B14 原生对话框 CDP 驱不动,S20 就没跑成,别再假装;④ 一批 10+ 项重蹈 S20 覆辙风险。

**PM**:① 最小可交付核 = REQ-014 修法 + 重 ship + B5 复验(3 项);② M 组上批失败是**结构性依赖**(flag 重启/种子准备)非纯时间 → 种子开工前备好、M1 排第一(限时)、到点砍 M2/M4 不砍 M1;③ **拆两线**:Track A = REQ-014 代码 PR(typecheck+单测绿即合,不等真机批),Track B = 重 ship 真机批(消费 A 已合代码);④ 新纪律:**走查新发现一律只登记 REQ-0NN 不内联修**(<30min 平凡改动除外);B8 移出矩阵,B22 严格限时到点即弃。

**User**:① REQ-014 对小白 = 「开机即坏且无出路」,疼一个数量级,首位正确;② M1 迁移开门/M3 卸 uv 像素/B8 日志轮转用户无感可降级;③ 用户视角更疼但未排:B22(用着用着崩)、C16(卸载残留含凭证)、REQ-039(cn 小白云任务必失败,B 仓)。

## 综合裁决(全部采纳进契约)

1. **REQ-014 两级全做**(格式级同步预清 + 存在性校验),否则不翻 REQ-014——Skeptic 采纳。
2. **`worktree "/"`(dirBase64="Lw")shape-only 校验保护** + 单测锁定;未知 tab 类型 fail-open 保留——Skeptic 采纳。
3. **两线拆分**:Track A 代码先行独立 PR;Track B 真机批消费其产物——PM 采纳。
4. **矩阵顺序**:装机 → M1(限时 30min,种子先备)→ B5(REQ-014 修后复验)→ B7①③⑤ → REQ-042/043 → C17/B14(尝试 osascript/screencapture,不成即诚实留用户批)→ M2/M4(时间不够先砍)→ M3(尾);B8 移 stretch;B22 不抽——PM/Skeptic/User 采纳。
5. **走查新发现只登记不内联修**(<30min 平凡改动除外)——PM 采纳。
6. **B16 go/no-go 决策请求**:随 ship gate 一并向用户提出(附 ADR-021 §4 挂钩点与 GOALS 判定)——CEO 采纳。

## 设计阶段跳过声明(阶段 3)

REQ-014 修法无新架构:两级方案由需求档「建议(待拍板)」+ S17 复现证据钉死;本批仅补一个实现级决策——**store-get IPC 对 `opencode.global.dat` 的 `tabs`/`tabs.recent` 键挂预清 promise**(保 A1 window-first 不回退,又保证 renderer 首读必是清洗后数据;tier-2 带总时限 fail-open)。该决策记入本档,plan-review 由 /app:review 阶段合并把关。
