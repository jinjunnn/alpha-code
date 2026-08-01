import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type {
  AlphaPackageEnvelopeV1,
  PackageProfilePayloadV1,
  PackageSupportedComponentV1,
} from "../shared/host-extension-package-contract/decoder"
import {
  packageEffectiveInstallGraphV1,
  type PackageAdmissionBindingV1,
} from "../shared/package-admission"
import { createPackageAdmissionCoordinator } from "./package-admission"
import { canonicalJson, sha256Hex } from "./ext-manifest-v2"
import { runExtensionTransaction } from "./ext-transaction"

const artifact = resolve(
  import.meta.dir,
  "../../../alpha-contracts-consumer/vendor/alpha-web-extension-package/expected.mcp-remote.compiled.json",
)
const snapshotDigest = "7".repeat(64)
const secretCanary = "REQ128_ADMISSION_SECRET_8d38a2"
let tmp = ""
let root = ""
let userData = ""
const previousRoot = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "package-admission-"))
  root = join(tmp, "root")
  userData = join(tmp, "user-data")
  mkdirSync(root, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = root
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * The **vendored producer output**, unpatched (`#759`). `#749` had to replace this with an inline
 * envelope literal because the then-pinned artifact predated the v2 contract and was refused by
 * design; a hand-built stand-in drifts with the contract and never goes red when it does, which is
 * exactly the `#737` class and is the last thing this — the admission chain — should carry.
 *
 * Nothing is patched. The payload bytes are re-serialised from the corpus's own `payloads` map and
 * must reproduce the digest the *signed envelope* declares; corrupt the artifact file and this
 * throws (or, further down the chain, the host's own integrity gate refuses the package) instead
 * of quietly passing.
 */
async function fixture() {
  const compiled = (await Bun.file(artifact).json()) as {
    envelope: AlphaPackageEnvelopeV1
    payloads: Record<string, PackageProfilePayloadV1>
  }
  const envelope = structuredClone(compiled.envelope)
  const rootComponent = envelope.components.find((component) => component.id === envelope.root)
  if (!rootComponent) throw new Error("producer corpus has no component matching its own root")
  const payload = structuredClone(compiled.payloads[rootComponent.id])
  if (payload?.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
    throw new Error("producer corpus profile drifted")
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
  if (
    bytes.byteLength !== rootComponent.payloadRef.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== rootComponent.payloadRef.sha256
  )
    throw new Error("producer corpus payload bytes do not reproduce their own signed payloadRef")
  return { envelope, bytes, payload }
}

/**
 * 授权集从**产物自己声明的** `requiredSecrets` 推出来,不是手打一个常量列表 —— 上游改密钥集时
 * 这些用例跟着走,而不是各自漂。前缀 `<componentId>#<NAME>` 是宿主 prerequisiteId 的构造规则。
 */
async function secretGrants(value: string, extra: Record<string, string> = {}) {
  const { envelope, payload } = await fixture()
  const behavior = payload.behavior as { requiredSecrets: string[] }
  if (behavior.requiredSecrets.length === 0) throw new Error("producer corpus declares no secrets")
  return {
    secrets: {
      ...Object.fromEntries(behavior.requiredSecrets.map((name) => [`${envelope.root}#${name}`, value])),
      ...extra,
    },
  }
}

function confirmation(preview: {
  authorization: Array<{ key: string; requested: string[] }>
  packageAuthorization: { binding: PackageAdmissionBindingV1 }
}) {
  return {
    confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
    binding: preview.packageAuthorization.binding,
  }
}

describe("package admission", () => {
  test.each([
    [
      "top-level keys such as decidedAt",
      (intent: Record<string, unknown>) => ({ ...intent, decidedAt: "2026-07-31T12:00:00.000Z" }),
      "renderer-supplied key",
    ],
    [
      "attemptId with a leading space",
      (intent: Record<string, unknown>) => ({ ...intent, attemptId: " attempt-invalid" }),
      "invalid attemptId",
    ],
    [
      "grants with an extra key",
      // 违规项是 `extra`,在 grants 形状解码阶段就被拒 —— secrets 里装的是什么与本条无关,
      // 所以这里不走 `secretGrants`(mutate 是同步的,拿不到它)。
      (intent: Record<string, unknown>) => ({
        ...intent,
        grants: { secrets: { ...(intent.grants as { secrets: object }).secrets }, extra: true },
      }),
      "invalid grants",
    ],
    [
      "global scope with an extra projectDir",
      (intent: Record<string, unknown>) => ({
        ...intent,
        scope: { scope: "global", projectDir: "/tmp/not-global" },
      }),
      "invalid scope",
    ],
    [
      "uppercase catalogId",
      (intent: Record<string, unknown>) => ({ ...intent, catalogId: "package:Generic-remote-mcp" }),
      "tampered or is stale",
    ],
    [
      "non-hex authorization binding",
      (intent: Record<string, unknown>) => {
        const changed = structuredClone(intent)
        ;(
          changed.authorization as {
            binding: { snapshotDigest: string }
          }
        ).binding.snapshotDigest = "g".repeat(64)
        return changed
      },
      "invalid authorization binding",
    ],
  ])("coordinator rejects %s before the transaction", async (_name, mutate, reason) => {
    const { envelope, bytes } = await fixture()
    let transactionCalls = 0
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async () => bytes },
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const intent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: `attempt-decode-${_name.replaceAll(" ", "-")}`,
    }
    const preview = await admit(intent)
    if (preview.ok || preview.stage !== "authorize") throw new Error("expected package authorization preview")

    const result = await admit(
      mutate({
        ...intent,
        grants: await secretGrants(secretCanary),
        authorization: confirmation(preview),
      }),
    )

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(reason) })
    expect(transactionCalls).toBe(0)
  })

  // 长度界消费契约的值(decoder 对 packageId 的 max 是 160)。它必须在**第一趟**就拒 ——
  // attempt 正是在第一趟被放进有界的 attempts Map 的,那里才是被攻陷 renderer 的着力点。
  test("coordinator refuses a catalogId beyond the contract bound on the first round", async () => {
    const { envelope, bytes } = await fixture()
    let transactionCalls = 0
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async () => bytes },
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const result = await admit({
      catalogId: `package:${"a".repeat(200)}`,
      scope: { scope: "global" as const },
      attemptId: "attempt-catalogid-bound",
    })
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("invalid catalogId") })
    expect(transactionCalls).toBe(0)
  })

  test("coordinator correlates a non-package namespace through decoded catalog identity", async () => {
    const { envelope, bytes } = await fixture()
    envelope.prelude.packageId = "skill:contract-package"
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async () => bytes },
    })

    const preview = await admit({
      catalogId: "skill:contract-package",
      scope: { scope: "global" },
      attemptId: "attempt-contract-package",
    })
    expect(preview).toMatchObject({
      ok: false,
      stage: "authorize",
      packageAuthorization: { plan: { packageId: "skill:contract-package" } },
    })
  })

  test("actual transaction writes the signed secret prerequisite into the restricted version directory", async () => {
    const { envelope, bytes, payload } = await fixture()
    let transactionCalls = 0
    let payloadFetches = 0
    const order: string[] = []
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: {
        fetchPayload: async () => {
          payloadFetches++
          order.push(payloadFetches === 1 ? "preview" : "revalidate")
          expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)
          return bytes
        },
      },
      secretVersionId: () => "v-12345678",
      transaction: async (...args) => {
        transactionCalls++
        order.push("transaction")
        return runExtensionTransaction(args[0], args[1], {
          ...args[2],
          populatePrepared: async () => {
            order.push("populate-prepared")
            await args[2].populatePrepared?.()
          },
          probePrepared: async () => {
            order.push("probe-prepared")
            return (
              (await args[2].probePrepared?.()) ?? {
                healthy: false,
                reason: "package test expected a prepared probe",
              }
            )
          },
          commitReceipt: (records) => {
            order.push("commit-receipt")
            return args[2].commitReceipt?.(records)
          },
        })
      },
    })
    const intent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-e2e",
    }
    expect(
      await admit({
        ...intent,
        grants: await secretGrants(secretCanary),
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("only after the authorization preview"),
    })
    expect(transactionCalls).toBe(0)
    expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)

    const first = await admit(intent)
    expect(first).toMatchObject({ ok: false, stage: "authorize" })
    if (first.ok || first.stage !== "authorize") throw new Error("expected package authorization preview")
    expect(transactionCalls).toBe(0)
    expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)

    const second = await admit({
      ...intent,
      grants: await secretGrants(secretCanary),
      authorization: confirmation(first),
    })
    expect(second).toMatchObject({
      ok: true,
      kind: "mcp",
      name: "generic-remote",
      installedDisabled: true,
    })
    expect(transactionCalls).toBe(1)
    // 语料声明了几个密钥就要落几个。只钉第一个名字的话,宿主静默丢掉第二个密钥仍然全绿 ——
    // 而用户拿到的是一个连不上的 MCP。名字来自**产物自己**,不是这里手打的常量。
    const versionDir = join(userData, "alpha-mcp-secrets", "generic-remote", "v-12345678")
    const declaredSecrets = (payload.behavior as { requiredSecrets: string[] }).requiredSecrets
    expect(declaredSecrets.length).toBeGreaterThan(1)
    expect(readdirSync(versionDir).sort()).toEqual([...declaredSecrets].sort())
    const config = readFileSync(join(root, "alpha.jsonc"), "utf8")
    for (const name of declaredSecrets) {
      const secretFile = join(versionDir, name)
      expect(readFileSync(secretFile, "utf8"), name).toBe(secretCanary)
      expect(statSync(secretFile).mode & 0o777, name).toBe(0o600)
      expect(config, name).toContain(`{file:${secretFile}}`)
    }
    expect(config).not.toContain(secretCanary)
    expect(existsSync(join(root, "installs.json"))).toBe(true)
    expect(existsSync(join(root, "ext-store", "mcp--generic-remote", "grants.json"))).toBe(true)
    expect(order).toEqual([
      "preview",
      "revalidate",
      "transaction",
      "populate-prepared",
      "probe-prepared",
      "commit-receipt",
    ])
  })

  test("cancel, binding tamper, stale revalidation, and replay have zero transaction or secret side effects", async () => {
    const { envelope, bytes } = await fixture()
    const changedEnvelope = structuredClone(envelope)
    const changedPayload = JSON.parse(new TextDecoder().decode(bytes)) as PackageProfilePayloadV1
    if (changedPayload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
      throw new Error("producer corpus profile drifted")
    changedPayload.behavior.url = `${changedPayload.behavior.url}?revision=2`
    const changedBytes = new TextEncoder().encode(`${JSON.stringify(changedPayload, null, 2)}\n`)
    changedEnvelope.components[0].payloadRef.bytes = changedBytes.byteLength
    changedEnvelope.components[0].payloadRef.sha256 = createHash("sha256").update(changedBytes).digest("hex")
    let loads = 0
    let transactionCalls = 0
    let changingPackage = false
    let activeBytes = bytes
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => {
        const changed = changingPackage && ++loads % 2 === 0
        activeBytes = changed ? changedBytes : bytes
        return {
          source: "remote",
          catalog: {
            version: "1",
            entries: [{}],
            packages: [changed ? changedEnvelope : envelope],
          },
          snapshotDigest,
        }
      },
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: { fetchPayload: async () => activeBytes },
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const preview = async (attemptId: string) => {
      const result = await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId,
      })
      if (result.ok || result.stage !== "authorize") throw new Error(`expected preview: ${JSON.stringify(result)}`)
      return result
    }

    const cancelled = await preview("attempt-cancel")
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-cancel",
        authorization: confirmation(cancelled),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("secret-cancelled") })

    const undeclared = await preview("attempt-secret-undeclared")
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-secret-undeclared",
        // 签名声明的全部密钥都给足,**外加**一个没人签名的 —— 违规项排在排序后的中间,
        // 「只看第一个/最后一个」的实现要能被抓住。
        grants: await secretGrants(secretCanary, { "mcp:generic-remote#B_KEY": "not-signed" }),
        authorization: confirmation(undeclared),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("secret-undeclared") })

    const capabilityTamper = await preview("attempt-capability-tamper")
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-capability-tamper",
        grants: await secretGrants(secretCanary),
        authorization: {
          ...confirmation(capabilityTamper),
          confirmed: { "mcp--generic-remote": [] },
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("does not exactly match") })

    // 枚举必须覆盖 binding 的**每一个**字段。漏掉一个 = 那个字段的绑定可以被 renderer 改写而
    // 无人发现,闸门对它就是假的。`graphDigest` 之前恰好不在这条枚举里。
    expect(Object.keys(cancelled.packageAuthorization.binding).sort()).toEqual([
      "capabilityDigest",
      "envelopeDigest",
      "graphDigest",
      "itemDigests",
      "snapshotDigest",
    ])
    for (const field of [
      "snapshotDigest",
      "envelopeDigest",
      "graphDigest",
      "itemDigests",
      "capabilityDigest",
    ] as const) {
      const attemptId = `attempt-tamper-${field}`
      const first = await preview(attemptId)
      const binding = structuredClone(first.packageAuthorization.binding)
      if (field === "itemDigests") binding.itemDigests[envelope.components[0].id] = "9".repeat(64)
      else binding[field] = "9".repeat(64)
      expect(
        await admit({
          catalogId: envelope.prelude.packageId,
          scope: { scope: "global" },
          attemptId,
          grants: await secretGrants(secretCanary),
          authorization: { ...confirmation(first), binding },
        }),
      ).toMatchObject({ ok: false, reason: expect.stringContaining("tampered") })
    }

    changingPackage = true
    loads = 0
    const stale = await preview("attempt-stale")
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-stale",
        grants: await secretGrants(secretCanary),
        authorization: confirmation(stale),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("facts changed") })
    expect(loads).toBe(2)
    expect(changedEnvelope.components[0].capabilities).toEqual(envelope.components[0].capabilities)
    expect(changedEnvelope.components[0].payloadRef.sha256).not.toBe(envelope.components[0].payloadRef.sha256)

    changingPackage = false
    const replay = await preview("attempt-replay")
    const authorized = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" },
      attemptId: "attempt-replay",
      grants: await secretGrants(secretCanary),
      authorization: confirmation(replay),
    }
    expect((await admit(authorized)).ok).toBe(true)
    expect(await admit(authorized)).toMatchObject({ ok: false, reason: expect.stringContaining("replayed") })
    expect(
      await admit({
        catalogId: envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: "attempt-replay",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("replayed") })
    expect(transactionCalls).toBe(1)
    expect(
      readdirSync(join(userData, "alpha-mcp-secrets", "generic-remote")).filter((name) => name.startsWith("v-")),
    ).toHaveLength(1)
  })

  // #712 退出门(正面断言,不是「我们没写」):把安装成功与安装失败两条路径跑完之后,**扫描**
  // 事务根下的每一个文件 + 引擎/恢复吐出的每一条日志 + 回给 renderer 的结果对象,断言
  //   ① 密钥明文一次都不出现;② 明文的 sha256 一次都不出现(摘要同样是泄露);
  //   ③ 密钥 store 的绝对路径**只**出现在 live config 里(它是引用通道),journal / 账本 /
  //      授权收据 / 日志 / IPC 结果里一次都不出现 —— journal 里绝不留任意绝对删除路径。
  test("no secret value, value digest, or absolute secret path leaves the reference channel", async () => {
    const { envelope, bytes } = await fixture()
    const okCanary = "REQ128_712_SCAN_OK_1f4c7a"
    const failCanary = "REQ128_712_SCAN_FAIL_9b2e50"
    const digest = (v: string) => createHash("sha256").update(v).digest("hex")
    const logs: string[] = []
    const dependencies = {
      loadVerifiedCatalog: async () => ({
        source: "remote" as const,
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev" as const,
      installability: { fetchPayload: async () => bytes },
    }
    const withLogCapture =
      (extra: Record<string, unknown> = {}) =>
      (...args: Parameters<typeof runExtensionTransaction>) =>
        runExtensionTransaction(args[0], args[1], {
          ...args[2],
          log: (event, detail) => logs.push(`${event} ${JSON.stringify(detail)}`),
          ...extra,
        })

    const install = async (admit: ReturnType<typeof createPackageAdmissionCoordinator>, attemptId: string, secret: string) => {
      const intent = { catalogId: envelope.prelude.packageId, scope: { scope: "global" as const }, attemptId }
      const preview = await admit(intent)
      if (preview.ok || preview.stage !== "authorize") throw new Error("expected package authorization preview")
      return admit({ ...intent, grants: await secretGrants(secret), authorization: confirmation(preview) })
    }

    // ① 成功装一次(密钥进版本目录,config 只拿 {file:} 引用)。
    const okOutcome = await install(
      createPackageAdmissionCoordinator({ ...dependencies, secretVersionId: () => "v-1111aaaa", transaction: withLogCapture() }),
      "attempt-scan-ok",
      okCanary,
    )
    expect(okOutcome).toMatchObject({ ok: true, kind: "mcp" })

    // ② 再走一次失败路径(prepared probe 不健康 → abort + 释放),让失败面的痕迹也进扫描。
    const failOutcome = await install(
      createPackageAdmissionCoordinator({
        ...dependencies,
        secretVersionId: () => "v-2222bbbb",
        transaction: withLogCapture({ probePrepared: () => ({ healthy: false, reason: "injected for the scan gate" }) }),
      }),
      "attempt-scan-fail",
      failCanary,
    )
    expect(failOutcome).toMatchObject({ ok: false })
    expect(existsSync(join(userData, "alpha-mcp-secrets", "generic-remote", "v-2222bbbb"))).toBe(false)

    const secretStore = join(userData, "alpha-mcp-secrets")
    const liveConfig = join(root, "alpha.jsonc")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) files.push(full)
      }
    }
    walk(root)
    expect(files.length).toBeGreaterThan(2) // 扫描面非空(journal + 账本 + config 至少三件)
    const journals = files.filter((f) => f.includes(`${sep}ext-tx${sep}journal${sep}`))
    expect(journals.length).toBeGreaterThan(0) // 本用例真的产生了 journal —— 否则下面的断言是空的

    const carriesSecretPath: string[] = []
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      for (const canary of [okCanary, failCanary]) {
        expect(text).not.toContain(canary)
        expect(text).not.toContain(digest(canary))
      }
      if (text.includes(secretStore)) carriesSecretPath.push(file)
    }
    // 绝对密钥路径**只**存在于 live config(引用通道);journal / installs.json / grants.json 一律没有。
    expect(carriesSecretPath).toEqual([liveConfig])
    for (const journal of journals) {
      const text = readFileSync(journal, "utf8")
      expect(text).not.toContain(secretStore)
      expect(text).toContain("mcp-secret-version") // 身份确实在 journal 里(否则上一条是空断言)
    }

    // 日志与回给 renderer 的结果对象同样干净。
    expect(logs.length).toBeGreaterThan(0)
    const wire = `${logs.join("\n")}\n${JSON.stringify(okOutcome)}\n${JSON.stringify(failOutcome)}`
    for (const canary of [okCanary, failCanary]) {
      expect(wire).not.toContain(canary)
      expect(wire).not.toContain(digest(canary))
    }
    expect(wire).not.toContain(secretStore)
  })

  test("prepared secret failures abort and remove every unreferenced version", async () => {
    const { envelope, bytes } = await fixture()
    const secretRoot = join(userData, "alpha-mcp-secrets", "generic-remote")
    const dependencies = {
      loadVerifiedCatalog: async () => ({
        source: "remote" as const,
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev" as const,
      installability: { fetchPayload: async () => bytes },
    }

    const populateFailure = createPackageAdmissionCoordinator({
      ...dependencies,
      secretVersionId: () => "v-deadbeef",
      transaction: (...args) =>
        runExtensionTransaction(args[0], args[1], {
          ...args[2],
          populatePrepared: async () => {
            await args[2].populatePrepared?.()
            throw new Error("injected prepared secret write failure")
          },
        }),
    })
    const populateIntent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-populate-failure",
    }
    const populatePreview = await populateFailure(populateIntent)
    if (populatePreview.ok || populatePreview.stage !== "authorize")
      throw new Error("expected package authorization preview")
    expect(
      await populateFailure({
        ...populateIntent,
        grants: await secretGrants(secretCanary),
        authorization: confirmation(populatePreview),
      }),
    ).toMatchObject({ ok: false })
    expect(readdirSync(secretRoot)).toEqual([])

    const unhealthyProbe = createPackageAdmissionCoordinator({
      ...dependencies,
      secretVersionId: () => "v-cafebabe",
      transaction: (...args) =>
        runExtensionTransaction(args[0], args[1], {
          ...args[2],
          probePrepared: () => ({ healthy: false, reason: "injected unhealthy prepared secret" }),
        }),
    })
    const probeIntent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-unhealthy-probe",
    }
    const probePreview = await unhealthyProbe(probeIntent)
    if (probePreview.ok || probePreview.stage !== "authorize") throw new Error("expected package authorization preview")
    expect(
      await unhealthyProbe({
        ...probeIntent,
        grants: await secretGrants(secretCanary),
        authorization: confirmation(probePreview),
      }),
    ).toMatchObject({ ok: false })
    expect(readdirSync(secretRoot)).toEqual([])
  })

  test("preexisting and lock-raced handwritten MCP config is never adopted or overwritten", async () => {
    const { envelope, bytes } = await fixture()
    const configPath = join(root, "alpha.jsonc")
    const handwritten =
      '{\n  // user-owned MCP leaf\n  "mcp": {\n    "generic-remote": { "type": "remote", "url": "https://user.example/mcp" }\n  }\n}\n'
    const dependencies = {
      loadVerifiedCatalog: async () => ({
        source: "remote" as const,
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev" as const,
      installability: { fetchPayload: async () => bytes },
    }

    writeFileSync(configPath, handwritten)
    let transactionCalls = 0
    const preexisting = createPackageAdmissionCoordinator({
      ...dependencies,
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const preexistingIntent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-preexisting-mcp",
    }
    const preexistingPreview = await preexisting(preexistingIntent)
    if (preexistingPreview.ok || preexistingPreview.stage !== "authorize")
      throw new Error("expected package authorization preview")
    expect(
      await preexisting({
        ...preexistingIntent,
        grants: await secretGrants(secretCanary),
        authorization: confirmation(preexistingPreview),
      }),
    ).toMatchObject({ ok: false })
    expect(transactionCalls).toBe(0)
    expect(readFileSync(configPath, "utf8")).toBe(handwritten)

    writeFileSync(configPath, "{}\n")
    const raced = createPackageAdmissionCoordinator({
      ...dependencies,
      secretVersionId: () => "v-feedface",
      transaction: async (...args) => {
        transactionCalls++
        writeFileSync(configPath, handwritten)
        return runExtensionTransaction(...args)
      },
    })
    const racedIntent = {
      catalogId: envelope.prelude.packageId,
      scope: { scope: "global" as const },
      attemptId: "attempt-raced-mcp",
    }
    const racedPreview = await raced(racedIntent)
    if (racedPreview.ok || racedPreview.stage !== "authorize") throw new Error("expected package authorization preview")
    expect(
      await raced({
        ...racedIntent,
        grants: await secretGrants(secretCanary),
        authorization: confirmation(racedPreview),
      }),
    ).toMatchObject({ ok: false })
    expect(transactionCalls).toBe(1)
    expect(readFileSync(configPath, "utf8")).toBe(handwritten)
  })

  /**
   * `graphDigest` claims to bind the effective install graph independently. A key-shape assertion
   * cannot tell that claim from a constant: replacing the production computation with
   * `"0".repeat(64)` used to leave the whole suite green. So assert the **value**, derived from the
   * signed envelope through the shared graph builder, for two packages whose graphs differ — one
   * value alone can always be hard-coded.
   */
  test("graphDigest is the canonical hash of the effective install graph, and two graphs never share one", async () => {
    const { envelope, bytes } = await fixture()
    const other = structuredClone(envelope)
    const otherPayload = JSON.parse(new TextDecoder().decode(bytes)) as PackageProfilePayloadV1
    if (otherPayload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
      throw new Error("producer corpus profile drifted")
    otherPayload.behavior.url = `${otherPayload.behavior.url}other/`
    const otherBytes = new TextEncoder().encode(`${JSON.stringify(otherPayload, null, 2)}\n`)
    other.components[0].payloadRef.bytes = otherBytes.byteLength
    other.components[0].payloadRef.sha256 = createHash("sha256").update(otherBytes).digest("hex")

    const bindingOf = async (signed: AlphaPackageEnvelopeV1, payloadBytes: Uint8Array, attemptId: string) => {
      const admit = createPackageAdmissionCoordinator({
        loadVerifiedCatalog: async () => ({
          source: "remote",
          catalog: { version: "1", entries: [{}], packages: [signed] },
          snapshotDigest,
        }),
        root: () => root,
        userDataPath: userData,
        environment: () => "dev",
        installability: { fetchPayload: async () => payloadBytes },
      })
      const preview = await admit({ catalogId: signed.prelude.packageId, scope: { scope: "global" }, attemptId })
      if (preview.ok || preview.stage !== "authorize") throw new Error(`expected preview: ${JSON.stringify(preview)}`)
      return preview.packageAuthorization.binding
    }
    // 期望值从**签名信封**独立推出来,不是从生产的 facts.graph 抄一份。
    const expected = (signed: AlphaPackageEnvelopeV1) =>
      sha256Hex(
        canonicalJson(
          packageEffectiveInstallGraphV1(signed, [
            signed.components[0] as unknown as PackageSupportedComponentV1,
          ]),
        ),
      )

    const first = await bindingOf(envelope, bytes, "attempt-graph-digest-1")
    const second = await bindingOf(other, otherBytes, "attempt-graph-digest-2")
    expect(first.graphDigest).toBe(expected(envelope))
    expect(second.graphDigest).toBe(expected(other))
    expect(first.graphDigest).not.toBe(second.graphDigest)
    // 不是把 envelopeDigest 换个名字放第二遍 —— 那样它绑的就不是这条闸门声称的东西。
    expect(first.graphDigest).not.toBe(first.envelopeDigest)
    expect(first.graphDigest).not.toBe(first.itemDigests[envelope.components[0].id])
  })

  /**
   * §5.1 门二 at the real entry point. The gate reads the **signed** component count, not the
   * effective graph: a Bundle whose only unsupported child is optional has an effective graph of
   * length 1, so an effective-length gate lets it through and installs the root alone — a half
   * installed package the user can see. Nothing may reach the transaction.
   */
  test("a signed two-component Bundle is refused before any payload fetch or transaction", async () => {
    const { envelope, bytes } = await fixture()
    const leafPayload = {
      schema: "alpha.host-extension-package.payload.agent.v1",
      behavior: {
        targetDir: "alpha-agents",
        asset: {
          sha256: "b".repeat(64),
          bytes: 1,
          mediaType: "text/markdown",
          url: "https://example.invalid/leaf.md",
        },
      },
    }
    const leafBytes = new TextEncoder().encode(`${JSON.stringify(leafPayload, null, 2)}\n`)
    const bundle = structuredClone(envelope)
    bundle.components[0].dependencies = ["agent:bundle-leaf"]
    bundle.components.push({
      id: "agent:bundle-leaf",
      required: false,
      dependencies: [],
      profileId: "agent",
      profileVersion: 1,
      // 未知 capability ⇒ optional leaf 被 skip ⇒ 有效图长度回到 1。审计方正是从这里绕过去的。
      capabilities: ["alpha.future.v1"],
      payloadRef: {
        sha256: createHash("sha256").update(leafBytes).digest("hex"),
        bytes: leafBytes.byteLength,
        mediaType: "application/vnd.alpha.host-extension-package.agent.v1+json",
        url: "https://example.invalid/leaf-payload.json",
      },
    } as unknown as (typeof bundle.components)[number])
    bundle.capabilities = ["alpha.future.v1", "alpha.secret-prerequisite.v1"]

    let fetches = 0
    let transactionCalls = 0
    const admit = createPackageAdmissionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [bundle] },
        snapshotDigest,
      }),
      root: () => root,
      userDataPath: userData,
      environment: () => "dev",
      installability: {
        fetchPayload: async (ref) => {
          fetches++
          return ref.mediaType.includes(".agent.") ? leafBytes : bytes
        },
      },
      transaction: async (...args) => {
        transactionCalls++
        return runExtensionTransaction(...args)
      },
    })
    const refused = await admit({
      catalogId: bundle.prelude.packageId,
      scope: { scope: "global" },
      attemptId: "attempt-signed-bundle",
    })
    expect(refused).toMatchObject({ ok: false, reason: "package-bundle-activation-pending" })
    if (refused.ok || refused.stage === "authorize") throw new Error("Bundle must never reach the preview")
    expect(refused.package?.verdict).toBe("blocked")
    expect(refused.package?.action.enabled).toBe(false)
    // 挡住的是动作,不是可见性:被跳过的子件仍如实呈现,原因码逐字来自 decoder。
    expect(refused.package?.components.map((entry) => [entry.componentId, entry.included])).toEqual([
      ["mcp:generic-remote", true],
      ["agent:bundle-leaf", false],
    ])
    expect(fetches, "永不安装的包不该产生任何网络请求").toBe(0)
    expect(transactionCalls).toBe(0)
    expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)
  })
})
