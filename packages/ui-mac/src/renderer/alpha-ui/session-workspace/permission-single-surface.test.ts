// 审批单一呈现面 —— watcher × 生产 dock 同场**运行时**闸门(#619 R1 Blocker 复审)。
//
// takeover-adapter-coexistence.test.ts 的反向闸门是源码文本棘轮,可被「改名组件 + 新
// class/DOM 属性 + 方括号取值提交」的等义改写绕过(Codex R1 对抗审给出的具体绕过法)。
// 本文件按同一审计给出的最简判据补运行时行为闸:同场真实挂载生产 PermissionWatcher 与
// 生产 SessionComposerDock,注入同一请求,断言
//   ① 全局恰一个五栏 Dialog,归属 Permission surface,不在 dock 子树;
//   ①′ **全局呈现面判据**:注入前后,整个 document 的规范形差异恰好是 Permission surface
//      的 portal 子树;且该子树逐字节等于「surface 单独渲染」的参考规范形。Portal 到任意
//      已存在节点、Portal 进 overlay 内部搭车、改写既有节点、新建 style/title、attachShadow
//      (原型层入账,含 closed)—— 一律红;
//   ② dock 只发生既定的 placeholder/权限 chip 增量(data-approval + 提示文案),结构
//      规范化后与注入前逐字节相等 —— 任何改名后的审批节点一出现即红;
//   ③ 决定只到达 Permission surface client —— dock/composer 的全部 SDK 出口是录音
//      proxy,方括号等义改写的调用同样被记录,除快照 list 外零 permission 流量。
//
// R2(Codex 复审)补:录音面原先只覆盖「被注入的 client」,dock 若**另建**一个真实
// `createOpencodeClient` 就能不新增 DOM、方括号提交,实测 POST .../permission/<id>/reply
// 真的发出而三条闸门全绿。现将 `@opencode-ai/sdk` 全部子路径 alias 到录音替身
// (single-surface-sdk-stub),新建 client 因此同样入账;该形态本身钉成第二条回归用例。
//
// R3(自查登记,owner 2026-07-26 裁决今晚堵):旧闸① 只数 dialog + body **直接**子节点增量,
// 闸② 只看 dock 子树 —— dock 里 `<Portal mount={任意已存在非 dock 节点}>` 渲一个只读
// 审批卡(无 role=dialog、无 data-permission-*)实测三闸全绿。①′ 把判据升成上述整体快照:
// 差异集合 = 恰好 Permission surface,不再枚举「什么算审批节点」。
//
// R3 收尾(Codex R3 实测四种残余退化,owner 2026-07-26 裁决按最小闭合堵,不重写架构):
// 快照从「属性 + 文本」升为「属性 + 文本 + 呈现相关 IDL/CSSOM 状态」—— textarea/input 的
// .value/.checked、style/link 的 CSSOM 规则文本入账;aria-hidden/inert 只在 body 直接子节点
// (dialog 分层的合法写入面)豁免;id 系属性从整类丢弃改为按出现序稳定化;收尾相位补查
// adoptedStyleSheets(活跃期检查对「收据后才收养」不设防)。
// 「不存在第二提交通道」这类命题**运行时测试原理上证明不了**(只证明已执行路径;Alt+Y
// 键盘处理器、window.confirm 门控分支不被派发就永不执行,Codex R3 两条实测绕过全绿)——
// 该面不归本文件管,由 permission-mount-ratchet.test.ts 的「决定提交入口白名单棘轮」按
// **源码可达性**互补覆盖,分工声明见彼处注释。

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

// 呈现面不可迁出 light DOM:闸①′ 的规范形只走 childNodes,shadow root(尤其 closed)对它
// 不可见 —— 所以在原型层记录**一切** attachShadow 调用,场景内断言为零。open/closed 一律入账。
const shadowRootHosts: Element[] = []
const originalAttachShadow = Element.prototype.attachShadow
Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
  shadowRootHosts.push(this)
  return originalAttachShadow.call(this, init)
}

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
  shadowRootHosts.splice(0)
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
  Element.prototype.attachShadow = originalAttachShadow
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

/** 呈现相关的 **IDL/CSSOM 状态** —— 不反射为 DOM 属性,纯属性快照抓不到(#619 R3
 *  Blocker-1 实测退化):textarea/input 的 `.value`/`.checked` 是用户真实可见的脏值;
 *  style/link 的 CSSOM 规则文本可经 `insertRule` 在 `textContent` 不变时改写呈现。 */
function idlState(element: Element): string {
  if (element.tagName === "TEXTAREA") return `|~value=${(element as HTMLTextAreaElement).value}`
  if (element.tagName === "INPUT") {
    const input = element as HTMLInputElement
    return `|~value=${input.value}|~checked=${input.checked}`
  }
  if (element.tagName === "STYLE" || element.tagName === "LINK") {
    const sheet = (element as HTMLStyleElement | HTMLLinkElement).sheet
    if (!sheet) return ""
    return `|~css=${Array.from(sheet.cssRules)
      .map((rule) => rule.cssText)
      .join("␟")}`
  }
  return ""
}

/** 规范序列化核心:元素标签 + 全部属性(经 mapAttribute 过滤/归一)+ 呈现相关 IDL/CSSOM
 *  状态 + 递归子节点与文本。任何节点增删、属性变化、文本变化、IDL 值变化、CSSOM 规则
 *  变化都会改变序列化结果;`exclude` 子树整棵跳过。
 *  mapAttribute 返回 undefined = 丢弃该属性;返回字符串 = 以该值入账(可做稳定化归一)。 */
function canonicalizeNode(
  node: Node,
  mapAttribute: (element: Element, name: string, value: string) => string | undefined,
  exclude?: Node,
): string {
  if (exclude && node === exclude) return ""
  // 空文本节点是 Solid 动态插入的定位标记(Show 翻转后留在原位),零呈现,不入账;
  // 任何**非空**文本(含纯空白 —— 可影响排版)照常入账。
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ? `#${node.textContent}` : ""
  if (node.nodeType !== Node.ELEMENT_NODE) return ""
  const element = node as Element
  const attributes = Array.from(element.attributes)
    .map((attribute) => ({ name: attribute.name, value: mapAttribute(element, attribute.name, attribute.value) }))
    .filter((attribute): attribute is { name: string; value: string } => attribute.value !== undefined)
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .sort()
  const children = Array.from(element.childNodes)
    .map((child) => canonicalizeNode(child, mapAttribute, exclude))
    .filter((serialized) => serialized !== "")
  return `<${element.tagName}|${attributes.join("|")}${idlState(element)}>[${children.join(",")}]`
}

/** 「审批挂起提示」的既定增量 —— composer 根的 data-approval 与输入框(.a-comp-input)的
 *  placeholder / aria-label 文案。这是注入前后 dock(乃至全文档)唯一被豁免的属性差异。 */
const sanctionedDockDelta = (element: Element, name: string) =>
  name === "data-approval" ||
  (element.classList.contains("a-comp-input") && (name === "placeholder" || name === "aria-label"))

/** dock 子树的规范序列化(闸②)。等义改写(改名组件、新 class、新 data-* 属性)造出的
 *  第二审批面必然新增节点/属性,规范化后与基线不再相等。 */
function canonicalizeDock(node: Node): string {
  return canonicalizeNode(node, (element, name, value) => (sanctionedDockDelta(element, name) ? undefined : value))
}

/** 全文档呈现面规范形(闸①′)。属性处置(#619 R3 Blocker-1 最小闭合,owner 2026-07-26 裁决):
 *  - inert / aria-hidden:只在 **body 直接子节点** 上豁免 —— 那是 dialog 分层的合法写入面
 *    (打开期对兄弟子树只能隐藏);其余任何深度的节点上照常入账 —— 用 aria-hidden 触发
 *    既有 CSS 把节点从 display:none 翻成 block 的退化在此红。
 *  - id / aria-labelledby / aria-describedby:createUniqueId 铸造、跨两次渲染非确定,但
 *    **不再整类丢弃** —— 改为按出现序局部稳定化(首见的 id token 记为 @id1、@id2…,定义与
 *    引用共享同一映射):新增/删除 id、改动引用拓扑照样改变规范形,被抹平的只有「同一
 *    出现位」的随机铸值本身。
 *  style、class、文本与其余一切属性照常入账:把既有节点改写成审批卡同样改变这份规范形。 */
function canonicalizePresentation(node: Node, exclude?: Node): string {
  const idTokens = new Map<string, string>()
  const stableIdTokens = (raw: string) =>
    raw
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => {
        if (!idTokens.has(token)) idTokens.set(token, `@id${idTokens.size + 1}`)
        return idTokens.get(token)!
      })
      .join(" ")
  return canonicalizeNode(
    node,
    (element, name, value) => {
      if (sanctionedDockDelta(element, name)) return undefined
      if ((name === "inert" || name === "aria-hidden") && element.parentElement === document.body) return undefined
      if (name === "id" || name === "aria-labelledby" || name === "aria-describedby") return stableIdTokens(value)
      return value
    },
    exclude,
  )
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

/** dock 侧被允许的审批类流量 —— **只读,零写**。
 *  #668 起读面是 v1+v2 合并快照(两条 list 都必须成功,feed 才 ready),所以合法集合从
 *  `{v2 list}` 扩成 `{v2 list, v1 list}`。判据的性质没有变化:任何 `reply`/`respond` 出现在
 *  dock 的录音面上,这条断言立刻红。 */
const SANCTIONED_DOCK_TRAFFIC = new Set(["v2.session.permission.list", "permission.list"])

describe("审批单一呈现面:watcher × 生产 dock 同场运行时闸门", () => {
  test("同一请求到达两个消费面:全文档呈现面差异收敛于 surface 子树(dock 增量差分基线);dock 仅既定提示增量;决定只到达 surface client", async () => {
    // ①′ 差分基线(R3 Major 改窄):先**只**挂生产 Permission surface(无 dock),同一请求下
    // 取其 portal 子树的规范形。它锁的只是「差异集合恰好收敛于 surface 自己的子树」——
    // 参照场里没有 dock,dock 谱系的任何搭车节点不可能混进参照,比较是逐字节等值,没有
    // 「什么算审批节点」的枚举。它**不是** surface 正确性的独立判据:参照与主场共用同一个
    // PermissionSurfaceMount,生产 PermissionDialog 自身的缺陷两侧同错同等(Codex R3 实测:
    // 给 dialog 加一个无标记第二按钮,两侧都出现、比较照样相等)。surface 自身长什么样由
    // PermissionDialog 的合同测试与 L2 证据把关。
    const referenceHost = document.createElement("div")
    document.body.append(referenceHost)
    const disposeReference = runtime.render(() => runtime.PermissionSurfaceReference(), referenceHost)
    await flush()
    await flush()
    const referenceBodyBefore = new Set(Array.from(document.body.children))
    runtime.injectPermissionAsked(request)
    await flush()
    const referenceAdded = Array.from(document.body.children).filter((child) => !referenceBodyBefore.has(child))
    expect(referenceAdded).toHaveLength(1)
    expect(referenceAdded[0]!.querySelector("[role='dialog']")).not.toBeNull()
    const surfaceReferenceCanonical = canonicalizePresentation(referenceAdded[0]!)
    disposeReference()
    await flush()
    document.body.replaceChildren()
    runtime.resetSingleSurfaceHarness()

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
    const documentCanonicalBefore = canonicalizePresentation(document.documentElement)

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
    const overlay = addedBodyChildren[0]!
    expect(overlay.contains(dialogs[0]!)).toBeTrue()

    // ①′ 全局呈现面判据(#619 残余路径 2):注入前后,**整个 document** 的规范形差异恰好是
    //    Permission surface 的 portal 子树 —— 把它整棵排除后与注入前逐字节相等。Portal 到任何
    //    已存在节点(dock 内、harness 根、surface 宿主、head、html…)、新建 style/title、把既有
    //    节点改写成审批卡,全都改变这份全文档规范形 → 红。
    expect(canonicalizePresentation(document.documentElement, overlay)).toBe(documentCanonicalBefore)
    //    而这棵被排除的子树本身,必须逐字节等于差分基线 —— overlay 里若有 dock 谱系的搭车
    //    节点(「Portal 进 overlay 内部搭车」),无 dock 的基线场里不可能有它,比较必红。
    //    (基线只界定差异集合的归属,不为 surface 自身的正确性作保 —— 见本用例头注。)
    expect(canonicalizePresentation(overlay)).toBe(surfaceReferenceCanonical)
    //    呈现面也不可迁进 shadow root(closed 模式对 childNodes 走查不可见,故在原型层入账)、
    //    不可经 adoptedStyleSheets 走 CSS content 通道(新建 <style>/<link> 已被上面的全文档
    //    规范形抓住)。
    expect(shadowRootHosts).toHaveLength(0)
    expect(document.adoptedStyleSheets ?? []).toHaveLength(0)

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
    expect(dockPermissionTraffic()).toEqual(SANCTIONED_DOCK_TRAFFIC)

    // 收尾相位:收据按生产 SSE 扇出双投递 → dialog 关闭、dock 提示回落、**全文档**呈现面回到
    // 基线 —— 决定之后才现身的迟到搭车节点(如「审批结果」浮层)在这里同样红。
    runtime.injectPermissionReplied(runtime.surfaceReceipts[0]!)
    await flush()
    expect(document.querySelector("[role='dialog']")).toBeNull()
    expect(composerRoot.hasAttribute("data-approval")).toBeFalse()
    expect(composerInput.getAttribute("placeholder")).not.toBe(zh["alpha.composer.placeholderDecision"])
    expect(canonicalizeDock(dockHost)).toBe(dockCanonicalBefore)
    expect(canonicalizePresentation(document.documentElement)).toBe(documentCanonicalBefore)
    expect(shadowRootHosts).toHaveLength(0)
    // R3 收尾相位补:活跃期的 adoptedStyleSheets 检查(上方)对「收据之后才收养」的
    // CSS content 通道不设防 —— 收尾在此重查,迟到收养同样红。
    expect(document.adoptedStyleSheets ?? []).toHaveLength(0)
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
    // 前置:此刻闸③仍绿 —— 只有快照 list(两条通道)这类只读流量。
    expect(dockPermissionTraffic()).toEqual(SANCTIONED_DOCK_TRAFFIC)

    runtime.submitDecisionViaFreshClient(request.id, request.fingerprint)
    await flush()

    // 这条绕过对闸①②完全隐形:零新增 DOM、Permission surface client 零提交。
    expect(canonicalizeDock(dockHost)).toBe(dockCanonicalBefore)
    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(1)
    expect(runtime.surfaceReplyCalls).toHaveLength(0)

    // 唯一抓住它的是闸③:新建 client 的提交进了录音面,合法集合被打破。
    expect(dockPermissionTraffic()).toEqual(new Set([...SANCTIONED_DOCK_TRAFFIC, "v2.session.permission.reply"]))
    expect(dockPermissionTraffic()).not.toEqual(SANCTIONED_DOCK_TRAFFIC)
  })
})
