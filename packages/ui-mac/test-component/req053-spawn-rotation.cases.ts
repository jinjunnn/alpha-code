// REQ-053 AC4 `#966`:**每次 spawn 前轮转引擎日志** 的行为判据(生产接线闸)。
//
// 它替代的是 `src/main/engine-runaway-guard.test.ts` 里那条只比较源码字符串下标的断言 ——
// 把 `server.ts` 的 `rotateServerLogs()` 那一行注释掉,那条断言会红没错,但把它**挪到 fork
// 之后**、或把 `pruneServerArchives` 删掉,它一条都不会红。本文件断的是**真实文件系统在
// fork 被调用的那一刻的状态**:注入的 fork 桩当场 `statSync` 两个 `serverLogRoots()` 根。
//
// 关键取舍:**不 mock `./logging`**。真 `rotateServerLogs` 必须跑,而 `initLogging()` 从未被调用
// ⇒ 模块内 `run === ""` ⇒ `write()` 直接 return、`getLogger()` 返回 undefined(调用点全是可选链),
// 所以真模块在这里是惰性的。代价是 `electron-log/main.js` 会在顶层碰 electron 的一大片面 ——
// 那正是 req053-electron-stub.ts 存在的理由。
import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
  ftruncateSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createElectronStub } from "./req053-electron-stub"

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  postMessage(message: { type: string }) {
    if (message.type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
    if (message.type === "stop") queueMicrotask(() => this.emit("exit", 0))
  }

  kill() {
    queueMicrotask(() => this.emit("exit", 0))
  }
}

let userDataPath = ""
mock.module("electron", () => createElectronStub({ userDataPath: () => userDataPath }))
mock.module("../src/main/store", () => ({
  getStore: () => ({ get: () => null, set: () => {}, delete: () => {} }),
}))

const { spawnLocalServer } = await import("../src/main/server")
const { serverLogRoots } = await import("../src/main/logging")

// `MAX_SERVER_LOG_BYTES` 是 logging.ts 的**私有**常量(未导出)。判据的锚点刻意写成独立字面量:
// 26 MiB > 25 MiB 阈值、1 MiB < 阈值。从被测模块 import 阈值 = 自指等价链(改错它一起自洽)。
const OVER_THRESHOLD_BYTES = 27_262_976 // 26 MiB
const UNDER_THRESHOLD_BYTES = 1_048_576 // 1 MiB
const HEAD_MARKER = "REQ053-ROTATION-HEAD:"
const TAIL_MARKER = ":REQ053-ROTATION-TAIL"
const ARCHIVE_RE = /^opencode\..+\.log$/

let scratch = ""
let xdgDataHome = ""
/** 两个期望的日志根 —— **独立字面量**,不是从 serverLogRoots() 抄回来的。 */
let expectedLogDirs: string[] = []
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["XDG_DATA_HOME", "ALPHA_SECRETS_DISABLE", "SHELL"] as const

/** 稀疏地造一个精确尺寸的大文件:头尾各一个可辨识 marker,中间空洞。 */
function seedSizedFile(file: string, size: number, tag: string) {
  const head = Buffer.from(`${HEAD_MARKER}${tag}`)
  const tail = Buffer.from(`${tag}${TAIL_MARKER}`)
  const fd = openSync(file, "w")
  try {
    writeSync(fd, head, 0, head.length, 0)
    ftruncateSync(fd, size)
    writeSync(fd, tail, 0, tail.length, size - tail.length)
  } finally {
    closeSync(fd)
  }
  return { head: head.toString(), tail: tail.toString(), ino: statSync(file).ino }
}

function readEdges(file: string, headLen: number, tailLen: number) {
  const size = statSync(file).size
  const fd = openSync(file, "r")
  try {
    const head = Buffer.alloc(headLen)
    readSync(fd, head, 0, headLen, 0)
    const tail = Buffer.alloc(tailLen)
    readSync(fd, tail, 0, tailLen, size - tailLen)
    return { head: head.toString(), tail: tail.toString() }
  } finally {
    closeSync(fd)
  }
}

function archivesIn(dir: string) {
  return readdirSync(dir)
    .filter((entry) => ARCHIVE_RE.test(entry))
    .sort()
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "req053-rotation-")))
  userDataPath = join(scratch, "user-data")
  xdgDataHome = join(scratch, "xdg-data")
  mkdirSync(userDataPath, { recursive: true })
  mkdirSync(xdgDataHome, { recursive: true })
  process.env.XDG_DATA_HOME = xdgDataHome
  process.env.ALPHA_SECRETS_DISABLE = "1"
  process.env.SHELL = "nu"
  expectedLogDirs = [join(xdgDataHome, "opencode", "log"), join(userDataPath, "opencode", "log")]
  expectedLogDirs.forEach((dir) => mkdirSync(dir, { recursive: true }))
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

/** 起一次真 spawn,并把「fork 被调用的那一刻」两个根的活跃日志状态带回来。 */
async function forkAndObserve() {
  const forkTimeActive: Array<number | "ENOENT"> = []
  const forkCalls: string[] = []
  const fakeFork = ((file: string) => {
    forkCalls.push(file)
    for (const dir of expectedLogDirs) {
      try {
        forkTimeActive.push(statSync(join(dir, "opencode.log")).size)
      } catch {
        forkTimeActive.push("ENOENT")
      }
    }
    return new FakeChild()
  }) as unknown as NonNullable<Parameters<typeof spawnLocalServer>[3]["fork"]>

  const result = await spawnLocalServer("127.0.0.1", 4096, "password", {
    userDataPath,
    healthCheck: async () => true,
    fork: fakeFork,
  })
  await result.health.wait
  await result.listener.stop()
  // 变异演练的指纹:判据是**这一行的值变了**,不是「我改了一行」。
  console.log(`[req053-drill] fork-time active=[${forkTimeActive.join(", ")}] forkCalls=${forkCalls.length}`)
  return { forkTimeActive, forkCalls }
}

test("an oversized engine log is already archived at the moment the sidecar is forked", async () => {
  // 反向自检:production 的根推导必须等于我们独立算出来的那两条,否则下面的种子会落在别处。
  expect(serverLogRoots()).toEqual(expectedLogDirs)

  const seeded = expectedLogDirs.map((dir, index) =>
    seedSizedFile(join(dir, "opencode.log"), OVER_THRESHOLD_BYTES, `root${index}`),
  )

  const { forkTimeActive, forkCalls } = await forkAndObserve()

  expect(forkCalls).toHaveLength(1)
  expect(forkTimeActive).toEqual(["ENOENT", "ENOENT"])

  expectedLogDirs.forEach((dir, index) => {
    const archives = archivesIn(dir)
    expect(archives, `expected exactly one archive in ${dir}`).toHaveLength(1)
    const archive = join(dir, archives[0]!)
    const stat = statSync(archive)
    expect(stat.size).toBe(OVER_THRESHOLD_BYTES)
    // rename,不是复制、不是截断:inode 必须与轮转前那个文件相同。
    expect(stat.ino).toBe(seeded[index]!.ino)
    expect(readEdges(archive, seeded[index]!.head.length, seeded[index]!.tail.length)).toEqual({
      head: seeded[index]!.head,
      tail: seeded[index]!.tail,
    })
  })
})

test("rotation keeps the three most recent archives by name, and never touches neighbours", async () => {
  // 具名字面量集合:`SERVER_LOG_ARCHIVES` 未导出,也刻意不去 import —— 只断 `length === 3`
  // 会被「保留**最旧**的 3 个」这个错误实现完整满足。
  const preseeded = [
    "opencode.20250101T000001.log",
    "opencode.20250101T000002.log",
    "opencode.20250101T000003.log",
    "opencode.20250101T000004.log",
    "opencode.20250101T000005.log",
  ]
  const expectedSurvivors = ["opencode.20250101T000004.log", "opencode.20250101T000005.log"]
  const base = Date.now() / 1000 - 30 * 86400

  for (const dir of expectedLogDirs) {
    preseeded.forEach((name, index) => {
      const file = join(dir, name)
      writeFileSync(file, `archive ${name}\n`)
      // mtime 递增:001 最旧、005 最新。prune 按 mtime 判,不按名字。
      utimesSync(file, base + index * 3600, base + index * 3600)
    })
    writeFileSync(join(dir, "user-notes.txt"), "user content — never delete\n")
    writeFileSync(join(dir, "opencode.log.bak"), "not an archive\n")
    seedSizedFile(join(dir, "opencode.log"), OVER_THRESHOLD_BYTES, "rotated")
  }

  await forkAndObserve()

  for (const dir of expectedLogDirs) {
    const archives = archivesIn(dir)
    console.log(`[req053-drill] survivors in ${dir}: ${archives.join(", ")}`)
    expect(archives).toHaveLength(3)
    expect(archives.filter((name) => preseeded.includes(name))).toEqual(expectedSurvivors)
    const fresh = archives.filter((name) => !preseeded.includes(name))
    expect(fresh).toHaveLength(1)
    expect(statSync(join(dir, fresh[0]!)).size).toBe(OVER_THRESHOLD_BYTES)
    expect(existsSync(join(dir, "user-notes.txt"))).toBe(true)
    expect(existsSync(join(dir, "opencode.log.bak"))).toBe(true)
  }
})

test("a log under the threshold survives the fork untouched (no unconditional rotation)", async () => {
  const seeded = expectedLogDirs.map((dir, index) =>
    seedSizedFile(join(dir, "opencode.log"), UNDER_THRESHOLD_BYTES, `small${index}`),
  )

  const { forkTimeActive } = await forkAndObserve()

  expect(forkTimeActive).toEqual([UNDER_THRESHOLD_BYTES, UNDER_THRESHOLD_BYTES])
  expectedLogDirs.forEach((dir, index) => {
    expect(archivesIn(dir)).toEqual([])
    const stat = statSync(join(dir, "opencode.log"))
    expect(stat.size).toBe(UNDER_THRESHOLD_BYTES)
    expect(stat.ino).toBe(seeded[index]!.ino)
  })
})
