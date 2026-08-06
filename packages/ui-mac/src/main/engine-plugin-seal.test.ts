// ADR-040(`#825`)咽喉闸:**往磁盘 `plugin[]` 加元素一律拒**。
//
// 这个文件回答的不是「已知的那几条安装路径被关了吗」——那是枚举,枚举对新成员默认放行。
// 它回答的是:**一个刚写出来的、没有在任何地方登记过的写入调用点,会不会被挡住。**
// 所以下面的用例**自己就是那个新调用点**:测试里现场构造一次配置写入,直接喂给生产的三族物理
// 写原语(`ext-config` 的原子提交 / `ext-config-tx` 的 image 对 / boot reconcile 的整文件写),
// 然后断言它被具名拒绝。
//
// 第三族是 `#832` 补上的:`#825` 交付时,boot 期那次 `JSON.stringify` 整文件写盘**结构性地不过
// 任何一道白名单**,而且每次启动都跑 —— 一道拦得住六条已知路径、拦不住第七条的闸,在「完整性」
// 这个维度上只是部分为真。见 ④。
//
// 三条纪律,写每条断言时都过了一遍:
//   · 断言的是**生产写盘那条路径**,不是内层纯函数 —— 摘掉 `prepareConfigTx` / `writeConfigTextAtomic`
//     里的那一行钩子,下面的用例必须红(实测过,见 PR 正文的绕过记录);
//   · **反方向要能过** —— 移除、清空、重排、以及完全不碰 `plugin[]` 的写(mcp/provider/agent)
//     必须照常成功。一个「什么都拒」的闸和没有闸一样坏:它会被绕过或删掉;
//   · 负例不取最退化的形状 —— 空配置加一个元素、已有一条再加一条、元组形态、以及「删一个同时
//     加一个」(净数量不变)都各有一格。只测「空 → 一条」的话,一个「只在数组非空时才拒」的
//     错误实现能全绿。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { sealEnginePluginAdditions } from "./engine-plugin-seal"
import { applyConfigImage, prepareConfigTx } from "./ext-config-tx"
import { persistMcp, readPluginArrayStrict, removePlugin, writeConfigTextAtomic } from "./ext-config"
import { reconcileEngineConfigTruth } from "./engine-config-truth-boot"

let tmp = ""
let alphaTmp = ""
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
const prevHome = process.env.ALPHA_OPENCODE_HOME
const prevAlpha = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-plugin-seal-"))
  alphaTmp = path.join(tmp, "alpha-home")
  fs.mkdirSync(alphaTmp, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = tmp
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  process.env.ALPHA_GLOBAL_DIR = alphaTmp
})
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
  if (prevHome === undefined) delete process.env.ALPHA_OPENCODE_HOME
  else process.env.ALPHA_OPENCODE_HOME = prevHome
  if (prevAlpha === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = prevAlpha
  fs.rmSync(tmp, { recursive: true, force: true })
})

const target = () => path.join(alphaTmp, "alpha.jsonc")
const writeCfg = (value: unknown) => fs.writeFileSync(target(), JSON.stringify(value, null, 2))
const readCfg = (): Record<string, unknown> => JSON.parse(fs.readFileSync(target(), "utf8"))
const refusal = (r: { ok: boolean } | { ok: false; reason: string }): string => {
  if (r.ok) throw new Error("expected a refusal, got ok")
  return (r as { reason: string }).reason
}

// ── ① 新写入点默认被挡住(本票的核心判据)──────────────────────────────────────────────────────
//
// 下面每一格都是一次**现场新写的调用**:没有 profile、没有登记表、没有任何白名单认识它。

describe("ADR-040 咽喉:任何新写入调用点往 plugin[] 加元素都被具名拒绝", () => {
  test("事务通道(prepareConfigTx):空配置 → 加一条,拒;文件逐字节不动", () => {
    writeCfg({ $schema: "https://opencode.ai/config.json" })
    const before = fs.readFileSync(target(), "utf8")
    const r = prepareConfigTx(target(), [{ keyPath: ["plugin"], value: ["brand-new-plugin@1.0.0"] }])
    expect(r.ok).toBe(false)
    expect(refusal(r)).toContain("ADR-040")
    expect(refusal(r)).toContain("brand-new-plugin@1.0.0") // 说得出加的是哪一个
    expect(fs.readFileSync(target(), "utf8")).toBe(before)
  })

  test("事务通道:已有一条 → 再加一条(既有那条原样保留),同样拒", () => {
    writeCfg({ plugin: ["/abs/plugins/kept@aaaa/plugin.js"] })
    const r = prepareConfigTx(target(), [
      { keyPath: ["plugin"], value: ["/abs/plugins/kept@aaaa/plugin.js", "/abs/plugins/new@bbbb/plugin.js"] },
    ])
    expect(r.ok).toBe(false)
    expect(refusal(r)).toContain("new@bbbb")
  })

  test("事务通道:元组形态 `[spec, options]` 也算元素(字符串谓词漏判它就是一条绕过口)", () => {
    writeCfg({ plugin: [] })
    const r = prepareConfigTx(target(), [{ keyPath: ["plugin"], value: [["sneaky@1", { label: "x" }]] }])
    expect(r.ok).toBe(false)
    expect(refusal(r)).toContain("sneaky@1")
  })

  test("事务通道:**删一个同时加一个**(长度不变)照样拒 —— 判据是元素身份,不是数量", () => {
    writeCfg({ plugin: ["old@1"] })
    const r = prepareConfigTx(target(), [{ keyPath: ["plugin"], value: ["new@2"] }])
    expect(r.ok).toBe(false)
    expect(refusal(r)).toContain("new@2")
  })

  test("事务通道:同一元素**加成两份**(重复)也算新增 —— 多重集比较,不是集合比较", () => {
    writeCfg({ plugin: ["dup@1"] })
    const r = prepareConfigTx(target(), [{ keyPath: ["plugin"], value: ["dup@1", "dup@1"] }])
    expect(r.ok).toBe(false)
    expect(refusal(r)).toContain("dup@1")
  })

  test("链式 edit:先删后加(第二条 edit 以第一条的结果为基线)—— 累积后的净结果仍被判出来", () => {
    writeCfg({ plugin: ["a@1", "b@1"] })
    const r = prepareConfigTx(target(), [
      { keyPath: ["plugin"], value: ["a@1"] }, // 合法减法
      { keyPath: ["plugin"], value: ["a@1", "c@1"] }, // 再加一条 —— 相对 live 前像是新增
    ])
    expect(r.ok).toBe(false)
    expect(refusal(r)).toContain("c@1")
  })

  test("物理写原语(applyConfigImage):**手搓 image 绕过 prepare** 也过不去,且抛错前不写盘", () => {
    // 这一格针对的是「新写入点自己构造 image、跳过计划期那道闸」——崩溃恢复重放走的正是这条路。
    writeCfg({ plugin: [] })
    const before = fs.readFileSync(target(), "utf8")
    const image = {
      target: target(),
      preImage: before,
      nextImage: JSON.stringify({ plugin: ["hand-rolled@1"] }, null, 2),
      preDigest: "unused",
      nextDigest: "unused",
    }
    expect(() => applyConfigImage(image)).toThrow(/ADR-040/)
    expect(fs.readFileSync(target(), "utf8")).toBe(before)
  })
})

// ── ② 反方向必须过:减法、无关键、以及 alpha 自有 ext 的 env 通道 ──────────────────────────────

describe("ADR-040 咽喉:清理方向与无关写入照常通过(闸不能是「什么都拒」)", () => {
  test("removePlugin:从 plugin[] 移除条目 —— 同一条物理写原语,照常成功", () => {
    writeCfg({ plugin: ["gone@1", "stay@1"] })
    expect(removePlugin("gone@1").ok).toBe(true)
    expect(readCfg().plugin).toEqual(["stay@1"])
  })

  test("清空到空数组、以及重排既有元素:都不是新增,放行", () => {
    writeCfg({ plugin: ["a@1", "b@1"] })
    const cleared = prepareConfigTx(target(), [{ keyPath: ["plugin"], value: [] }])
    expect(cleared.ok).toBe(true)
    const reordered = prepareConfigTx(target(), [{ keyPath: ["plugin"], value: ["b@1", "a@1"] }])
    expect(reordered.ok).toBe(true)
  })

  test("完全不碰 plugin 的写(mcp)在**带既有 plugin[] 的配置上**照常成功 —— 咽喉零误伤", () => {
    writeCfg({ plugin: ["existing@1"] })
    expect(persistMcp("demo", { type: "local", command: ["npx", "-y", "demo-mcp"] }).ok).toBe(true)
    expect(readCfg().plugin).toEqual(["existing@1"]) // 原样保留
    expect(readPluginArrayStrict()).toEqual({ ok: true, value: ["existing@1"] })
  })
})

// ── ④ 第三族物理写原语:boot reconcile 的**整文件**写(`#832`)────────────────────────────────
//
// `#825` 交付时它是**唯一已知绕开咽喉**的写入口:每次启动都跑,`JSON.stringify` 整个 `alpha.jsonc`
// 覆盖一遍,三道白名单一道都不过。本段是那个口子被关掉的判据。
//
// 三格分工(缺一格就有一半是假的):
//   · 一格证明**这种形状的新调用点**(手搓整文件文本)过不去;
//   · 一格证明**生产入口真的把该做的活做了**——「什么都不写」同样满足「没有新增」,那是错误实现;
//   · 一格证明**生产入口那条路上真的执行了咽喉**:喂一个咽喉会拒、而它自己的容错读**不会**拒的
//     输入,看它是不是当场停手。摘掉写盘处那次咽喉调用,这一格立刻绿转红 —— 它不靠源码文本。

describe("ADR-040 咽喉:boot reconcile 的整文件写(第三族物理写原语)", () => {
  const legacyDir = () => path.join(tmp, "opencode-home")
  const writeLegacy = (obj: unknown) => {
    fs.mkdirSync(legacyDir(), { recursive: true })
    fs.writeFileSync(path.join(legacyDir(), "opencode.jsonc"), JSON.stringify(obj))
  }

  test("新调用点手搓一次整文件写,加一条 —— 拒,且文件逐字节不动", () => {
    writeCfg({ plugin: ["kept@1"], mcp: {} })
    const before = fs.readFileSync(target(), "utf8")
    const r = writeConfigTextAtomic(
      target(),
      before,
      JSON.stringify({ plugin: ["kept@1", "whole-file-smuggled@2"], mcp: {} }, null, 2) + "\n",
    )
    expect(r.ok).toBe(false)
    expect(refusal(r)).toContain("ADR-040")
    expect(refusal(r)).toContain("whole-file-smuggled@2")
    expect(fs.readFileSync(target(), "utf8")).toBe(before)
  })

  test("生产入口:legacy 带一个真源没有的 plugin ⇒ 没并进来,而这一次 reconcile 该写的照写", () => {
    writeCfg({ $schema: "https://opencode.ai/config.json", plugin: ["kept@1"] })
    writeLegacy({ mcp: { markitdown: { type: "local" } }, plugin: ["legacy-smuggled@9"] })
    const out = reconcileEngineConfigTruth({ log: () => {}, warn: () => {} })
    expect(out.skipped).toBe(false)
    if (!out.skipped) expect(out.migrated).toBe(true) // 写发生了 —— 不是靠「整次拒写」拿到的绿
    expect(readCfg().plugin).toEqual(["kept@1"]) // 逐元素
    expect((readCfg().mcp as Record<string, unknown>).markitdown).toBeDefined()
  })

  test("生产入口:盘上的 alpha.jsonc 语法坏掉而它自己容错读得出 plugin 条目 ⇒ 整次拒写,文件身份不变", () => {
    // 缺一个逗号:jsonc-parser 3.3.1 的容错解析照样给出 {plugin,mcp}(实测),而带 errors 的严格读
    // 报 1 个语法错 —— 于是「写完之后没多出元素」证不出来。fail-closed 的定义就是这一格。
    fs.writeFileSync(target(), '{\n  "plugin": ["kept@1"]\n  "mcp": {}\n}\n')
    const before = { text: fs.readFileSync(target(), "utf8"), stat: fs.statSync(target()) }
    const legacyFile = path.join(legacyDir(), "opencode.jsonc")
    writeLegacy({ mcp: { markitdown: { type: "local" } } })

    const out = reconcileEngineConfigTruth({ log: () => {}, warn: () => {} })

    expect(out.skipped).toBe(false)
    if (!out.skipped) {
      expect(out.migrated).toBe(false)
      expect(out.bailedOut).toContain("ADR-040") // 说得出是被哪道闸拦的
    }
    const after = { text: fs.readFileSync(target(), "utf8"), stat: fs.statSync(target()) }
    expect(after.text).toBe(before.text) // 用户那份坏文件原样留着,不被「修复」成另一份
    expect(after.stat.ino).toBe(before.stat.ino) // 内容相同也可能是幂等重写 ⇒ 身份与时间一起判
    expect(after.stat.mtimeMs).toBe(before.stat.mtimeMs)
    expect(fs.existsSync(legacyFile)).toBe(true) // 没写成 ⇒ 更不能去删源
  })
})

// ── ③ 纯函数契约:fail-closed 的三种「证不出来」───────────────────────────────────────────────
//
// 这一段直接测 `sealEnginePluginAdditions`。它不能代替上面两段(内层纯函数全绿而分流层被绕过,
// 是本仓记录在案的假闸形态),但它是唯一能把「证不出来」的三种形状逐个摆出来的地方。

describe("sealEnginePluginAdditions — fail-closed 的边界", () => {
  const t = "/tmp/alpha.jsonc"
  test("待写文本不是合法 jsonc ⇒ 拒(无法证明没新增)", () => {
    expect(sealEnginePluginAdditions(t, "{}", "{ not jsonc").ok).toBe(false)
  })
  test("既有文本坏掉而待写文本仍有条目 ⇒ 拒;待写没有条目(纯清理)⇒ 放行", () => {
    expect(sealEnginePluginAdditions(t, "{ broken", JSON.stringify({ plugin: ["x@1"] })).ok).toBe(false)
    expect(sealEnginePluginAdditions(t, "{ broken", JSON.stringify({ plugin: [] })).ok).toBe(true)
    expect(sealEnginePluginAdditions(t, "{ broken", JSON.stringify({ mcp: {} })).ok).toBe(true)
  })
  test("plugin 键不是数组:两侧逐字相同 ⇒ 这次写没碰它,放行;只有一侧是 ⇒ 拒", () => {
    const weird = JSON.stringify({ plugin: "oops", mcp: {} })
    const weirdPlusMcp = JSON.stringify({ plugin: "oops", mcp: { a: {} } })
    expect(sealEnginePluginAdditions(t, weird, weirdPlusMcp).ok).toBe(true)
    expect(sealEnginePluginAdditions(t, JSON.stringify({ plugin: [] }), weird).ok).toBe(false)
  })
  test("文件缺席的两种表示(`\"\"` 与 `\"{}\"`)等价:加元素一律拒,不加则放行", () => {
    for (const before of ["", "{}"]) {
      expect(sealEnginePluginAdditions(t, before, JSON.stringify({ plugin: ["x@1"] })).ok).toBe(false)
      expect(sealEnginePluginAdditions(t, before, JSON.stringify({ mcp: { a: {} } })).ok).toBe(true)
    }
  })
  test("元组内 options 的键序变化不算新增(否则一次无关格式化就会被误拒)", () => {
    const before = JSON.stringify({ plugin: [["p@1", { a: 1, b: 2 }]] })
    const after = JSON.stringify({ plugin: [["p@1", { b: 2, a: 1 }]] })
    expect(sealEnginePluginAdditions(t, before, after).ok).toBe(true)
    // 但 options 的**值**变了就是另一个元素 —— 那是换了一份要执行的东西。
    const changed = JSON.stringify({ plugin: [["p@1", { a: 9, b: 2 }]] })
    expect(sealEnginePluginAdditions(t, before, changed).ok).toBe(false)
  })
})
