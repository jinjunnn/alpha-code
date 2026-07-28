// #668 顺带处置 —— alpha 设置项 `permissions.autoApprove` 不再是死开关。
//
// 它此前全仓无消费者:只有类型定义、settings UI 绑定、main 侧透传三处引用,**切了不改变任何
// 行为**。而真正活着的自动应答器(`packages/app/src/context/permission.tsx`)照旧会在
// `permission.asked` 上以 `"once"` 自动批准,且 alpha 已经删掉 v1 审批呈现面 ⇒ 那是零 UI 放行。
// 一个名叫"自动批准权限"、默认关闭、却什么都没关的开关,比没有这个开关更坏。
//
// owner 2026-07-28 裁决"要么接线要么删",本 PR 选择接线,形态是**单向 kill switch**:
// 关(默认)⇒ 任何 autoAccept 配置都不放行;开 ⇒ 上游既有语义一字未改。它不新增任何自动放行
// 能力(候选 D 已被否决)。
//
// 本闸的射程,写明白:它跑的是**生产判定权威**(`autoRespondsPermission` / `sessionAutoAccept`
// 本体,按相对路径直接加载 packages/app 的源文件 —— 不经 barrel、不在测试里重写等价物),在总闸开/关 × 会话/父会话/目录/无目录的**全矩阵**
// 上断言输出。它不覆盖"provider 有没有把设置传进来"—— 那一面由类型系统兜底:`options` 参数
// **必填**,新增调用点忘了传是编译错误,而不是静默绕过;并且 provider 在真正落到 respond 的那
// 唯一收口(`respondPending`)上另有一道显式短路。
//
// 变异验证(交付时实跑):删掉 `permission-auto-respond.ts` 里的两处 `if (!options.autoApprove)`
// ⇒ 本文件"关闭"那一组用例全红。

import {
  acceptKey,
  autoRespondsPermission,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  sessionAutoAccept,
} from "../../../../app/src/context/permission-auto-respond"
import { describe, expect, test } from "bun:test"

const OFF = { autoApprove: false }
const ON = { autoApprove: true }

const directory = "/tmp/project"
const sessions = [
  { id: "root" },
  { id: "child", parentID: "root" },
  { id: "grandchild", parentID: "child" },
]
/** 覆盖所有能让上游语义返回 true 的 store 形状。 */
const acceptingStores: Array<{ name: string; autoAccept: Record<string, boolean>; directory?: string }> = [
  { name: "会话级(裸 sessionID 键)", autoAccept: { grandchild: true } },
  { name: "父会话级(谱系继承)", autoAccept: { root: true } },
  { name: "会话+目录复合键", autoAccept: { [acceptKey("grandchild", directory)]: true }, directory },
  { name: "目录级通配", autoAccept: { [directoryAcceptKey(directory)]: true }, directory },
]

const permission = { sessionID: "grandchild" }

describe("permissions.autoApprove = 关(默认):没有任何自动放行", () => {
  for (const item of acceptingStores) {
    test(`${item.name} —— 上游语义会放行,总闸关闭后不放行`, () => {
      // 前置:这份 store 在总闸开启时**确实**会自动放行 —— 否则本用例什么都没证明。
      expect(autoRespondsPermission(item.autoAccept, sessions, permission, item.directory, ON)).toBe(true)
      // 判据:总闸关闭 ⇒ 不放行。
      expect(autoRespondsPermission(item.autoAccept, sessions, permission, item.directory, OFF)).toBe(false)
      // override 分支同样被闸住:它返回 undefined 时调用方会继续往下查目录级 fallback,
      // 所以总闸关闭时必须是一个确定的 false,不能是 undefined。
      expect(sessionAutoAccept(item.autoAccept, sessions, permission, item.directory, OFF)).toBe(false)
    })
  }

  test("无目录场景同样不放行", () => {
    expect(autoRespondsPermission({ grandchild: true }, sessions, permission, undefined, ON)).toBe(true)
    expect(autoRespondsPermission({ grandchild: true }, sessions, permission, undefined, OFF)).toBe(false)
  })
})

describe("permissions.autoApprove = 开:上游既有语义一字未改", () => {
  test("显式关掉的会话仍然不放行(总闸不是覆盖,只是前置)", () => {
    expect(autoRespondsPermission({ grandchild: false, [directoryAcceptKey(directory)]: true }, sessions, permission, directory, ON)).toBe(false)
  })

  test("未配置时回落目录级判定", () => {
    expect(autoRespondsPermission({}, sessions, permission, directory, ON)).toBe(false)
    expect(isDirectoryAutoAccepting({ [directoryAcceptKey(directory)]: true }, directory)).toBe(true)
  })
})
