import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"

// Trimmed from opencode/packages/desktop/src/main/server.ts. Forks the sidecar
// utilityProcess (which imports virtual:opencode-server) and waits for it to
// report ready, then health-checks GET /global/health with Basic auth.

export type SidecarListener = { stop: () => Promise<void> }
export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

const SIDECAR_SERVICE_NAME = "opencode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  userDataPath: string
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

function createSidecarEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  )
  delete env.DEBUG
  if (!app.isPackaged) env.OPENCODE_DISABLE_CHANNEL_DB = "1"
  return env
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
): Promise<{ listener: SidecarListener; health: HealthCheck }> {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: createSidecarEnv(),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })

  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_e: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }
  app.on("child-process-gone", onProcessGone)

  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (err) => options.onStderr?.(`utility process error: ${String(err)}`))
  child.stdout?.on("data", (c: Buffer) => options.onStdout?.(c.toString("utf8").trimEnd()))
  child.stderr?.on("data", (c: Buffer) => options.onStderr?.(c.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: ReturnType<typeof setTimeout>

    const fail = (err: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(err)
    }
    const refresh = () => {
      clearTimeout(timeout)
      timeout = setTimeout(
        () => fail(new Error(`sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms`)),
        SIDECAR_START_STALL_TIMEOUT,
      )
    }
    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => fail(new Error(`sidecar exited before ready with code ${code}`))
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refresh()
    child.postMessage({ type: "start", hostname, port, password, userDataPath: options.userDataPath })
  }).catch((err) => {
    if (!exited) child.kill()
    throw err
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`sidecar exited before health check passed with code ${code}`)
    })
    const ready = async () => {
      while (true) {
        await delay(100)
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
      }
    }
    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined
  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }
  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }
  try {
    const res = await fetch(healthUrl, { method: "GET", headers, signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
