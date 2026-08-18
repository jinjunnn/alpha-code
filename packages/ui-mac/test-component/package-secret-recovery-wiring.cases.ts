// REQ-128 #712 生产接线闸。
//
// 判据不是「释放函数能用」——那是单元测试。判据是**崩溃恢复的生产接线真的会释放它**:
// `registerExtIpcHandlers` 构造的 recoveryOpts 必须带 releasePrepared,而且引擎真的调到它。
//
// 到达方式不是合成的:用户点安装 → 事务在授权终闸之后 populate 了受限密钥版本 → 进程在提交前
// 死掉。盘上于是留着一个 0600 的密钥目录,而 live config 从未指向它。下一次任何写操作(或下次
// 启动)都要经恢复 gate,那里必须把它收掉 —— 同时**绝不**碰 live config 仍在引用的那个版本。
//
// 反向确认过:把 ext-ipc.ts 的 `releasePrepared:` 一行删掉,孤儿版本目录原样留在盘上,本文件转红。
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, mock, test } from "bun:test"
import type { PackageAdmissionPreviewV1 } from "../src/shared/package-admission"

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const tmp = mkdtempSync(join(tmpdir(), "req128-712-recovery-"))
const userData = join(tmp, "user-data")

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
const canonicalBytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)

const liveSecret = "REQ128_712_LIVE_SECRET_c31f8a"
const orphanSecret = "REQ128_712_ORPHAN_SECRET_7e02d4"

const mcpPayload = {
  schema: "alpha.host-extension-package.payload.mcp-remote.v1",
  behavior: {
    url: "https://mcp.example.invalid/service",
    headersTemplate: { Authorization: "Bearer {A_KEY}" },
    requiredSecrets: ["A_KEY"],
    auth: "none",
  },
}
const mcpPayloadBytes = canonicalBytes(mcpPayload)
const mcpEnvelope = {
  schema: "alpha.host-extension-package.v1",
  prelude: { packageId: "package:recovery-mcp", version: "1.0.0" },
  // #749 合同 v2:信封新增必填 `root`。本夹具是单组件,root 即该组件自身。
  root: "mcp:recovery-mcp",
  presentation: { displayName: "recovery-mcp", description: "REQ-128 #712 recovery wiring fixture" },
  components: [
    {
      id: "mcp:recovery-mcp",
      required: true,
      dependencies: [],
      profileId: "mcp-remote",
      profileVersion: 1,
      capabilities: ["alpha.secret-prerequisite.v1"],
      payloadRef: {
        sha256: sha(mcpPayloadBytes),
        bytes: mcpPayloadBytes.byteLength,
        mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
        url: "https://assets.test/req128-712/mcp-payload.json",
      },
    },
  ],
  capabilities: ["alpha.secret-prerequisite.v1"],
}
const snapshotDigest = "6".repeat(64)

mock.module("electron", () => ({
  BrowserWindow: class {
    static fromWebContents() {
      return undefined
    }
  },
  dialog: {
    showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
  },
}))

mock.module("../src/main/ipc", () => ({
  pickedFiles: {
    read: async () => {
      throw new Error("unexpected picked-file read")
    },
  },
}))

// 恢复日志要能被读到 —— 「引擎真的走了释放这一步」的正面证据。
const logLines: string[] = []
mock.module("../src/main/logging", () => ({
  getLogger: () => ({
    error: (m: unknown) => logLines.push(String(m)),
    log: (m: unknown) => logLines.push(String(m)),
    warn: (m: unknown) => logLines.push(String(m)),
  }),
}))

mock.module("../src/main/ext-advisory-gate", () => ({
  listAdvisoryBlockedFacts: () => ({ ids: [], fresh: true }),
  makeAdvisoryGate: () => () => ({ allowed: true }),
}))

mock.module("../src/main/remote-catalog", () => ({
  downloadRemoteAsset: async () => ({ ok: false, reason: "unexpected remote asset download" }),
  readCachedCatalog: () => null,
  registerPackageCatalogReadIpcHandlers: (
    register: (channel: string, handler: IpcHandler) => void,
    refresh: () => Promise<unknown>,
  ) => {
    register("ext-remote-catalog", () => refresh())
    register("ext-package-detail", () => null)
  },
  refreshRemoteCatalog: async () => ({
    source: "remote",
    catalog: { version: "2026-08-01", entries: [{}], packages: [mcpEnvelope] },
    version: "2026-08-01",
    fetchedAt: "2026-08-01T00:00:00.000Z",
    via: "channel-dev",
    channel: "dev",
    snapshotDigest,
  }),
}))

mock.module("../src/main/ext-mcp-activation", () => ({
  reloadInstalledMcp: async (name: string) => ({ reference: name, status: "connected" }),
  probeProjectMcpActivation: async () => "unverifiable" as const,
}))

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  expect(init?.redirect).toBe("error")
  const url = String(input)
  if (url.endsWith("mcp-payload.json")) return new Response(mcpPayloadBytes, { status: 200 })
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof fetch

const { initAlphaEnvironment, getAlphaEnvironment } = await import("../src/main/alpha-environment")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")
const { claimMcpSecretVersionDir, newMcpSecretVersionId, writeMcpSecretVersioned } = await import(
  "../src/main/alpha-mcp-secrets"
)
const { readTransactionJournal } = await import("../src/main/ext-transaction")

delete process.env.ALPHA_GLOBAL_DIR
initAlphaEnvironment({
  isPackaged: false,
  channel: "dev",
  appDataDir: tmp,
  baseRoot: join(tmp, "alpha-code-state"),
  homeDir: join(tmp, "home"),
})
registerExtIpcHandlers(
  userData,
  "dev",
  async () => ({ url: "http://127.0.0.1:39119", username: "opencode", password: "route-password" }),
  join(tmp, "home"),
)

afterAll(() => {
  globalThis.fetch = originalFetch
  rmSync(tmp, { recursive: true, force: true })
})

async function install(attemptId: string, secrets: Record<string, string>) {
  const handler = handlers.get("ext-install-catalog")
  if (!handler) throw new Error("ext-install-catalog handler was not registered")
  const intent = { catalogId: "package:recovery-mcp", scope: { scope: "global" as const }, attemptId }
  const first = await handler({ sender: { id: 1 } }, intent)
  const preview = first as {
    stage: string
    authorization: Array<{ key: string; requested: string[] }>
    packageAuthorization: PackageAdmissionPreviewV1
  }
  if (preview.stage !== "authorize") throw new Error(`expected preview, got ${JSON.stringify(first)}`)
  return handler(
    { sender: { id: 1 } },
    {
      ...intent,
      grants: { secrets },
      authorization: {
        confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
        binding: preview.packageAuthorization.binding,
      },
    },
  )
}

const serverDir = () => join(userData, "alpha-mcp-secrets", "recovery-mcp")

test("the production recovery wiring releases a crashed transaction's prepared secret version and spares the live one", async () => {
  const root = getAlphaEnvironment().mutableRoot

  // ── ① 先真装一次:得到一个**被 live config 引用**的版本(它绝不许被删)。
  const installed = await install("recovery-mcp-1", { "mcp:recovery-mcp#A_KEY": liveSecret })
  expect(installed).toMatchObject({ ok: true, kind: "mcp", name: "recovery-mcp" })
  const [liveVersion] = readdirSync(serverDir())
  expect(liveVersion).toBeTruthy()
  const liveFile = join(serverDir(), liveVersion!, "A_KEY")
  expect(readFileSync(liveFile, "utf8")).toBe(liveSecret)
  expect(readFileSync(join(root, "alpha.jsonc"), "utf8")).toContain(`{file:${liveFile}}`)

  // ── ② 造出「崩在 populate 之后、提交之前」的盘面:受限版本已在盘上,journal 记着它的身份,
  //      而 live config 从未指向它。用的是生产 store API,不是手捏目录。
  const orphanVersion = newMcpSecretVersionId()
  const claimed = claimMcpSecretVersionDir(userData, "recovery-mcp", orphanVersion)
  expect(claimed.ok).toBe(true)
  const orphanWrite = writeMcpSecretVersioned(userData, "recovery-mcp", orphanVersion, "A_KEY", orphanSecret)
  expect(orphanWrite.ok).toBe(true)
  const orphanFile = join(serverDir(), orphanVersion, "A_KEY")
  expect(readFileSync(orphanFile, "utf8")).toBe(orphanSecret)

  const txId = "tx-req128712-0000abcd"
  const journal = {
    v: 1,
    txId,
    op: "install",
    state: "staged",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    items: [
      {
        key: "mcp--recovery-mcp",
        action: "config",
        genId: "gen-000000-000000",
        files: [],
        config: { target: join(root, "alpha.jsonc"), slot: 0, preDigest: "0".repeat(64), nextDigest: "1".repeat(64) },
      },
    ],
    // live 那条排在**第一位**,孤儿排第二 —— 「只处理第一条」会把孤儿留下,「不做引用复核」
    // 会把还在用的密钥删掉。两种削弱各被一条断言杀死。
    prepared: [
      { kind: "mcp-secret-version", store: "alpha-mcp-secrets", server: "recovery-mcp", version: liveVersion },
      { kind: "mcp-secret-version", store: "alpha-mcp-secrets", server: "recovery-mcp", version: orphanVersion },
    ],
  }
  const journalDir = join(root, "ext-tx", "journal")
  mkdirSync(journalDir, { recursive: true })
  writeFileSync(join(journalDir, `${txId}.json`), `${JSON.stringify(journal, null, 2)}\n`)

  // ── ③ 触发**生产**恢复:受闸写通道的每一次调用都先经 recoveryGate.withRecoveredWrite。
  //      这里刻意只走**预览**那一轮 —— 它不写 config,所以下面「live 引用没变」是干净的判据。
  logLines.length = 0
  const configBefore = readFileSync(join(root, "alpha.jsonc"), "utf8")
  const previewHandler = handlers.get("ext-install-catalog")!
  const previewAfterCrash = await previewHandler(
    { sender: { id: 1 } },
    { catalogId: "package:recovery-mcp", scope: { scope: "global" as const }, attemptId: "recovery-mcp-preview" },
  )
  expect(previewAfterCrash).toMatchObject({ ok: false, stage: "authorize" })

  // journal 真的被生产恢复收敛了(否则下面的资产断言可能只是「什么都没发生」)。
  expect(readTransactionJournal(root, txId)?.state).toBe("aborted")

  // ── ④ 孤儿被释放;live 版本毫发无伤,config 逐字未变、仍指向它。
  expect(existsSync(join(serverDir(), orphanVersion))).toBe(false)
  expect(existsSync(orphanFile)).toBe(false)
  expect(readFileSync(liveFile, "utf8")).toBe(liveSecret)
  expect(readFileSync(join(root, "alpha.jsonc"), "utf8")).toBe(configBefore)
  expect(configBefore).toContain(`{file:${liveFile}}`)

  // ⑤ 「仍被引用」是被如实上报的,不是静默吞掉。
  expect(logLines.join("\n")).toContain("still referenced by the merged config view")

  // ⑥ 恢复没有把后续写操作挡死(一个不可达残留不该封死整条扩展写通道)。
  const afterRecovery = await install("recovery-mcp-2", { "mcp:recovery-mcp#A_KEY": liveSecret })
  expect(afterRecovery).toMatchObject({ ok: true, kind: "mcp" })

  // ⑦ 明文永不出现在日志里。
  for (const canary of [liveSecret, orphanSecret]) expect(logLines.join("\n")).not.toContain(canary)
})
