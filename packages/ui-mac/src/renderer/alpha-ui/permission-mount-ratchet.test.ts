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
// #668:PermissionSurfaceClient 工厂从 app.tsx 抽成模块(闸门要挂载生产接线点,见下方白名单
// 注释)。挂载唯一性的判据因此在两份文件上一起数,不是换个地方就不数了。
const permissionSurface = await Bun.file(resolve(root, "packages/app/src/context/permission-surface.tsx")).text()
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
    expect(`${app}${permissionSurface}`.match(/component=\{PermissionSurface\}/g)).toHaveLength(1)
    expect(app).toContain("createPermissionSurfaceMount")
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

  /** 白名单 = 今天真实存在的引用面,一文件一 token,精确到形态。
   *
   *  ── #668 显式更新(owner 2026-07-28 裁决半场 A;这条棘轮是刻意设的,悄悄绕过它是本仓
   *     最常见的失败形态,所以下面写清"为什么这次放行是对的")──────────────────────
   *
   *  变更:`packages/app/src/app.tsx` 退场,换成两个文件;新增一个 v1 提交入口。
   *
   *  1) `context/permission-surface.tsx` 顶替 app.tsx 持有 `permission.reply`。
   *     这**不是**新增入口,是同一个入口原样搬家:app.tsx 里那段 PermissionSurfaceClient
   *     工厂被整体抽成模块,app.tsx 只剩一行 `createPermissionSurfaceMount(...)`。抽出来的
   *     动机是闸门可执行性(ADR-037 决策 4):#668 的行为闸要在真实 DOM 里挂载**生产**接线点、
   *     点真的按钮、看真的 SDK 出口 —— app.tsx 整棵路由树挂不动。入口总数不变。
   *
   *  2) `context/permission-v1-adapter.ts` 新增 v1 `permission.reply`(即
   *     `/permission/{requestID}/reply`)。这是本票要修的缺陷本身:ADR-036 之后真正在跑的是
   *     v1 引擎,它发 `permission.asked`,而 alpha 的审批面只订 v2 —— 于是审批请求既不呈现
   *     也无人应答,回合无限期挂起(#668 实测)。呈现面要能应答 v1,就必须有一个 v1 提交入口;
   *     owner 否决了 B(引擎侧桥接)与 C(恢复上游 v1 呈现面),A 的定义就是"审批面同时消费
   *     两条通道"。
   *
   *  为什么这次放行不破坏这条棘轮要守的东西:棘轮守的是"审批决定只能从**被登记的**接线点
   *  提交",不是"只能有一个通道"。放行后:
   *   - 呈现面仍然只有一个(PermissionDialog / PermissionWatcher),棘轮上半场的单一挂载断言
   *     一字未改、照常执行;
   *   - 两个 reply 引用面都在同一个模块对(surface + adapter)里,由**同一个** Permission
   *     surface client 调用;dock/composer 依旧零提交路径(运行时闸③ 逐条断言,#668 后它的
   *     合法流量集合从 `{v2 list}` 扩成 `{v2 list, v1 list}` —— 仍然只有读,没有写);
   *   - v1 提交路径带**指纹绑定**:只有携带 `engine-v1:<id>` 指纹的命令会被路由到 v1,
   *     其余照旧走 v2;陈旧/错单在客户端即被拒。
   *
   *  3) `context/permission.tsx` 的 `permission.respond` 登记不变(上游 legacy 自动应答器),
   *     但它在 #668 里被接上了 `permissions.autoApprove` 这个此前的死开关:关(默认)= 该
   *     入口不会提交任何决定。登记保留,因为引用面确实还在。
   *
   *  新增任何引用面都必须先动这份清单 —— 那是一次显式的架构决策,不是顺手的代码改动。 */
  const SANCTIONED_ENTRY_HOLDERS = [
    { file: "packages/app/src/context/permission-surface.tsx", token: "permission.reply" },
    { file: "packages/app/src/context/permission-v1-adapter.ts", token: "permission.reply" },
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
