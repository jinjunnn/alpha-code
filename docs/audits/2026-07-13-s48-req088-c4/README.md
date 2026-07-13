# S48 REQ-088 前置 C4:探针矩阵真机取证(2026-07-13)

Issue alpha-code#181 激活前置 C4(spike 报告 §8 条件 4):**ui-mac Electron 真机** + **spike 双闸全开**下,
驱动真实会话场景(快速切换 session、back/forward、reload、切 directory、切 server),采集
`window.__req087Spike.summary()` 探针矩阵,断言订阅/PTY/挂载计数不泄漏、不随重复操作线性累积。

**判定:C4 PASS(附探针口径修正说明,见 §口径缺口)。** 核心断言全部成立:
所有场景稳态 `terminalPanels===1`、可见 composer ≤1、命令数钉死 117(±1 合法抖动)、
sidecar PTY 恒 1(孤儿 0,优于 C2 legacy 基线的「≤1」容忍)、violations **不随操作次数增长**。
`summary()` 的字面布尔位出现 3 处假阳性,全部溯源到同一探针口径缺口(0ms 采样先于 lazy 叶挂载),
非产品泄漏,已附完整原始序列证明。

## 环境与双闸

- 真机:`ALPHA_SURFACE_SESSION=alpha bun run --cwd packages/ui-mac dev`(dev 模式 CDP 9222 常开;
  env 是 main 侧 surface resolver 的 env-override 通道)。
- localStorage 闸:DevTools/CDP 里 `localStorage.setItem("ALPHA_SESSION_SPIKE","1")` + reload。
- 双闸核验(`01-gates.json`):`surfaces.session = {mode:"alpha", reason:"env-override"}` + `spikeFlag:"1"`;
  进入会话后出现「ALPHA FRAME(REQ-087 原型)」header 条 + 右下角 SPIKE 橙色计数条(`01-gate-open-session-a.png`)。
  即 surface 侧原型(Alpha 外框 + `@opencode-ai/app/surface/session` 窄导出叶)+ 容器侧探针同时生效。
- 驱动:裸 WebSocket CDP(`Runtime.evaluate` / `Page.captureScreenshot` / `Input.dispatch*`,
  形态同 `scripts/verify-picker-respawn.ts`),脚本见 `harness/`。**注意 renderer 用 MemoryRouter**:
  window.location 与路由无关,导航必须走真实 UI(alpha 侧栏会话链接/项目行、alpha-topbar 后退/前进钮、
  命令面板)——probe 的 `useLocation()` 采的才是真路由。
- 数据:两个沙箱项目(scratchpad proj-a/proj-b)+ 真 sidecar 引擎 API 建会话/种 shell 轮次;
  第二服务器 = 独立 XDG 的真 `opencode serve`(127.0.0.1:14790)。PTY 口径 = sidecar `GET /pty`
  (Basic auth 凭据经 `window.api.awaitInitialization()` 取得);连接数口径 = lsof ESTABLISHED。

## 矩阵逐场景

| 场景 | 操作 | summary() 前 → 后 | PTY 前→后 | 稳态(settled)序列 | 判定 |
|---|---|---|---|---|---|
| S0 基线 | 侧栏点入 session A(冷入场) | fresh → `{samples:6, sessionRouteSamples:2, violations:1, acc:f/f}` | 0→0(未开终端) | composer 0/1、panel 1、cmd 117(40) | ✅(violation=冷入场 0ms 采样,见口径缺口) |
| S1 快速切换 | 开终端后 A↔B ×6(~350ms 间隔) | `{v:1, acc:f/f}` → `{v:1, cmdAcc:true, panelAcc:true}` | 1→1 | 8 个新采样全部 panel=1、cmd=117 | ✅ Δviolations=0;两 acc flag 为 0 锚定假阳性;**孤儿 PTY 0** |
| S2 back/forward | topbar 后退×3 + 前进×3 | `{v:1}` → `{v:1}` | 1→1 | 8 个新采样全部 panel=1、cmd=117 | ✅ Δviolations=0 |
| S3 reload | 开终端,`location.reload()` ×2(+闸设定 reload 共 3 次) | 每次 fresh window `{samples:6, sRoute:2, v:1, acc:f/f}` | 1→1→1 | 每次重入 R:frame 1、panel 1、composer 1、cmd 117 | ✅ PTY 跨 reload 同一 `pty_f59d2bf9…` 重连,不重复孵化 |
| S4 切 directory | proj-a↔proj-b 会话交替 ×6 | `{v:1, cmdAcc:true}` → `{v:1, cmdAcc:false, panelAcc:true}` | 1→1 | 12 个新采样 panel 全 1;cmd 116/117(跨目录 ±1 抖动,恰好演示 flag 双向噪声) | ✅ Δviolations=0 |
| S5 切 server | add-server flow 切至 :14790 → home;跨 server 误点回收 | violations +1(crash 期采样) | local PTY 1→1;tcp 稳定 | 探针不采样(见发现 3) | ⚠️ 泄漏面 PASS;3 项发现见下 |

原始数据:`10-s0-baseline.json`、`20-s1-fast-switch.json`、`30-s2-back-forward.json`、
`40-s4-directory-switch.json`、`70-s3-reload.json`、`90-final-all-samples.json`(含 PTY 明细)。

## summary() 口径缺口(3 处假阳性的唯一根因)

探针每次路由变化采样两次(0ms + 650ms)。**0ms 采样发生在 lazy 会话叶挂载完成之前**
(alpha 侧栏是裸 `<a>`+`navigate()`,无 hover preload → 首次入场 chunk 冷加载),该采样读到
`terminalPanels:0 / commandOptions:92`:

1. `isSingleMount` 要求 `terminalPanels===1`,把「尚未挂载」(0)与「双挂载」(≥2)同判为 violation
   → 每个 fresh window 恒 +1(S3 三次 reload 每次精确复现 1 次,不随后续操作增长)。
2. `detectMonotonicGrowth` 被 0/92 锚定:序列 `[0,1,1,…,1]`、`[92,117,…,117]` 单调不减且净增 > jitter
   → `panelAcc/cmdAcc` 假阳性;S4 跨目录一次 116 的合法 dip 又把 cmdAcc 翻回 false——flag 对单样本噪声双向敏感。
3. 反向核验:若真有泄漏,violations 应随操作线性增长——实测 6 次快切/6 次导航/6 次目录切换 Δ 全 0,
   稳态序列全程钉死(见各 JSON 的 samples 数组)。

## S5 发现(REQ-088 范围内需裁决)

1. **已有 server 间切换在 alpha shell 无可用 UI 面**:`newLayoutDesigns` 开启时(alpha 恒开)
   DialogSelectServer 的行 onSelect 被 gate 为 no-op(dialog-select-server.tsx
   `onSelect={(x) => { if (x && !settings.general.newLayoutDesigns()) … }}`);切换只能经
   add-server flow(`server.add` + `navigate("/")`)或 ConnectionError 屏。
2. **跨 server 点击 sidecar 会话必然崩溃(有界)**:alpha 侧栏恒 pin 在 local sidecar,server2
   active 时点其会话 → 上游叶 throw `Session not found` → **SurfaceBoundary 按设计兜住**:
   fallback UI(`57-…png`)+ userData failures.session 记录 + toast;点「重新加载并回退旧版页面」
   后 env-override 重新解析为 alpha、双闸重开、会话恢复(`58-…png`)——rollback contract 真机实证。
3. **探针对纯 server 切换不采样**:切 server 不改路由,probe 按 pathname 采样 → 盲区。该场景泄漏面
   由引擎侧口径覆盖:local sidecar PTY 恒 1、Electron↔engine TCP 无累积(切换/往返多次后稳定)。

## 残留清理(全部完成,备份于会话 scratchpad `c4/backup/`)

- 3 个测试会话(A/B/R)+ proj-b 会话 C:sidecar `DELETE /session/:id`,复核两目录 session 数 = 0。
- `ALPHA_SESSION_SPIKE` localStorage 闸:移除并复核 null(在 app 存活期内完成,已落 leveldb)。
- proj-a/proj-b:经产品面「归档」从侧栏隐藏(上游无服务端项目删除面);侧栏复核只剩用户原有项目。
- userData(ai.opencode.desktop.dev):`server.list` 移除 C4 second server(恢复为空)、
  删除 `http://127.0.0.1:14790\0notification` 键、tabs 137→131(4 session tab + 2 draft tab)、
  2 个 draft .dat + 5 个本次产生的 workspace .dat(内容含本次 session/PTY/server2 scope)删除、
  notification list 227→222、`alpha-surfaces.json`(仅含本次 crash 记录、无 pins)删除。
  终验:userData 内 14790/scratchpad 引用 0 命中(缓存类目录除外)。
- 进程/端口:dev app、第二引擎全部终止;9222/14790/5173 全空。
- 引擎侧:写入的是本 worktree 分支专属 dev DB(`opencode-feat-181-req088-session-adapter.db`),
  用户主 DB 未触碰;其中 proj-a/proj-b 两条空 project 行为惰性残留(无删除 API,已归档隐藏,如实记录)。
- 仓库:`git status` 仅新增本目录;产品代码零改动。

## 截图索引

| 文件 | 内容 |
|---|---|
| `01-gate-open-session-a.png` | 双闸全开:ALPHA FRAME header + SPIKE 计数条 + legacy 叶 |
| `10-s0-baseline-session-a.png` | S0 基线(session A,timeline 9 行) |
| `20/21-s1-*.png` | S1 终端开启前后 + 快切后 |
| `30/31-s2-*.png` | S2 back×3 后 / forward×3 后 |
| `41-s4-after-directory-switch.png` | S4 目录往返后 |
| `51/53-s5-*.png` | 服务器 dialog / add-flow 切换后 server2 home |
| `57/58-s5-*.png` | SurfaceBoundary fallback / boundary reload 恢复 |
| `70/71/72-s3-*.png` | S3 reload 前 / reload#2 后 / reload#3 后 |
