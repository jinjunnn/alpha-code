// `#1353` —— 「发送被拦下时的输入框提示」视觉 harness(真组件挂载,零生产代码改动;
// 与已批 2026-09-17-1130-settings-tools-visuals / 2026-08-12-583-584-586 harness 同一模式)。
//
// 挂载现役生产组件 `AlphaComposerRuntime`(首页与对话页是同一个组件)与现役生产 CSS
// (组件自身 import 原样加载 + tokens)。`api.moderation.check` 是按状态给定的夹具,
// 其余通道给最小成功桩;**提示不是画出来的** —— 它由生产 `submit()` 在夹具判命中后置起,
// 走的就是用户按下回车那条路。loopback Vite 构建 + Chrome --headless=new 截图;
// 不启动 Electron、不用任何账号 / API key。
//
// 用法:?state=session-blocked|session-clean|session-typed|home-blocked&theme=light|dark&width=narrow|wide
//
// `session-typed` 是**版式对照组**:同一段文字打进输入框但不按发送。窄宽下那段文字本来就长过
// 输入框的 54px(`.a-comp-input` 是纯 CSS min/max-height、没有 JS 自动长高,超出即滚动)——
// 有没有这条提示都一样。留着这一格,是为了让「窄宽下第二行被截」不被误读成本增量引入的版式回归。
/* @jsxImportSource solid-js */
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import "../../../../packages/ui-mac/src/renderer/alpha-ui/tokens.css"
import { AlphaComposerRuntime } from "../../../../packages/ui-mac/src/renderer/alpha-ui/alpha-composer"
import { setLocale } from "../../../../packages/ui-mac/src/renderer/i18n"
import catalogJson from "../../../../packages/ui-mac/src/main/alpha-models.json"

setLocale("zh")

const params = new URLSearchParams(location.search)
const state = params.get("state") ?? "session-blocked"
const theme = params.get("theme") === "dark" ? "dark" : "light"
const width = params.get("width") === "narrow" ? 380 : 640

document.documentElement.dataset.colorScheme = theme
document.documentElement.style.colorScheme = theme
document.body.style.margin = "0"
document.body.style.background = "var(--a-bg-subtle)"

const catalog = { ...(catalogJson as Record<string, never>), liveSync: { status: "static" }, pricingBasisModelId: null }
const provider = (catalog as unknown as { platformProvider: { id: string } }).platformProvider
const models = (catalog as unknown as { platformModels: Array<{ id: string; name: string }> }).platformModels

const info = (id: string, name: string) => ({
  id,
  providerID: provider.id,
  name,
  api: { id: provider.id, type: "aisdk", package: "@ai-sdk/openai-compatible" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 128_000, output: 8_192 },
})

/** 命中与否按状态给定。`session-clean` 是反向格:同一段文字、同一次发送,只是没命中。 */
const blocks = state !== "session-clean"
/** `session-typed` 只打字、不发送 —— 版式对照组。 */
const sends = state !== "session-typed"

Object.defineProperty(window, "api", {
  configurable: true,
  value: {
    endpoints: async () => null,
    openLink: () => {},
    moderation: { check: async () => blocks },
    models: { catalog: async () => catalog },
    auth: {
      getState: async () => ({ status: "logged-in", mode: "platform" }),
      subscribe: () => () => {},
      start: async () => {},
    },
    account: {
      summary: async () => ({
        balanceFen: 4800,
        walletUsedFen: 0,
        plan: {
          id: "pro",
          name: "Pro",
          status: "active",
          window5h: { usedCredits: 0, limitCredits: 100, resetsInMin: 0 },
          window7d: { usedCredits: 0, limitCredits: 100, resetsInMin: 0 },
          renewsAt: "",
          daysLeft: 10,
        },
        usage: { todayTokens: 0, weekTokens: 0, tasksThisMonth: 0 },
        usageSeries: [],
      }),
    },
    providers: {
      keyStatus: async () => ({}),
      add: async () => ({ ok: true }),
      test: async () => ({ ok: true, ms: 1 }),
      setKey: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
      removeKey: async () => ({ ok: true }),
    },
  },
})

const modelContract = {
  list: async () => models.map((model) => info(model.id, model.name)),
  current: async () => ({ providerID: provider.id, id: models[0]!.id }),
  switch: async () => {},
}

const projects = {
  store: { projects: [], ready: true, error: false },
  reload: async () => {},
  createSession: async () => undefined,
  // 首页格:被拦下时它必须一次都不被调用(判据在 test-component 那一侧,这里只是不让它真跳转)。
  startChat: async () => undefined,
  sdk: () =>
    ({
      command: { list: async () => ({ data: [] }) },
      session: { promptAsync: async () => ({}), command: async () => ({ data: {} }), abort: async () => ({}) },
    }) as never,
  renameSession: async () => false,
  shareSession: async () => undefined,
  deleteSession: async () => false,
  copySession: async () => undefined,
}

const stage = document.createElement("div")
stage.style.cssText = `max-width:${width}px;margin:0 auto;padding:40px 16px`
document.body.append(stage)

const home = state === "home-blocked"
render(
  () =>
    createComponent(AlphaComposerRuntime, {
      mode: home ? "home" : "session",
      projects: projects as never,
      directory: () => "/Users/kai/app/kama-bot-local",
      ...(home ? {} : { sessionID: () => "S1" }),
      command: { options: [], trigger: () => {} } as never,
      modelContract: modelContract as never,
      ...(home
        ? {}
        : { sessionDock: { running: () => false, contextUsage: () => 38, approvalPending: () => false } }),
    }) as unknown as Element,
  stage,
)

const BODY = "帮我把这段客服回复改得更直接一点,现在读起来太绕了。"

/** 走用户那条路:把字打进生产 textarea,然后按回车。提示由生产 `submit()` 置起。 */
setTimeout(() => {
  const textarea = document.querySelector("textarea")
  if (!textarea) {
    document.documentElement.dataset.visualError = "no textarea"
    return
  }
  textarea.value = BODY
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: BODY }))
  setTimeout(() => {
    if (sends) textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    setTimeout(() => {
      // 自证这一帧确实处在它自称的状态:命中格必须真有那个元素,反向格与对照组必须真没有。
      const present = !!document.querySelector("[data-alpha-composer-blocked]")
      document.documentElement.dataset.blockedPresent = String(present)
      document.documentElement.dataset.visualReady = present === (blocks && sends) ? "true" : "false"
    }, 260)
  }, 260)
}, 400)
