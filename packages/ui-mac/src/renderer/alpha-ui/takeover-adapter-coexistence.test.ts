// REQ-088 T6(#181):takeover × adapter 共存审计 —— 可静态钉住的锚点。
//
// 审计对象:ComposerTakeover / ModelPickerInject / TimelineInject 三个 DOM 级接管件。
// 结论(详见 docs/audits/2026-07-13-s48-req088-t6-takeover-coexistence.md 审计矩阵):
// 它们「挂载方式无关」的根因是三条结构不变量,本文件把每条钉成源码锚点 ——
//   ① 挂载通道:takeover 作为 AppInterface children 在 router root 挂载一次,不在任何
//      surface 工厂/session 叶内 —— adapter 换叶不触碰它们的生命周期;
//   ② 观察面:全部经 document.body MutationObserver + document 级捕获事件工作,
//      只依赖上游叶渲染的 DOM 锚点,不依赖叶「怎么被挂进来」;
//   ③ 同 document 前提:adapter 模式经 `@opencode-ai/app/surface/session` 窄导出在
//      同一 document 内渲染上游叶(无 iframe)—— ②的选择器/事件才可达。
// 另补钉 takeover 依赖、但 REQ-012 锚点契约(upstream-anchors.json)覆盖不到的上游锚点:
//   - `session-composer` 以三元字面量渲染,anchor-audit 字面量匹配不到 → 落在 knownDead
//     (假死,REQ-005 基线审计 §0.1)——即上游改名不会红任何测试。此处直接钉渲染点。
//   - data-key / data-selected / data-slash-id / data-message-id / data-timeline-part-id /
//     data-kind / id="review-panel" 等不在 data-component|slot|action 命名空间。
// 形态同 surface-seam-contract.test.ts:冻结 packages/app|ui 无法在 bun test 直接 import,
// 以源码文本断言。断言红 = 共存前提破坏,回 T6 审计矩阵重评,不得只改测试。
//
// 运行时半边(真机取证)不在本文件伪造:CDP 探针清单见同名审计文档 §5。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const ALPHA_UI = import.meta.dir
const RENDERER = path.resolve(ALPHA_UI, "..")
const REPO = path.resolve(RENDERER, "..", "..", "..", "..")
const read = (p: string) => fs.readFileSync(p, "utf8")
const app = (p: string) => read(path.join(REPO, "packages/app/src", p))
const ui = (p: string) => read(path.join(REPO, "packages/ui/src", p))

const composerTakeover = read(path.join(ALPHA_UI, "composer-takeover.tsx"))
const modelPickerInject = read(path.join(ALPHA_UI, "model-picker-inject.tsx"))
const timelineInject = read(path.join(ALPHA_UI, "timeline-inject.tsx"))
const rendererIndex = read(path.join(RENDERER, "index.tsx"))
const takeovers: Record<string, string> = {
  "composer-takeover.tsx": composerTakeover,
  "model-picker-inject.tsx": modelPickerInject,
  "timeline-inject.tsx": timelineInject,
}

/** renderer 下全部非测试 ts/tsx 源(用于扫窄导出消费者)。 */
function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield p
  }
}

describe("T6 ①挂载通道:takeover 与 session 叶零耦合(挂载方式无关的结构根因)", () => {
  test("三个 takeover 都作为 AppInterface children 挂载(AlphaBoundary 包裹,router root 单例)", () => {
    for (const name of ["ComposerTakeover", "ModelPickerInject", "TimelineInject"]) {
      expect(rendererIndex).toContain(`<AlphaBoundary name="${name}">`)
    }
  })

  test("takeover 模块不 import @opencode-ai/app(不消费任何 upstream context/组件,只碰 document)", () => {
    for (const [name, src] of Object.entries(takeovers)) {
      // 含窄导出 ./surface/session 在内 —— takeover 与叶模块之间必须没有 import 边。
      expect({ name, coupled: src.includes(`"@opencode-ai/app`) }).toEqual({ name, coupled: false })
    }
  })

  test("takeover 观察面 = document.body MutationObserver,每件恰一个(AC8 结构 observer 预算基线 = 3)", () => {
    for (const [name, src] of Object.entries(takeovers)) {
      const observers = src.match(/new MutationObserver\(/g) ?? []
      expect({ name, observers: observers.length }).toEqual({ name, observers: 1 })
      expect(src).toContain("mo.observe(document.body, { childList: true, subtree: true })")
      expect(src).toContain("mo?.disconnect()")
    }
  })

  test("TimelineInject 不再挂发送捕获监听(#251:上游 composer 被 ComposerTakeover 隐藏,捕获路径已死)", () => {
    expect(timelineInject).not.toContain(`document.addEventListener("keydown"`)
    expect(timelineInject).not.toContain(`document.addEventListener("click"`)
    expect(timelineInject).not.toContain("function captureSend")
  })

  test("路由假设走版本化 legacy-route-abi,不手搓路由正则(adapter 不改路由形状,ABI 是唯一事实源)", () => {
    expect(composerTakeover).toContain(`import { parseRoute } from "../../shared/legacy-route-abi"`)
  })
})

describe("T6 ③同 document 前提:窄导出消费者不得引入 iframe/独立 document", () => {
  test("renderer 内每个 @opencode-ai/app/surface/session 消费者都在同一 document 渲染叶(无 iframe)", () => {
    // 不钉具体文件名:T2 正把 spike host 正式化为 AlphaSessionWorkspace,唯一收敛点断言归
    // req087-characterization.test.ts(随 T2 更新)。此处只钉「无论宿主叫什么,不得是 iframe」。
    const importers: string[] = []
    for (const f of walk(RENDERER)) {
      const src = read(f)
      if (src.includes("@opencode-ai/app/surface/session")) importers.push(f)
    }
    expect(importers.length).toBeGreaterThanOrEqual(1)
    for (const f of importers) {
      expect({ file: path.relative(RENDERER, f), iframe: read(f).includes("<iframe") }).toEqual({
        file: path.relative(RENDERER, f),
        iframe: false,
      })
    }
  })
})

describe("T6 ②a ComposerTakeover 锚点(REQ-012 manifest 假死缺口在此补钉)", () => {
  test("选择器 [data-component=session-composer] ↔ 上游三元渲染点(prompt-input.tsx;改名此处必红)", () => {
    // session-composer 在 upstream-anchors.json 里是 knownDead(假死:三元字面量匹配不到,
    // REQ-005 基线 §0.1)——锚点契约测试对它改名不设防。这里直接钉住渲染表达式。
    expect(app("components/prompt-input.tsx")).toContain(
      `data-component={newSession() ? "session-new-composer" : "session-composer"}`,
    )
  })

  test("隐性前置:composer 锚点只在 newLayoutDesigns 分支渲染 + alpha 主进程种子恒 true", () => {
    expect(app("components/prompt-input.tsx")).toContain("<Match when={props.controls.newLayoutDesigns}>")
    expect(read(path.join(REPO, "packages/ui-mac/src/main/alpha-defaults.ts"))).toContain(
      "general.newLayoutDesigns = true",
    )
  })

  test("样式假设:body flag 与 CSS 隐藏规则成对存在(设/清各一处,隐藏保留 DOM)", () => {
    expect(composerTakeover).toContain(`document.body.setAttribute("data-alpha-composer-takeover", "")`)
    expect(composerTakeover).toContain(`document.body.removeAttribute("data-alpha-composer-takeover")`)
    const css = read(path.join(ALPHA_UI, "alpha-composer.css"))
    expect(css).toContain(`body[data-alpha-composer-takeover] [data-component="session-composer"]`)
    // 隐藏而非移除:上游 composer 的状态/命令注册面必须保持存活(取代它的是视觉,不是生命周期)。
    expect(css).toMatch(
      /body\[data-alpha-composer-takeover\] \[data-component="session-composer"\] \{\s*display: none !important;/,
    )
  })

  test("可见性口径 = offsetParent(与 spike 探针同口径;宿主 chrome 不得用 display:none 包叶)", () => {
    expect(composerTakeover).toContain("offsetParent !== null")
  })

  test("usage-ring 收养锚点 progress-circle 仍由上游渲染", () => {
    expect(ui("components/progress-circle.tsx")).toContain(`data-component="progress-circle"`)
  })
})

describe("T6 ②b ModelPickerInject 锚点(弹层在 body 级 portal,叶挂载方式天然无关)", () => {
  test("上游 model picker 弹层经 Kobalte Portal 挂 body(不在 session 叶子树内)", () => {
    expect(app("components/dialog-select-model.tsx")).toContain("<Kobalte.Portal>")
  })

  test("native 行契约:list-item/list-scroll + data-key/data-selected(后两者在 REQ-012 命名空间外)", () => {
    const list = ui("components/list.tsx")
    expect(list).toContain(`data-slot="list-scroll"`)
    expect(list).toContain(`data-slot="list-item"`)
    expect(list).toContain("data-key={props.key(item)}")
    expect(list).toContain("data-selected={item === props.current}")
  })

  test("选择通路 = 点击隐藏 native 行(model.set 留在上游 route-scoped context,inject 不复制状态)", () => {
    expect(modelPickerInject).toContain(`[data-slot="list-item"][data-key=`)
    expect(modelPickerInject).toContain("el?.click()")
  })

  test("接管后初始焦点归 alpha 搜索框(#250 r1:上游 autofocus 的原生搜索框被 reskin 隐藏)", () => {
    // claimFocus:picker 打开即把焦点移到 alpha 搜索框,带重试(晚到的上游 autofocus 不能赢终局),
    // 且不抢已在 picker 内的焦点(用户点行 / add-provider 表单)。
    expect(modelPickerInject).toContain("const claimFocus = ()")
    expect(modelPickerInject).toContain("searchEl.focus()")
    expect(modelPickerInject).toContain("setTimeout(claimFocus, d)")
    expect(modelPickerInject).toContain(`document.querySelector("[data-alpha-picker]")?.contains(active)`)
    expect(modelPickerInject).toContain("ref={searchEl}")
  })
})

describe("T6 ②c TimelineInject 锚点(REQ-012 manifest 命名空间外的补钉)", () => {
  test("slash 菜单锚点 data-slash-id 仍由上游渲染(slash-popover.tsx)", () => {
    expect(app("components/prompt-input/slash-popover.tsx")).toContain("data-slash-id={cmd.id}")
  })

  test("消息身份锚点 data-message-id / data-timeline-part-id 仍由上游渲染(cmd chip 持久化的 key)", () => {
    expect(app("pages/session/timeline/message-timeline.tsx")).toContain(
      "data-message-id={input.row().userMessageID}",
    )
    const messagePart = ui("components/message-part.tsx")
    expect(messagePart).toContain(`data-component="user-message" data-timeline-part-id={textPart()?.id}`)
  })

  test("审查面板通路:id=review-panel + header 的 aria-controls 开关仍存在(「在面板打开」pill 的通路)", () => {
    expect(app("pages/session/session-side-panel.tsx")).toContain(`id="review-panel"`)
    expect(app("components/session/session-header.tsx")).toContain(`aria-controls="review-panel"`)
  })

  test("错误卡去重锚点 data-kind=tool-error-card 仍由上游渲染", () => {
    expect(ui("components/tool-error-card.tsx")).toContain(`data-kind="tool-error-card"`)
  })

  // 目录网格 <entries> 格式锁已随 #252 摘除(decorateDirOutput 死路径已删,无耦合可锁)。
})
