---
title: "cap:session-surface L2 真机矩阵 — #322 Router/MemoryRouter leaf-XOR / preload / provider remount / fatal reload"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-19
review_after: 2026-10-19
---

# cap:session-surface L2 真机证据 — #322(2026-07-19)

归并 REQ-084/086/087/088 的 router/adapter/session lifecycle 验证矩阵(capability = session surface)。
真机 Electron dev 取证(S48 视觉审计同款 CDP 形态:`--remote-debugging-port=9222` 裸 WebSocket,
`OPENCODE_TEST_ONBOARDING=1` 全隔离临时根 —— userData/XDG/ALPHA_GLOBAL_DIR 均改道系统临时目录,
不碰真实用户数据)。基点 HEAD = `a5613686`(alpha),被测面只读、未改任何产品代码。

两实例:
- **实例 A**(发布默认,无 env override):证发布态 leaf XOR + 非法目录回退 + fatal→reload→legacy 全链。
- **实例 B**(`ALPHA_SURFACE_HOME=legacy ALPHA_SURFACE_SESSION=alpha`):证 env-override 分层 + session 双闸
  (env-override + localStorage `ALPHA_SESSION_SPIKE`)开合。

## 矩阵结果

| # | 项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 生产 IPC 解析三 surface(env>pin>发布默认) | PASS | `window.api.surfaces.resolve()` 返回 `home/newSession=alpha(release-default)`、`session=legacy(release-default)`(`322-a-defaults.json` resolve0);实例 B 得 `home=legacy(env-override)`、`session=alpha(env-override)`(`322-b-envgate.json` resolve) |
| 2 | Home 叶 XOR(`/` → 单 AlphaHome,零上游 composer) | PASS | `alphaHomeCount=1`、`alphaNewSessionCount=0`、`upstreamSessionComposer=0`(`322-a-defaults.json` home);截图 `322-a1-home-alpha.png` |
| 3 | 新会话 draft 叶 XOR(`/:dir/session` 无 id → route effect 建 draft) | PASS | `/:dir/session` 落 `alphaNewSession=1`、其余叶 0(`322-a-defaults.json` draft) |
| 4 | 真实 session 发布默认 = legacy 上游叶(零 alpha 标记) | PASS | 侧栏点开引擎建的 session:`upstreamSessionComposer=1`、`alphaSessionWorkspace=0`、`alphaHome/NewSession=0`(`322-a-nav.json` sessionLeaf);截图 `322-a5-session-legacy-leaf.png` |
| 5 | 非法目录回退不变量(`directory-layout`) | PASS | `/<bogus-dir>/session` 不崩、落 newSession 叶(`322-a-defaults.json` invalidDir) |
| 6 | preload 转发只驱动 effective leaf(`preload: () => Leaf.preload?.()`) | PASS | seam 契约锚点 `surface-seam-contract.test.ts:29`;真机三 surface 解析各自命中单叶,无双叶并存(#2–4 计数) |
| 7 | provider wrapper 生命周期保留(session 叶包 SessionProviders,draft 叶包 DraftProviders) | PASS | seam 契约锚点 `surface-seam-contract.test.ts:38`;env-override 开 spike 后 workspace 包住上游 composer(`322-b-envgate.json` workspaceWrapsUpstream=true) |
| 8 | fatal → 上报(await 落盘)→ reload → home 回 legacy(crash-fallback) | PASS | `reportFailure` 后 `resolve` 得 `home=legacy(crash-fallback)`;reload 后 `alphaHome=0`(上游 home)、`resolveAfterReload.home=crash-fallback`(`322-a-defaults.json` resolveAfterRecord/homeAfterFatal/resolveAfterReload);截图 `322-a4-home-legacy-after-fatal.png` |
| 9 | 记录清除后 reload → home 恢复 alpha(版本内自然恢复) | PASS | 清 `alpha-surfaces.json` 后 reload:`resolveAfterClear.home=alpha(release-default)`(`322-a-nav.json` resolveAfterClear) |
| 10 | env-override 分层(home=legacy 生效,newSession 不受影响) | PASS | 实例 B `homeLegacy` 三叶皆 0(上游 home),`newSession=alpha` 保持发布默认(`322-b-envgate.json`);截图 `322-b1-home-upstream.png` |
| 11 | session 双闸:env=alpha 但 spike 未开 → 上游叶;spike 开 → AlphaSessionWorkspace;关闸 → 回上游 | PASS | `sessionNoSpike.alphaSessionWorkspace=0` → 开闸 `sessionWithSpike.alphaSessionWorkspace=1` 且包上游 composer → 关闸 `sessionSpikeOff.alphaSessionWorkspace=0`(`322-b-envgate.json`);截图 `322-b3-session-workspace-spike-on.png` |
| 12 | MemoryRouter 生产装载(renderer 入口 `router={MemoryRouter}`) | PASS | 全程 URL 走内存路由(`location.pathname` 恒 `/index.html`,应用路由在 MemoryRouter 内),深链/back-forward 经 `window.history`(`renderer/index.tsx:473`) |

全 12 项 PASS。单测配套:`surface-seam-contract.test.ts`(seam 存活锚点)、`alpha-surfaces.test.ts`
(env>pin>默认分层、#334 硬 alpha 不豁免崩溃记录、落盘 fail-closed)—— ui-mac 全量 `2180 pass / 0 fail`(2026-07-19 复跑)。

## 文件

| 文件 | 内容 |
|---|---|
| `322-a-defaults.json` | 实例 A:三 surface 解析、home/draft/session leaf 计数、非法目录、fatal→reload |
| `322-a-nav.json` | 实例 A:记录清除后恢复、侧栏 openSession 生产路径落上游叶 |
| `322-b-envgate.json` | 实例 B:env-override 分层 + session 双闸开合 |
| `322-a1-home-alpha.png` | 发布默认 home = AlphaHome |
| `322-a3-session-legacy.png` / `322-a5-session-legacy-leaf.png` | 发布默认 session = 上游叶 |
| `322-a4-home-legacy-after-fatal.png` | fatal 落盘 + reload 后 home 回上游 |
| `322-b1-home-upstream.png` | env=legacy → 上游 home |
| `322-b3-session-workspace-spike-on.png` | 双闸全开 → AlphaSessionWorkspace 包上游叶 |

## 判定

矩阵全项 PASS —— session-surface capability 的 leaf XOR、preload 单叶转发、provider remount 保留、
env>pin>默认分层、双闸开合、fatal→reload→legacy 全链在当前 alpha `a5613686` 真机成立。
本票关闭(completed)。
