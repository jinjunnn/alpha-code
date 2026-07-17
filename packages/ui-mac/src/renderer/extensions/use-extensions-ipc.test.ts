// REQ-016 真机批发现(2026-07-05):已安装 tab 卸载/更新点击对全部带账本条目静默失败。
// 根因:store.receipts 的元素是 Solid store 节点(Proxy);Electron contextBridge 的结构化
// 克隆对 Proxy 抛 "An object could not be cloned" → window.api.ext.uninstall(receipt) 的
// IPC 调用根本发不出去,且 void 调用吞掉 rejection(零 toast 零行内错)。
// 修复 = use-extensions.ts 在过桥前 unwrap(uninstall / updateEntry 两处)。
// 本测试锁定这条不变量:store 节点不可结构化克隆,unwrap 后可以 —— 防止将来新增 IPC 调用
// 时再把 store 节点直接塞过桥。
// 注意:bun test 把 solid-js 解析到 server 构建(store 节点非 Proxy),无法在测试里复现
// 浏览器构建的 store Proxy 行为 —— 故用字面 Proxy 锁「Proxy 过不了结构化克隆」的机制本身,
// 用 solid 的 unwrap 锁修复契约(browser 构建下拆 Proxy;server 构建下恒等,无害)。
import { describe, expect, test } from "bun:test"
import { createStore, unwrap } from "solid-js/store"

const receipt = {
  id: "skill:safe-refactor",
  name: "safe-refactor",
  type: "skill",
  scope: "global",
  version: "2026-07-03.1",
  installedAt: "2026-07-05T00:00:00.000Z",
  origin: "catalog",
  files: ["/x/.alpha/skills/safe-refactor"],
}

describe("IPC 参数必须 unwrap(REQ-016 真机批回归锁)", () => {
  test("Proxy 对象结构化克隆必抛(= contextBridge 拒收 store 节点的机制)", () => {
    const proxied = new Proxy({ ...receipt }, {})
    expect(() => structuredClone(proxied)).toThrow()
  })

  test("unwrap(store 节点) 可克隆且字段完整(= 过桥安全的修复契约)", () => {
    const [store] = createStore({ receipts: [receipt] })
    const plain = unwrap(store.receipts[0])
    const cloned = structuredClone(plain)
    expect(cloned).toEqual(receipt)
  })
})

// ── REQ-099(#307):卸载意图 scope 分支(uninstallIntentFor 纯函数;hook 挂载不可测的既有约束下,
// 契约在此锁定:project 收据必须携带项目目录,目录缺失如实拒绝 —— 绝不降级 global 删错同名对象)。
import { uninstallIntentFor } from "./use-extensions"

describe("uninstallIntentFor(#307 scope 分支)", () => {
  test("global 收据 → {scope:'global'},与项目上下文无关", () => {
    const r = uninstallIntentFor({ type: "skill", name: "safe-refactor", scope: "global" }, "/some/project")
    expect(r).toEqual({ ok: true, intent: { type: "skill", name: "safe-refactor", scope: "global" } })
  })

  test("project 收据 + 项目上下文 → {scope:'project', projectDir}", () => {
    const r = uninstallIntentFor({ type: "skill", name: "writer", scope: "project" }, "/w/alpha-code")
    expect(r).toEqual({ ok: true, intent: { type: "skill", name: "writer", scope: "project", projectDir: "/w/alpha-code" } })
  })

  test("project 收据、上下文丢失 → 如实拒绝(不发 intent,不降级 global)", () => {
    const r = uninstallIntentFor({ type: "skill", name: "writer", scope: "project" }, undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("project")
  })
})
