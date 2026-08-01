// REQ-128 #712 —— 事务根**之外**的受限资源(prepared resource)在引擎里的完整生命周期。
//
// 本票之前,受限密钥版本只是一对匿名闭包(populatePrepared / probePrepared):它在授权终闸之后
// 就已经落盘,而 journal 里没有任何东西知道它存在。进程死在 populate 与提交之间 ⇒ 磁盘上留着一
// 个 0600 的密钥目录,恢复既无从保留也无从清理,因为**没有人知道要去看哪里**。
//
// 增量因此是数据模型的:身份进 journal(只进身份),释放归引擎调度,在线失败路径与崩溃恢复走
// 同一个接缝。本文件按这四条断言:
//   ① 形状闸在**写盘前**:未登记 kind/store、非安全路径段、任何超出身份的字段(值/摘要/绝对
//      路径)= 零副作用拒绝;
//   ② 身份**先于** populate 落盘 —— populate 闭包里读磁盘 journal 就已经能看见它;
//   ③ 提交成功 = 绝不释放;abort / rollback = 释放恰好一次,且发生在 journal 终态化之前;
//   ④ 崩溃后恢复做同一件事:收敛成 aborted/rolled-back → 释放;前滚成 committed → 不释放。
//
// 全部真盘临时目录,可注入面走参数 DI(仓规:零 mock.module)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  ExtTxCrashError,
  readTransactionJournal,
  recoverExtensionTransactions,
  runExtensionTransaction,
  validatePreparedResources,
  type HealthProbe,
  type TxCommitRecord,
  type TxFileSpec,
  type TxPlan,
  type TxPreparedResourceV1,
} from "./ext-transaction"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tx-prepared-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const noop = () => {}
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex")
const healthyProbe: HealthProbe = () => ({ healthy: true })

const BODY = "prepared fixture skill body"
const FILES: TxFileSpec[] = [{ path: "SKILL.md", sha256: sha(BODY), size: Buffer.byteLength(BODY) }]

const DESCRIPTOR: TxPreparedResourceV1 = {
  kind: "mcp-secret-version",
  store: "alpha-mcp-secrets",
  server: "demo",
  version: "v-deadbeefcafe",
}

function planWith(prepared?: TxPreparedResourceV1[]): TxPlan {
  return {
    items: [{ key: "skill--prepared", files: FILES, manifestDigest: `sha256:${sha("skill--prepared")}`, receipt: { id: "skill:prepared" } }],
    ...(prepared ? { prepared } : {}),
  }
}

/** 受限资源的替身:root **之外**的一个目录(与真实密钥 store 同拓扑 —— 事务不许直接删它)。 */
function preparedDirOf(): string {
  return path.join(root, "..", `prepared-store-${path.basename(root)}`, DESCRIPTOR.server, DESCRIPTOR.version)
}

function makeHooks(released: TxPreparedResourceV1[][], extra: Record<string, unknown> = {}) {
  const dir = preparedDirOf()
  return {
    populate: (_item: unknown, stagingDir: string) => fs.writeFileSync(path.join(stagingDir, "SKILL.md"), BODY),
    populatePrepared: () => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(dir, "A_KEY"), "PREPARED_CANARY_VALUE", { mode: 0o600 })
    },
    probePrepared: () => ({ healthy: fs.existsSync(path.join(dir, "A_KEY")), reason: "prepared file missing" }) as const,
    releasePrepared: (resources: TxPreparedResourceV1[]) => {
      released.push(resources.map((r) => ({ ...r })))
      fs.rmSync(path.join(dir, ".."), { recursive: true, force: true })
    },
    probe: healthyProbe,
    commitReceipt: noop as (records: TxCommitRecord[]) => void,
    log: noop,
    ...extra,
  }
}

afterEach(() => {
  fs.rmSync(path.join(preparedDirOf(), "..", ".."), { recursive: true, force: true })
})

describe("#712 prepared resource — 形状闸(写盘前)", () => {
  test.each([
    ["未登记 kind", { ...DESCRIPTOR, kind: "ssh-key" }, "unknown prepared resource kind"],
    ["未登记 store", { ...DESCRIPTOR, store: "some-other-store" }, "unknown prepared resource store"],
    ["带路径分隔符的 server", { ...DESCRIPTOR, server: "../../etc" }, "not a safe path segment"],
    ["相对段 version", { ...DESCRIPTOR, version: ".." }, "not a safe path segment"],
    ["绝对路径 version", { ...DESCRIPTOR, version: "/etc/passwd" }, "not a safe path segment"],
    // 「多余字段一律拒」是把「不要把值写进 journal」从人的记性变成结构:
    ["夹带落点文件", { ...DESCRIPTOR, files: ["/tmp/x"] }, "unexpected field"],
    ["夹带值摘要", { ...DESCRIPTOR, valueDigest: sha("secret") }, "unexpected field"],
  ])("%s → 计划零副作用拒绝", async (_name, bad, expectedReason) => {
    // 违规项**不放首位**:前面先放一条完全合法的身份 —— 「只查第一个元素」的削弱必须转红。
    const legal: TxPreparedResourceV1 = { ...DESCRIPTOR, version: "v-00000001" }
    const result = await runExtensionTransaction(
      root,
      planWith([legal, bad as unknown as TxPreparedResourceV1]),
      makeHooks([]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected refusal")
    expect(result.stage).toBe("validate")
    expect(result.reason).toContain(expectedReason)
    // 零副作用:没建 journal、没碰 store、没落资源(合法的那条也没被放行)。
    expect(fs.existsSync(path.join(root, "ext-tx"))).toBe(false)
    expect(fs.existsSync(preparedDirOf())).toBe(false)
  })

  test("重复身份被拒;16 条以内的合法身份放行", () => {
    // 重复项同样不占首位。
    expect(
      validatePreparedResources([{ ...DESCRIPTOR, version: "v-00000001" }, DESCRIPTOR, { ...DESCRIPTOR }]),
    ).toContain("duplicate prepared resource")
    expect(validatePreparedResources(Array.from({ length: 17 }, (_v, i) => ({ ...DESCRIPTOR, version: `v-${i}` })))).toContain(
      "exceed 16",
    )
    // 同 server 不同 version、同 version 不同 server 都不是重复。
    expect(
      validatePreparedResources([
        DESCRIPTOR,
        { ...DESCRIPTOR, version: "v-00000001" },
        { ...DESCRIPTOR, server: "other" },
      ]),
    ).toBeNull()
    expect(validatePreparedResources(undefined)).toBeNull()
    expect(validatePreparedResources([])).toBeNull()
  })
})

describe("#712 prepared resource — journal 与释放调度", () => {
  test("身份先于 populate 落盘,且 journal 里只有身份(无值/无摘要/无绝对路径)", async () => {
    let journalAtPopulate: unknown
    const released: TxPreparedResourceV1[][] = []
    const hooks = makeHooks(released)
    const result = await runExtensionTransaction(root, planWith([DESCRIPTOR]), {
      ...hooks,
      populatePrepared: () => {
        // 磁盘上的 journal —— 不是内存里的对象。populate 之后才落盘就等于「资源在盘上而无人知道」。
        const [name] = fs.readdirSync(path.join(root, "ext-tx", "journal"))
        journalAtPopulate = readTransactionJournal(root, name!.slice(0, -".json".length))?.prepared
        hooks.populatePrepared()
      },
    })
    expect(result.ok).toBe(true)
    expect(journalAtPopulate).toEqual([DESCRIPTOR])

    const journalDir = path.join(root, "ext-tx", "journal")
    const texts = fs.readdirSync(journalDir).map((n) => fs.readFileSync(path.join(journalDir, n), "utf8"))
    expect(texts).not.toHaveLength(0)
    for (const text of texts) {
      expect(text).not.toContain("PREPARED_CANARY_VALUE")
      expect(text).not.toContain(sha("PREPARED_CANARY_VALUE"))
      expect(text).not.toContain(preparedDirOf()) // 绝对删除路径不进 journal
      expect(text).toContain(DESCRIPTOR.version) // 身份进 journal
    }
  })

  test("提交成功:绝不释放(资源已被 live 引用)", async () => {
    const released: TxPreparedResourceV1[][] = []
    const result = await runExtensionTransaction(root, planWith([DESCRIPTOR]), makeHooks(released))
    expect(result.ok).toBe(true)
    expect(released).toEqual([])
    expect(fs.existsSync(path.join(preparedDirOf(), "A_KEY"))).toBe(true)
  })

  test("pre-switch 失败(probePrepared 不健康):释放恰一次,且在 journal 终态化之前", async () => {
    const released: TxPreparedResourceV1[][] = []
    const stateWhenReleased: string[] = []
    const hooks = makeHooks(released)
    const result = await runExtensionTransaction(root, planWith([DESCRIPTOR]), {
      ...hooks,
      probePrepared: () => ({ healthy: false, reason: "injected" }),
      releasePrepared: (resources: TxPreparedResourceV1[]) => {
        const [name] = fs.readdirSync(path.join(root, "ext-tx", "journal"))
        stateWhenReleased.push(readTransactionJournal(root, name!.slice(0, -".json".length))!.state)
        hooks.releasePrepared(resources)
      },
    })
    expect(result.ok).toBe(false)
    expect(released).toEqual([[DESCRIPTOR]])
    expect(stateWhenReleased).toEqual(["staged"]) // 尚未 aborted —— 释放先于终态化
    expect(fs.existsSync(preparedDirOf())).toBe(false)
  })

  test("接缝缺失:资源保留在盘上,并如实进 warnings(不谎报已清理)", async () => {
    const hooks = makeHooks([])
    const { releasePrepared: _drop, ...withoutSeam } = hooks
    const result = await runExtensionTransaction(root, planWith([DESCRIPTOR]), {
      ...withoutSeam,
      probePrepared: () => ({ healthy: false, reason: "injected" }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.warnings.join(" ")).toContain("without a releasePrepared seam")
    expect(fs.existsSync(path.join(preparedDirOf(), "A_KEY"))).toBe(true)
  })

  test("接缝抛错(资源仍被引用/来源不可读):终态化不被阻断,理由如实进 warnings", async () => {
    const hooks = makeHooks([])
    const result = await runExtensionTransaction(root, planWith([DESCRIPTOR]), {
      ...hooks,
      probePrepared: () => ({ healthy: false, reason: "injected" }),
      releasePrepared: () => {
        throw new Error("still referenced by the merged config view — retained")
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected failure")
    expect(result.warnings.join(" ")).toContain("prepared resource release failed: still referenced")
    // journal 仍收敛成终态 —— 一个不可达的残留不该封死后续全部扩展写。
    const [name] = fs.readdirSync(path.join(root, "ext-tx", "journal"))
    expect(readTransactionJournal(root, name!.slice(0, -".json".length))!.state).toBe("aborted")
  })
})

describe("#712 prepared resource — 崩溃恢复", () => {
  test("崩在 populate 与 switch 之间:恢复收敛 aborted 并释放", async () => {
    const released: TxPreparedResourceV1[][] = []
    const hooks = makeHooks(released)
    await expect(
      runExtensionTransaction(root, planWith([DESCRIPTOR]), { ...hooks, crashAt: "after-populate" }),
    ).rejects.toThrow(ExtTxCrashError)
    // 崩溃后:资源在盘上,live 从未改变。
    expect(fs.existsSync(path.join(preparedDirOf(), "A_KEY"))).toBe(true)
    expect(released).toEqual([])

    const recovered = await recoverExtensionTransactions(root, {
      probe: healthyProbe,
      commitReceipt: noop,
      releasePrepared: hooks.releasePrepared,
      pidAlive: () => false,
      log: noop,
    })
    expect(recovered.ok).toBe(true)
    expect(recovered.reports.at(-1)!.action).toBe("aborted")
    expect(released).toEqual([[DESCRIPTOR]])
    expect(fs.existsSync(preparedDirOf())).toBe(false)
  })

  test("崩在 switch 之后且恢复探测健康:前滚 committed,**绝不**释放", async () => {
    const released: TxPreparedResourceV1[][] = []
    const hooks = makeHooks(released)
    await expect(
      runExtensionTransaction(root, planWith([DESCRIPTOR]), { ...hooks, crashAt: "after-switched" }),
    ).rejects.toThrow(ExtTxCrashError)
    const recovered = await recoverExtensionTransactions(root, {
      probe: healthyProbe,
      commitReceipt: noop,
      releasePrepared: hooks.releasePrepared,
      pidAlive: () => false,
      log: noop,
    })
    expect(recovered.ok).toBe(true)
    expect(recovered.reports.at(-1)!.action).toBe("resumed-committed")
    expect(released).toEqual([])
    expect(fs.existsSync(path.join(preparedDirOf(), "A_KEY"))).toBe(true)
  })

  test("崩在 switch 之后但恢复无 probe/receipt 接缝(健康未知 → 回滚):释放", async () => {
    const released: TxPreparedResourceV1[][] = []
    const hooks = makeHooks(released)
    await expect(
      runExtensionTransaction(root, planWith([DESCRIPTOR]), { ...hooks, crashAt: "after-switched" }),
    ).rejects.toThrow(ExtTxCrashError)
    const recovered = await recoverExtensionTransactions(root, {
      releasePrepared: hooks.releasePrepared,
      // receipt 未 durable 的确证接缝 —— 缺了它引擎会拒绝进回滚分支(#336)。
      receiptCommitted: () => false,
      pidAlive: () => false,
      log: noop,
    })
    expect(recovered.ok).toBe(true)
    expect(recovered.reports.at(-1)!.action).toBe("rolled-back")
    expect(released).toEqual([[DESCRIPTOR]])
    expect(fs.existsSync(preparedDirOf())).toBe(false)
  })

  test("多条 prepared resource:恢复把它们**全部**交给接缝(不是只交第一条)", async () => {
    const released: TxPreparedResourceV1[][] = []
    const hooks = makeHooks(released)
    const second: TxPreparedResourceV1 = { ...DESCRIPTOR, server: "second", version: "v-00000002" }
    await expect(
      runExtensionTransaction(root, planWith([DESCRIPTOR, second]), { ...hooks, crashAt: "after-populate" }),
    ).rejects.toThrow(ExtTxCrashError)
    const recovered = await recoverExtensionTransactions(root, {
      probe: healthyProbe,
      commitReceipt: noop,
      releasePrepared: hooks.releasePrepared,
      pidAlive: () => false,
      log: noop,
    })
    expect(recovered.ok).toBe(true)
    expect(released).toEqual([[DESCRIPTOR, second]])
  })

  test("恢复幂等:第二轮不再重复释放", async () => {
    const released: TxPreparedResourceV1[][] = []
    const hooks = makeHooks(released)
    await expect(
      runExtensionTransaction(root, planWith([DESCRIPTOR]), { ...hooks, crashAt: "after-staged" }),
    ).rejects.toThrow(ExtTxCrashError)
    const opts = { probe: healthyProbe, commitReceipt: noop, releasePrepared: hooks.releasePrepared, pidAlive: () => false, log: noop }
    await recoverExtensionTransactions(root, opts)
    expect(released).toHaveLength(1)
    await recoverExtensionTransactions(root, opts)
    expect(released).toHaveLength(1)
  })

  test("畸形 journal 的 prepared 面绝不进释放路径(保留待人工诊断)", async () => {
    const released: TxPreparedResourceV1[][] = []
    const hooks = makeHooks(released)
    await expect(
      runExtensionTransaction(root, planWith([DESCRIPTOR]), { ...hooks, crashAt: "after-populate" }),
    ).rejects.toThrow(ExtTxCrashError)
    // 手工把 journal 的 prepared 面改成一个逃逸路径 —— 恢复必须拒绝据它删任何东西。
    const journalDir = path.join(root, "ext-tx", "journal")
    const [name] = fs.readdirSync(journalDir)
    const file = path.join(journalDir, name!)
    const journal = JSON.parse(fs.readFileSync(file, "utf8"))
    journal.prepared = [{ ...DESCRIPTOR, server: "../../escape" }]
    fs.writeFileSync(file, JSON.stringify(journal, null, 2))

    const recovered = await recoverExtensionTransactions(root, {
      probe: healthyProbe,
      commitReceipt: noop,
      releasePrepared: hooks.releasePrepared,
      pidAlive: () => false,
      log: noop,
    })
    expect(recovered.ok).toBe(true)
    expect(released).toEqual([])
    expect(recovered.reports.at(-1)!.retained).toBe(true)
    expect(recovered.reports.at(-1)!.detail).toContain("not a safe path segment")
    expect(fs.existsSync(path.join(preparedDirOf(), "A_KEY"))).toBe(true)
  })
})
