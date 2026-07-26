import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { frontendSurfaceById } from "../../shared/frontend-surface-manifest"

const root = resolve(import.meta.dir, "../../../../..")
const legacyDock = resolve(root, "packages/app/src/pages/session/composer/session-permission-dock.tsx")
const composerRegion = await Bun.file(
  resolve(root, "packages/app/src/pages/session/composer/session-composer-region.tsx"),
).text()
const composerState = await Bun.file(
  resolve(root, "packages/app/src/pages/session/composer/session-composer-state.ts"),
).text()
const composerReskin = await Bun.file(
  resolve(root, "packages/ui-mac/src/renderer/alpha-ui/composer-reskin.css"),
).text()
const renderer = await Bun.file(resolve(root, "packages/ui-mac/src/renderer/index.tsx")).text()
const app = await Bun.file(resolve(root, "packages/app/src/app.tsx")).text()
const watcher = await Bun.file(
  resolve(root, "packages/ui-mac/src/renderer/alpha-ui/permission-watcher.tsx"),
).text()
const permissionDialog = await Bun.file(
  resolve(root, "packages/ui-mac/src/renderer/alpha-ui/PermissionDialog.tsx"),
).text()
const l2Harness = await Bun.file(
  resolve(root, "docs/verification/2026-07-21-req090-permission-l2/harness.html"),
).text()
const l2Readme = await Bun.file(
  resolve(root, "docs/verification/2026-07-21-req090-permission-l2/README.md"),
).text()

describe("Alpha Permission unique-mount ratchet", () => {
  test("deletes the upstream dock, legacy submission path, and dedicated reskin", async () => {
    expect(await Bun.file(legacyDock).exists()).toBeFalse()
    expect(composerRegion).not.toContain("SessionPermissionDock")
    expect(composerState).not.toContain("client.permission.respond")
    expect(composerReskin).not.toContain('data-kind="permission"')
    expect(composerReskin).not.toContain("permission-patterns")
  })

  test("mounts exactly once through the current Session SDK seam and records Alpha ownership", () => {
    expect(renderer.match(/<PermissionWatcher\b/g)).toHaveLength(1)
    expect(renderer).toContain("permission: (props) =>")
    expect(app).toContain("props.surfaces?.permission")
    expect(app.match(/component=\{PermissionSurface\}/g)).toHaveLength(1)
    expect(watcher).not.toContain("createOpencodeClient")
    expect(watcher).not.toContain("global.event")
    expect(frontendSurfaceById("inline.permission")).toMatchObject({
      owner: "alpha.permission",
      lineage: "alpha",
      mount: { kind: "overlay", host: "alpha-permission-dialog" },
      source: "packages/ui-mac/src/renderer/alpha-ui/permission-watcher.tsx",
    })
  })

  test("uses the Session Permission contract without sharing REQ-212 domain enums", () => {
    expect(permissionDialog).toContain("PermissionV2DecisionCommand")
    expect(permissionDialog).not.toContain("ext-capability-authorization")
    expect(permissionDialog).not.toContain("ExtensionCapability")
  })

  test("keeps the frame 03 L2 matrix on real Alpha CSS with no contract placeholders", () => {
    const facts = ["subject", "action", "resources", "scope", "expiry"]
    const decisions = ["once", "always", "reject"]
    expect(l2Harness).toContain("permission-dialog.css")
    facts.forEach((fact) => {
      expect(l2Harness).toContain(`data-permission-fact="${fact}"`)
    })
    decisions.forEach((decision) => {
      expect(l2Harness).toContain(`data-permission-decision="${decision}"`)
    })
    expect(l2Harness).toContain('data-kind="failed"')
    expect(l2Harness).not.toContain("待契约")
    expect(l2Readme).toContain("完整事实 / 三态 / 提交失败 × 双主题")
  })
})

// #619 R3 Blocker-2:审批决定提交入口的**源码可达性**闸门(owner 2026-07-26 裁决:
// 不用测试闸门解决,改静态规则)。
//
// 分工声明 —— 本规则与运行时行为闸(session-workspace/permission-single-surface.test.ts
// 闸③)互补,任何一条都不是万能闸门:
// - 运行时闸只能证明「它实际执行过的路径」零违规流量。用户门控的提交通道(Alt+Y 键盘
//   处理器、window.confirm 门控分支)不被测试派发就永不执行 —— Codex R3 两条实测绕过
//   在运行时闸下全绿。「不存在第二提交通道」这类命题运行时测试**原理上证明不了**。
// - 本棘轮按**源码引用面**补位:静态扫描全部生产源,permission 决定提交入口
//   (v2 `permission.reply` / legacy `permission.respond`,经归一化连方括号取值
//   `["permission"]["reply"]` 一并折算)只允许出现在下方白名单 —— 未执行路径在源码
//   引用面上即红。
// - 本规则本身是文本判据,可被间接取值绕过(先把 permission 对象存进变量再调 .reply):
//   那一面恰好是运行时闸③的射程(SDK 全前缀 alias 录音,任何**执行到**的提交都入账)。
//   删除任何一条闸都要回 #619 审计链重评,不得只改测试。
//
// 现状勘破(Codex R3):生产没有已接线的 V2 授权 IPC —— preload `showNotification` 是
// 单向通知(不返回动作);内置 opencode-notify 插件监听的是 legacy `permission.asked`,
// 不是本票的 `permission.v2.asked`。本规则防的是**将来**把第二提交通道接进
// renderer/preload/main/dock,不是在堵一个现存活漏洞。
describe("审批决定提交入口:单一引用面白名单棘轮(#619 R3 Blocker-2)", () => {
  /** app + ui-mac 的全部生产 ts/tsx。排除仅测试文件与测试 harness 命名约定
   *  (*.test.* / *-test-runtime.* / *-stub.*)—— harness 里的对抗探针刻意携带提交调用。 */
  function* walkProduction(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        yield* walkProduction(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      if (/\.test\.|-test-runtime\.|-stub\./.test(entry.name)) continue
      yield p
    }
  }

  /** 归一化:去空白、方括号字符串取值折算成点取值 —— `v2.session["permission"]['reply']`
   *  与 `v2.session.permission.reply` 落成同一形态,方括号等义改写不豁免。 */
  const normalize = (source: string) =>
    source
      .replace(/\s+/g, "")
      .replace(/\[["'`]/g, ".")
      .replace(/["'`]\]/g, "")

  const DECISION_ENTRY_TOKENS = ["permission.reply", "permission.respond"] as const

  /** 白名单 = 今天真实存在的引用面,一文件一 token,精确到形态:
   *  - app.tsx:PermissionSurfaceClient 工厂 —— 把 typed `v2.session.permission.reply`
   *    接给独立 Permission surface(PermissionWatcher)的唯一生产接线点;
   *  - context/permission.tsx:上游 legacy v1 `permission.respond` 通道的现存量登记
   *    (监听 legacy `permission.asked`,不在 V2 射程)。新增任何引用面都必须先动这份
   *    清单 —— 那是一次显式的架构决策,不是顺手的代码改动。 */
  const SANCTIONED_ENTRY_HOLDERS = [
    { file: "packages/app/src/app.tsx", token: "permission.reply" },
    { file: "packages/app/src/context/permission.tsx", token: "permission.respond" },
  ] as const

  test("permission 决定提交入口(reply/respond,含方括号等义形态)只出现在白名单接线点", () => {
    const offenders: Array<{ file: string; token: string }> = []
    const seen = new Set<string>()
    for (const scanRoot of [resolve(root, "packages/app/src"), resolve(root, "packages/ui-mac/src")]) {
      for (const filePath of walkProduction(scanRoot)) {
        const normalized = normalize(readFileSync(filePath, "utf8"))
        for (const token of DECISION_ENTRY_TOKENS) {
          if (!normalized.includes(token)) continue
          const file = relative(root, filePath)
          if (SANCTIONED_ENTRY_HOLDERS.some((holder) => holder.file === file && holder.token === token)) {
            seen.add(`${file}::${token}`)
            continue
          }
          offenders.push({ file, token })
        }
      }
    }
    expect(offenders).toEqual([])
    // 反锈蚀:白名单里的接线点必须仍然真实在场 —— 入口迁移时必须显式改这份清单,
    // 不允许清单退化成一堆指向空气的豁免。
    expect([...seen].sort()).toEqual(
      SANCTIONED_ENTRY_HOLDERS.map((holder) => `${holder.file}::${holder.token}`).sort(),
    )
  })
})
