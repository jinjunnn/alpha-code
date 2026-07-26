// 审批单一呈现面 —— watcher × 生产 dock 同场**运行时**闸门(#619 R1 Blocker 复审)。
//
// takeover-adapter-coexistence.test.ts 的反向闸门是源码文本棘轮,可被「改名组件 + 新
// class/DOM 属性 + 方括号取值提交」的等义改写绕过(Codex R1 对抗审给出的具体绕过法)。
// 本文件按同一审计给出的最简判据补运行时行为闸:同场真实挂载生产 PermissionWatcher 与
// 生产 SessionComposerDock,注入同一请求,断言
//   ① 全局恰一个五栏 Dialog,归属 Permission surface,不在 dock 子树;
//   ② dock 只发生既定的 placeholder/权限 chip 增量(data-approval + 提示文案),结构
//      规范化后与注入前逐字节相等 —— 任何改名后的审批节点一出现即红;
//   ③ 决定只到达 Permission surface client —— dock/composer 的全部 SDK 出口是录音
//      proxy,方括号等义改写的调用同样被记录,除快照 list 外零 permission 流量。
//
// R2(Codex 复审)补:录音面原先只覆盖「被注入的 client」,dock 若**另建**一个真实
// `createOpencodeClient` 就能不新增 DOM、方括号提交,实测 POST .../permission/<id>/reply
// 真的发出而三条闸门全绿。现将 `@opencode-ai/sdk` 全部子路径 alias 到录音替身
// (single-surface-sdk-stub),新建 client 因此同样入账;该形态本身钉成第二条回归用例。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import type { PermissionV2Request } from "@opencode-ai/sdk/v2/client"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import { dict as zh } from "../../i18n/zh"
import type * as RuntimeModule from "./single-surface-test-runtime"

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-permission-single-surface-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  resolve: {
    alias: [
      { find: "@opencode-ai/app", replacement: join(import.meta.dir, "single-surface-app-stub.ts") },
      // 正则(而非字符串前缀)才能把 `@opencode-ai/sdk` 的**全部子路径** —— /v2/client、
      // /v2、/client、/v2/gen/client… —— 整条映到同一个替身(字符串 alias 只做前缀替换,
      // 会留下 `<stub>.ts/v2/client` 这种残尾)。于是 bundle 里**新建**的 client 也落进
      // 同一录音 proxy,「另建真实 client 偷偷提交」因此进闸③射程(#619 R2 Blocker)。
      {
        find: /^@opencode-ai\/sdk(?:\/.*)?$/,
        replacement: join(import.meta.dir, "single-surface-sdk-stub.ts"),
      },
      { find: "@solidjs/router", replacement: join(import.meta.dir, "single-surface-router-stub.ts") },
    ],
  },
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "single-surface-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "single-surface-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "single-surface-test-runtime.js")).href
)) as typeof RuntimeModule

// 生产 composer 链路挂载所需的最小 preload 桥:auth/models/keys 一律给「永不 settle」的
// 读 —— 模型链停留在 loading(两次 DOM 快照之间零无关翻转),且不产生未处理拒绝;审批
// 链路不依赖这些通道。经 defineProperty(configurable) 注入(裸赋值在 window.api 已被前序
// 文件定义为只读时会抛,抛在模块顶层会中断 afterAll 注册并把 happy-dom 注册泄漏给后续
// 文件 —— 那正是本文件曾污染 artifact-workbench zip 测试的根因)。
const neverSettle = () => new Promise<never>(() => {})

const request: PermissionV2Request = {
  id: "per_single_surface_1",
  sessionID: runtime.HARNESS_IDENTITY.sessionID,
  fingerprint: "a".repeat(64),
  subject: { kind: "agent", id: "build-reviewer" },
  action: "bash",
  resources: ["pwd", "src/**"],
  scope: { kind: "session", sessionID: runtime.HARNESS_IDENTITY.sessionID },
  expiresAt: 1_893_456_000_000,
  save: ["src/**"],
}

beforeEach(() => {
  runtime.resetSingleSurfaceHarness()
  document.body.replaceChildren()
  Object.defineProperty(window, "api", {
    configurable: true,
    writable: true,
    value: {
      models: { catalog: neverSettle },
      providers: { keyStatus: neverSettle },
      auth: { getState: neverSettle, subscribe: () => () => {} },
    },
  })
})

afterEach(async () => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  await flush()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mountHarness() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(runtime.render(() => runtime.SingleSurfaceHarness(), host))
}

/** dock 子树的规范序列化。除「审批挂起提示」的既定增量 —— composer 根的 data-approval
 *  与输入框(.a-comp-input)的 placeholder / aria-label 文案 —— 之外,任何节点增删、属性
 *  变化、文本变化都会改变序列化结果。等义改写(改名组件、新 class、新 data-* 属性)造出
 *  的第二审批面必然新增节点/属性,规范化后与基线不再相等。 */
function canonicalizeDock(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return `#${node.textContent}`
  if (node.nodeType !== Node.ELEMENT_NODE) return ""
  const element = node as Element
  const sanctionedTextAttrs = element.classList.contains("a-comp-input") ? ["placeholder", "aria-label"] : []
  const attributes = Array.from(element.attributes)
    .filter((attribute) => attribute.name !== "data-approval" && !sanctionedTextAttrs.includes(attribute.name))
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .sort()
  const children = Array.from(element.childNodes)
    .map(canonicalizeDock)
    .filter((serialized) => serialized !== "")
  return `<${element.tagName}|${attributes.join("|")}>[${children.join(",")}]`
}

/** 闸③的判据本体:dock/composer 侧录音面上的审批类流量。录音面覆盖注入的 client
 *  **与 bundle 内新建的 client**(@opencode-ai/sdk 全前缀 alias),属性访问链无拼写豁免,
 *  方括号等义改写同样入账。合法值只有快照 list 一条。 */
function dockPermissionTraffic(): Set<string> {
  return new Set(
    runtime.dockClientCalls
      .map((call) => call.path)
      .filter((path) => path.toLowerCase().includes("permission") || path.toLowerCase().includes("reply")),
  )
}

const FACTS = ["subject", "action", "resources", "scope", "expiry"] as const

describe("审批单一呈现面:watcher × 生产 dock 同场运行时闸门", () => {
  test("同一请求到达两个消费面:恰一个五栏 Dialog;dock 仅既定提示增量、零新增审批节点;决定只到达 surface client", async () => {
    mountHarness()
    await flush()
    await flush()

    const dockHost = document.body.querySelector("[data-harness-dock]")!
    // 前置:dock 挂的是生产 composer 本体(非桩),且此刻全局零 dialog、feed 已就绪。
    const composerRoot = dockHost.querySelector('[data-alpha-composer="session"]')!
    expect(composerRoot).not.toBeNull()
    const composerInput = dockHost.querySelector<HTMLTextAreaElement>("textarea.a-comp-input")!
    expect(composerInput).not.toBeNull()
    expect(document.querySelector("[role='dialog']")).toBeNull()
    expect(composerRoot.hasAttribute("data-approval")).toBeFalse()

    const bodyChildrenBefore = new Set(Array.from(document.body.children))
    const dockCanonicalBefore = canonicalizeDock(dockHost)

    runtime.injectPermissionAsked(request)
    await flush()

    // ① 全局恰一个五栏 Dialog,归属 Permission surface(portal 到 body),不在 dock 子树。
    const dialogs = document.querySelectorAll("[role='dialog']")
    expect(dialogs).toHaveLength(1)
    for (const fact of FACTS) {
      expect(document.querySelectorAll(`[data-permission-fact="${fact}"]`)).toHaveLength(1)
    }
    expect(document.querySelectorAll("[data-permission-decision]")).toHaveLength(3)
    expect(dockHost.contains(dialogs[0]!)).toBeFalse()
    const addedBodyChildren = Array.from(document.body.children).filter((child) => !bodyChildrenBefore.has(child))
    expect(addedBodyChildren).toHaveLength(1)
    expect(addedBodyChildren[0]!.contains(dialogs[0]!)).toBeTrue()

    // ② dock 只发生既定的 placeholder / 权限 chip 增量;结构规范化后与注入前逐字节相等
    //    = 零新增审批节点(改名/新属性的等义改写在此必红)。
    expect(composerRoot.hasAttribute("data-approval")).toBeTrue()
    expect(composerInput.getAttribute("placeholder")).toBe(zh["alpha.composer.placeholderDecision"])
    expect(composerInput.getAttribute("aria-label")).toBe(zh["alpha.composer.placeholderDecision"])
    expect(canonicalizeDock(dockHost)).toBe(dockCanonicalBefore)

    // ③ 决定只到达 Permission surface client。dock/composer 的全部 SDK 出口都是录音
    //    proxy(方括号取值同样被记录):整个场景中除快照 list 外零 permission/reply 流量。
    document.querySelector<HTMLButtonElement>('[data-permission-decision="once"]')!.click()
    await flush()
    expect(runtime.surfaceReplyCalls.map((call) => call.requestID)).toEqual([request.id])
    expect(runtime.surfaceReplyCalls[0]!.command.decision).toBe("once")
    expect(dockPermissionTraffic()).toEqual(new Set(["v2.session.permission.list"]))

    // 收尾相位:收据按生产 SSE 扇出双投递 → dialog 关闭、dock 提示回落、结构回到基线。
    runtime.injectPermissionReplied(runtime.surfaceReceipts[0]!)
    await flush()
    expect(document.querySelector("[role='dialog']")).toBeNull()
    expect(composerRoot.hasAttribute("data-approval")).toBeFalse()
    expect(composerInput.getAttribute("placeholder")).not.toBe(zh["alpha.composer.placeholderDecision"])
    expect(canonicalizeDock(dockHost)).toBe(dockCanonicalBefore)
  })

  // Codex R2 实测打穿上一版三条闸门的等义改写:**不新增 DOM**、在 dock 链路里**另建一个
  // 真实 SDK client**、方括号取值提交 —— 当时 `POST /api/session/<id>/permission/<id>/reply`
  // 真的发出而闸①②③全绿(录音面只覆盖被注入的 client)。本例把该形态本身钉成回归:
  // 新建 client 必须同样落进录音面,亦即闸③会红。alias 一撤,这里立刻红。
  test("等义改写回归:不新增 DOM、另建真实 SDK client、方括号提交 —— 同样落进录音面,闸③照样红", async () => {
    mountHarness()
    await flush()
    await flush()

    const dockHost = document.body.querySelector("[data-harness-dock]")!
    runtime.injectPermissionAsked(request)
    await flush()
    const dockCanonicalBefore = canonicalizeDock(dockHost)
    // 前置:此刻闸③仍绿 —— 只有快照 list 一条合法流量。
    expect(dockPermissionTraffic()).toEqual(new Set(["v2.session.permission.list"]))

    runtime.submitDecisionViaFreshClient(request.id, request.fingerprint)
    await flush()

    // 这条绕过对闸①②完全隐形:零新增 DOM、Permission surface client 零提交。
    expect(canonicalizeDock(dockHost)).toBe(dockCanonicalBefore)
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(1)
    expect(runtime.surfaceReplyCalls).toHaveLength(0)

    // 唯一抓住它的是闸③:新建 client 的提交进了录音面,合法集合被打破。
    expect(dockPermissionTraffic()).toEqual(
      new Set(["v2.session.permission.list", "v2.session.permission.reply"]),
    )
    expect(dockPermissionTraffic()).not.toEqual(new Set(["v2.session.permission.list"]))
  })
})
