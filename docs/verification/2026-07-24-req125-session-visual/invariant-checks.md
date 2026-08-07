---
title: "REQ-125 V1 功能/安全门抽查 — I1–I8 + 功能门 + benchmark"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-07
---

# REQ-125 #547 V1 · 不变量 I1–I8 抽查清单(功能/安全门)

依据:方案基线 rev2 `docs/design/2026-07-24-session-seam-baseline.md` §③(I1–I8)与
§④ V1 行(功能门 + benchmark)。本文件保留父需求关闭前的不变量与性能核查范围;
截图逐行终判以 [`matrix.md`](matrix.md) 为准。

## 2026-08-06 执行记录

- 基点:alpha@`d3790e90b1e815001f8bb40f4ce8d15573c5de89`。
- `bash scripts/alpha-check.sh`:**7/7 通过**;89 个具名 gate 文件全部在位且实际执行,
  条数与登记精确一致;seed assets 与 changed-Markdown 相对链接门均通过。
- 视觉矩阵:74/74 行已有终判(57 PASS / 15 FAIL / 2 N/A);72 个可达行均有明暗双主题
  证据。FAIL 均已路由到 #538 的子票,详见 [`README.md`](README.md)。
- 功能/安全窄门:24 个 production-component/happy-dom 测试文件实跑,**294 pass / 0 fail**,
  1362 次断言,5.52s。覆盖 I1–I8、row projection、历史加载/流式/滚动锚定、dock
  fail-closed、Recovery、旧注入清零与 manifest lineage。
- 静态复核:旧注入文件 0、旧符号 0、未经 sanitizer 的 HTML API 0、裸外开 0。唯一
  `querySelector` 命中是 `alpha-composer.tsx` 对自身 popover 的局部元素定位,不是上游
  session DOM 查询;终端舞台的 5 个原始色值均由既有 token ratchet 白名单钉住。
- benchmark 合同已完成证据审计并终判 **3 FAIL**:C5 前基点的 Alpha timeline host 是空壳,
  且合并前没有生产采样,因此不存在可比较的 before 数据;上游 app timeline benchmark 又未
  测量本次 Alpha C5 变更,不得虚构指标或倒签 PASS。#866 已在可达代码 commit
  `80b42438a3386e26a36feb3a9d1f68c1de898852` 建立
  [当前生产性能基线](../2026-08-06-req125-timeline-performance/README.md),只供未来 delta。
- 全部执行均为无界面 L1:production Solid 组件、生产 CSS、确定性 adapter/fixture 与
  loopback-only headless Chrome。未启动 Electron、Alpha Code、packaged app 或前台 Chrome,
  也未读取账号或真实 API key。本记录不冒充候选发布包的 L3 GUI smoke。

## 终态矩阵

| ID  | 能力面                        | 结果 | 证据锚点                                                               |
| --- | ----------------------------- | ---- | ---------------------------------------------------------------------- |
| I1  | Alpha 边界/零上游 session DOM | PASS | workspace/review/terminal ratchet + 静态扫描;局部 popover 查询人工核对 |
| I2  | typed adapter/身份窄化        | PASS | workspace core、review core/panel、route manifest                      |
| I3  | 审批/未知 part fail-closed    | PASS | PermissionDialog、permission mount、timeline/tool-card 未知态          |
| I4  | Alpha Recovery                | PASS | Recovery 真实 Solid 渲染四分区 + workspace Recovery boundary           |
| I5  | `--a-*` token 白名单          | PASS | workspace/review/terminal CSS ratchet + 原始色值白名单复核             |
| I6  | URL/远程资源安全              | PASS | tool-card URL scheme/remote image 合同 + 裸外开静态扫描                |
| I7  | 有界/渐进渲染                 | PASS | 超大 patch 解析前拒绝、分段 fold、工具输出/Markdown 上限               |
| I8  | 会话竞态/审批 request-ID      | PASS | identity triple、迟到结果丢弃、stale/repeat permission reply           |
| F1  | row projection                | PASS | session timeline/model projection、未知 part 有界降级                  |
| F2  | 历史加载/流式                 | PASS | history loading、continuous anchoring、streaming freeze/windowing      |
| F3  | 滚动锚定                      | PASS | 底部跟随、离底冻结、回到底部恢复                                       |
| F4  | dock fail-closed/Recovery     | PASS | permission dock、Recovery 与 workspace 集成测试                        |
| F5  | 旧注入清零/manifest lineage   | PASS | 旧文件/符号静态扫描 + frontend surface manifest 测试                   |
| B1  | 大会话冷开 before/after       | FAIL | C5 前 Alpha host 为空且无采样;#866 当前基线不倒签 before               |
| B2  | 30s 流式帧率 before/after     | FAIL | 上游 harness 不覆盖 Alpha C5;#866 当前基线只供未来 delta               |
| B3  | 滚顶加载/内存 before/after    | FAIL | 不得以不可比数据补签;#866 已归档当前 raw/median                        |

以下保留父需求关闭前的详细合同与测试映射。原表中的「真机抽查」是未来候选发布包 L3
观测场景,不属于本次 L1 证据的声明范围;其安全/状态不变量已由上表所列确定性测试覆盖。任何
终态 FAIL 均阻断 REQ-125 父票关闭,但不阻止 #547 按已完整执行的 VERIFY 语义关闭。

统一跑法:`bun --cwd packages/ui-mac test src/renderer/alpha-ui src/shared`
(下表单测列只列关键锚点,不是全集)。

## I1 · 白名单边界(禁 import 上游 session 组件、零查上游 DOM)

| 验证                  | 命令/测试名                                                                                                                                                        | 预期                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 骨架 ratchet          | `alpha-session-workspace.test.ts` · "does not import or query upstream session DOM and no longer embeds SessionPage"                                               | 绿                                   |
| 审查面板 ratchet      | `session-rail/review/review-panel.test.ts` · "review sources never import upstream session components or touch upstream DOM"                                       | 绿                                   |
| 终端面板 ratchet      | `session-rail/terminal/terminal-rail.test.ts` · "terminal shell imports no upstream module and hand-rolls no engine or data channel"                               | 绿                                   |
| C5/C6/C7 同型 ratchet | 用上文 grep 定位各票 I1 静态断言测试                                                                                                                               | 每票各有一条且绿                     |
| 全量兜底 grep         | `grep -rn "app/pages/session\|MessageTimeline\|MessagePart" packages/ui-mac/src/renderer/alpha-ui/session-* packages/ui-mac/src/renderer/alpha-ui/alpha-composer*` | 零命中(测试文件内的反断言字符串除外) |

## I2 · 外部数据经 typed adapter/SDK/IPC,消费处窄化

| 验证                   | 命令/测试名                                                                                                                   | 预期                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| C1a typed live context | `session-workspace-core.test.ts` · "v2 target route plus typed sync record resolves the real server/directory/session triple" | 绿                                  |
| 消费点窄化             | `review-core.test.ts` · "narrows SDK records at the consumption point and drops malformed entries"                            | 绿;malformed 丢弃不崩               |
| 容器/视图分层          | `review-panel.test.ts` · "data flows only through the typed channel in the container; the view is channel-free"               | 绿                                  |
| 路由识别(C1a 首修项)   | `shared/route-manifest.test.ts` · "golden hrefs retain legacy compatibility and encode the canonical v2 target route"         | 绿;v2 target 路由可解析出会话三元组 |

## I3 · 审批 fail-closed;禁未经 sanitizer 管线的 HTML

| 验证                           | 命令/测试名                                                                                                         | 预期                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 审批 fail-closed(REQ-090 存量) | `PermissionDialog.test.ts`(五项事实/三态/失败不假定授权)+ `permission-mount-ratchet.test.ts`(唯一挂载/旧 dock 删除) | 全绿                                                                                   |
| C7 dock fail-closed            | grep 定位 C7 测试:dock 数据读不到/未知状态 → 不渲染动作、不放行                                                     | 绿                                                                                     |
| sanitizer 兜底 grep            | `grep -rn "innerHTML\|insertAdjacentHTML\|dangerouslySetInnerHTML" packages/ui-mac/src/renderer/alpha-ui/session-*` | 零命中,或唯一命中处是白名单内容引擎(Markdown sanitize 通道)的合同内注入点,逐处人工核对 |
| 未知 part fail-closed(功能门)  | grep 定位 C6 测试:未知工具/未知 part → 有界纯文本通用卡                                                             | 绿;真机抽查:构造未知工具名的 part,渲染为有界文本卡,无 HTML 注入面                      |

## I4 · 崩溃走 Alpha Recovery 合同(不回落上游叶)

| 验证                             | 命令/测试名                                                                                       | 预期                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 骨架 ratchet                     | `alpha-session-workspace.test.ts` · "keeps the release seam and existing Alpha Recovery boundary" | 绿                                                                           |
| Recovery 存量                    | `Recovery.test.ts`                                                                                | 绿                                                                           |
| 真机抽查(功能门 · Recovery 路径) | CDP 在会话页注入渲染异常(cap-session-surface #322 同法)→ 观察落点                                 | 落 Alpha Recovery surface,零 legacy session 叶;Recovery 不依赖会话页局部状态 |

## I5 · 令牌白名单(alpha 面只用 --a-\*)

| 验证          | 命令/测试名                                                                                                                                                                                               | 预期         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 顶栏/骨架     | `alpha-session-workspace.test.ts` · "uses one alpha 46px topbar and only --a-\* CSS variables"                                                                                                            | 绿           |
| 面板 CSS      | `review-panel.test.ts` · "panel CSS uses only --a-_ tokens and respects reduced motion";`terminal-rail.test.ts` · "css uses only --a-_ tokens; raw colors live only in the theme-invariant stage anchors" | 绿           |
| C5/C6/C7 同型 | grep 定位各票 token ratchet                                                                                                                                                                               | 每票各有且绿 |
| 兜底 grep     | `grep -rnE "#[0-9a-f]{3,8}\\b                                                                                                                                                                             | rgba?\\(     | oklch\\(" packages/ui-mac/src/renderer/alpha-ui/session-_/\*\*/_.css` | 命中仅限声明过的 theme-invariant 锚(如终端深底舞台),逐处比对测试白名单 |

## I6 · URL/远程资源:协议白名单、外链外开、不放宽 CSP

| 验证            | 命令/测试名                                                                                                                             | 预期                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| C6 链接处理测试 | grep 定位 C6 URL/协议测试                                                                                                               | 非白名单协议(javascript:/file:/data: 非图像)拒绝;外链走显式外开 |
| 外开面 grep     | `grep -rn "openExternal\|window.open" packages/ui-mac/src/renderer/alpha-ui/session-*`                                                  | 全部经统一白名单 helper,无裸调用                                |
| CSP 未放宽      | `git diff <pre-seam 基点>..HEAD -- packages/ui-mac/src/main packages/ui-mac/src/renderer/index.html \| grep -i "content-security\|csp"` | 零改动(或改动为收紧)                                            |
| 真机抽查        | seed 会话含对抗性 Markdown(javascript: 链接、远程图片)→ 点击/渲染                                                                       | 不在应用内导航、远程图不扩大外联面                              |

## I7 · 资源耗尽:有界/渐进渲染

| 验证               | 命令/测试名                                                                                                                | 预期                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 超大 patch 拒绝    | `review-core.test.ts` · "oversized patches are refused before the parser runs (I6/I7)"                                     | 绿                                  |
| 有界展开           | `review-core.test.ts` · "fold reveals are chunked, never unbounded (I7)"                                                   | 绿                                  |
| C5/C6 有界渲染测试 | grep 定位:超大 Markdown/代码块/工具输出上限、虚拟化不豁免单卡上限                                                          | 绿                                  |
| 真机抽查           | 构造 10MB 级 diff 与超长工具输出(harness-plan 构造表)→ 截断/拒绝 UI + 无整串进 sanitizer/Shiki(主进程不假死、渲染帧不冻结) | 界面可用;截断态截图入矩阵 D1 备注行 |

## I8 · 跨会话竞态:身份三元组绑定 + 审批 request-ID

| 验证                            | 命令/测试名                                                                                                                                                                                                     | 预期                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| C1a 隔离                        | `session-workspace-core.test.ts` · "all three identity fields must match before an async result is accepted" / "late records from the previous route/provider cannot populate the next session"                 | 绿                                                           |
| 面板绑定                        | `review-panel.test.ts` · "async loads and view state are bound to the C1 session identity (I8)";`terminal-rail.test.ts` · "engine channel is only consumable with an accepted identity triple (I8 fail-closed)" | 绿                                                           |
| 审批回复绑定                    | `PermissionDialog.test.ts`(409/ConflictError 区分、失败精确重试) + C7 stale/重复回复拒绝测试(grep 定位)                                                                                                         | 绿                                                           |
| 真机抽查(功能门 · 会话切换隔离) | 长任务运行中快速切换两个会话往返 ×5                                                                                                                                                                             | 无串台:时间线/右栏/顶栏状态均属当前会话;旧会话迟到事件不写入 |

## 功能门(§④ V1 行,I1–I8 之外)

| 项                        | 验证                                                                                                                                                                                                                                                                                                                                                                                                | 预期                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| row projection            | grep 定位 C5 行模型投影测试(SDK parts → 行类型)                                                                                                                                                                                                                                                                                                                                                     | 每种 part 类型有确定投影;顺序/合并稳定                         |
| 流式与历史加载            | 真机:流式期间行追加不闪断;滚到顶触发历史加载                                                                                                                                                                                                                                                                                                                                                        | 无重复行、无跳位;加载中有指示                                  |
| 滚动锚定                  | 真机:底部跟随时新行自动滚;离底后不抢滚,回到底部按钮出现(H5)                                                                                                                                                                                                                                                                                                                                         | 符合;离底阅读不被打断                                          |
| dock fail-closed          | 见 I3 行                                                                                                                                                                                                                                                                                                                                                                                            | 同 I3                                                          |
| Recovery 路径             | 见 I4 真机行                                                                                                                                                                                                                                                                                                                                                                                        | 同 I4                                                          |
| 旧注入零命中(C8 收口)     | ① `test -e packages/ui-mac/src/renderer/alpha-ui/composer-takeover.tsx -o -e packages/ui-mac/src/renderer/alpha-ui/timeline-inject.tsx && echo FAIL`;② `grep -rn "ComposerTakeover\|TimelineInject\|timeline-reskin" packages/ui-mac/src/renderer/index.tsx packages/ui-mac/src/renderer/alpha-ui/`;③ 真机 CDP:`document.querySelectorAll('[data-alpha-cmd],.a-tc-ico,.a-dirgrid,.a-openp').length` | ① 无输出(文件已删);② 零命中;③ = 0(会话页 DOM 无任何旧注入标记) |
| lineage/manifest 同步(C8) | grep 定位 #546 manifest/PAGE-MAP 测试;`frontend-surface-manifest.ts` session 条目 = alpha                                                                                                                                                                                                                                                                                                           | 绿;陈旧条目已修正                                              |

## benchmark(session/timeline 前后对比;packages/app/AGENTS.md 合同)

合同:`packages/app/AGENTS.md:4` —— 改 session/timeline 前记录生产基准、改后对比。
本 REQ 的「前」应为 C5 合并前主线基点,「后」应为全票合并 HEAD;两侧同机、同 fixture、
同窗口规格,各跑 3 次取中位。证据审计确认该合同在 C5 合并前未执行:C5 父提交
`53531ff371abe49a2e29fc0bd0cd86f6e43a5f19` 的 Alpha timeline host 为空,没有可测的等价
实现;PR #563 也未归档 before 样本。现存 `packages/app/e2e/performance/timeline` 测的是未随
C5 改动的上游 timeline,不能作为替代基线。

| 指标           | 采法                                                                               | 判定                          |
| -------------- | ---------------------------------------------------------------------------------- | ----------------------------- |
| 大会话冷开     | 500+ 行 fixture 会话,路由进入 → 时间线首屏渲染完成(CDP Tracing / performance.mark) | 后 ≤ 前 ×1.1                  |
| 流式帧率       | 长任务流式 30s,rAF 采样丢帧率(CDP Tracing)                                         | 后丢帧率不高于前 +10%         |
| 滚动与历史加载 | fixture 会话滚顶加载一批历史的耗时 + `process.memoryUsage`/renderer 内存           | 后 ≤ 前 ×1.1;内存无台阶式增长 |

本次 B1/B2/B3 均在“可比性前置门”终判 FAIL。#866 已建立可复用的
[当前 Alpha 基线](../2026-08-06-req125-timeline-performance/README.md):三轮中位数为
冷开 104.7ms、30s 流式 rAF gap p95 26.1ms/估算丢帧率 10.2023%、滚顶触发 14.9ms、
历史前插 45.2ms、锚点位移 58.875px,并归档 renderer memory 与完整 raw diagnostics。
该证据只供未来 delta
对比,不得倒签不存在的 C5 前性能结论;父票 #538 保持开放。
