// REQ-088 T6(#181):takeover × adapter 共存审计 —— 可静态钉住的锚点。
//
// 审计对象:ComposerTakeover / TimelineInject 两个遗留 DOM 接管件，以及 canonical composer picker。
// 结论(详见 docs/audits/2026-07-13-s48-req088-t6-takeover-coexistence.md 审计矩阵):
// 它们「挂载方式无关」的根因是三条结构不变量,本文件把每条钉成源码锚点 ——
//   ① 挂载通道:takeover 作为 AppInterface children 在 router root 挂载一次,不在任何
//      surface 工厂/session 叶内 —— adapter 换叶不触碰它们的生命周期;
//   ② 遗留观察面:经 document.body MutationObserver 工作,
//      只依赖上游叶渲染的 DOM 锚点,不依赖叶「怎么被挂进来」;
//   ③ 同 document 前提:adapter 模式经 `@opencode-ai/app/surface/session` 窄导出在
//      同一 document 内渲染上游叶(无 iframe)—— ②的选择器/事件才可达。
// 另补钉 takeover 依赖、但 REQ-012 锚点契约(upstream-anchors.json)覆盖不到的上游锚点:
//   - `session-composer` 以三元字面量渲染,anchor-audit 字面量匹配不到 → 落在 knownDead
//     (假死,REQ-005 基线审计 §0.1)——即上游改名不会红任何测试。此处直接钉渲染点。
//   - data-key / data-selected / data-slash-id / data-message-id / data-timeline-part-id /
//     data-kind / id="review-panel" 等不在 data-component|slot|action 命名空间。
// packages/app|ui 锚点仍以源码契约断言；REQ-090 picker owner 的唯一挂载由组件测试真实渲染
// AlphaComposer 后查询 data marker，本文件只保留旧模块不存在与 renderer 其它文件零引用的
// 纯文本否定辅助门。断言红 = 共存前提破坏,回 T6 审计矩阵重评,不得只改测试。
//
// 运行时半边(真机取证)不在本文件伪造:CDP 探针清单见同名审计文档 §5。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { FRONTEND_SURFACE_MANIFEST } from "../../shared/frontend-surface-manifest"

const ALPHA_UI = import.meta.dir
const RENDERER = path.resolve(ALPHA_UI, "..")
const REPO = path.resolve(RENDERER, "..", "..", "..", "..")
const read = (p: string) => fs.readFileSync(p, "utf8")
const app = (p: string) => read(path.join(REPO, "packages/app/src", p))
const ui = (p: string) => read(path.join(REPO, "packages/ui/src", p))

const composerTakeover = read(path.join(ALPHA_UI, "composer-takeover.tsx"))
const timelineInject = read(path.join(ALPHA_UI, "timeline-inject.tsx"))
const alphaComposer = read(path.join(ALPHA_UI, "alpha-composer.tsx"))
const composerModelPicker = read(path.join(ALPHA_UI, "alpha-composer-model.tsx"))
const modelContract = read(path.join(ALPHA_UI, "model-contract.ts"))
const composerState = read(path.join(ALPHA_UI, "composer-state.ts"))
const rendererIndex = read(path.join(RENDERER, "index.tsx"))
const takeovers: Record<string, string> = {
  "composer-takeover.tsx": composerTakeover,
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
  test("两个遗留 takeover 作为 AppInterface children 挂载(AlphaBoundary 包裹,router root 单例)", () => {
    for (const name of ["ComposerTakeover", "TimelineInject"]) {
      expect(rendererIndex).toContain(`<AlphaBoundary name="${name}">`)
    }
  })

  test("takeover 模块不 import @opencode-ai/app(不消费任何 upstream context/组件,只碰 document)", () => {
    for (const [name, src] of Object.entries(takeovers)) {
      // 含窄导出 ./surface/session 在内 —— takeover 与叶模块之间必须没有 import 边。
      expect({ name, coupled: src.includes(`"@opencode-ai/app`) }).toEqual({ name, coupled: false })
    }
  })

  test("遗留 takeover 观察面 = document.body MutationObserver,每件恰一个(AC8 observer 预算 = 2)", () => {
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

describe("REQ-090 model picker ratchet:旧 DOM 接管退役，canonical owner 唯一", () => {
  test("旧 inject/reskin 文件不存在且 renderer root 不再挂载或导入", () => {
    expect(fs.existsSync(path.join(ALPHA_UI, "model-picker-inject.tsx"))).toBe(false)
    expect(fs.existsSync(path.join(ALPHA_UI, "model-picker-reskin.css"))).toBe(false)
    expect(rendererIndex).not.toContain("ModelPickerInject")
    expect(rendererIndex).not.toContain("model-picker-reskin.css")
  })

  test("renderer 其它生产源码不再 import 或挂载 canonical picker(纯文本否定辅助门)", () => {
    const picker = path.join(ALPHA_UI, "alpha-composer-model.tsx")
    const composer = path.join(ALPHA_UI, "alpha-composer.tsx")
    const pickerHolders = [...walk(RENDERER)]
      .filter((file) => file !== picker)
      .filter((file) => read(file).includes("alpha-composer-model") || read(file).includes("ModelPickPop"))
      .map((file) => path.relative(RENDERER, file))
      .sort()

    expect(pickerHolders).toEqual(["alpha-ui/alpha-composer.tsx"])
    expect(read(composer)).toContain('import { ModelPickPop } from "./alpha-composer-model"')
  })

  test("可执行 manifest 对 model picker 只有一个 canonical Alpha owner，且 source 文件存在", () => {
    const entries = FRONTEND_SURFACE_MANIFEST.filter((surface) => surface.id === "overlay.model-picker")
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      owner: "alpha.composer-model",
      source: "packages/ui-mac/src/renderer/alpha-ui/alpha-composer-model.tsx",
      mount: { kind: "overlay", host: "alpha-composer-model" },
    })
    expect(fs.existsSync(path.join(REPO, entries[0]!.source))).toBe(true)
  })

  test("选择面只直调 typed v2 list/get/switch，不观察或点击上游隐藏控件", () => {
    expect(modelContract).toContain("client.v2.model")
    expect(modelContract).toContain("client.v2.session.get")
    expect(modelContract).toContain("client.v2.session.switchModel")
    for (const source of [composerModelPicker, modelContract]) {
      expect(source).not.toContain("MutationObserver")
      expect(source).not.toContain("el?.click()")
      expect(source).not.toContain('data-slot="list-item"')
    }
    expect(composerModelPicker).toContain("await props.onSelect(row.model)")
    expect(alphaComposer).toContain("modelContract.switch(sessionID, modelRefOf(model))")
  })

  test("model/variant 不再落 localStorage 形成第二真值，picker 打开后聚焦 canonical 搜索框", () => {
    expect(composerState).not.toContain("alpha.composer.model")
    expect(composerState).not.toContain("alpha.composer.effort")
    expect(composerState).not.toMatch(/localStorage\.(getItem|setItem|removeItem)/)
    expect(composerModelPicker).toContain("queueMicrotask(() => search?.focus())")
    expect(composerModelPicker).toContain("ref={search}")
  })

  test("session 每轮以 typed get 的 Model.Ref 覆盖 UI 投影，消除 localStorage/context 双真值", () => {
    expect(alphaComposer).toContain("const sessionID = props.sessionID?.()")
    expect(alphaComposer).toContain("void runModelChain(directory, sessionID)")
    expect(alphaComposer).toContain("invalidateComposerModelProjection(sessionID)")
    expect(alphaComposer).toContain("await readState(modelContract.current(sessionID))")
    expect(alphaComposer).toContain("failComposerModelProjection(sessionID)")
    expect(alphaComposer).toContain("resolveComposerModelProjection(")
    expect(alphaComposer).not.toContain("restoreSuspendedModel")
  })
})

describe("T6 ②c TimelineInject 锚点(REQ-012 manifest 命名空间外的补钉)", () => {
  test("slash 菜单锚点 data-slash-id 仍由上游渲染(slash-popover.tsx)", () => {
    expect(app("components/prompt-input/slash-popover.tsx")).toContain("data-slash-id={cmd.id}")
  })

  test("消息身份锚点 data-message-id / data-timeline-part-id 仍由上游渲染(cmd chip 持久化的 key)", () => {
    expect(app("pages/session/timeline/message-timeline.tsx")).toContain("data-message-id={input.row().userMessageID}")
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
