// Runs in an Electron utilityProcess. Imports the embedded opencode server via
// the `virtual:opencode-server` alias (electron.vite.config.ts -> the submodule
// dist/node/node.js) and calls Server.listen with Basic auth + loopback CORS.
// Adapted (trimmed) from opencode/packages/desktop/src/main/sidecar.ts.

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
}
type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = { stop(close?: boolean): void | Promise<void> }

const parentPort = getParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command.password, command.userDataPath)
    // The embedded server. Resolved at bundle time by the vite alias.
    const { Server } = await import("virtual:opencode-server")
    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      // Must match the renderer's oc:// origin or fetches get CORS-blocked.
      cors: ["oc://renderer"],
    })
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
    // TODO (alpha-code G1): to auto-bundle @alpha-code/ext regardless of cwd,
    // inject OPENCODE_CONFIG_CONTENT here with an ABSOLUTE plugin path, e.g.
    //   process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    //     $schema: "https://opencode.ai/config.json",
    //     plugin: ["/abs/path/to/packages/ext/src/plugin.ts"],
    //   })
    // (relative specs inside OPENCODE_CONFIG_CONTENT are NOT path-resolved.)
  })
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const c = value as Partial<StartCommand | StopCommand>
  if (c.type === "stop") return { type: "stop" }
  if (c.type !== "start") return
  if (typeof c.hostname !== "string") return
  if (typeof c.port !== "number") return
  if (typeof c.password !== "string") return
  if (typeof c.userDataPath !== "string") return
  return {
    type: "start",
    hostname: c.hostname,
    port: c.port,
    password: c.password,
    userDataPath: c.userDataPath,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort(): ParentPort {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
