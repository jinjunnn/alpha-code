// REQ-159 (`#1322`) —— 工作区写探针(AC2 的数据源、AC3 的判据本体)。
//
// 全平台的那一半:合同与簿记 —— 命令/应答的形状 fail-closed、errno 分类(只有 EPERM 是围栏的拒绝)、真文件系统上
// 写-删不留残、main 侧请求簿(超时 / 子进程退出 / 无关消息 / 对不上号 都答 unknown,不猜);以及 AC3 判据
// (`judgeWriteProbeCalibration`)的自证 —— 恒答「不可写」的替身、恒答「可写」的替身都被当场拒掉。
// 真 .node / 真 seatbelt / 真子进程的那一半(darwin-only)在 workspace-write-probe-fence.test.ts,两边共用同一个判据
// (从 ./workspace-write-probe-judge 导入 —— 那不是生产代码,是判据本体,住在测试旁边)。

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgeWriteProbeCalibration } from "./workspace-write-probe-judge"
import {
  buildWriteProbeCommand,
  buildWriteProbeReply,
  classifyWriteProbeError,
  createWriteProbeRequester,
  parseWriteProbeCommand,
  parseWriteProbeReply,
  runWorkspaceWriteProbe,
} from "./workspace-write-probe"

const errno = (code: string) => Object.assign(new Error(`${code}: synthetic`), { code })

describe("write probe 合同(main ↔ sidecar)—— 形状 fail-closed", () => {
  test("命令:只认 type=write-probe + 安全整数 id + 非空目录;别的一律当没有", () => {
    expect(parseWriteProbeCommand(buildWriteProbeCommand(7, "/ws/a"))).toEqual({ type: "write-probe", id: 7, directory: "/ws/a" })
    for (const bad of [undefined, null, "write-probe", { type: "stop" }, { type: "write-probe", id: "7", directory: "/ws" }, { type: "write-probe", id: 1.5, directory: "/ws" }, { type: "write-probe", id: 1, directory: "" }, { type: "write-probe", id: 1 }])
      expect(parseWriteProbeCommand(bad), JSON.stringify(bad)).toBeUndefined()
  })

  test("应答:outcome 只认三种取值;detail 可选且只认字符串;成功路径不带 detail 键", () => {
    expect(parseWriteProbeReply(buildWriteProbeReply(3, { outcome: "denied", detail: "write EPERM: x" }))).toEqual({ type: "write-probe-result", id: 3, outcome: "denied", detail: "write EPERM: x" })
    const plain = buildWriteProbeReply(4, { outcome: "writable" })
    expect(plain).toEqual({ type: "write-probe-result", id: 4, outcome: "writable" })
    expect("detail" in plain).toBe(false)
    for (const bad of [{ type: "write-probe-result", id: 1, outcome: "maybe" }, { type: "write-probe-result", id: "1", outcome: "writable" }, { type: "ready" }, null])
      expect(parseWriteProbeReply(bad), JSON.stringify(bad)).toBeUndefined()
    // detail 不是字符串 ⇒ 丢掉 detail,不丢整条应答
    expect(parseWriteProbeReply({ type: "write-probe-result", id: 2, outcome: "unknown", detail: 42 })).toEqual({ type: "write-probe-result", id: 2, outcome: "unknown" })
  })

  test("errno 分类:只有 EPERM 是围栏的拒绝;EACCES / ENOENT / ENOTDIR / 无码 都是 unknown(不替围栏背书)", () => {
    expect(classifyWriteProbeError("EPERM")).toBe("denied")
    for (const code of ["EACCES", "ENOENT", "ENOTDIR", "EROFS", "EEXIST", undefined]) expect(classifyWriteProbeError(code), String(code)).toBe("unknown")
  })
})

describe("runWorkspaceWriteProbe —— 真文件系统 + 注入失败", () => {
  test("可写目录:写-删成功答 writable,目录里一个探针文件都不留", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac1322-probe-"))
    try {
      expect(runWorkspaceWriteProbe(dir)).toEqual({ outcome: "writable" })
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("不存在的目录答 unknown(ENOENT),detail 带码", () => {
    const result = runWorkspaceWriteProbe(join(tmpdir(), `ac1322-nope-${Date.now()}`))
    expect(result.outcome).toBe("unknown")
    expect(result.detail).toMatch(/^write ENOENT/)
  })

  test("写被 EPERM 拒 ⇒ denied;EACCES ⇒ unknown;写成功但删失败 ⇒ 仍 writable 且 detail 点名残留", () => {
    const denied = runWorkspaceWriteProbe("/ws", { writeFile: () => { throw errno("EPERM") }, remove: () => {} })
    expect(denied.outcome).toBe("denied")
    expect(denied.detail).toMatch(/^write EPERM: /)

    const acces = runWorkspaceWriteProbe("/ws", { writeFile: () => { throw errno("EACCES") }, remove: () => {} })
    expect(acces.outcome).toBe("unknown")

    const leftover = runWorkspaceWriteProbe("/ws", { writeFile: () => {}, remove: () => { throw errno("EBUSY") }, stamp: () => "stamp" })
    expect(leftover.outcome).toBe("writable")
    expect(leftover.detail).toContain("/ws/.alpha-write-probe-stamp")
  })

  test("探针文件名带唯一戳且用 wx 打开:同名已存在算失败(unknown),永远不覆盖用户文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac1322-probe-wx-"))
    try {
      writeFileSync(join(dir, ".alpha-write-probe-fixed"), "user data")
      const result = runWorkspaceWriteProbe(dir, { stamp: () => "fixed" })
      expect(result.outcome).toBe("unknown")
      expect(result.detail).toMatch(/^write EEXIST/)
      expect(readdirSync(dir)).toEqual([".alpha-write-probe-fixed"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createWriteProbeRequester —— main 侧请求簿", () => {
  test("往返:命令按 id 发出,应答按 id 对号;无关消息与对不上号的应答都被忽略", async () => {
    const wire: unknown[] = []
    const requester = createWriteProbeRequester((command) => void wire.push(command), { timeoutMs: 1_000 })
    const pending = requester.request("/ws/a")
    expect(wire).toEqual([{ type: "write-probe", id: 1, directory: "/ws/a" }])
    expect(requester.receive({ type: "ready" })).toBe(false)
    expect(requester.receive({ type: "write-probe-result", id: 99, outcome: "denied" })).toBe(false)
    expect(requester.receive({ type: "write-probe-result", id: 1, outcome: "denied", detail: "write EPERM: x" })).toBe(true)
    expect(await pending).toEqual({ outcome: "denied", detail: "write EPERM: x" })
    // 同一 id 再答一次:没人在等,忽略
    expect(requester.receive({ type: "write-probe-result", id: 1, outcome: "writable" })).toBe(false)
  })

  test("超时答 unknown 并点名超时;之后迟到的应答不再被消费", async () => {
    const requester = createWriteProbeRequester(() => {}, { timeoutMs: 20 })
    const result = await requester.request("/ws/a")
    expect(result.outcome).toBe("unknown")
    expect(result.detail).toMatch(/no reply from the engine within 20ms/)
    expect(requester.receive({ type: "write-probe-result", id: 1, outcome: "denied" })).toBe(false)
  })

  test("子进程退出:在途请求立刻答 unknown(不是 denied),之后的请求不再发、直接答 unknown", async () => {
    const wire: unknown[] = []
    const requester = createWriteProbeRequester((command) => void wire.push(command), { timeoutMs: 1_000 })
    const inflight = requester.request("/ws/a")
    requester.close("sidecar exited with code 1")
    expect(await inflight).toEqual({ outcome: "unknown", detail: "sidecar exited with code 1" })
    expect(await requester.request("/ws/b")).toEqual({ outcome: "unknown", detail: "sidecar exited with code 1" })
    expect(wire).toHaveLength(1)
  })

  test("postMessage 自己抛(通道已坏)⇒ 当场答 unknown,不挂到超时", async () => {
    const requester = createWriteProbeRequester(() => {
      throw new Error("channel closed")
    }, { timeoutMs: 10_000 })
    const result = await requester.request("/ws/a")
    expect(result.outcome).toBe("unknown")
    expect(result.detail).toMatch(/could not reach the engine: channel closed/)
  })
})

describe("AC3 判据先自证:两个替身各被拒在一边", () => {
  test("恒答「不可写」的替身被当场拒掉(它会把每个项目都标成只读)", () => {
    const verdict = judgeWriteProbeCalibration({ inside: "denied", outside: "denied" })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? "" : verdict.reason).toMatch(/mark every project read-only/)
  })

  test("恒答「可写」的替身在集合外臂被拒(它永远报不出只读工作区)", () => {
    const verdict = judgeWriteProbeCalibration({ inside: "writable", outside: "writable" })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? "" : verdict.reason).toMatch(/never reports a read-only workspace/)
  })

  test("答 unknown 的替身两边都不算数", () => {
    expect(judgeWriteProbeCalibration({ inside: "unknown", outside: "denied" }).ok).toBe(false)
    expect(judgeWriteProbeCalibration({ inside: "writable", outside: "unknown" }).ok).toBe(false)
  })
})
