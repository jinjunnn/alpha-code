// `#733`(REQ-130):`needs_auth` 从引擎状态一路到用户能点的按钮 —— 整条链跑生产件。
//
// 独立进程运行:真实 Solid DOM 构建 + **真实** `useExtensions` + **真实** `ExtensionHub`。
// 唯一的替身是 SDK client 本身(它对面是引擎的 HTTP 服务),其余每一跳都是生产代码:
//
//   engine `mcp.status` → `loadStatus()` 的状态投影 → `InstalledState.needsAuth`
//   → hub 的状态文案与按钮 → `ext.authenticateMcp()` → SDK `POST /mcp/:name/auth/authenticate`
//
// **为什么不能只测其中一段**:把投影单独测了、把按钮单独测了,中间那一跳断掉两边照样全绿 ——
// 那正是 CLAUDE.md 里「断言的粒度不能比缺陷粗一格」与「没测生产接线」两条讲的事。
//
// 本文件不声称端到端授权跑得通:alpha-web / alpha-platform 两侧都还没部署(实测 `.well-known`
// 均 404)。这里证明的是**本地这一侧的接线**,真机授权归部署后的验收。

import { afterAll, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import { dict as zh } from "../src/renderer/i18n/zh"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
// `solid-js/store` 少这一行**不报错**,而是静默失去反应性(store 变了 memo 永不重跑、
// 列表恒空 —— 看起来像渲染逻辑写错了)。判据写在 CLAUDE.md《本机验证陷阱》里。
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "mcp-needs-auth-solid-components",
  setup(builder) {
    builder.onLoad({ filter: /packages\/ui-mac\/src\/.*\.tsx$/ }, async (args) => {
      const transformed = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTypescript, { allExtensions: true, isTSX: true, onlyRemoveTypeImports: true }],
        ],
        sourceMaps: "inline",
      })
      return { contents: transformed?.code ?? "", loader: "js" }
    })
  },
})

// ── SDK client 替身 = 引擎 HTTP 面的边界。它之内的每一行都是生产代码 ────────────────────────
type StatusMap = Record<string, { status: string; error?: string }>
let engineStatus: StatusMap = {}
const authenticateCalls: Array<{ name: string }> = []
const installCatalogCalls: unknown[] = []
let directoryPickerCalls = 0
/** authenticate 返回什么由用例决定:
 *   - `succeed`  = 授权后引擎报 connected;
 *   - `reject`   = SDK 以 `{error}` resolve(v2 默认 `throwOnError:false`,HTTP 400/404 **不会抛**);
 *   - `http-200-but-failed` = **端点成功、授权没成**。`POST /mcp/:name/auth/authenticate` 的
 *     success 类型就是 `MCP.Status`(五臂联合),所以 200 + `{status:"failed"}` 是**合法响应**。
 *     审计 M1 正是这一格:按「不再 needs_auth」判成功,用户会看到「已重新登录」而 MCP 仍不可用。 */
let authenticateBehaviour: "succeed" | "reject" | "http-200-but-failed" = "succeed"

/** `#1106` connect 的引擎侧结局由用例决定(生产 `MCP.connect` 对 enabled:false 定义照常连,
 *  结局只会是三臂之一,**不可能**回到 disabled):
 *   - `needs_auth`    = doomed 真定义:401 → needs_auth(把 boot 里那次尝试搬到 hub 时刻的主线);
 *   - `econnrefused`  = kill-switch 的 WITHHELD 中和条目:127.0.0.1:1 毫秒级拒绝 → failed;
 *   - `connected`     = 凭证其实已经在(别处授权完成)。 */
let connectBehaviour: "needs_auth" | "econnrefused" | "connected" = "needs_auth"
const connectCalls: Array<{ name: string }> = []

const emptyStream = { [Symbol.asyncIterator]: async function* () {} }
const fakeClient = {
  mcp: {
    status: async () => ({ data: engineStatus as unknown, error: undefined }),
    connect: async (parameters: { name: string }) => {
      connectCalls.push({ name: parameters.name })
      if (connectBehaviour === "econnrefused") {
        engineStatus = { ...engineStatus, [parameters.name]: { status: "failed", error: "connect ECONNREFUSED 127.0.0.1:1" } }
      } else if (connectBehaviour === "connected") {
        engineStatus = { ...engineStatus, [parameters.name]: { status: "connected" } }
      } else {
        engineStatus = { ...engineStatus, [parameters.name]: { status: "needs_auth" } }
      }
      return { data: {}, error: undefined }
    },
    disconnect: async () => ({ data: {}, error: undefined }),
    add: async () => ({ data: {}, error: undefined }),
    auth: {
      authenticate: async (parameters: { name: string }) => {
        authenticateCalls.push({ name: parameters.name })
        if (authenticateBehaviour === "reject") return { data: undefined, error: { _tag: "McpUnsupportedOAuthError" } }
        if (authenticateBehaviour === "http-200-but-failed") {
          // HTTP 层完全成功(无 error),body 是合法的 failed 臂;引擎那边这个 server 依旧连不上。
          engineStatus = { ...engineStatus, [parameters.name]: { status: "failed", error: "token rejected by resource server" } }
          return { data: { status: "failed", error: "token rejected by resource server" }, error: undefined }
        }
        // 授权成功 = 引擎那边这个 server 现在连上了。下一次 loadStatus 会读到它。
        engineStatus = { ...engineStatus, [parameters.name]: { status: "connected" } }
        return { data: { status: "connected" }, error: undefined }
      },
    },
  },
  app: { agents: async () => ({ data: [], error: undefined }) },
  global: {
    event: async () => ({ stream: emptyStream }),
    dispose: async () => ({ data: {}, error: undefined }),
  },
}
mock.module("@opencode-ai/sdk/v2/client", () => ({ createOpencodeClient: () => fakeClient }))

// 云连接器卡只在「已登录 + platform」时展示状态与动作。`#624` 起 `platformStatus` 也进判据,
// 故这里改成**可驱动**的:用例设完 `authStateForCase` 再 mount,订阅时回放当前值。
type CaseAuthState = { status: string; mode: string; platformStatus?: "ready" | "recovering" }
let authStateForCase: CaseAuthState = { status: "logged-in", mode: "platform", platformStatus: "ready" }
mock.module("../src/renderer/auth-recovery", () => ({
  subscribeAuthState: (listener: (state: CaseAuthState) => void) => {
    listener(authStateForCase)
    return () => {}
  },
}))
mock.module("@solidjs/router", () => ({ useLocation: () => ({ pathname: "/" }) }))
mock.module("../src/renderer/alpha-ui/Banner", () => ({ Banner: () => null }))

Object.defineProperty(window, "api", {
  configurable: true,
  value: {
    openDirectoryPicker: async () => {
      directoryPickerCalls++
      return "/picked-during-install"
    },
    updater: { check: async () => {} },
    auth: { start: async () => {} },
    ext: {
      listInstalls: async () => ({ global: [], project: [] }),
      sessionGrants: async () => ({ grants: [] }),
      factorySkillIds: async () => [],
      onSessionGrantsEnded: () => () => {},
      inventoryView: async () => undefined,
      installedPackages: async () => ({ ok: true as const, packages: [] }),
      advisoryActive: async () => ({ ids: [], fresh: true }),
      migrateScan: async () => ({ enabled: false, inventory: { skills: [], mcp: [], plugins: [] } }),
      remoteCatalog: async () => ({ ok: false as const, reason: "not used by this case file" }),
      checkRuntime: async () => ({ ok: true as const }),
      installCatalog: async (intent: unknown) => {
        installCatalogCalls.push(intent)
        engineStatus = { ...engineStatus, filesystem: { status: "connected" } }
        return {
          ok: true as const,
          kind: "mcp",
          name: "filesystem",
          mcpActivation: { reference: "filesystem", status: "connected" as const },
        }
      },
      builtinRead: async () => ({ tools: [], agents: [], protection: { hard: [], alphaInjected: [] } }),
      curationBlob: async () => undefined,
      migrateVerify: async () => ({ ok: true as const }),
    },
  },
})

const { createComponent } = solid
const { render } = solidWeb
// 必须**动态** import:静态 import 会在 registrator 之前牵出 solid-js,整个文件拿到 server 构建
//(指纹 = 报错与改动无关且全文件一起挂)。纪律在 CLAUDE.md《本机验证陷阱》。
const { ExtensionHub } = await import("../src/renderer/extensions/extension-hub")
const { ToastViewport, dismissToast } = await import("../src/renderer/alpha-ui/Toast")
const { setHubSection } = await import("../src/renderer/extensions/ext-hub-state")

const disposals: Array<() => void> = []
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function waitFor(assertion: () => void) {
  let failure: unknown
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      assertion()
      return
    } catch (error) {
      failure = error
      await flush()
    }
  }
  throw failure
}

function mount(section: "installed" | "cloud" | "connectors") {
  setHubSection(section)
  const root = document.createElement("div")
  root.id = "root"
  root.className = "a-ui"
  document.body.append(root)
  disposals.push(render(() => createComponent(ToastViewport, {}), document.body.appendChild(document.createElement("div"))))
  const dispose = render(
    () =>
      createComponent(ExtensionHub, {
        server: () => ({ baseUrl: "http://127.0.0.1:65535" }) as never,
        open: () => true,
        onClose: () => {},
      }),
    root,
  )
  disposals.push(dispose)
}

function reset() {
  for (const dispose of disposals.splice(0)) dispose()
  document.body.replaceChildren()
  // toast 是**模块级单例 store**,而且经 Portal 挂到 body —— 清 DOM 清不掉它:
  // 下一个用例挂上新视口时,上一条 toast 会原样再渲染一遍,于是「没有出现成功提示」
  // 这类断言会读到上一条的残留而假绿/假红。id 单调递增,逐个撤掉即可(幂等)。
  for (let id = 1; id <= 500; id++) dismissToast(id)
  authenticateCalls.length = 0
  installCatalogCalls.length = 0
  connectCalls.length = 0
  directoryPickerCalls = 0
  authenticateBehaviour = "succeed"
  connectBehaviour = "needs_auth"
  authStateForCase = { status: "logged-in", mode: "platform", platformStatus: "ready" }
}

const toastTexts = () => Array.from(document.querySelectorAll(".a-toast")).map((node) => node.textContent ?? "")

afterAll(async () => {
  reset()
  await GlobalRegistrator.unregister()
})

const authorizeButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-mcp-authorize]"))

test("needs_auth 的 MCP 行:状态说「需要重新登录」,并出现一颗真的能点的按钮", async () => {
  reset()
  engineStatus = { cloud: { status: "needs_auth" } }
  mount("installed")

  await waitFor(() => expect(authorizeButtons().map((b) => b.dataset.mcpAuthorize)).toEqual(["cloud"]))
  // 状态文案:说「需要重新登录」,**不是**「未连接」——后者会把唯一的补救路径从界面上抹掉。
  await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.ext.mcpNeedsAuth"]))
  expect(document.body.textContent).not.toContain(zh["alpha.ext.disabled"])
  expect(authorizeButtons()[0]!.textContent).toBe(zh["alpha.ext.mcpAuthorize"])
  expect(authorizeButtons()[0]!.disabled).toBe(false)
})

test("点下去真的走到引擎的 authenticate,授权后那颗按钮消失、状态翻成已连接", async () => {
  reset()
  engineStatus = { cloud: { status: "needs_auth" } }
  mount("installed")
  await waitFor(() => expect(authorizeButtons().length).toBe(1))

  authorizeButtons()[0]!.click()

  // ① 生产链真的调到了引擎那条 HTTP 端点,且带对了 server 名。
  await waitFor(() => expect(authenticateCalls).toEqual([{ name: "cloud" }]))
  // ② 状态从引擎重读 —— 不是本地乐观改一下(那会在授权其实失败时谎报成功)。
  await waitFor(() => expect(authorizeButtons().length).toBe(0))
  await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.ext.enabledLive"]))
  expect(document.body.textContent).not.toContain(zh["alpha.ext.mcpNeedsAuth"])
  // ③ 成功提示到达用户面(真 ToastViewport,不是「hub 调过 flash」这种内部事实)。
  await waitFor(() => expect(toastTexts().some((text) => text.includes(zh["alpha.ext.mcpAuthDone"]))).toBe(true))
})

test("授权没完成时如实说失败,按钮留在原地(不谎报已重新登录)", async () => {
  reset()
  engineStatus = { cloud: { status: "needs_auth" } }
  authenticateBehaviour = "reject"
  mount("installed")
  await waitFor(() => expect(authorizeButtons().length).toBe(1))

  authorizeButtons()[0]!.click()

  await waitFor(() => expect(authenticateCalls).toEqual([{ name: "cloud" }]))
  await waitFor(() => expect(toastTexts().some((text) => text.includes(zh["alpha.ext.mcpAuthFailed"]))).toBe(true))
  expect(toastTexts().some((text) => text.includes(zh["alpha.ext.mcpAuthDone"]))).toBe(false)
  // 补救入口必须还在 —— 「再试一次」是这条提示唯一有意义的下一步。
  expect(authorizeButtons().length).toBe(1)
})

test("M1:端点 200 但 body 是 failed —— 必须说失败,绝不能说「已重新登录」", async () => {
  reset()
  engineStatus = { cloud: { status: "needs_auth" } }
  authenticateBehaviour = "http-200-but-failed"
  mount("installed")
  await waitFor(() => expect(authorizeButtons().length).toBe(1))

  authorizeButtons()[0]!.click()

  await waitFor(() => expect(authenticateCalls).toEqual([{ name: "cloud" }]))
  // 授权后这个 server 是 `failed`:`needs_auth` 确实不成立了 —— 按「不再 needs_auth」
  // 判成功的实现会在这里宣布成功,而用户的 MCP 根本用不了。
  await waitFor(() => expect(document.body.textContent).toContain("token rejected by resource server"))
  await waitFor(() => expect(toastTexts().some((text) => text.includes(zh["alpha.ext.mcpAuthFailed"]))).toBe(true))
  expect(toastTexts().some((text) => text.includes(zh["alpha.ext.mcpAuthDone"]))).toBe(false)
  // failed 不是用户点一下能修好的状态 ⇒ 授权按钮不该留在那里假装还能救。
  expect(authorizeButtons().length).toBe(0)
})

// ── 区分度证明:一个「永远显示授权按钮」的错误实现必须过不了下面这两条 ────────────────────
test("failed 的 MCP 行不出授权按钮(它不是用户点一下能修好的状态)", async () => {
  reset()
  engineStatus = { cloud: { status: "failed", error: "connect ECONNREFUSED" } }
  mount("installed")

  await waitFor(() => expect(document.body.textContent).toContain("connect ECONNREFUSED"))
  expect(authorizeButtons().length).toBe(0)
})

test("needs_client_registration 也不出授权按钮(缺 clientId,点一百次也没用)", async () => {
  reset()
  engineStatus = {
    cloud: { status: "needs_client_registration", error: "Server does not support dynamic client registration." },
  }
  mount("installed")

  await waitFor(() => expect(document.body.textContent).toContain("dynamic client registration"))
  expect(authorizeButtons().length).toBe(0)
  expect(document.body.textContent).not.toContain(zh["alpha.ext.mcpNeedsAuth"])
})

test("connected 的 MCP 行不出授权按钮", async () => {
  reset()
  engineStatus = { cloud: { status: "connected" } }
  mount("installed")

  await waitFor(() => expect(document.body.textContent).toContain(zh["alpha.ext.enabledLive"]))
  expect(authorizeButtons().length).toBe(0)
})

// ── 云连接器卡:用户看云通道状态的主要位置 ───────────────────────────────────────────────
test("云连接器卡在 needs_auth 时说「需要重新登录」并给出同一个动作", async () => {
  reset()
  engineStatus = { cloud: { status: "needs_auth" } }
  mount("cloud")

  await waitFor(() => expect(document.querySelector(".alpha-ext-cloudst")?.textContent).toBe(zh["alpha.ext.mcpNeedsAuth"]))
  // 「未连接(引擎会自动重连)」在这里是**假话**:没有令牌,引擎永远不会自己连上。
  expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudConnDisconnected"])
  const buttons = authorizeButtons()
  expect(buttons.length).toBe(1)

  buttons[0]!.click()
  await waitFor(() => expect(authenticateCalls).toEqual([{ name: "cloud" }]))
  await waitFor(() => expect(document.querySelector(".alpha-ext-cloudst")?.textContent).toBe(zh["alpha.ext.cloudConnConnected"]))
  expect(authorizeButtons().length).toBe(0)
})

test("带 {workspace} 的 Hub MCP 安装不打开目录选择器,只发送全局 catalog intent", async () => {
  reset()
  engineStatus = {}
  mount("connectors")

  let filesystemCard: HTMLElement | undefined
  await waitFor(() => {
    filesystemCard = Array.from(document.querySelectorAll<HTMLElement>(".alpha-ext-card")).find((card) =>
      card.textContent?.includes("文件系统"),
    )
    expect(filesystemCard).toBeInstanceOf(HTMLElement)
  })
  filesystemCard!.querySelector<HTMLButtonElement>(".alpha-ext-add")!.click()

  let confirm: HTMLButtonElement | null = null
  await waitFor(() => {
    confirm = document.querySelector<HTMLButtonElement>("[role='dialog'] .a-dialog-footer .a-btn:last-child")
    expect(confirm).toBeInstanceOf(HTMLButtonElement)
  })
  confirm!.click()

  await waitFor(() => expect(installCatalogCalls).toHaveLength(1))
  expect(directoryPickerCalls).toBe(0)
  expect(installCatalogCalls[0]).toEqual({ catalogId: "mcp:filesystem", scope: { scope: "global" } })
})

// ── `#624`:平台凭证恢复中,云能力 fail-close ────────────────────────────────────────────────
//
// 缺陷原形:`cloudReady` 只看 `status` + `mode`,`platformStatus:"recovering"` 照样放行。
// 它放行的是本渲染进程权限最高的两个动作(云派发 = 代码出境 + 计费;enableCloud),而 main
// **不会**替我们兜底 —— `getAccessToken` 不看有效期,`authed()` 只判 token 在不在。
//
// 判据取**用户真按的那颗按钮的 disabled**,不是谓词的返回值:谓词单测过不了「按钮忘了接线」。
// 每一格都配一条 ready 的正向对照 —— 否则把按钮恒置 disabled 也能全绿。
//
// 反向验证(已实跑):把 `cloudReady` 改回 `onPlatform()`,下面 4 条 recovering 用例转红。

const recoveringAuth = () => {
  authStateForCase = { status: "logged-in", mode: "platform", platformStatus: "recovering" }
}
/** 详情页主操作按钮(「启用」/「添加」)。 */
const primaryAddButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button.alpha-ext-add")).find(
    (b) => b.textContent === zh["alpha.ext.enableCloud"],
  )
/** 打开某个云条目的详情页(点卡片,走生产的 openEntryDetail)。 */
async function openCloudEntry(displayName: string) {
  await waitFor(() => {
    const card = Array.from(document.querySelectorAll<HTMLElement>(".alpha-ext-card")).find((c) =>
      c.querySelector(".alpha-ext-card-name b")?.textContent?.includes(displayName),
    )
    if (!card) throw new Error(`card not found: ${displayName}`)
    card.click()
  })
}

test("`#624` 恢复中:云条目的「启用」按钮禁用(ready 时可用)", async () => {
  reset()
  recoveringAuth()
  engineStatus = { cloud: { status: "connected" } }
  mount("cloud")
  await openCloudEntry("云代码审查")
  await waitFor(() => expect(primaryAddButton()).toBeDefined())
  expect(primaryAddButton()!.disabled).toBe(true)

  // 正向对照:同一条链、同一颗按钮,ready 时必须是可点的。
  reset()
  engineStatus = { cloud: { status: "connected" } }
  mount("cloud")
  await openCloudEntry("云代码审查")
  await waitFor(() => expect(primaryAddButton()).toBeDefined())
  expect(primaryAddButton()!.disabled).toBe(false)
})

test("`#624` 恢复中:code-review 详情的云派发按钮禁用(ready 时可用)", async () => {
  // 派发区的按钮 = 真正把代码送出去的那两颗(上传 / legacy diff)。
  const dispatchButtons = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".alpha-ext-cloudrun button.alpha-ext-add"))

  reset()
  recoveringAuth()
  engineStatus = { cloud: { status: "connected" } }
  mount("cloud")
  await openCloudEntry("云代码审查")
  await waitFor(() => expect(dispatchButtons().length).toBeGreaterThan(0))
  expect(dispatchButtons().map((b) => b.disabled)).not.toContain(false)

  reset()
  engineStatus = { cloud: { status: "connected" } }
  mount("cloud")
  await openCloudEntry("云代码审查")
  await waitFor(() => expect(dispatchButtons().length).toBeGreaterThan(0))
  expect(dispatchButtons().map((b) => b.disabled)).toContain(false)
})

test("`#624` 恢复中的门控条不谎称「未登录 / BYOK」,也不给 no-op 按钮", async () => {
  reset()
  recoveringAuth()
  engineStatus = { cloud: { status: "connected" } }
  mount("cloud")

  await waitFor(() =>
    expect(document.querySelector(".alpha-ext-cloudgate-t")?.textContent).toBe(zh["alpha.ext.cloudGateTitleRecovering"]),
  )
  // 用户此刻**已登录**且**已在 platform 模式** —— 这两句都是假话。
  expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudGateTitleMode"])
  expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudGateTitleLogin"])
  // 「切换到平台模式」点下去是 no-op;恢复中不给任何动作。
  expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudSwitchMode"])
  expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudLoginCta"])
})

test("`#624` 恢复中的连接器卡说「凭证恢复中」,不说「需登录平台模式」", async () => {
  reset()
  recoveringAuth()
  engineStatus = { cloud: { status: "connected" } }
  mount("cloud")

  await waitFor(() =>
    expect(document.querySelector(".alpha-ext-cloudst")?.textContent).toBe(zh["alpha.ext.cloudConnRecovering"]),
  )
  expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudConnNeedLogin"])
  // 恢复中不得谎称「已连接」—— 那正是这次要拦的放行。
  expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudConnConnected"])
})

// ── `#1106`:注入面推迟的云连接,hub 观察到 disabled 时补上那一次 connect ────────────────────
//
// 注入面在「无已存 OAuth 凭证 ⇒ boot 连接注定 needs_auth」时把云 server 写成 enabled:false,
// 引擎 boot 不再为它等 1.8–9.7 秒;这里验证被搬走的那次连接确实在 hub 时刻补上,
// 且 `#733` 的补救链(needs_auth → 按钮 → authenticate)在其后原样成立。
// 反向判据:把 use-extensions 的 kickDeferredCloudMcp 摘掉,下面第一、三条当场红。

test("`#1106` 主线:disabled 云条目 → hub 补发一次 connect → needs_auth → 授权按钮点亮 → 授权成功", async () => {
  reset()
  engineStatus = { cloud: { status: "disabled" } }
  mount("cloud")

  // kick 恰好一次;引擎如实报回 needs_auth,`#733` 的卡片臂与按钮随之点亮。
  await waitFor(() => expect(connectCalls).toEqual([{ name: "cloud" }]))
  await waitFor(() => expect(document.querySelector(".alpha-ext-cloudst")?.textContent).toBe(zh["alpha.ext.mcpNeedsAuth"]))
  await waitFor(() => expect(authorizeButtons().length).toBe(1))

  // 其后的授权链与 `#733` 逐字相同 —— kick 不得再多发 connect。
  authorizeButtons()[0]!.click()
  await waitFor(() => expect(authenticateCalls).toEqual([{ name: "cloud" }]))
  await waitFor(() => expect(document.querySelector(".alpha-ext-cloudst")?.textContent).toBe(zh["alpha.ext.cloudConnConnected"]))
  expect(connectCalls).toEqual([{ name: "cloud" }])
})

test("`#1106` 只认云条目的 disabled:needs_auth 的 cloud 与 disabled 的别家 server 都不触发 connect", async () => {
  reset()
  engineStatus = { cloud: { status: "needs_auth" }, filesystem: { status: "disabled" } }
  mount("cloud")

  // 等到状态真的被读进来(按钮出现 = loadStatus 已完成),再断零 —— 不然是「没跑」冒充「没发」。
  await waitFor(() => expect(authorizeButtons().length).toBe(1))
  expect(connectCalls).toEqual([])
})

test("`#1106` kill-switch 的中和条目:kick 连到 127.0.0.1:1 即刻失败,不出授权按钮", async () => {
  reset()
  connectBehaviour = "econnrefused"
  engineStatus = { cloud: { status: "disabled" } }
  mount("cloud")

  await waitFor(() => expect(connectCalls).toEqual([{ name: "cloud" }]))
  // 结局 failed:卡片说「未连接」,没有一颗点了必失败的授权按钮(与今天的 kill-switch 呈现一致)。
  await waitFor(() => expect(document.querySelector(".alpha-ext-cloudst")?.textContent).toBe(zh["alpha.ext.cloudConnDisconnected"]))
  expect(authorizeButtons().length).toBe(0)
})

test("`#1106` 凭证其实已在(别处授权完成):kick 直接把它连上", async () => {
  reset()
  connectBehaviour = "connected"
  engineStatus = { cloud: { status: "disabled" } }
  mount("cloud")

  await waitFor(() => expect(connectCalls).toEqual([{ name: "cloud" }]))
  await waitFor(() => expect(document.querySelector(".alpha-ext-cloudst")?.textContent).toBe(zh["alpha.ext.cloudConnConnected"]))
  expect(authorizeButtons().length).toBe(0)
})
