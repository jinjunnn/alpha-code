// REQ-088 T6(#181)→ REQ-125 C7:takeover × adapter 共存审计 —— 可静态钉住的锚点。
//
// 审计对象(C7 后):TimelineInject(最后一个遗留 DOM 接管件,C8 清理)与 canonical
// composer picker。ComposerTakeover 已随 REQ-125 C7 删除 —— 会话页 composer 由 seam 会话页
// (session-workspace/session-composer-dock.tsx)直挂 AlphaComposer,零 Portal/零选择器/
// 零收养;本文件对其只保留「删除后零引用」的棘轮断言。
// 结构不变量(详见 docs/audits/2026-07-13-s48-req088-t6-takeover-coexistence.md 审计矩阵):
//   ① 挂载通道:遗留 takeover 作为 AppInterface children 在 router root 挂载一次,不在任何
//      surface 工厂/session 叶内 —— adapter 换叶不触碰它们的生命周期;
//   ② 遗留观察面:经 document.body MutationObserver 工作,
//      只依赖上游叶渲染的 DOM 锚点,不依赖叶「怎么被挂进来」;
//   ③ REQ-125 C1 后 alpha session surface 不再消费上游 session 叶;遗留 TimelineInject
//      仅保留到 C8 清理,且在 v2 alpha seam 下应零命中。
// packages/app|ui 锚点仍以源码契约断言;REQ-090 picker owner 的唯一挂载由组件测试真实渲染
// AlphaComposer 后查询 data marker,本文件只保留旧模块不存在与 renderer 其它文件零引用的
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
const sessionUi = (p: string) => read(path.join(REPO, "packages/session-ui/src", p))

const timelineInject = read(path.join(ALPHA_UI, "timeline-inject.tsx"))
const alphaComposer = read(path.join(ALPHA_UI, "alpha-composer.tsx"))
const composerModelPicker = read(path.join(ALPHA_UI, "alpha-composer-model.tsx"))
const modelContract = read(path.join(ALPHA_UI, "model-contract.ts"))
const composerState = read(path.join(ALPHA_UI, "composer-state.ts"))
const rendererIndex = read(path.join(RENDERER, "index.tsx"))
const takeovers: Record<string, string> = {
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
  test("最后一个遗留 takeover 作为 AppInterface children 挂载(AlphaBoundary 包裹,router root 单例)", () => {
    expect(rendererIndex).toContain(`<AlphaBoundary name="TimelineInject">`)
  })

  test("takeover 模块不 import @opencode-ai/app(不消费任何 upstream context/组件,只碰 document)", () => {
    for (const [name, src] of Object.entries(takeovers)) {
      // 含窄导出 ./surface/session 在内 —— takeover 与叶模块之间必须没有 import 边。
      expect({ name, coupled: src.includes(`"@opencode-ai/app`) }).toEqual({ name, coupled: false })
    }
  })

  test("遗留 takeover 观察面 = document.body MutationObserver,每件恰一个(C7 后 observer 预算 = 1)", () => {
    for (const [name, src] of Object.entries(takeovers)) {
      const observers = src.match(/new MutationObserver\(/g) ?? []
      expect({ name, observers: observers.length }).toEqual({ name, observers: 1 })
      expect(src).toContain("mo.observe(document.body, { childList: true, subtree: true })")
      expect(src).toContain("mo?.disconnect()")
    }
  })

  test("TimelineInject 不再挂发送捕获监听(#251:用户真实输入在 AlphaComposer,DOM 捕获路径已死)", () => {
    expect(timelineInject).not.toContain(`document.addEventListener("keydown"`)
    expect(timelineInject).not.toContain(`document.addEventListener("click"`)
    expect(timelineInject).not.toContain("function captureSend")
  })
})

describe("REQ-125 C7:ComposerTakeover 删除后零引用(棘轮)", () => {
  test("composer-takeover.tsx 不存在,renderer 生产源码零引用(组件名/文件名/body flag/收养停靠位)", () => {
    expect(fs.existsSync(path.join(ALPHA_UI, "composer-takeover.tsx"))).toBe(false)
    const forbidden = ["ComposerTakeover", "composer-takeover", "data-alpha-composer-takeover", "data-alpha-usage-host"]
    const offenders: Array<{ file: string; token: string }> = []
    for (const file of walk(RENDERER)) {
      const src = read(file)
      for (const token of forbidden) {
        if (src.includes(token)) offenders.push({ file: path.relative(RENDERER, file), token })
      }
    }
    expect(offenders).toEqual([])
  })

  test("takeover 的 CSS 面一并终结:不再隐藏上游 composer,不再保留收养容器规则", () => {
    const css = read(path.join(ALPHA_UI, "alpha-composer.css"))
    expect(css).not.toContain("data-alpha-composer-takeover")
    expect(css).not.toContain("data-alpha-composer-host")
    expect(css).not.toContain("data-alpha-usage-host")
  })

  test("审批呈现权协调走进程内 claim(零 DOM):dock 仅在 feed 就绪时接管,watcher 让位并保持兜底", () => {
    const watcher = read(path.join(ALPHA_UI, "permission-watcher.tsx"))
    expect(watcher).toContain("sessionApprovalDockClaimed(props.sessionID)")
    // Blocker-2:兜底面与 dock 同一 fail-closed feed;呈现严格以 ready 为闸。
    expect(watcher).toContain("createPermissionV2Feed(")
    expect(watcher).toContain("feed.state.ready &&")
    const dock = read(path.join(ALPHA_UI, "session-workspace", "session-composer-dock.tsx"))
    // Major:先立后破 —— claim 绑定在自身 feed 就绪上,而不是 list 前一次性夺权。
    expect(dock).toContain("bindSessionApprovalClaim({")
    expect(dock).toContain("ready: () => feed()?.state.ready ?? false")
    const claim = read(path.join(ALPHA_UI, "session-workspace", "session-approval-claim.ts"))
    expect(claim).not.toContain("document")
    expect(claim).not.toContain("querySelector")
  })

  test("审计修复轮棘轮:always 项目身份取会话精确 projectID;停止键走已批稿 accent 令牌", () => {
    const dock = read(path.join(ALPHA_UI, "session-workspace", "session-composer-dock.tsx"))
    // Major:与独立 Permission surface 同源的当前项目身份(SessionV2Info.projectID,
    // typed session info),不再用 worktree 目录猜测(sandbox 会话不可误禁 always)。
    expect(dock).toContain("serverSync().session.data.info[bound.sessionID]?.projectID")
    expect(dock).not.toContain("project.worktree ===")
    // minor:停止键配色 = 已批稿 --a-accent 系;禁 --a-danger 与裸色回退。
    const css = read(path.join(ALPHA_UI, "alpha-composer.css"))
    expect(css).not.toContain("--a-danger")
    expect(css).toMatch(
      /\.a-comp-stop\[data-ready\] \{\s*background: var\(--a-accent-subtle\);\s*color: var\(--a-accent\);\s*border: 1px solid var\(--a-accent-border\);/,
    )
    // Major:会话发送走 v2 durable 队列 delivery 契约;直连 promptAsync 调用全量退役(注释可提及)。
    const composer = read(path.join(ALPHA_UI, "alpha-composer.tsx"))
    expect(composer).not.toContain(".promptAsync(")
    expect(composer).toMatch(/c\.v2\.session\s*\.prompt\(\{/)
    expect(composer).toContain('delivery: "queue"')
  })

  test("会话 composer 由 seam 会话页直挂:session-workspace 源码零 Portal/零上游选择器/零收养", () => {
    const dir = path.join(ALPHA_UI, "session-workspace")
    for (const file of fs.readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name))) {
      const src = read(path.join(dir, file))
      for (const token of ["<Portal", "querySelector", "MutationObserver", "data-component="]) {
        expect({ file, token, hit: src.includes(token) }).toEqual({ file, token, hit: false })
      }
    }
    const workspace = read(path.join(dir, "alpha-session-workspace.tsx"))
    expect(workspace).toContain("<SessionComposerDock live={live} projects={props.projects} />")
    const dock = read(path.join(dir, "session-composer-dock.tsx"))
    expect(dock).toContain('mode="session"')
    expect(dock).toContain("sessionDock={dockApi}")
  })
})

describe("REQ-125 C1 I1:上游 session 叶消费者归零", () => {
  test("renderer 不再 import @opencode-ai/app/surface/session", () => {
    const importers: string[] = []
    for (const f of walk(RENDERER)) {
      const src = read(f)
      if (src.includes("@opencode-ai/app/surface/session")) importers.push(f)
    }
    expect(importers.map((file) => path.relative(RENDERER, file))).toEqual([])
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
    const messagePart = sessionUi("components/message-part.tsx")
    expect(messagePart).toContain(`data-component="user-message" data-timeline-part-id={textPart()?.id}`)
  })

  test("审查面板通路:id=review-panel + header 的 aria-controls 开关仍存在(「在面板打开」pill 的通路)", () => {
    expect(app("pages/session/session-side-panel.tsx")).toContain(`id="review-panel"`)
    expect(app("components/session/session-header.tsx")).toContain(`aria-controls="review-panel"`)
  })

  test("错误卡去重锚点 data-kind=tool-error-card 仍由上游渲染", () => {
    expect(sessionUi("components/tool-error-card.tsx")).toContain(`data-kind="tool-error-card"`)
  })

  // 目录网格 <entries> 格式锁已随 #252 摘除(decorateDirOutput 死路径已删,无耦合可锁)。
})
