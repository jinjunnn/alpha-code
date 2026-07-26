// REQ-088 T6(#181)→ REQ-125 C7/C8:遗留 DOM 接管件全量退役 —— 删除后零引用棘轮。
//
// 两个遗留 takeover 均已删除:
//   - ComposerTakeover 随 REQ-125 C7 删除 —— 会话页 composer 由 seam 会话页
//     (session-workspace/session-composer-dock.tsx)直挂 AlphaComposer,零 Portal/零选择器/零收养;
//   - TimelineInject 随 REQ-125 C8 删除 —— alpha 时间线为 session surface 内自持 typed leaf
//     (session-timeline/*),旧的上游 DOM 注入与 timeline reskin CSS 一并退役。
// 本文件保留:两件接管件的「删除后零引用」棘轮、REQ-090 canonical picker ratchet、
// REQ-125 C1 I1(上游 session 叶消费者归零)。T6 共存审计矩阵的历史结论见
// docs/audits/2026-07-13-s48-req088-t6-takeover-coexistence.md;其上游锚点补钉(REQ-012 命名空间外)
// 已随注入件退役删除 —— 无耦合可锁。断言红 = 退役前提破坏(有人把接管路径带回来了),
// 回审计矩阵重评,不得只改测试。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { FRONTEND_SURFACE_MANIFEST } from "../../shared/frontend-surface-manifest"

const ALPHA_UI = import.meta.dir
const RENDERER = path.resolve(ALPHA_UI, "..")
const REPO = path.resolve(RENDERER, "..", "..", "..", "..")
const read = (p: string) => fs.readFileSync(p, "utf8")

const alphaComposer = read(path.join(ALPHA_UI, "alpha-composer.tsx"))
const composerModelPicker = read(path.join(ALPHA_UI, "alpha-composer-model.tsx"))
const modelContract = read(path.join(ALPHA_UI, "model-contract.ts"))
const composerState = read(path.join(ALPHA_UI, "composer-state.ts"))
const rendererIndex = read(path.join(RENDERER, "index.tsx"))

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

/** renderer 下全部非测试生产文本(ts/tsx/css/html/json)—— 退役零引用棘轮的扫描面。 */
function* walkText(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walkText(p)
    else if (/\.(ts|tsx|css|html|json)$/.test(entry.name)) yield p
  }
}

describe("REQ-125 C7:ComposerTakeover 删除后零引用(棘轮)", () => {
  test("composer-takeover.tsx 不存在,renderer 生产文本零引用(组件名/文件名/body flag/收养停靠位)", () => {
    expect(fs.existsSync(path.join(ALPHA_UI, "composer-takeover.tsx"))).toBe(false)
    const forbidden = ["ComposerTakeover", "composer-takeover", "data-alpha-composer-takeover", "data-alpha-usage-host"]
    const offenders: Array<{ file: string; token: string }> = []
    for (const file of walkText(RENDERER)) {
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

  test("审批统一走独立 Permission surface(owner 裁决 2026-07-25):dock 审批呈现面删除后零引用(反向闸门)", () => {
    // 若有人重新引入 dock 审批卡 / claim 抢占机制,本断言必须变红 —— 审批呈现的唯一
    // 路径是 PermissionWatcher 的 PermissionDialog(REQ-090 合同面)。
    expect(fs.existsSync(path.join(ALPHA_UI, "session-workspace", "session-approval-card.tsx"))).toBe(false)
    expect(fs.existsSync(path.join(ALPHA_UI, "session-workspace", "session-approval-claim.ts"))).toBe(false)
    const forbidden = [
      "SessionApprovalCard",
      "SessionApprovalHost",
      "session-approval-card",
      "session-approval-claim",
      "claimSessionApprovalDock",
      "bindSessionApprovalClaim",
      "sessionApprovalDockClaimed",
      "data-alpha-session-approval",
      "a-swk-approval",
    ]
    const offenders: Array<{ file: string; token: string }> = []
    for (const file of walkText(RENDERER)) {
      const src = read(file)
      for (const token of forbidden) {
        if (src.includes(token)) offenders.push({ file: path.relative(RENDERER, file), token })
      }
    }
    expect(offenders).toEqual([])
    // 唯一路径本身在场且保持 Blocker-2 的 fail-closed 闸:呈现严格以 ready 为闸,
    // 且不存在任何让位条件(claim 判断消失后 Show 条件只剩 ready × 队首请求)。
    const watcher = read(path.join(ALPHA_UI, "permission-watcher.tsx"))
    expect(watcher).toContain("createPermissionV2Feed(")
    expect(watcher).toContain("feed.state.ready && feed.state.requests[0]")
    expect(watcher).toContain("<PermissionDialog")
    // dock 侧无决定提交路径:feed 的 reply 是拒绝桩,不携带任何放行网络调用。
    const dock = read(path.join(ALPHA_UI, "session-workspace", "session-composer-dock.tsx"))
    expect(dock).toContain("approval decisions are submitted only via the permission surface")
    expect(dock).not.toContain("session.permission.reply")
  })

  test("档位决策源棘轮:权威实时读 + 有界 GET(审计 R4/R5)", () => {
    // Major(R4:决策源):档位决策(needsSwitch/CAS/漂移)一律权威实时读(typed GET),
    // serverSync 缓存(不消费 v2 切档事件,永不更新)禁作决策源。
    const composerSrc = read(path.join(ALPHA_UI, "alpha-composer.tsx"))
    expect(composerSrc).toContain("async function readSessionAgent(")
    // R5:权威读必须有界(signal 交给 SDK + 本地竞速),无界 GET 悬挂会把 sending 永锁。
    expect(composerSrc).toContain("client.v2.session.get({ sessionID }, { signal })")
    expect(composerSrc).toContain("AbortSignal.timeout(timeoutMs)")
    expect(composerSrc).not.toContain("sessionAgent()")
    const dock = read(path.join(ALPHA_UI, "session-workspace", "session-composer-dock.tsx"))
    expect(dock).not.toContain("observeSessionAgent")
    expect(dock).not.toContain("sessionAgent")
  })

  test("审计修复轮棘轮:停止键走已批稿 accent 令牌;发送走 v2 durable 队列", () => {
    // (原「always 项目身份取会话精确 projectID」棘轮随 dock 审批卡删除而失去主体:
    // dock 已无任何放行动作;独立 Permission surface 的 always 项目身份由
    // PermissionDialog 自身的 fail-closed 用例锁定。)
    const dock = read(path.join(ALPHA_UI, "session-workspace", "session-composer-dock.tsx"))
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
    // REQ-125 C558:AlphaComposer 经 SessionComposerMount(挂载定格身份键)直挂,仍是 props 传入、
    // 零 Portal/零选择器/零收养 —— mode/sessionDock 契约随之移入 mount wrapper。
    expect(dock).toContain("<SessionComposerMount")
    const composerMount = read(path.join(dir, "session-composer-mount.tsx"))
    expect(composerMount).toContain('mode="session"')
    expect(composerMount).toContain("sessionDock={props.dock}")
  })
})

describe("REQ-125 C8:TimelineInject 删除后零引用(棘轮)", () => {
  test("timeline-inject/timeline-reskin/timeline 目录不存在,renderer root 零挂载零导入", () => {
    expect(fs.existsSync(path.join(ALPHA_UI, "timeline-inject.tsx"))).toBe(false)
    expect(fs.existsSync(path.join(ALPHA_UI, "timeline-reskin.css"))).toBe(false)
    expect(fs.existsSync(path.join(ALPHA_UI, "timeline"))).toBe(false)
    expect(rendererIndex).not.toContain("TimelineInject")
    expect(rendererIndex).not.toContain("timeline-reskin.css")
  })

  test("renderer 生产文本零引用(组件名/文件名/reskin 入口)", () => {
    const forbidden = ["TimelineInject", "timeline-inject", "timeline-reskin"]
    const offenders: Array<{ file: string; token: string }> = []
    for (const file of walkText(RENDERER)) {
      const src = read(file)
      for (const token of forbidden) {
        if (src.includes(token)) offenders.push({ file: path.relative(RENDERER, file), token })
      }
    }
    expect(offenders).toEqual([])
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
    expect(alphaComposer).toContain("const currentPromise = sessionID ? readState(modelContract.current(sessionID))")
    expect(alphaComposer).toContain("currentPromise ? await currentPromise")
    expect(alphaComposer).toContain("failComposerModelProjection(sessionID)")
    expect(alphaComposer).toContain("resolveComposerModelProjection(")
    expect(alphaComposer).not.toContain("restoreSuspendedModel")
  })
})

// T6 ②a/②c 上游锚点补钉(REQ-012 命名空间外)已随两件接管件退役删除 —— 注入路径死亡后无耦合可锁。
