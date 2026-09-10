---
type: design
slug: req159-sandbox-disclosure
date: 2026-09-10
status: proposed
relates:
  - jinjunnn/alpha-code#1322(REQ-159 子票 4,本增量是其 Ready 门)
  - docs/design/2026-09-09-req159-process-fence-baseline.md §三 I3 / I4
---

# 沙箱下的两处如实告知 —— 终端脚条一项,工作区一枚只读胶囊

> 帧见同目录 [`frame.html`](frame.html)(终端面板常态 / 悬停 / 窄右栏 / 空态;顶栏可写 / 只读 /
> 弹层;首页 chip 两态;状态表;中英文案)。批准后并入
> [`current/session-workspace/design.html`](../current/session-workspace/design.html) 的 `#term`
> (脚条与空态注记)与 `#wtopsec`(状态胶囊之后),锚 `#term-sandbox` / `#wtop-readonly`;台账见
> [`current/session-workspace/components.md`](../current/session-workspace/components.md)。

## 1. 与上一稿的关系

**继承**(session-workspace 现行稿 `#term` / `#wtopsec`,全部不动):

- 终端面板外框:面板页签、深底输出区(内核引擎渲染)、脚条「运行状态 · 环境 · 尺寸」、空态形态与措辞;
- 顶栏:项目胶囊 › 会话名 · 状态胶囊(两态)· 终端开关 · 右栏开关;
- 首页 / 新对话页共用的工作区 chip(该页无活稿,视觉基线仍是已批首页稿)。

**新增**:

- 终端脚条第三项「沙箱开启 · 你的部分终端配置可能不生效」(窄于 360px 只留「沙箱开启」,整句进悬停);
  悬停层给三句解释;空态在「新建一个……」之下多一行同义短句;
- 顶栏状态胶囊之后一枚暖色「只读」胶囊,悬停 / 点击弹层给原因、出路、脚注;新对话页的 chip 在目录名后
  加同色尾标,悬停给同一段解释。

**取代**:无。「状态胶囊只有两态」仍成立 —— 只读是工作区状态不是会话状态,所以是另一枚胶囊。

**为什么**:owner 2026-09-09 裁决终端配置降级走「如实披露」,不放宽 `$HOME`、不改 PTY 起登录
shell;多工作区决定书也把「集合外目录一写就 `operation not permitted`,而失败只在工具输出里」列为
待披露的可观察面。两句实话今天在产品里零落点。

## 2. 动笔前的地面真相(本轮实读)

| 事实 | 坐标 |
| --- | --- |
| 终端脚条今天 = 运行状态 · shell · 尺寸,三项 mono 小字 | `packages/ui-mac/src/renderer/alpha-ui/session-rail/terminal/terminal-rail-panel.tsx:200-220`(`.a-term-foot`、`footRunning/footIdle`、`data-alpha-terminal-foot-env`、`.a-term-foot-size`) |
| 终端空态今天 = 标题 + 一句 + 新建按钮 | 同文件 `:107-124`;文案 `renderer/i18n/zh.ts:1468-1469` / `en.ts:1499-1500` |
| 活稿终端面板:脚条「运行状态 + 环境 + 尺寸」、空态措辞 | `current/session-workspace/design.html:687-722` |
| 顶栏今天 = 项目胶囊 › 会话名 · 状态胶囊(`role=status aria-live=polite`)· 两个开关 | `session-workspace/session-workspace-shell.tsx:102-166`(`WorkspaceTopbar`) |
| 活稿顶栏:「状态胶囊只有两态」 | `current/session-workspace/design.html:480-511` |
| 新对话页不走顶栏,工作区选择是 chip;首页同源 | `alpha-ui/alpha-new-session.tsx:21,153`;`alpha-ui/workspace-chip.tsx:1-8` |
| 「目录成为当前工作区」的入口 | `workspace-chip.tsx:104-108`(选目录 → `onSelect`)、`sidebar/alpha-sidebar.tsx:681-693`(`resolveDraftTarget`);`main/deep-links.ts`(41 行,票面点名,本轮未逐行复读) |
| 集合外工作区:打得开、读得了、一写就拒,失败只在工具输出里;下次启动即在集合里 | `docs/architecture/2026-09-09-multi-workspace-fence-decision.md` §2.4;落地形状 §7 |
| 引擎侧「围栏装上了」有明确信号:sidecar apply 成功才起,main 日志一行;renderer 今天没有对应信号 | `main/process-fence-apply.ts`、`docs/architecture/2026-09-09-req159-process-fence.md` §1 |
| 只读判据只能是真写一次:字符串比较在四种形状上出错 | 多工作区决定书(`ws1extra` / 软链进出 / APFS 大小写) |
| 视觉语言 | `2026-06-25-cool-graphite-visual-system.md`(本机没有 `frontend-design` 技能,以此文为准);`--a-warning` 沿本页 `design.css` 的 `#d97706` |

## 3. 契约(批准后即 AC 字面量锚点)

### 3.1 终端面(静态)

| 项 | 规则 |
| --- | --- |
| 出现条件 | 沙箱真的装上(引擎自报)。没装上的平台 / 形态不出现 —— 没有围栏就不说有 |
| 位置 | 脚条第三项,在环境(shell)之后、尺寸之前;空态在正文之下、按钮之上 |
| 常驻 | 不可关闭、不弹窗、不计数;与「zsh」同级的环境事实 |
| 窄宽 | 面板宽 < 360px 只显「沙箱开启」,整句进 `title` / 悬停层 |
| 悬停层 | 标题 + 三句(能写哪里 / 什么会被拦且不报错 / 什么不受影响),抬起的表面,箭头指回脚条项 |
| 判据钩子 | 脚条项 `data-alpha-terminal-foot-sandbox`,空态行 `data-alpha-terminal-empty-sandbox`;反向用例 = 删掉脚条项,呈现层判据必须红 |

### 3.2 工作区(动态)

| 状态 | 触发 | 呈现 |
| --- | --- | --- |
| 探针未答 | 目录刚成为当前工作区,真写一次的探针未返回 | 无标记 |
| 可写 | 探针在该目录写入并删除成功 | 无标记 |
| 只读 | 被围住的引擎回报写入被拒 | 顶栏胶囊 / chip 尾标出现,直到切换工作区或重新启动 |
| 未知 | 引擎不在 / 探针出错 / 该平台无沙箱 | 无标记(未知 ≠ 只读) |

| 项 | 规则 |
| --- | --- |
| 探针 | 由被围栏的引擎在目标工作区真写一次再删;**先在可写工作区答过「可写」才算数**,恒答「不可写」的探针被判据当场拒掉 |
| 触发点 | 三个入口各触发一次:chip 选目录、侧栏 draft 目标解析、deep link |
| 位置 | 顶栏:状态胶囊之后,同款尺寸,暖色淡底;chip:目录名与折叠箭头之间,同色更小 |
| 弹层 | 标题 + 三句 + 脚注 + 动作「重新启动 Alpha」;悬停与点击都能开 |
| 辅助技术 | 胶囊 `role=status`,文本即「只读」;弹层 `aria-describedby` 指回胶囊 |
| 判据钩子 | 顶栏 `data-alpha-workspace-readonly`,chip `data-alpha-workspace-chip-readonly`;两臂判据 = 集合内工作区无标记、集合外有标记 |

## 4. 帧外说明

- **「重新启动 Alpha」按钮**是本稿唯一超出「只呈现」的动作(票面边界是呈现面 + 探针)。留它的理由:
  弹层若只说「重新启动后即可」却不给入口,用户得自己去找。owner 可划掉,划掉后弹层只留文字。
- 终端告知刻意**不写进输出区**:输出区归终端引擎,内容会被用户自己的 rc 输出冲走;脚条常驻。
- 只读告知刻意**不用 toast、不放左栏项目行**:toast 会消失而只读持续到重启;左栏列全部项目,
  只读描述的是「这个项目 vs 这次启动」的关系,只对当前工作区成立。
- 文案里的「不写文件的设置(别名、提示符、PATH)照常生效」是按围栏机制(只拒文件写)写的陈述,
  不是实测清单;实现时若某项被证伪,改文案不改结构。

## 5. 批准后的落点

1. 帧并入 `current/session-workspace/design.html`:`#term` 的脚条与空态各加注记 + 悬停层,
   铸锚 `#term-sandbox`;`#wtopsec` 状态胶囊之后加只读胶囊帧与弹层,铸锚 `#wtop-readonly`;
   `#contract` 加两行(终端脚条第三项;工作区只读状态)。
2. 台账两行的「设计定稿」填批准日;实现票关闭的同一 PR 回填「落地」与代码入口。
3. 本目录就地冻结。
