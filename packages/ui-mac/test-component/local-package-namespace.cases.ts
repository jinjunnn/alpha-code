// REQ-128 Phase 3 `[T3-channel]`(#782)—— G8 `local:` **双向**命名空间闸。
//
// ① 铸造侧:本地铸造器只准产 `local:` 前缀(判据语料 = 仓内**真实**语料 62 个插件,
//    外加一个把 manifest 名字写成 `mcp:markitdown` 的敌意夹具)。
// ② admission 侧:`resolvePreparedPackage` 必须拒绝任何 packageId 以 `local:` 开头的
//    **已验签 catalog 信封** —— 用**真实 admission coordinator** 跑,不是自己拼一条等价链。
//
// **只做①视为未完成**,这是本文件存在的全部理由:`ext-package-installed`(`ext-ipc.ts`)
// 是**纯按字符串查 V3 图、不问来源**的。一个 packageId 为 `local:x` 的已验签包装上之后,
// 远程 catalog 详情页会命中本地插件的图,当场长出「移除此扩展包」—— 用户在一个远程包的
// 页面上一键卸掉自己手动导入的插件。挡自己人挡得再严也拦不住这条。
//
// 第三条(基线 §8 纪律 2 / `#737`):**来源不从 packageId 前缀读**。只读列表通道的 `origin`
// 必须来自 child record,所以这里真装一个 `package:` 开头的 catalog 包,断言它的 origin 是
// `catalog` —— 换成从前缀推断的实现,这条依然绿,所以还要断言那条被记在这里的可达路径。

import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, mock, test } from "bun:test"
import type { AlphaPackageEnvelopeV1, PackageProfilePayloadV1 } from "../src/shared/host-extension-package-contract/decoder"

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const tmp = mkdtempSync(join(tmpdir(), "local-package-namespace-"))
const userData = join(tmp, "user-data")

const payload = {
  schema: "alpha.host-extension-package.payload.mcp-remote.v1",
  behavior: { url: "https://mcp.example.com/", headersTemplate: {}, requiredSecrets: [], auth: "none" },
} as unknown as PackageProfilePayloadV1
const payloadBytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)

/** 同一份信封,只有 packageId 不同 —— 唯一变量就是命名空间。 */
function envelopeWith(packageId: string): AlphaPackageEnvelopeV1 {
  return {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId, version: "1.0.0" },
    presentation: { displayName: "Namespace Fixture", description: "REQ-128 namespace gate fixture." },
    root: "mcp:namespace-fixture",
    components: [
      {
        id: "mcp:namespace-fixture",
        required: true,
        dependencies: [],
        profileId: "mcp-remote",
        profileVersion: 1,
        capabilities: [],
        payloadRef: {
          sha256: createHash("sha256").update(payloadBytes).digest("hex"),
          bytes: payloadBytes.byteLength,
          mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
          url: "https://alphacodeone.com/catalog/assets/mcp.namespace-fixture/1.0.0/alpha-package/payload.json",
        },
      },
    ],
    capabilities: [],
  } as unknown as AlphaPackageEnvelopeV1
}

const LOCAL_ENVELOPE_ID = "local:namespace-fixture"
const CATALOG_ENVELOPE_ID = "package:namespace-fixture"
const snapshotDigest = "5".repeat(64)

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
  ipcMain: { handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) },
}))

mock.module("../src/main/ipc", () => ({
  pickedFiles: {
    read: async () => {
      throw new Error("unexpected picked-file read")
    },
  },
}))

mock.module("../src/main/logging", () => ({ getLogger: () => ({ error: () => {}, log: () => {}, warn: () => {} }) }))

mock.module("../src/main/ext-advisory-gate", () => ({
  listAdvisoryBlockedFacts: () => ({ ids: [], fresh: true }),
  makeAdvisoryGate: () => () => ({ allowed: true }),
}))

mock.module("../src/main/remote-catalog", () => ({
  downloadRemoteAsset: async () => ({ ok: false, reason: "unexpected remote asset download" }),
  readCachedCatalog: () => null,
  registerPackageCatalogReadIpcHandlers: () => {},
  // 一份**已验签**的 Catalog 快照,同时带着两个信封。admission 的其余十六条保证一条不动 ——
  // 变的只有 packageId 的命名空间。
  refreshRemoteCatalog: async () => ({
    source: "remote",
    catalog: { version: "2026-08-02", entries: [{}], packages: [envelopeWith(LOCAL_ENVELOPE_ID), envelopeWith(CATALOG_ENVELOPE_ID)] },
    version: "2026-08-02",
    fetchedAt: "2026-08-02T00:00:00.000Z",
    via: "channel-dev",
    channel: "dev",
    snapshotDigest,
  }),
}))

mock.module("../src/main/ext-mcp-activation", () => ({
  reloadInstalledMcp: async (name: string) => ({ reference: name, status: "connected" }),
}))

const originalFetch = globalThis.fetch
globalThis.fetch = (async () => new Response(payloadBytes, { status: 200 })) as typeof fetch

const { initAlphaEnvironment, getAlphaEnvironment } = await import("../src/main/alpha-environment")
const { LOCAL_PACKAGE_READ_CHANNELS, GATED_WRITE_CHANNELS } = await import("../src/main/ext-write-channels")
const { LOCAL_PACKAGE_ID_PREFIX, isLocalPackageId } = await import("../src/shared/local-package-namespace")
const { previewLocalClaudePlugin } = await import("../src/main/claude-plugin-intake")
const { materializeCorpus, pluginRootsIn } = await import("./claude-plugin-corpus.fixture")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")

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
  async () => ({ url: "http://127.0.0.1:39117", username: "opencode", password: "route-password" }),
  join(tmp, "home"),
)

afterAll(() => {
  globalThis.fetch = originalFetch
  rmSync(tmp, { recursive: true, force: true })
})

const call = (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return handler({ sender: { id: 1 } }, ...args)
}

test("G8②:真实 admission coordinator 拒绝任何 `local:` 开头的已验签 catalog 信封", async () => {
  const refused = (await call(GATED_WRITE_CHANNELS.installCatalog, {
    catalogId: LOCAL_ENVELOPE_ID,
    scope: { scope: "global" },
    attemptId: "namespace-attempt-1",
  })) as Record<string, unknown>
  expect(refused.ok).toBe(false)
  // 断言的是**具名拒因**,不是 `ok === false`:没有这道闸时它同样 `ok === false`
  // (那是 `stage: "authorize"` 的授权预览)—— 只断言 `ok===false` 是假闸形态⑨。
  expect(String(refused.reason)).toContain(LOCAL_PACKAGE_ID_PREFIX)
  expect(String(refused.reason)).toContain("reserved for locally imported packages")
  expect(refused.stage).toBeUndefined()
  expect(refused.packageAuthorization).toBeUndefined()
  // 零副作用:账本里一张图都没有。
  const listed = (await call(LOCAL_PACKAGE_READ_CHANNELS.listInstalledPackages)) as { ok: boolean; packages: unknown[] }
  expect(listed).toEqual({ ok: true, packages: [] })
})

test("同一份信封换成 `package:` 命名空间 ⇒ 走到真实授权屏(证明拒绝来自命名空间,不是别的东西)", async () => {
  const preview = (await call(GATED_WRITE_CHANNELS.installCatalog, {
    catalogId: CATALOG_ENVELOPE_ID,
    scope: { scope: "global" },
    attemptId: "namespace-attempt-2",
  })) as Record<string, unknown>
  // 这条是上一条的**对照臂**:两次调用之间唯一的差别就是 packageId 的前缀。
  expect(preview.ok).toBe(false)
  expect(preview.stage).toBe("authorize")
  expect(preview.packageAuthorization).toBeDefined()
  expect(String(preview.reason ?? "")).not.toContain("reserved for locally imported packages")
})

test("只读列表通道:装成之后的 `origin` 来自 child record,不是从 packageId 前缀推的", async () => {
  const preview = (await call(GATED_WRITE_CHANNELS.installCatalog, {
    catalogId: CATALOG_ENVELOPE_ID,
    scope: { scope: "global" },
    attemptId: "namespace-attempt-3",
  })) as { authorization: Array<{ key: string; requested: string[] }>; packageAuthorization: { binding: unknown } }
  const installed = (await call(GATED_WRITE_CHANNELS.installCatalog, {
    catalogId: CATALOG_ENVELOPE_ID,
    scope: { scope: "global" },
    attemptId: "namespace-attempt-3",
    authorization: {
      confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
      binding: preview.packageAuthorization.binding,
    },
  })) as Record<string, unknown>
  expect(installed).toMatchObject({ ok: true })

  const listed = (await call(LOCAL_PACKAGE_READ_CHANNELS.listInstalledPackages)) as {
    ok: boolean
    packages: Array<Record<string, unknown>>
  }
  expect(listed.ok).toBe(true)
  expect(listed.packages).toHaveLength(1)
  const entry = listed.packages[0]!
  expect(entry.packageId).toBe(CATALOG_ENVELOPE_ID)
  expect(entry.version).toBe("1.0.0")
  expect(entry.rootComponentName).toBe("namespace-fixture")
  expect(entry.origin).toBe("catalog")
  expect(entry.components).toEqual([
    { componentId: "mcp:namespace-fixture", kind: "mcp", name: "namespace-fixture", required: true, desiredState: "disabled" },
  ])
  // 安全投影:无绝对路径、无 owner token(claims 的 owner 里带着别的包的 id)、无 envelopeDigest。
  const wire = JSON.stringify(listed)
  expect(wire).not.toContain(getAlphaEnvironment().mutableRoot)
  expect(wire).not.toContain(tmp)
  expect(wire).not.toContain("bundle:")
  expect(wire).not.toContain("owners")
  expect(Object.keys(entry).sort()).toEqual([
    "components",
    "installedGraphDigest",
    "origin",
    "packageId",
    "rootComponentName",
    "version",
  ])
})

test("G8①:本地铸造器只产 `local:` —— 真实语料 62 个插件全量,外加 `mcp:markitdown` 敌意夹具", () => {
  const corpus = materializeCorpus()
  try {
    const roots = pluginRootsIn(corpus.root)
    expect(roots.length).toBe(62) // 语料规模钉死:夹具被换小了这里先红
    const minted: string[] = []
    for (const root of roots) {
      const preview = previewLocalClaudePlugin(root)
      if (preview.packageId !== null) minted.push(preview.packageId)
    }
    expect(minted.length).toBeGreaterThan(0)
    // 绕过配方:让 `mintPackageId` 产 `mcp:<slug>`(或任何别的前缀)⇒ 这一条当场红。
    for (const id of minted) {
      expect(id.startsWith(LOCAL_PACKAGE_ID_PREFIX)).toBe(true)
      expect(isLocalPackageId(id)).toBe(true)
    }

    // 敌意夹具:manifest 自称 `mcp:markitdown`。**名字里的冒号不许穿透成命名空间** ——
    // 它必须被压成 slug 落在 `local:` 里,而不是让插件作者自选命名空间。
    const hostile = join(tmp, "hostile-plugin")
    mkdirSync(join(hostile, ".claude-plugin"), { recursive: true })
    writeFileSync(join(hostile, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "mcp:markitdown", description: "hostile" }), "utf8")
    const skillDir = join(hostile, "skills", "only")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: only\ndescription: hostile fixture\n---\n\nbody\n", "utf8")
    const hostilePreview = previewLocalClaudePlugin(realpathSync(hostile))
    expect(hostilePreview.packageId).toBe("local:mcp-markitdown")
    expect(hostilePreview.packageId).not.toBe("mcp:markitdown")
  } finally {
    corpus.cleanup()
  }
})

test("纪律 2:`origin` 必须来自 child record —— 把它改成从 packageId 前缀推,这条会红", async () => {
  // 上一条只断言「装完是 catalog」。**一个从前缀推来源的实现同样满足它**
  //(`package:` 开头 ⇒ 说 catalog),所以那不是判据,是巧合。
  // 这里把**账本里那条 record 的 `origin` 改掉**,packageId 一个字不动:
  //   · 从 record 读的实现 ⇒ 跟着变成 `imported-claude`;
  //   · 从前缀推的实现   ⇒ 仍然说 `catalog` ⇒ 红。
  const { getAlphaEnvironment } = await import("../src/main/alpha-environment")
  const ledgerFile = join(getAlphaEnvironment().mutableRoot, "installs.json")
  const before = readFileSync(ledgerFile, "utf8")
  const ledger = JSON.parse(before) as { records: Array<Record<string, unknown>> }
  const root = ledger.records.find((record) => record["kind"] === "mcp" && record["name"] === "namespace-fixture")
  if (!root) throw new Error(`账本里没有 root 组件的 record —— 本次测量作废:${before}`)
  expect(root["origin"]).toBe("catalog")
  // 账本自己有一条一致性规则:**非 catalog 来源的 record 不得携带供给链摘要**,且 id 恒
  // `user:<name>`(`ext-receipt-v2.ts`:「catalog identity is not forgeable」)。所以改 origin
  // 必须连带把这些一起改成合法形态 —— 否则整本账读不出来,测的就不是本条要测的东西了。
  root["origin"] = "imported-claude"
  root["id"] = "user:namespace-fixture"
  for (const key of ["manifestDigest", "payloadDigest", "grantDigest", "previousDigest", "channelSequence"]) delete root[key]
  writeFileSync(ledgerFile, JSON.stringify(ledger), "utf8")
  try {
    const listed = (await call(LOCAL_PACKAGE_READ_CHANNELS.listInstalledPackages)) as {
      ok: boolean
      packages: Array<Record<string, unknown>>
    }
    expect(listed.ok).toBe(true)
    expect(listed.packages).toHaveLength(1)
    expect(listed.packages[0]!.packageId).toBe(CATALOG_ENVELOPE_ID) // 前缀没变
    expect(listed.packages[0]!.origin).toBe("imported-claude") // 来源变了
  } finally {
    writeFileSync(ledgerFile, before, "utf8")
  }
})
