import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { createRoot } from "solid-js"
import type { SidecarGenerationState } from "../../preload/types"
import type { useExtensions } from "./use-extensions"

const transport = fetch
const root = await mkdtemp(join(tmpdir(), "alpha-1505-"))
const listeners = new Set<(state: SidecarGenerationState) => void>()
let generation = 0
let runtime: { createRoot: typeof createRoot; useExtensions: typeof useExtensions }
let engine: ReturnType<typeof Bun.spawn>
let engineUrl: string
let captured: Record<string, { status: string }>
const disposers: (() => void)[] = []
const proxies: ReturnType<typeof Bun.serve>[] = []

async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for production hook/engine")
}

function emit(status: SidecarGenerationState["status"]) {
  if (status === "recovering") generation++
  listeners.forEach((listener) => listener({ generation, status, reason: "token-only" }))
}

function closedPort() {
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = socket.port!
  socket.stop(true)
  return port
}

function recover(port: number) {
  // Relay the actual engine response unchanged; no fabricated HTTP status/body.
  proxies.push(Bun.serve({
    hostname: "127.0.0.1", port,
    fetch: (request) => {
      const url = new URL(new URL(request.url).pathname, engineUrl)
      url.searchParams.set("directory", join(root, "project"))
      return transport(new Request(url, request))
    },
  }))
  emit("ready")
}

function mount(port: number, delayFailure?: Promise<void>) {
  let requests = 0
  let refused = 0
  let settled = 0
  // The hook does not expose SDK fetch injection. Observe its real transport boundary only;
  // delaying an actual refused request makes the late-error arm deterministic.
  globalThis.fetch = (async (input, init) => {
    const status = new URL(input instanceof Request ? input.url : String(input)).pathname === "/mcp"
    if (status) requests++
    try {
      return await transport(input, init)
    } catch (error) {
      if (status) {
        refused++
        if (delayFailure) await delayFailure
      }
      throw error
    } finally {
      if (status) settled++
    }
  }) as typeof fetch
  const hook = runtime.createRoot((dispose) => {
    disposers.push(dispose)
    return runtime.useExtensions(() => ({ baseUrl: `http://127.0.0.1:${port}` }))
  })
  return { hook, requests: () => requests, refused: () => refused, settled: () => settled }
}

beforeAll(async () => {
  await mkdir(join(root, "project"))
  // Own configuration bytes; the asserted response shape is captured from the real /mcp below.
  await Bun.write(join(root, "project/opencode.json"), JSON.stringify({
    mcp: { "recovery-sample": { type: "remote", url: "http://127.0.0.1:1", enabled: false } },
  }))
  const port = closedPort()
  engineUrl = `http://127.0.0.1:${port}`
  engine = Bun.spawn({
    cmd: [process.execPath, "run", resolve(import.meta.dir, "../../../../opencode/src/index.ts"), "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    cwd: join(root, "project"),
    env: {
      ...process.env,
      OPENCODE_TEST_HOME: root,
      XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
      OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_PURE: "1",
      OPENCODE_SERVER_PASSWORD: "", OPENCODE_CONFIG: join(root, "project/opencode.json"),
      OPENCODE_CONFIG_DIR: join(root, "config/opencode"), OPENCODE_CONFIG_CONTENT: "{}",
    },
    stdout: Bun.file(join(root, "engine.log")), stderr: Bun.file(join(root, "engine.log")),
  })
  await until(async () => (await Bun.file(join(root, "engine.log")).text()).includes(`listening on ${engineUrl}`))
  const response = await transport(`${engineUrl}/mcp?directory=${encodeURIComponent(join(root, "project"))}`, { signal: AbortSignal.timeout(10_000) })
  expect(response.ok).toBe(true)
  captured = await response.json()
  expect(captured["recovery-sample"]).toEqual({ status: "disabled" })

  const entry = join(root, "runtime.ts")
  await Bun.write(entry, `export { createRoot } from "solid-js"; export { useExtensions } from ${JSON.stringify(join(import.meta.dir, "use-extensions.ts"))};`)
  await build({
    configFile: false, logLevel: "silent", root: resolve(import.meta.dir, "../../.."),
    plugins: [solid()],
    resolve: { alias: [
      { find: /^solid-js\/store$/, replacement: import.meta.resolve("solid-js/store/dist/store.js").replace("file://", "") },
      { find: /^solid-js\/web$/, replacement: import.meta.resolve("solid-js/web/dist/web.js").replace("file://", "") },
      { find: /^solid-js$/, replacement: import.meta.resolve("solid-js/dist/solid.js").replace("file://", "") },
    ] },
    build: {
      outDir: join(root, "bundle"), lib: { entry, formats: ["es"], fileName: () => "runtime.js" },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })
  GlobalRegistrator.register()
  Object.defineProperty(window, "api", { value: {
    sidecarGeneration: { subscribe: (listener: (state: SidecarGenerationState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    } },
    ext: {
      listInstalls: async () => ({ global: [], project: [] }),
      sessionGrants: async () => ({ grants: [] }),
      onSessionGrantsEnded: () => () => {}, factorySkillIds: async () => [],
    },
  } })
  runtime = await import(pathToFileURL(join(root, "bundle/runtime.js")).href)
})

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  proxies.splice(0).forEach((proxy) => proxy.stop(true))
  globalThis.fetch = transport
})

afterAll(async () => {
  engine?.kill("SIGKILL")
  if (engine) await engine.exited
  if (typeof window !== "undefined") await GlobalRegistrator.unregister()
  await rm(root, { recursive: true, force: true })
})

function expectLoaded(hook: ReturnType<typeof useExtensions>) {
  expect(hook.store.error).toBe(false)
  expect(hook.store.ready).toBe(true)
  expect(Object.keys(hook.store.mcp)).toEqual(Object.keys(captured))
  expect(hook.store.mcp["recovery-sample"]).toMatchObject({ name: "recovery-sample", enabled: false, connected: false })
}

test("AC1: same renderer/address automatically rereads after ready and clears the installed-list error", async () => {
  const port = closedPort()
  const probe = mount(port)
  await until(() => probe.hook.store.error)
  expect(probe.requests()).toBe(1)
  emit("recovering")
  expect(probe.requests()).toBe(1)
  recover(port)
  await until(() => probe.hook.store.ready)
  expect(probe.requests()).toBe(2)
  expectLoaded(probe.hook)
  // Normal ten-minute renewal must not reread an already successful list.
  emit("recovering")
  emit("ready")
  await Bun.sleep(20)
  expect(probe.requests()).toBe(2)
})

test("AC2: a late real connection-refused error cannot overwrite the new generation's successful list", async () => {
  const delayed = Promise.withResolvers<void>()
  const port = closedPort()
  const probe = mount(port, delayed.promise)
  try {
    await until(() => probe.refused() === 1)
    emit("recovering")
    recover(port)
    await until(() => probe.hook.store.ready)
    expect(probe.requests()).toBe(2)
    expectLoaded(probe.hook)
    delayed.resolve()
    await until(() => probe.settled() === 2)
    await Bun.sleep(20)
    expectLoaded(probe.hook)
  } finally {
    delayed.resolve()
  }
})

test("AC2: cleanup unsubscribes recovery and invalidates an in-flight status result", async () => {
  const delayed = Promise.withResolvers<void>()
  const probe = mount(closedPort(), delayed.promise)
  try {
    await until(() => probe.refused() === 1)
    disposers.pop()!()
    emit("recovering")
    emit("ready")
    delayed.resolve()
    await until(() => probe.settled() === 1)
    await Bun.sleep(20)
    expect(probe.requests()).toBe(1)
    expect(probe.hook.store.error).toBe(false)
    expect(probe.hook.store.ready).toBe(false)
  } finally {
    delayed.resolve()
  }
})

test("AC3: unavailable/failed recovery keeps the real refusal error and manual retry remains usable", async () => {
  const probe = mount(closedPort())
  await until(() => probe.hook.store.error)
  emit("recovering")
  emit("failed")
  expect(probe.requests()).toBe(1)
  expect(probe.hook.store.error).toBe(true)
  await probe.hook.refresh()
  expect(probe.requests()).toBe(2)
  emit("recovering")
  emit("ready")
  await until(() => probe.settled() === 3)
  expect(probe.hook.store.error).toBe(true)
  expect(probe.hook.store.ready).toBe(false)
  expect(probe.hook.store.mcp).toEqual({})
  await probe.hook.refresh()
  expect(probe.requests()).toBe(4)
  expect(probe.hook.store.error).toBe(true)
})
