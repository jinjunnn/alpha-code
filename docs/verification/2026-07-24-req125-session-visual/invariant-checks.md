---
title: "REQ-125 V1 功能/安全门抽查 — I1–I8 + 功能门 + benchmark"
kind: verification
status: draft
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-24
---

# REQ-125 #547 V1 · 不变量 I1–I8 抽查清单(功能/安全门)

依据:方案基线 rev2 `docs/design/2026-07-24-session-seam-baseline.md` §③(I1–I8)与
§④ V1 行(功能门 + benchmark)。抽查在全部 CODE 票合并后的主线 HEAD 执行,与截图批
同窗;测试跑主 checkout 真环境(worktree 符号链接假红,判据只认 delta-vs-base)。
已合票(#539/#540/#550)的测试名为实测锚点;未合票(C5/C6/C7/C8)的条目给出定位法
`grep -rn "REQ-125 C5\|REQ-125 C6\|REQ-125 C7\|REQ-125 C8" packages/ui-mac/src --include "*.test.ts"`,
测试名以票落地为准。任何一条红 = 阻断 REQ-125 关闭(不挡单 CODE 票)。

统一跑法:`bun --cwd packages/ui-mac test src/renderer/alpha-ui src/shared`
(下表单测列只列关键锚点,不是全集)。

## I1 · 白名单边界(禁 import 上游 session 组件、零查上游 DOM)

| 验证 | 命令/测试名 | 预期 |
|---|---|---|
| 骨架 ratchet | `alpha-session-workspace.test.ts` · "does not import or query upstream session DOM and no longer embeds SessionPage" | 绿 |
| 审查面板 ratchet | `session-rail/review/review-panel.test.ts` · "review sources never import upstream session components or touch upstream DOM" | 绿 |
| 终端面板 ratchet | `session-rail/terminal/terminal-rail.test.ts` · "terminal shell imports no upstream module and hand-rolls no engine or data channel" | 绿 |
| C5/C6/C7 同型 ratchet | 用上文 grep 定位各票 I1 静态断言测试 | 每票各有一条且绿 |
| 全量兜底 grep | `grep -rn "app/pages/session\|MessageTimeline\|MessagePart" packages/ui-mac/src/renderer/alpha-ui/session-* packages/ui-mac/src/renderer/alpha-ui/alpha-composer*` | 零命中(测试文件内的反断言字符串除外) |

## I2 · 外部数据经 typed adapter/SDK/IPC,消费处窄化

| 验证 | 命令/测试名 | 预期 |
|---|---|---|
| C1a typed live context | `session-workspace-core.test.ts` · "v2 target route plus typed sync record resolves the real server/directory/session triple" | 绿 |
| 消费点窄化 | `review-core.test.ts` · "narrows SDK records at the consumption point and drops malformed entries" | 绿;malformed 丢弃不崩 |
| 容器/视图分层 | `review-panel.test.ts` · "data flows only through the typed channel in the container; the view is channel-free" | 绿 |
| 路由识别(C1a 首修项) | `shared/route-manifest.test.ts` · "golden hrefs retain legacy compatibility and encode the canonical v2 target route" | 绿;v2 target 路由可解析出会话三元组 |

## I3 · 审批 fail-closed;禁未经 sanitizer 管线的 HTML

| 验证 | 命令/测试名 | 预期 |
|---|---|---|
| 审批 fail-closed(REQ-090 存量) | `PermissionDialog.test.ts`(五项事实/三态/失败不假定授权)+ `permission-mount-ratchet.test.ts`(唯一挂载/旧 dock 删除) | 全绿 |
| C7 dock fail-closed | grep 定位 C7 测试:dock 数据读不到/未知状态 → 不渲染动作、不放行 | 绿 |
| sanitizer 兜底 grep | `grep -rn "innerHTML\|insertAdjacentHTML\|dangerouslySetInnerHTML" packages/ui-mac/src/renderer/alpha-ui/session-*` | 零命中,或唯一命中处是白名单内容引擎(Markdown sanitize 通道)的合同内注入点,逐处人工核对 |
| 未知 part fail-closed(功能门) | grep 定位 C6 测试:未知工具/未知 part → 有界纯文本通用卡 | 绿;真机抽查:构造未知工具名的 part,渲染为有界文本卡,无 HTML 注入面 |

## I4 · 崩溃走 Alpha Recovery 合同(不回落上游叶)

| 验证 | 命令/测试名 | 预期 |
|---|---|---|
| 骨架 ratchet | `alpha-session-workspace.test.ts` · "keeps the release seam and existing Alpha Recovery boundary" | 绿 |
| Recovery 存量 | `Recovery.test.ts` | 绿 |
| 真机抽查(功能门 · Recovery 路径) | CDP 在会话页注入渲染异常(cap-session-surface #322 同法)→ 观察落点 | 落 Alpha Recovery surface,零 legacy session 叶;Recovery 不依赖会话页局部状态 |

## I5 · 令牌白名单(alpha 面只用 --a-*)

| 验证 | 命令/测试名 | 预期 |
|---|---|---|
| 顶栏/骨架 | `alpha-session-workspace.test.ts` · "uses one alpha 46px topbar and only --a-* CSS variables" | 绿 |
| 面板 CSS | `review-panel.test.ts` · "panel CSS uses only --a-* tokens and respects reduced motion";`terminal-rail.test.ts` · "css uses only --a-* tokens; raw colors live only in the theme-invariant stage anchors" | 绿 |
| C5/C6/C7 同型 | grep 定位各票 token ratchet | 每票各有且绿 |
| 兜底 grep | `grep -rnE "#[0-9a-f]{3,8}\b|rgba?\(|oklch\(" packages/ui-mac/src/renderer/alpha-ui/session-*/**.css` | 命中仅限声明过的 theme-invariant 锚(如终端深底舞台),逐处比对测试白名单 |

## I6 · URL/远程资源:协议白名单、外链外开、不放宽 CSP

| 验证 | 命令/测试名 | 预期 |
|---|---|---|
| C6 链接处理测试 | grep 定位 C6 URL/协议测试 | 非白名单协议(javascript:/file:/data: 非图像)拒绝;外链走显式外开 |
| 外开面 grep | `grep -rn "openExternal\|window.open" packages/ui-mac/src/renderer/alpha-ui/session-*` | 全部经统一白名单 helper,无裸调用 |
| CSP 未放宽 | `git diff <pre-seam 基点>..HEAD -- packages/ui-mac/src/main packages/ui-mac/src/renderer/index.html \| grep -i "content-security\|csp"` | 零改动(或改动为收紧) |
| 真机抽查 | seed 会话含对抗性 Markdown(javascript: 链接、远程图片)→ 点击/渲染 | 不在应用内导航、远程图不扩大外联面 |

## I7 · 资源耗尽:有界/渐进渲染

| 验证 | 命令/测试名 | 预期 |
|---|---|---|
| 超大 patch 拒绝 | `review-core.test.ts` · "oversized patches are refused before the parser runs (I6/I7)" | 绿 |
| 有界展开 | `review-core.test.ts` · "fold reveals are chunked, never unbounded (I7)" | 绿 |
| C5/C6 有界渲染测试 | grep 定位:超大 Markdown/代码块/工具输出上限、虚拟化不豁免单卡上限 | 绿 |
| 真机抽查 | 构造 10MB 级 diff 与超长工具输出(harness-plan 构造表)→ 截断/拒绝 UI + 无整串进 sanitizer/Shiki(主进程不假死、渲染帧不冻结) | 界面可用;截断态截图入矩阵 D1 备注行 |

## I8 · 跨会话竞态:身份三元组绑定 + 审批 request-ID

| 验证 | 命令/测试名 | 预期 |
|---|---|---|
| C1a 隔离 | `session-workspace-core.test.ts` · "all three identity fields must match before an async result is accepted" / "late records from the previous route/provider cannot populate the next session" | 绿 |
| 面板绑定 | `review-panel.test.ts` · "async loads and view state are bound to the C1 session identity (I8)";`terminal-rail.test.ts` · "engine channel is only consumable with an accepted identity triple (I8 fail-closed)" | 绿 |
| 审批回复绑定 | `PermissionDialog.test.ts`(409/ConflictError 区分、失败精确重试) + C7 stale/重复回复拒绝测试(grep 定位) | 绿 |
| 真机抽查(功能门 · 会话切换隔离) | 长任务运行中快速切换两个会话往返 ×5 | 无串台:时间线/右栏/顶栏状态均属当前会话;旧会话迟到事件不写入 |

## 功能门(§④ V1 行,I1–I8 之外)

| 项 | 验证 | 预期 |
|---|---|---|
| row projection | grep 定位 C5 行模型投影测试(SDK parts → 行类型) | 每种 part 类型有确定投影;顺序/合并稳定 |
| 流式与历史加载 | 真机:流式期间行追加不闪断;滚到顶触发历史加载 | 无重复行、无跳位;加载中有指示 |
| 滚动锚定 | 真机:底部跟随时新行自动滚;离底后不抢滚,回到底部按钮出现(H5) | 符合;离底阅读不被打断 |
| dock fail-closed | 见 I3 行 | 同 I3 |
| Recovery 路径 | 见 I4 真机行 | 同 I4 |
| 旧注入零命中(C8 收口) | ① `test -e packages/ui-mac/src/renderer/alpha-ui/composer-takeover.tsx -o -e packages/ui-mac/src/renderer/alpha-ui/timeline-inject.tsx && echo FAIL`;② `grep -rn "ComposerTakeover\|TimelineInject\|timeline-reskin" packages/ui-mac/src/renderer/index.tsx packages/ui-mac/src/renderer/alpha-ui/`;③ 真机 CDP:`document.querySelectorAll('[data-alpha-cmd],.a-tc-ico,.a-dirgrid,.a-openp').length` | ① 无输出(文件已删);② 零命中;③ = 0(会话页 DOM 无任何旧注入标记) |
| lineage/manifest 同步(C8) | grep 定位 #546 manifest/PAGE-MAP 测试;`frontend-surface-manifest.ts` session 条目 = alpha | 绿;陈旧条目已修正 |

## benchmark(session/timeline 前后对比;packages/app/AGENTS.md 合同)

合同:`packages/app/AGENTS.md:4` —— 改 session/timeline 前记录生产基准、改后对比。
本 REQ 的「前」= C5 合并前主线基点(采集时从 git 记录该 commit),「后」= 全票合并
HEAD;两侧同机、同 fixture、同窗口规格,各跑 3 次取中位。

| 指标 | 采法 | 判定 |
|---|---|---|
| 大会话冷开 | 500+ 行 fixture 会话,路由进入 → 时间线首屏渲染完成(CDP Tracing / performance.mark) | 后 ≤ 前 ×1.1 |
| 流式帧率 | 长任务流式 30s,rAF 采样丢帧率(CDP Tracing) | 后丢帧率不高于前 +10% |
| 滚动与历史加载 | fixture 会话滚顶加载一批历史的耗时 + `process.memoryUsage`/renderer 内存 | 后 ≤ 前 ×1.1;内存无台阶式增长 |

超阈 = FAIL:转 bug 票挂父票 #538(优先序 stability > simplicity > performance,
性能退化票不豁免)。结果表连同原始 trace 归档本目录,采集 README 汇总。
