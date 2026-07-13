# S48 REQ-088 T3+T4:live-engine characterization adapter 对比与性能预算判定(2026-07-13)

- Issue:jinjunnn/alpha-code#181(REQ-088);spike 任务分解 T3/T4
  (docs/audits/2026-07-12-req087-legacy-session-adapter.md §9)
- 前置:C2 legacy 基线套件(`packages/ui-mac/test-live/req087/`,PR #243)、
  T2 AlphaSessionWorkspace 正式化(commit 5d6fc779/ae1db6e4)
- 交付:①C2 六项 live characterization 在 **adapter 模式**(真 AlphaSessionWorkspace 外框 +
  C1 窄导出叶)逐项复跑并与 legacy 同 harness 对比(spike §7 OPEN 全项);②AC7 性能四指标 +
  孤儿 PTY 上界的双边原始数与预算判定;③CrossServerGuard 引导卡的 live 补测(T2 §4 注意点 2)。
- 结论:**T3 全项行为一致(0 差异项);T4 全指标 PASS**(§5/§6)。
- 门禁(worktree `feat/181-req088-session-adapter`,基点 ae1db6e4):`bun test src`
  **1287 pass / 0 fail**(与 T2 后基线持平 —— 本任务零 src 改动,套件仍在权威门外);
  `bun run --cwd packages/ui-mac typecheck` 干净;`scripts/alpha-check.sh` 三门全绿;
  live 套件 adapter/legacy 各**两连跑全绿且数值同带**(§4)。

---

## 1. 方法论:注入通道调研与运行态选择

### 1.1 通道调研(动手前定案)

| 事实 | 证据 |
|---|---|
| seam 读法:`createSessionRoute(props.surfaces?.session ?? Session)`,surface 与默认叶 XOR | 冻结 packages/app/src/app.tsx:466 |
| 冻结 web 入口挂 `AppInterface` 时**不传 surfaces** ⇒ 「web 运行态注入 alpha surface」在冻结入口上不存在 | 冻结 packages/app/src/entry.tsx:167-181 |
| `AppInterface`/`AppSurfaces`/`AppBaseProviders`/`PlatformProvider`/`ServerConnection` 均为包根公开导出(ui-mac renderer 同一消费面) | packages/app/src/index.ts:2-13,29-30;ui-mac renderer/index.tsx:3-18 |
| C2 legacy 基线的运行态 = 冻结 app 自身 vite dev(web) | test-live/req087/harness.ts(frozen 分支)|

**裁量**:合法通道存在 —— 不改任何冻结文件,由 harness 自有 web host
(`test-live/req087/webhost/`,alpha 文件)复刻冻结 entry.tsx 的 web Platform 与挂载参数,
经**公开 `surfaces` prop** 注入**真 AlphaSessionWorkspace**(REQ-088 T2 正式组件:chrome /
CrossServerGuard / SurfaceBoundary / C1 窄导出叶;窄导出消费点不变,仍是
alpha-session-workspace.tsx,锚点测试口径不受影响)。双闸语义保留:localStorage
`ALPHA_SESSION_SPIKE` 闸关 ⇒ 工厂返回 undefined ⇒ surfaces.session 未注入 ⇒ 严格上游默认叶。

### 1.2 可比性设计(主对比 = webhost 双跑)

- **两半边同一 host、同一 vite server、同一引擎(XDG 隔离 + scripted model)、同一 Chromium、
  同一台机器同一时段采集;唯一差异 = localStorage 闸**(harness 在 adapter 运行为每个浏览器
  context `addInitScript` 预置)。模块图两半相同(host 恒静态 import adapter 模块,闸只决定
  注入与否),连 dev-transform 成本都对称。
- **防错半边**:每个会话页断言点过 `assertSurfaceMode`(adapter:`[data-alpha-session-workspace]`
  挂载且 chrome 高度>0;legacy:该锚点必须为 0),度量点之后调用,不污染 mount 计时窗口。
- **历史锚点处理**:已落盘的 `baselines/legacy-baseline.json`(冻结 entry 运行态)不动;本次
  另行 frozen-legacy 复采一跑作 host 中性校验(§4 表末行)——webhost-legacy 与 frozen-legacy
  同带(mount 中位 1031-1084 vs 1075;p95 25.7-27.7 vs 25.8),复刻 host 无可测开销,
  历史锚点继续有效。

### 1.3 未选 Electron CDP 双跑的理由(及其覆盖归属)

- legacy 半边在 Electron 下必须整体重采(与 C2 基线不同运行态),且真机噪声大(真用户 XDG、
  sidecar 随机端口、updater);六项里鼠标滚轮/拖拽/键盘驱动在裸 CDP 下要重写整套。
- Electron 特有面(preload/window.api/补丁 bundle)**不在 adapter-vs-legacy 差异面上**
  (两模式同用),且 C4 已用 Electron 真机覆盖 adapter 探针矩阵与回退链路
  (docs/audits/2026-07-13-s48-req088-c4/)。发布态最终确认归 T5(§8)。

### 1.4 已披露偏差(均两半边对称,不影响对比结论)

1. webhost 不含 ui-mac electron 构建的 brandI18nPlugin/patchUpstreamPlugin(与 C2 基线运行态
   一致);补丁在生产对两模式一视同仁(mode 无关)。
2. webhost 不含 Sentry/auth_token 分支(冻结入口在 harness 环境同样不激活,行为等价)。
3. `window.api` 兜底为空对象:仅影响 SurfaceBoundary **fatal** 链路的上报侧(web 无 preload,
   上报 no-op);度量路径不触达;Electron 真机上报语义由 C4 实证。

## 2. 变更清单(全部在权威门外,`bun test src` 无感)

| 文件 | 变更 |
|---|---|
| `packages/ui-mac/test-live/req087/webhost/{index.html,main.tsx,vite.config.ts}` | 新增:对比 web host(entry.tsx 复刻 + surfaces 注入;头注释含通道合法性论证) |
| `packages/ui-mac/test-live/req087/harness.ts` | `REQ088_HOST`/`REQ088_SURFACE` 双参数(默认全关 = C2 原语义);webhost 启动分支;adapter 闸注入;`assertSurfaceMode`/`ADAPTER_SEL` |
| `packages/ui-mac/test-live/req087/req087-live-characterization.test.ts` | 六项接线 assertSurfaceMode;AC7 基线文件按 flavor 参数化(frozen 仍写 legacy-baseline.json,字节语义不变);facts 落盘;新增 CrossServerGuard 补测(adapter 专属) |
| `packages/ui-mac/test-live/req087/baselines/req088-webhost-{legacy,adapter}{,-facts}.json` | 新增:双边最新一跑的原始数(两连跑第 1 跑存档于运行日志,数值见 §4/§5) |

复跑命令(两边各自完整套件):

```bash
cd packages/ui-mac
REQ088_HOST=webhost                        REQ087_LIVE_PORT_BASE=14750 bun test --timeout 300000 test-live/req087   # legacy 半边
REQ088_HOST=webhost REQ088_SURFACE=adapter REQ087_LIVE_PORT_BASE=14750 bun test --timeout 300000 test-live/req087   # adapter 半边
```

## 3. T3:characterization 逐项对比(spike §7 OPEN 全项)

六项测试在两个模式下**同断言、同阈值**运行;下表为逐项行为面比对。判定「一致」= 双边两连跑
全部断言通过且关键观测值相同。

| # | §7 OPEN 项 | 关键观测(legacy → adapter) | 判定 |
|---|---|---|---|
| 1 | AC5 100+ 长 timeline:首屏/stream/上翻/跟底与暂停/hash 定位 | 首屏单 composer + 跟底 ≤2px;流式期 gap ≤24px 收敛回 ≤2px;`before=` 分页 prepend 后可见锚 ±1px 收敛;上翻状态新流不拽底(scrollTop 漂移 ≤4px);`#message-<id>` 深链目标入视口 —— 双边全同 | **一致**(chrome 占 30px 后视口变矮不破坏任何锚定/跟底断言 —— spike R3 / T2 §4 注意点 1 闭合) |
| 2 | AC6 terminal 生命周期 + PTY 不泄漏 | ctrl+` 自动建 PTY(+1)、ctrl+alt+t(+2)、拖拽重排顺序交换且 PTY 不变、切 session 面板不复制(panels 恒 1)、首次切走 recover-clone 孤儿 =1 且往返不再增长、reload 恢复 tabs 不重复 attach、逐个关闭全量回收、引擎 DELETE 清零 —— 双边全同 | **一致**(孤儿 PTY 1 == 1,见 §6) |
| 3 | AC6 permission once/always/reject + abort/重试 | once:3 按钮 dock、replied=once、tool completed;always:二次仍询问 → 三次不再询问直接执行;reject(不同 pattern):询问 → denied → error 族;abort:assistant 收敛不悬挂;重试正常完成 —— 双边全同 | **一致**(真实权限机全管线,无 mock)|
| 4 | AC4 运行时半边:event subscription / PTY 跨切换 | SSE open 基线 =1,8 次切换全样本 open=1(无过渡尖峰)、pty=0 恒定、composers=1、panels=1 —— 双边 facts JSON 逐样本相同 | **一致** |
| 5 | streaming/steer/queue/abort/tool card/review panel 焦点返回 | 流式发送焦点不丢;steer 排队焦点保持 + 队列消费(4 completed,f2 落地);Escape abort(<12s,尾 token 未出现)焦点保持;tool card 点开 → ctrl+l 回焦;review panel mod+shift+r 双向 toggle + 回焦 —— 双边全同 | **一致** |
| 6 | (新增,adapter 专属)CrossServerGuard 引导卡 | 未知会话 id(引擎 `Session not found` 错误族,与 C4 S5 跨 server 点击同一抛错路径)→ 引导卡渲染(「重新加载(回到本地引擎)」/「返回首页」两动作在位),SurfaceBoundary fallback **未**触发 | **PASS**(T2 §4 注意点 2 引导卡半边闭合;rethrow 半边见 §7-O1) |

**T3 结论:§7 OPEN 全项在 adapter 模式行为与 legacy 一致,差异项 0。**

## 4. 运行矩阵(稳定性:两连跑一致才算数)

| 运行 | 结果 | mount 中位(3 跑) | 订阅 | 滚动 p95 / avg / max (ms) | heap Δ (bytes) | 孤儿 PTY |
|---|---|---|---|---|---|---|
| webhost-legacy #1 | 6/6 | 1084(1072/1084/1084) | 1 | 25.7 / 14.68 / 41.6 | 117,124 | 1 |
| webhost-legacy #2 | 6/6 | 1031(1071/1026/1031) | 1 | 27.7 / 14.77 / 41.7 | 120,804 | 1 |
| webhost-adapter #1 | 7/7 | 1059(1063/1059/1059) | 1 | 27.7 / 15.04 / 41.7 | 113,684 | 1 |
| webhost-adapter #2 | 7/7 | 1087(1056/1087/1097) | 1 | 27.8 / 15.03 / 41.7 | 122,588 | 1 |
| frozen-legacy(锚点复采,host 中性校验) | 6/6 | 1075(1074/1099/1075) | 1 | 25.8 / 14.71 / 41.7 | 126,868 | 1 |
| (参照)C2 落盘锚点 legacy-baseline.json | — | 1049(1050/1049/1038) | 1 | 16 / 14.74 / 43.4 | 119,124 | 1(C2 评论口径) |

- 双边各自两连跑结果一致(全绿 + 数值同带);heap 绝对值 adapter(≈83.7MB)略低于
  legacy(≈84.5MB),同量级。
- p95 在本机呈 16↔27.7ms 双峰(60Hz 帧量化:偶发一次双帧),legacy 自身即横跨该带
  (C2 锚点 16;本次 25.7/27.7;C2 issue 评论口径 27.7)——p95 对比按「带内」判读。

## 5. T4:性能预算判定(主对比 = webhost 双跑,两连跑取均值/最劣值)

预算事前声明:订阅数必须相等;mount 中位 adapter ≤ legacy × 1.10;滚动 p95 adapter 最劣 ≤
legacy 带上沿 × 1.20;内存同量级(±10%)且采样期无单调泄漏;孤儿 PTY adapter ≤ legacy。

| 指标 | legacy(两跑) | adapter(两跑) | Δ | 预算 | 判定 |
|---|---|---|---|---|---|
| mount 中位 (ms) | 1084 / 1031(均值 1057.5) | 1059 / 1087(均值 1073) | **+15.5ms(+1.5%)**,小于 legacy 自身跑间波动(±2.5%) | ≤ +10% | **PASS** |
| open event 订阅数 | 1 / 1 | 1 / 1 | 0 | 相等 | **PASS** |
| usedJSHeap 采样 (MB) | 84.35–84.72 | 83.63–83.75 | **−0.9MB(−1.0%)** | ±10%、无单调增长 | **PASS**(3 采样点 Δ 113.7k–122.6k vs 117.1k–120.8k,同带,无泄漏趋势) |
| 滚动 p95 (ms) | 25.7 / 27.7 | 27.7 / 27.8 | 最劣 +0.1ms(+0.4%,带内) | ≤ 带上沿 ×1.20(33.2ms) | **PASS** |
| 滚动 avg (ms) | 14.68 / 14.77 | 15.04 / 15.03 | +0.31ms(+2.1%) | (参考项) | PASS |

**T4 结论:全指标 PASS —— adapter 模式相对 legacy 无可判定的性能回退。**

## 6. 孤儿 PTY 上界判定

- 本对比(web 运行态):legacy 恒 1、adapter 恒 1(两连跑一致;AC6 断言含「不线性累积 +
  泄漏上界 = 恢复孤儿」);**adapter ≤ legacy 成立(1 ≤ 1)—— PASS**。
- 与 C4 的关系:C4 Electron 真机 adapter 实测 0(优于 legacy 基线 ≤1)。差异来源是**运行时**
  (web vs Electron 的终端 WebSocket 断连/handoff 时序),不是 adapter 本身 —— 同一 web
  运行时下双边同为 1 恰好证明该怪癖 mode 无关。契约口径「不劣于 legacy(≤1)」在两种运行时
  均成立。

## 7. OPEN 项与处置(无 FAIL 项)

| # | 项 | 处置 |
|---|---|---|
| O1 | CrossServerGuard **rethrow 半边**(非 `Session not found` 族的叶致命 → SurfaceBoundary)无法经合法通道在真叶诱发(不 mock 冻结叶) | 已覆盖:C4 真机 SurfaceBoundary fallback 全链路实证 + session-workspace-core 单测(识别失败 = 退回 fatal 现状,降级方向安全);残余作 T5 回退演练清单项 |
| O2 | webhost ≠ Electron 生产运行态(补丁 bundle / preload / sidecar) | 差异面 mode 无关(§1.3/§1.4);C4 已覆盖 Electron 真机 adapter;最终发布态确认归 T5 + 视觉验收(§8) |
| O3 | SurfaceBoundary fatal 上报在 web host 为 no-op(空对象兜底) | 仅 fatal 链路上报侧;Electron 语义 C4 已实证;无行动项 |

## 8. 给视觉验收与 T5(发布态阶梯)的注意点

1. **视觉验收(Electron 真机,CDP 9222)**:chrome 亮/暗两态、超长项目名截断、「新会话」
   过渡态、引导卡布局(按钮文案已 live 实证:「重新加载(回到本地引擎)」/「返回首页」)、
   spike 探针 overlay 与 chrome 同屏遮挡 —— T2 §4 清单原样有效;本档不替代视觉验收。
2. **T5 裁决输入**:C1-C4 前置 + 本档 T3 全项一致 + T4 全 PASS ⇒ session surface 升
   `auto-fallback` 的行为/性能障碍已消除;剩余闭环 = Electron 端到端灰度 + 回退演练
   (含 O1 rethrow 演练、auto-fallback 崩溃记录路径)。
3. **对比复现纪律**:任何后续复采必须双边同 host 同跑(§1.2);`legacy-baseline.json`
   仍是 frozen 运行态锚点,不得用 webhost 数覆盖(AC7 已按 flavor 分文件)。
4. p95 判读须按 16↔27.7ms 帧量化双峰带(§4),单跑单值对比会假红/假绿。
