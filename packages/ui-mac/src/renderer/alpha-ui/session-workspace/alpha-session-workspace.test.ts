import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  canEditUserMessageForSession,
  createSessionEditUserMessageHandler,
  discardStaleEditRequest,
} from "./session-edit-user-message"
import { identityKey, type AlphaSessionLiveSnapshot } from "./session-workspace-core"

const tsx = readFileSync(join(import.meta.dir, "alpha-session-workspace.tsx"), "utf8")
const shell = readFileSync(join(import.meta.dir, "session-workspace-shell.tsx"), "utf8")
const dock = readFileSync(join(import.meta.dir, "session-composer-dock.tsx"), "utf8")
const composerMount = readFileSync(join(import.meta.dir, "session-composer-mount.tsx"), "utf8")
const dockCore = readFileSync(join(import.meta.dir, "session-dock-core.ts"), "utf8")
const permissionFeed = readFileSync(join(import.meta.dir, "session-permission-feed.ts"), "utf8")
const css = readFileSync(join(import.meta.dir, "session-workspace.css"), "utf8")
const rendererIndex = readFileSync(join(import.meta.dir, "../../index.tsx"), "utf8")
const sidebar = readFileSync(join(import.meta.dir, "../../sidebar/alpha-sidebar.tsx"), "utf8")
const upstreamApp = readFileSync(join(import.meta.dir, "../../../../../app/src/app.tsx"), "utf8")
const upstreamSession = readFileSync(join(import.meta.dir, "../../../../../app/src/pages/session.tsx"), "utf8")

describe("REQ-125 C1b seam skeleton mount", () => {
  test("real Solid mount covers the skeleton, host toggles, and both status states", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        resolve(import.meta.dir, "../../../../test-component/session-workspace.cases.ts"),
      ],
      cwd: resolve(import.meta.dir, "../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // 判据只有「子进程绿」:钉总数会在别人合法新增一条用例时误红,而 `toContain("0 fail")`
    // 反过来能被 "10 fail" 匹配上 —— 取回真实数字再比,并要求至少跑过一条。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, ran: pass > 0 }).toEqual({ fail: "0", ran: true })
  })
})

describe("REQ-125 #862 edit resend production behavior", () => {
  const identity = { serverKey: "sidecar", directory: "/tmp/workspace", sessionID: "ses_1" }
  const intent = { sessionID: "ses_1", messageID: "msg_1", text: "完整原文" }
  const snapshot: AlphaSessionLiveSnapshot = {
    identity,
    project: "workspace",
    title: "session",
    activity: "running",
  }

  test("unknown and child session metadata fail closed", () => {
    expect(canEditUserMessageForSession(identity, undefined)).toBe(false)
    expect(
      canEditUserMessageForSession(identity, {
        id: "ses_1",
        directory: "/tmp/workspace",
        title: "session",
        parentID: "parent",
      }),
    ).toBe(false)
    expect(canEditUserMessageForSession(identity, { id: "ses_1", directory: "/tmp/workspace", title: "session" })).toBe(
      true,
    )
  })

  test("same-session prefill survives while an identity switch discards it", () => {
    let request: Parameters<typeof discardStaleEditRequest>[0] = {
      identityKey: identityKey(identity),
      revision: 1,
      text: intent.text,
    }
    const discard = () => (request = undefined)

    discardStaleEditRequest(request, identity, discard)
    expect(request).toBeDefined()
    discardStaleEditRequest(request, { ...identity, sessionID: "ses_2" }, discard)
    expect(request).toBeUndefined()
  })

  test("engine error blocks prefill, preserves the reason, and reports failure", async () => {
    const calls: string[] = []
    const applied: unknown[] = []
    const rejected: unknown[] = []
    const engineError = { code: "revert-rejected" }
    const handler = createSessionEditUserMessageHandler({
      current: () => snapshot,
      accepts: () => true,
      canEdit: () => true,
      session: () => ({
        abort: async () => void calls.push("abort"),
        revert: async () => (calls.push("revert"), { error: engineError }),
      }),
      apply: (request) => applied.push(request),
      reject: (error) => rejected.push(error),
    })

    await handler(intent)
    expect(calls).toEqual(["abort", "revert"])
    expect(applied).toEqual([])
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as Error & { cause?: unknown }).cause).toBe(engineError)
  })

  test("in-flight duplicate reuses one revert and an identity switch never prefills", async () => {
    let resolveRevert!: (value: unknown) => void
    const reverted = new Promise<unknown>((resolve) => (resolveRevert = resolve))
    let accepted = true
    let revertCalls = 0
    const applied: unknown[] = []
    const handler = createSessionEditUserMessageHandler({
      current: () => ({ ...snapshot, activity: "idle" }),
      accepts: () => accepted,
      canEdit: () => true,
      session: () => ({
        abort: async () => {},
        revert: async () => (revertCalls++, reverted),
      }),
      apply: (request) => applied.push(request),
      reject: () => {},
    })

    const first = handler(intent)
    const duplicate = handler(intent)
    await Promise.resolve()
    expect(revertCalls).toBe(1)
    accepted = false
    resolveRevert({ data: true })
    await Promise.all([first, duplicate])
    expect(applied).toEqual([])
  })
})

describe("REQ-125 C1b I1 and Recovery static ratchets", () => {
  test("does not import or query upstream session DOM and no longer embeds SessionPage", () => {
    const forbidden = [
      "@opencode-ai/app/surface/session",
      "app/src/pages/session",
      "MessageTimeline",
      "MessagePart",
      "basic-tool",
      "tool-error-card",
      "querySelector",
      "MutationObserver",
      "UpstreamSessionLeaf",
      "SessionPage",
    ]
    forbidden.forEach((token) =>
      expect(`${tsx}\n${shell}\n${dock}\n${composerMount}\n${dockCore}\n${permissionFeed}`).not.toContain(token),
    )
    expect(tsx).not.toContain("preloadSessionLeaf")
    expect(sidebar).not.toContain("preloadSessionLeaf")
    expect(tsx).toContain("useServerSDK")
    expect(tsx).toContain("useServerSync")
    expect(tsx).toContain("<SessionLiveProvider")
  })

  test("uses one alpha 46px topbar and only --a-* CSS variables", () => {
    expect(shell.match(/<header\b/g)).toHaveLength(1)
    expect(css.match(/\.a-swk-topbar \{[^}]*\}/)?.[0]).toContain("height: 46px")
    expect(
      [...css.matchAll(/var\((--[^,)]+)/g)].map((match) => match[1]).filter((token) => !token.startsWith("--a-")),
    ).toEqual([])
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i)
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  })

  test("child-session state is mutually exclusive with a sendable composer (zero promptAsync path when child)", () => {
    // SessionComposerMount hosts the only send surface (AlphaComposer). It must mount exactly
    // once, and only as the fallback of the childSession() gate — so a child session renders
    // just the child card, with no composer host and hence no reachable prompt/send/promptAsync
    // path. The composer itself lives only inside the mount wrapper, never directly in the dock.
    expect(dock.match(/<SessionComposerMount\b/g)).toHaveLength(1)
    expect(dock).not.toContain("<AlphaComposer")
    expect(dock).toMatch(
      /when=\{childSession\(\)\}[\s\S]*?fallback=\{[\s\S]*?<SessionComposerMount\b[\s\S]*?SessionChildCard/,
    )
    expect(composerMount.match(/<AlphaComposer\b/g)).toHaveLength(1)
  })

  test("composer instance is keyed by identity; the per-identity stash captures/restores on remount (I8-bound)", () => {
    // The gate unmounts the composer when a session turns out to be a child (info late). A
    // per-identity draft stash captures the draft on that unmount and re-injects it on remount,
    // so unmount is not unrecoverable loss.
    expect(dock).toContain("createComposerDraftStash")
    expect(dock).toMatch(/<SessionComposerMount\b[\s\S]*?drafts=\{draftStash\}/)
    // Root fix (round 4): the composer instance is KEYED by identity — a same-workspace session
    // switch tears down the old instance (its cleanup captures under its own keyed key) and
    // mounts a fresh one for the new identity. Key and instance lifecycle are one, so there is no
    // "frozen key vs reactive directory" split: continued edits after a switch land in the new key.
    expect(composerMount).toContain("const key = identityKey(props.identity())")
    expect(composerMount).toContain("when={mount()}")
    expect(composerMount).toContain("keyed")
    // restore/capture use the memoized mounted identity key, never a cleanup-time re-read of identity().
    expect(composerMount).toContain("initialText: props.drafts.restore(key)")
    expect(composerMount).toContain("initialText={mounted.initialText}")
    expect(composerMount).toMatch(/onDraftCapture=\{[^}]*props\.drafts\.capture\(mounted\.key,\s*draft\)/)
    expect(composerMount).not.toMatch(/capture\(identityKey\(/)
    // Identity undefined ⇒ no composer, just a light placeholder (mounts once identity resolves;
    // avoids the empty-key drop).
    expect(composerMount).toContain("a-swk-composer-pending")
  })

  test("#862 编辑重发接入 fail-closed session info 闸与生产行为函数", () => {
    expect(tsx).toContain("canEditUserMessageForSession")
    expect(tsx).toContain("createSessionEditUserMessageHandler")
    expect(tsx).toContain("discardStaleEditRequest(editRequest(), current()?.identity")
    expect(tsx).toContain('pushToast({ kind: "error", title: t("alpha.timeline.editResendFailed") })')
    expect(dock).toContain("editRequest={props.editRequest}")
    expect(composerMount).toContain("edit?.identityKey === key")
    expect(composerMount).toContain("revision: edit.revision")
  })

  test("workspace owns the single session-page titlebar and its drag region (#574)", () => {
    // 静态标记:session surface 声明自带顶栏 → 上游 NewLayout(pin+patch 通道)在 session
    // 路由跳过窗口 Titlebar;标记缺席(legacy / 上游默认叶)= Titlebar 原样。
    expect(tsx).toContain("Surface.ownsTitlebar = true")
    expect(upstreamApp).toContain("props.surfaces?.session?.ownsTitlebar === true")
    // 顶栏即窗口拖拽区;交互件全部从拖拽区挖出。
    expect(css.match(/\.a-swk-topbar \{[^}]*\}/)?.[0]).toContain("app-region: drag")
    expect(css).toMatch(/\.a-swk-topbar :is\([^)]*button[^)]*\) \{[^}]*app-region: no-drag/)
    // REQ-126 AC7(#658):浮动终端/审查开关整块退休 —— 原来 #574 只是用 CSS 把它在会话页
    // **遮**掉(命令随上游 session 叶退役,新对话页那份照样可见且无效)。控件没了,遮它的规则
    // 也必须没有:留着一条指向已删控件的隐藏规则,下次有人复活控件时会以为它还被管着。
    // 顶栏本身的行为闸(真挂载 + 真点)在 shell-commands.test.ts。
    const sidebarCss = readFileSync(join(import.meta.dir, "../../sidebar/sidebar.css"), "utf8")
    expect(sidebarCss.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("alpha-topbar-right")
    expect(sidebarCss).toContain('body[data-alpha-sidebar="collapsed"] .a-swk-topbar')
  })

  test("keeps the single session composition and existing Alpha Recovery boundary", () => {
    expect(rendererIndex).toContain(`session: (projects: AlphaProjectsApi) => alphaSessionWorkspaceSurface(projects)`)
    expect(rendererIndex).toContain(`[productionRoutes.session.surface]: productionRoutes.session.mount(alphaProjects)`)
    expect(upstreamApp).toContain(`function createTargetSessionRoute(`)
    expect(upstreamApp).toContain(`<TargetSessionRouteContent content={Content} />`)
    expect(upstreamApp).toContain(`<Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />`)
    expect(upstreamSession).toContain(`<TargetSessionPage content={props.content} />`)
    expect(tsx).toContain(`<SurfaceBoundary surface="session">`)
    expect(tsx).not.toMatch(/fallback|legacy/i)
  })
})
