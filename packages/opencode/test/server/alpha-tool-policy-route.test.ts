// alpha 自有文件(basename `alpha-*`,ADR-043 因子②)。
//
// REQ-131 / #1130 —— 引擎 tool policy 面(inventory 读 + record 写 + reset)从**已收编**的 v2
// permission 面走出引擎进程的常驻闸(路线 B,勘破见票面 2026-09-17 评论与
// docs/architecture/2026-09-17-tool-policy-transport-seam.md)。
//
// 判据纪律:
//   ① 不 mock 任何 layer:请求穿过生产装配 `HttpApiApp.routes`(真 location 中间件 →
//      PermissionHandler → core 标签 → opencode bridge → InstanceStore.provide → AlphaToolPolicy/Inventory);
//   ② wire 契约自证:跨 HTTP 后再 decode 一次 `parseToolPolicyInventory`;
//   ③ 写侧不是「返回 204 就算」—— 写完再读 inventory,断言 effective 真的翻了(R2),
//      再删掉,断言又翻回默认(同一 selector 的记录被移除,不是被覆盖);
//   ④ 放宽有闸:service 层 enabled 不带 bindingDigest 在 wire 上就被拒(400),
//      不是落盘后让全文档进 quarantine(R3);
//   ⑤ quarantine 是 409 而不是 500 / 静默成功;reset 之后再写可以通(R4);
//   ⑥ 控制组:兄弟路径被 UI 兜底吃掉、回的不是 JSON —— 所以上面的 200 不能单靠状态码判(R5)。
import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { Global } from "@opencode-ai/core/global"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { policyFilePath } from "../../src/permission/alpha-tool-policy"
import { parseToolPolicyInventory } from "@opencode-ai/schema/alpha-tool-inventory"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

// ── 手写的期望字面量(不从 canonicalToolIdentity() 导出)────────────────────────
const ID_BUILTIN_WRITE = "builtin::write"
const ROUTE_INVENTORY = "/api/permission/tool-policy/inventory"
const ROUTE_RECORD = "/api/permission/tool-policy/record"
const ROUTE_RECORD_REMOVE = "/api/permission/tool-policy/record/remove"
const ROUTE_RESET = "/api/permission/tool-policy/reset"
const POLICY_BASE = path.join(Global.Path.data, "alpha-tool-policy")

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, { ...init, headers }), context)
}

function json(route: string, directory: string, method: "PUT" | "POST", body?: unknown) {
  return request(route, directory, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function inventory(directory: string) {
  const response = await request(ROUTE_INVENTORY, directory)
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type") ?? "").toContain("application/json")
  const body = (await response.json()) as { data: unknown }
  return parseToolPolicyInventory(body.data)
}

function tool(inv: ReturnType<typeof parseToolPolicyInventory>, canonical: string) {
  return inv.services.flatMap((service) => service.tools).find((item) => item.canonical === canonical)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  // 分区 = (anonymous, project.id);tmpdir 实例的 project.id 跨用例可能相同,策略文件住在
  // 进程级 XDG data 下 ⇒ 每条用例之后整目录清掉,前一条写的记录不会咬到后一条。
  await fs.rm(POLICY_BASE, { recursive: true, force: true })
})

describe("#1130 tool policy face over the collected v2 permission group", () => {
  test("R1 GET inventory returns the live inventory of the location's engine instance", async () => {
    await using tmp = await tmpdir({ git: true })
    const inv = await inventory(tmp.path)
    expect(inv.version).toBe(1)
    expect(inv.user.status).toBe("absent")
    expect(inv.services.length).toBeGreaterThan(0)
    const write = tool(inv, ID_BUILTIN_WRITE)
    expect(write?.effective).toMatchObject({ state: "enabled", reason: { kind: "default", class: "builtin" } })
    for (const service of inv.services) {
      for (const item of service.tools) expect(["allow", "ask", "deny"]).toContain(item.effective.action)
    }
  })

  test("R2 PUT record flips effective through the same resolver; remove flips it back", async () => {
    await using tmp = await tmpdir({ git: true })
    const set = await json(ROUTE_RECORD, tmp.path, "PUT", {
      selector: { level: "class", class: "builtin" },
      state: "ask",
    })
    expect(set.status).toBe(204)

    const after = await inventory(tmp.path)
    expect(after.classRecords).toEqual([{ selector: { level: "class", class: "builtin" }, state: "ask" }])
    expect(tool(after, ID_BUILTIN_WRITE)?.effective).toMatchObject({
      state: "ask",
      action: "ask",
      reason: { kind: "user", level: "class" },
    })

    const removed = await json(ROUTE_RECORD_REMOVE, tmp.path, "POST", {
      selector: { level: "class", class: "builtin" },
    })
    expect(removed.status).toBe(204)
    const restored = await inventory(tmp.path)
    expect(restored.classRecords).toEqual([])
    expect(tool(restored, ID_BUILTIN_WRITE)?.effective).toMatchObject({ state: "enabled", reason: { kind: "default" } })
  })

  test("R3 service-level enabled without bindingDigest is rejected on the wire (400), never persisted", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await json(ROUTE_RECORD, tmp.path, "PUT", {
      selector: { level: "service", source: "mcp", origin: "anything" },
      state: "enabled",
    })
    expect(response.status).toBe(400)
    const inv = await inventory(tmp.path)
    expect(inv.user.status).toBe("absent")
  })

  test("R4 quarantined document: writes are 409, reset backs it up and reopens writes", async () => {
    await using tmp = await tmpdir({ git: true })
    const before = await inventory(tmp.path)
    await fs.mkdir(path.dirname(policyFilePath(POLICY_BASE, before.partition)), { recursive: true })
    await fs.writeFile(policyFilePath(POLICY_BASE, before.partition), "not a document")

    const quarantined = await inventory(tmp.path)
    expect(quarantined.user.status).toBe("quarantined")

    const refused = await json(ROUTE_RECORD, tmp.path, "PUT", {
      selector: { level: "class", class: "builtin" },
      state: "ask",
    })
    expect(refused.status).toBe(409)

    const reset = await json(ROUTE_RESET, tmp.path, "POST")
    expect(reset.status).toBe(200)
    const body = (await reset.json()) as { data: { backup?: string } }
    expect(body.data.backup).toMatch(/\.quarantined-\d+$/)
    expect(await fs.readFile(body.data.backup!, "utf8")).toBe("not a document")

    const reopened = await inventory(tmp.path)
    expect(reopened.user.status).toBe("absent")
    const set = await json(ROUTE_RECORD, tmp.path, "PUT", {
      selector: { level: "class", class: "builtin" },
      state: "ask",
    })
    expect(set.status).toBe(204)
  })

  // 控制组:生产路由表末尾的 `/*` UI 兜底对未知路径也回 200 —— 上面的 200 不能单靠状态码判。
  test("R5 an unknown sibling path is served by the UI catch-all, not by the tool policy handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request(`${ROUTE_INVENTORY}-does-not-exist`, tmp.path)
    expect(response.headers.get("content-type") ?? "").not.toContain("application/json")
  })
})
