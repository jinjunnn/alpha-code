// REQ-235 C1 main 半场:一个 root 档案为 `cloud@1` 的签名包,走**生产 evaluator → 生产 admission →
// 真 `runExtensionTransaction` → 真 V3 账本 → 生产整包卸载**。
//
// 信封与载荷取自宿主自己发布的 decoder 语料 `cloud-v1`(字节就是 artifact 里那一份),不手搓形状。
// 钉住四件事:
//   · F4 安全视图投影:compatible 时 `cloud` 恰是解码后的 behavior,其它包与非 compatible 恒缺席;
//   · I10:预览 / 确认 / binding / 事务 / `grants.json` 看到的都是 `["cloud:dispatch"]`,不是载荷派生的 `[]`;
//   · receipts-only:只写账本记录与授权账,零文件、零引擎 config;
//   · 卸载删 record **并**删 `grants.json`(不然重装会把旧授权当成已确认基线)。

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AlphaPackageEnvelopeV1, CloudPayloadV1 } from "../shared/host-extension-package-contract/decoder"
import { canonicalArtifactJsonBytesV1, HOST_EXTENSION_PACKAGE_CORPUS } from "../shared/host-extension-package-contract/generate-artifact"
import type { PackageAdmissionPreviewV1 } from "../shared/package-admission"
import { readCapabilityGrant } from "./ext-capability-grants"
import { removeInstallGrants } from "./ext-install-planner"
import { uninstallPackageV1, type PackageArtifactInstallersV1 } from "./ext-package-uninstall"
import { findRecordV2, readPackageGraphs } from "./ext-receipt-v2"
import { runExtensionTransaction } from "./ext-transaction"
import { createPackageAdmissionCoordinator } from "./package-admission"
import { evaluatePackageForHost } from "./package-installability"

type CorpusCase = {
  name: string
  envelope: AlphaPackageEnvelopeV1
  components: Array<{ id: string; payload: Record<string, unknown> | null }>
}
const corpus = (await Bun.file(
  resolve(import.meta.dir, "../shared/host-extension-package-contract", HOST_EXTENSION_PACKAGE_CORPUS),
).json()) as { cases: CorpusCase[] }
const caseNamed = (name: string) => structuredClone(corpus.cases.find((item) => item.name === name)!)
const cloudCase = caseNamed("cloud-v1")
const cloudPayload = cloudCase.components[0]!.payload as CloudPayloadV1
const packageId = cloudCase.envelope.prelude.packageId
const componentName = cloudCase.envelope.root.slice(cloudCase.envelope.root.indexOf(":") + 1)
const grantKey = `cloud--${componentName}`
// 语料的 payloadRef 摘要算在 canonical 字节上 —— 喂回同一份字节,摘要与字节数两道核对都是真的。
const bytesOf = (item: CorpusCase) => (ref: { url: string }) => {
  const component = item.envelope.components.find((entry) => entry.payloadRef.url === ref.url)!
  const payload = item.components.find((entry) => entry.id === component.id)!.payload!
  return Promise.resolve(canonicalArtifactJsonBytesV1(payload))
}

const snapshotDigest = "5".repeat(64)
let tmp = ""
let root = ""
let userData = ""
const previousRoot = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "req235-cloud-package-"))
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

function coordinator(transactionCalls: { count: number }) {
  return createPackageAdmissionCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: [cloudCase.envelope] },
      snapshotDigest,
    }),
    root: () => root,
    userDataPath: userData,
    casBaseRoot: () => userData,
    environment: () => "dev",
    installability: { fetchPayload: bytesOf(cloudCase) },
    fetchAsset: async () => {
      throw new Error("a cloud package has no asset to fetch")
    },
    transaction: (...args) => {
      transactionCalls.count++
      return runExtensionTransaction(...args)
    },
  })
}

const previewOf = (outcome: unknown): PackageAdmissionPreviewV1 => {
  const staged = outcome as { ok: boolean; packageAuthorization?: PackageAdmissionPreviewV1 }
  if (staged.ok || !staged.packageAuthorization) throw new Error(`expected a preview, got ${JSON.stringify(outcome).slice(0, 300)}`)
  return staged.packageAuthorization
}

const refusingInstallers = (): PackageArtifactInstallersV1 => {
  const refuse = (what: string) => () => {
    throw new Error(`a cloud child must not reach ${what}`)
  }
  return {
    removeFsInstall: refuse("removeFsInstall"),
    removeMcpConfig: refuse("removeMcpConfig"),
    removeCommandConfig: refuse("removeCommandConfig"),
    removeMcpSecretsStrict: refuse("removeMcpSecretsStrict"),
    releaseAlphaConnectionBindings: refuse("releaseAlphaConnectionBindings"),
    removeInstallGrants,
    removePluginPath: refuse("removePluginPath"),
  }
}

describe("REQ-235 cloud@1 package: safe view projection (F4)", () => {
  test("a compatible cloud root projects exactly the decoded behavior", async () => {
    const view = await evaluatePackageForHost(cloudCase.envelope, { fetchPayload: bytesOf(cloudCase) })
    expect(view.verdict).toBe("compatible")
    expect(view.action).toEqual({ kind: "install", enabled: true, reasonCode: "package-compatible" })
    expect(view.prerequisites).toEqual({ status: "ready", items: [] })
    expect(view.cloud).toEqual(cloudPayload.behavior)
  })

  test("non-cloud packages and refused cloud packages carry no cloud key", async () => {
    const skill = caseNamed("skill-v1")
    expect("cloud" in (await evaluatePackageForHost(skill.envelope, { fetchPayload: bytesOf(skill) }))).toBe(false)

    // 同样的签名字节,但载荷里两个字段同名 ⇒ 解码拒 ⇒ blocked,不是半张表单。
    const broken = structuredClone(cloudCase)
    const payload = broken.components[0]!.payload as CloudPayloadV1
    payload.behavior.fixed = [{ name: "prompt", value: "duplicate" }]
    const bytes = canonicalArtifactJsonBytesV1(payload)
    broken.envelope.components[0]!.payloadRef = {
      ...broken.envelope.components[0]!.payloadRef,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    }
    const refused = await evaluatePackageForHost(broken.envelope, { fetchPayload: bytesOf(broken) })
    expect(refused.verdict).toBe("blocked")
    expect(refused.action.reasonCode).toBe("package-payload-invalid")
    expect("cloud" in refused).toBe(false)

    // 一个名字进不了 `ext-store/cloud--<name>/` 的组件,在 browse 阶段就拒,而不是写盘时被账本拒。
    const unsafe = structuredClone(cloudCase)
    const badId = `cloud:${"x".repeat(65)}`
    unsafe.envelope.components[0]!.id = badId
    unsafe.envelope.root = badId
    const unsafeView = await evaluatePackageForHost(unsafe.envelope, { fetchPayload: bytesOf(unsafe) })
    expect(unsafeView.verdict).toBe("blocked")
    expect("cloud" in unsafeView).toBe(false)
  })
})

describe("REQ-235 cloud@1 package: authorization, receipts-only install, uninstall (I10)", () => {
  test("preview, confirmation, transaction and grants all carry cloud:dispatch; only a receipt is written", async () => {
    const calls = { count: 0 }
    const admit = coordinator(calls)
    const intent = { catalogId: packageId, scope: { scope: "global" as const }, attemptId: "attempt-cloud-1" }
    const preview = previewOf(await admit(intent))
    expect(calls.count).toBe(0)
    expect(preview.items).toEqual([
      { key: grantKey, previous: null, requested: ["cloud:dispatch"], added: ["cloud:dispatch"], removed: [], requiresConfirmation: true },
    ])
    expect(preview.plan.items).toHaveLength(1)
    expect(preview.plan.items[0]).toMatchObject({
      included: true,
      role: "root",
      key: grantKey,
      kind: "cloud",
      name: componentName,
      capabilities: ["cloud:dispatch"],
      prerequisites: [],
      operations: ["write-install-record", "write-capability-grant"],
    })

    // 确认集必须恰等于预览集:按载荷派生的空集确认 ⇒ 拒,零事务。
    const underConfirmed = await admit({
      ...intent,
      authorization: { confirmed: { [grantKey]: [] }, binding: preview.binding },
    })
    expect(underConfirmed.ok).toBe(false)
    expect(calls.count).toBe(0)

    const second = previewOf(await admit({ ...intent, attemptId: "attempt-cloud-2" }))
    const result = await admit({
      ...intent,
      attemptId: "attempt-cloud-2",
      authorization: { confirmed: { [grantKey]: ["cloud:dispatch"] }, binding: second.binding },
    })
    expect(result, JSON.stringify(result).slice(0, 300)).toMatchObject({ ok: true, kind: "cloud", name: componentName, installed: [cloudCase.envelope.root], activateMcp: [] })
    expect(calls.count).toBe(1)

    const record = findRecordV2(root, "cloud", componentName)
    expect(record).toMatchObject({ id: cloudCase.envelope.root, kind: "cloud", desiredState: "enabled", origin: "catalog" })
    expect(record?.files ?? []).toEqual([])
    expect(record?.configKey).toBeUndefined()
    expect(readCapabilityGrant(root, grantKey)?.capabilities).toEqual(["cloud:dispatch"])
    expect(existsSync(join(root, "alpha.jsonc"))).toBe(false)
    const graphs = readPackageGraphs(root)
    expect(graphs.ok && graphs.packageGraphs.map((graph) => [graph.packageId, graph.root.kind, graph.root.name])).toEqual([
      [packageId, "cloud", componentName],
    ])
  })

  test("uninstall removes the receipt and the grant; a reinstall asks again", async () => {
    const calls = { count: 0 }
    const admit = coordinator(calls)
    const intent = { catalogId: packageId, scope: { scope: "global" as const } }
    const first = previewOf(await admit({ ...intent, attemptId: "attempt-cloud-a" }))
    const installed = await admit({
      ...intent,
      attemptId: "attempt-cloud-a",
      authorization: { confirmed: { [grantKey]: ["cloud:dispatch"] }, binding: first.binding },
    })
    expect(installed.ok).toBe(true)
    expect(readCapabilityGrant(root, grantKey)).not.toBeNull()

    const removed = uninstallPackageV1(packageId, { globalRoot: () => root, installers: refusingInstallers() })
    expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true, removed: [{ kind: "cloud", name: componentName }] })
    expect(findRecordV2(root, "cloud", componentName)).toBeNull()
    expect(readCapabilityGrant(root, grantKey)).toBeNull()
    const graphs = readPackageGraphs(root)
    expect(graphs.ok && graphs.packageGraphs).toEqual([])

    const again = previewOf(await admit({ ...intent, attemptId: "attempt-cloud-b" }))
    expect(again.items[0]).toMatchObject({ key: grantKey, previous: null, requiresConfirmation: true })
  })
})
