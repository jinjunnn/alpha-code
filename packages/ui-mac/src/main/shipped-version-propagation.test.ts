// `#1255` —— 出货版本号在仓内的**每一份副本**都必须等于 packages/ui-mac/package.json 的 version。
//
// ── 这道闸治的是什么 ────────────────────────────────────────────────────────────
// docs/runbooks/distribution.md §1 ① 写着「packages/ui-mac/package.json 的 version 是唯一真源」。
// 那句话描述的是**语义**上的真源,不是仓内的事实:同一个字面量今天还被抄在另外三处
// (两份 consumer-pin 夹具 + bun.lock 的 packages/ui-mac 工作区条目)。0.1.10 发版(PR #1233)
// 只抬了 package.json,于是:
//   · 两条 consumer-pin 断言在 `alpha` 基线上**恒红**,与任何人的改动都无关 —— 一条真闸门变成
//     所有人共用的噪音,已实测诱发至少一次 `--no-verify`(而 `--no-verify` 一次关掉全部十道门);
//   · bun.lock 那一行让**每一次** `bun install`(worktree-bootstrap.sh 的第二步)都把工作树弄脏,
//     而仓里另有一条纪律说「脏树诱发 git checkout -- <path>,会把同路径下未提交的真实改动一起抹掉」。
//
// ── 为什么不是「再抄一遍那两条已有断言」────────────────────────────────────────
// 那两条断言已经存在,而且 #1233 那次它们确实会红 —— 它们没拦住,是因为它们**按文件硬编码**、
// 而且分散在两个包里。本文件补的是它们结构上给不出的三件事:
//   1. **枚举**而不是点名:今后新增的 consumer-pin 夹具默认被罩住,不必有人记得再写一条断言;
//   2. bun.lock 那一处**今天没有任何东西在看**(实测:`bun install --frozen-lockfile --dry-run`
//      对停在 0.1.9 的工作区版本 **exit 0** —— bun 自己不把它当 lockfile 不一致);
//   3. 一次把**全部**漂移点连同改法一起打出来,而不是让人一条测试一条测试地追。
//
// ── 判据的自证(仓里的纪律:先证明这个手段能测出已知的坏,再用它判未知的好)────────
// 下面四条 control 跑在**合成的、故意坏掉的**目录树上,证明 `driftingSites()` 真的看得见:
// 夹具版本落后、bun.lock 版本落后、bun.lock 结构变了(判「量不出来」而不是判绿)、
// 夹具把 consumer_version 整个删掉(不许靠删字段绕过)。
//
// 删掉本文件会失去什么:发版漏抬副本这件事重新只由两条硬编码断言兜着(它们只认今天这两个
// 文件名),bun.lock 那一处回到零覆盖,而 ui-mac 整包地板(3000)吸收得掉本文件的全部条数。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")

/** 出货版本的**唯一真源**。 */
const SHIPPED_VERSION_FILE = "packages/ui-mac/package.json"

/** alpha 自己写的 consumer-pin 夹具目录(vendored 的那些属于 producer,由哈希锁管,不在此列)。 */
const CONSUMER_PIN_DIR = "packages/alpha-contracts-consumer/fixtures/consumers"

/** 今天已知的两份 pin。枚举退化成零命中时,这两条会当场红 —— 空输出不是结论。 */
const KNOWN_CONSUMER_PINS = [
  "packages/alpha-contracts-consumer/fixtures/consumers/alpha-code-640/ledger-page.json",
  "packages/alpha-contracts-consumer/fixtures/consumers/alpha-code-681/model-catalog-v2.json",
]

/**
 * bun.lock 里 `packages/ui-mac` 工作区那一格的 version。
 *
 * 刻意**不**去解析整个 lockfile:它不是 JSON(实测 `JSON.parse` 与 `Bun.file().json()` 双双
 * SyntaxError),自己写一个 JSONC 替身正是本仓点名过的「手写别人文法的替身」。这里只在
 * `"packages/ui-mac"` 这个锚上取一格,并要求它**恰好命中一次**:命中 0 次或多次 = bun 改了
 * lockfile 形状 ⇒ 本闸判「量不出来」(抛错、红),而不是安静地判绿。
 */
const LOCK_UI_MAC_VERSION = /"packages\/ui-mac"\s*:\s*\{\s*"name"\s*:\s*"ui-mac"\s*,\s*"version"\s*:\s*"([^"]*)"/g

export type VersionSite = {
  /** 仓库相对路径 + 该文件里的哪一格。 */
  where: string
  /** 那一格今天写着的版本。 */
  declared: string
  /** 漂移时给人的改法(bun.lock 由 bun 自己写,不许手改)。 */
  howToFix: string
}

function shippedVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, SHIPPED_VERSION_FILE), "utf8"))
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`${SHIPPED_VERSION_FILE} 没有可用的 version —— 出货版本真源坏了,本闸无法测量`)
  }
  return pkg.version
}

/** 递归列出 consumer-pin 目录下的全部 *.json(仓库相对路径,排序后返回)。 */
export function consumerPinFiles(root: string): string[] {
  const base = join(root, CONSUMER_PIN_DIR)
  if (!existsSync(base)) throw new Error(`consumer-pin 目录不存在:${CONSUMER_PIN_DIR} —— 本闸无法测量`)
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".json")) found.push(relative(root, full))
    }
  }
  walk(base)
  return found.sort()
}

/**
 * 仓内**每一处**抄了出货版本的地方。默认拒:pin 夹具的形状不认识就抛错(红),
 * 不许靠「少写一个字段」从枚举里滑出去。
 */
export function versionSites(root: string): VersionSite[] {
  const sites: VersionSite[] = []

  for (const path of consumerPinFiles(root)) {
    const pin = JSON.parse(readFileSync(join(root, path), "utf8"))
    if (pin.consumer !== "alpha-code") {
      throw new Error(`${path} 的 consumer 不是 "alpha-code"(实为 ${JSON.stringify(pin.consumer)}) —— 本闸只知道怎么给 alpha-code 的 pin 定版本,遇到新消费方请先决定它钉谁的版本`)
    }
    if (typeof pin.consumer_version !== "string" || pin.consumer_version.length === 0) {
      throw new Error(`${path} 缺少 consumer_version —— consumer-pin 夹具必须声明它钉住的出货版本(alpha-platform 的 cutover gate 读这一格)`)
    }
    sites.push({
      where: `${path}  →  consumer_version`,
      declared: pin.consumer_version,
      howToFix: `把 ${path} 的 "consumer_version" 改成出货版本`,
    })
  }

  const lock = readFileSync(join(root, "bun.lock"), "utf8")
  LOCK_UI_MAC_VERSION.lastIndex = 0
  const lockMatches = [...lock.matchAll(LOCK_UI_MAC_VERSION)]
  if (lockMatches.length !== 1) {
    throw new Error(`bun.lock 里 "packages/ui-mac" 工作区的 version 锚命中 ${lockMatches.length} 次(应为 1)—— lockfile 形状变了,本闸这次量不出来,请先修本闸再判绿`)
  }
  sites.push({
    where: 'bun.lock  →  workspaces["packages/ui-mac"].version',
    declared: lockMatches[0]![1]!,
    howToFix: "在仓根跑一次 `bun install`,让 bun 自己把 lockfile 写回(禁止手改 lockfile)",
  })

  return sites
}

/** 与出货版本不一致的那些格子。空数组 = 没有漂移。 */
export function driftingSites(root: string): VersionSite[] {
  const shipped = shippedVersion(root)
  return versionSites(root).filter((site) => site.declared !== shipped)
}

function driftReport(root: string): string {
  const shipped = shippedVersion(root)
  const drifting = driftingSites(root)
  if (drifting.length === 0) return ""
  return [
    `出货版本(${SHIPPED_VERSION_FILE})= ${shipped},但仓内有 ${drifting.length} 处副本没跟上:`,
    ...drifting.map((site) => `  · ${site.where} = ${site.declared}\n      改法:${site.howToFix}`),
    "发版 runbook:docs/runbooks/distribution.md §1 ①",
  ].join("\n")
}

// ── 合成树(control 用)──────────────────────────────────────────────────────────
// 只造本闸读的那几个文件,不 copy 整个仓 —— 被测的是 versionSites()/driftingSites() 本体。

const scratchRoots: string[] = []

function synthesizeRoot(options: {
  shipped: string
  pins: Array<{ path: string; body: Record<string, unknown> }>
  lock: string
}): string {
  const root = mkdtempSync(join(tmpdir(), "alpha-1255-"))
  scratchRoots.push(root)
  const write = (relPath: string, body: string) => {
    const full = join(root, relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  write(SHIPPED_VERSION_FILE, JSON.stringify({ name: "ui-mac", version: options.shipped }, null, 2))
  for (const pin of options.pins) write(join(CONSUMER_PIN_DIR, pin.path), JSON.stringify(pin.body, null, 2))
  write("bun.lock", options.lock)
  return root
}

function lockText(version: string): string {
  return `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "packages/ui-mac": {\n      "name": "ui-mac",\n      "version": "${version}",\n      "dependencies": {},\n    },\n  },\n}\n`
}

const healthyPin = (version: string) => ({
  path: "alpha-code-640/ledger-page.json",
  body: { kind: "schema", contract: "LedgerPageV1", consumer: "alpha-code", consumer_version: version, expect: "valid" },
})

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

describe("#1255 出货版本号在仓内的副本", () => {
  test("consumer-pin 枚举没有退化成零命中 —— 今天已知的两份 pin 必须都在里面", () => {
    const found = consumerPinFiles(REPO_ROOT)
    expect(found.length).toBeGreaterThanOrEqual(KNOWN_CONSUMER_PINS.length)
    for (const known of KNOWN_CONSUMER_PINS) expect(found).toContain(known)
  })

  test("仓内每一处抄了出货版本的地方都等于 packages/ui-mac/package.json 的 version", () => {
    expect(driftReport(REPO_ROOT)).toBe("")
  })

  test("bun.lock 的 packages/ui-mac 工作区版本锚恰好命中一次,且等于出货版本", () => {
    const lock = versionSites(REPO_ROOT).find((site) => site.where.startsWith("bun.lock"))
    expect(lock).toBeDefined()
    expect(lock!.declared).toBe(shippedVersion(REPO_ROOT))
  })

  // ── control:先证明它测得出已知的坏 ────────────────────────────────────────────

  test("control:consumer-pin 版本落后时,漂移报告点名那个文件", () => {
    const root = synthesizeRoot({ shipped: "0.1.10", pins: [healthyPin("0.1.9")], lock: lockText("0.1.10") })
    const drifting = driftingSites(root)
    expect(drifting.map((site) => site.where)).toEqual([
      `${CONSUMER_PIN_DIR}/alpha-code-640/ledger-page.json  →  consumer_version`,
    ])
    expect(drifting[0]!.declared).toBe("0.1.9")
    expect(driftReport(root)).toContain("0.1.9")
  })

  test("control:bun.lock 工作区版本落后时,漂移报告点名 bun.lock 并给出「跑 bun install」", () => {
    const root = synthesizeRoot({ shipped: "0.1.10", pins: [healthyPin("0.1.10")], lock: lockText("0.1.9") })
    const drifting = driftingSites(root)
    expect(drifting.map((site) => site.where)).toEqual(['bun.lock  →  workspaces["packages/ui-mac"].version'])
    expect(drifting[0]!.howToFix).toContain("bun install")
  })

  test("control:bun.lock 形状变了(锚命中 0 次)判「量不出来」,不判绿", () => {
    const root = synthesizeRoot({
      shipped: "0.1.10",
      pins: [healthyPin("0.1.10")],
      lock: '{\n  "lockfileVersion": 2,\n  "members": {}\n}\n',
    })
    expect(() => driftingSites(root)).toThrow(/命中 0 次/)
  })

  test("control:pin 夹具删掉 consumer_version 不能从枚举里滑出去", () => {
    const root = synthesizeRoot({
      shipped: "0.1.10",
      pins: [{ path: "alpha-code-640/ledger-page.json", body: { kind: "schema", consumer: "alpha-code" } }],
      lock: lockText("0.1.10"),
    })
    expect(() => driftingSites(root)).toThrow(/缺少 consumer_version/)
  })
})
