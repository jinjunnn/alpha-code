# Sprint 2026-07-06 S21 —— 真机批 vNext-2 + REQ-014 修法

> **抽取(用户拍板 2026-07-06)**:REQ-014 ②修法(headline,两级)+ S20 未跑真机残单。challenge 四线裁决见 [challenge.md](challenge.md)(两线拆分/矩阵排序/只登记不内联修/B16 决策请求)。
> **方法**:Track A = 代码 PR 先行(typecheck+单测绿即合);Track B = 重 ship 签名+公证包(含 Track A + REQ-042/043)→ CDP 走查(REQ-016/S20 同法);证据落 `docs/audits/2026-07-06-s21-realmachine-vnext2/verify.md`。
> **纪律**:走查新发现一律只登记 REQ-0NN 不内联修(<30min 平凡改动除外);每项证据入册才翻状态;到点收工不补跑。

## Track A —— REQ-014 修法(代码)

| # | 项 | 验收 | 状态 |
|---|---|---|---|
| A1 | tier-1 格式级预清:`opencode.global.dat` 的 `tabs`/`tabs.recent` 同步清洗(session 缺 server/dirBase64/sessionId 即剔;draft 缺 draftID 即剔;未知 type fail-open 保留;recent 形状不合法或不指向幸存 tab 即清)| 纯函数单测:毒键样本(S17 证据原件形状)被剔 + `worktree "/"`(dirBase64="Lw")存活 + 合法态零改动 + 解析失败 fail-open | ✅(`tabs-preclean.ts`,16 单测)|
| A2 | tier-2 存在性校验:serverReady 后按 dir 查 session 存在性,悬空 session tab 剔除、recent 联动清;总时限 fail-open(引擎不可达/超时 = 保持原样)| 注入式查询函数单测:悬空剔/存活留/查询失败 fail-open/超时 fail-open | ✅(分页未尽亦 fail-open)|
| A3 | store-get gate:IPC 对该 store 两键首读挂预清 promise(A1 window-first 不回退)| renderer 首读必为清洗后数据;gate 有硬上界不悬挂 | ✅(仅 gate tabs 两键;语言等键不受影响)|
| A4 | 留痕:每次剔除 main.log 记明细(反静默 B11)| 日志行含被剔原因与计数 | ✅(`[req014-preclean]` 前缀)|

## Track B —— 真机批矩阵(按序,硬 cutoff)

| # | 项 | 验收 | 来源 | 状态 |
|---|---|---|---|---|
| B0 | 重 ship 签名+公证包 + 装机冷启动 healthy | stapler/spctl 过;首屏正常 | — | |
| B1 | M1 迁移开门演练(种子先备,限时 30min)| `ALPHA_MIGRATE_ENABLE=1` + 旧位种子 → 迁 `~/.alpha` + 钉版重装 + 旧位净除(**= A2 P0 verified 收口**)| S20 M1 | |
| B2 | REQ-014 修后复验 | 植入 S17 同款毒键(形态 B)+ 悬空 id(形态 A)→ 冷启动正常起屏 + main.log 预清留痕;无毒态零回归 | S20 B5 改 | |
| B3 | B7①③⑤ 发布断言 | 版本断言/断网首启 smoke/0.0.0 注入验证 | S20 B7 | |
| B4 | REQ-042/043 verified | 植易失 URL → main.log 留痕 + store 键消失;popover 切档实拍(不成则机制单测已锁,如实记)| S20 审计续批 | |
| B5 | C17/B14 对话框演练 | 构造超前 DB(隔离根)→ 阻断对话框;osascript/screencapture 驱动,**不成即诚实留用户批** | S20 B2 | |
| B6 | M2 git 真克隆 · M4 dispose 打断(时间不够先砍)| 浅克隆入账 · 打断定性 | S20 M2/M4 | |
| B7 | M3 卸 uv 像素(尾)| PATH 遮蔽 → 详情页缺失指引截图 | S20 M3 | |

**stretch(不占工位)**:B8 日志轮转 · B22 复现(严格限时,到点即弃)。
**明确不抽**:C1 云回流(耗额度)· B2 短TTL/logout/断网/睡眠(用户批)· B9(需真实发版)· E2/E6 · B16 实现(只产出 go/no-go 决策请求,随 ship gate 问)。

## Gates
- Track A:北极星守卫 + typecheck + 单测全绿即可独立 PR;
- Track B:每项证据入 audit 才翻状态;破坏性操作先备份后还原;
- ship gate(必询问):PR merge 前问用户,**同场附 B16 go/no-go 决策请求**;
- 回写:REQ-014 翻 shipped(两级都落地才可;verified 待 B2 复验)· A2/REQ-042/043 等随证据翻 verified。

## 结果(收批回填)
_待回填。_
