// REQ-012:上游 DOM 锚点契约测试(546-sync 静默回归的防复发红线)。
// 三重断言:①清单新鲜(CSS/TSX 引用集 == 清单,防清单腐烂)②alive 全部可渲染(上游任意包 ∪ alpha
// 自渲染)——上游 sync 删/改名 → 本测试红,合入/发布前拦下 ③knownDead 保持死(复活了必须迁回 alive,
// 清单双向诚实——2026-07-03 实证过:94 个"死"锚点随 session-ui 拆包整批复活)。
// 改 reskin 后清单过期 → 跑 `bun scripts/gen-upstream-anchors.ts` 再提交。

import { describe, expect, test } from "bun:test"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { checkAnchors, extractReferencedAnchors, loadSources, type AnchorManifest, type AnchorRef } from "./anchor-audit"
import manifest from "./upstream-anchors.json"

const rendererDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(rendererDir, "..", "..", "..", "..")

const m = manifest as AnchorManifest
const sources = loadSources(repoRoot, rendererDir)
const refs = extractReferencedAnchors(rendererDir)
const refKeys = refs.map((r) => `${r.kind}:${r.value}`)
const parse = (key: string): AnchorRef => {
  const [kind, ...rest] = key.split(":")
  return { kind: kind as AnchorRef["kind"], value: rest.join(":") }
}

describe("upstream anchor contract (REQ-012)", () => {
  test("清单新鲜:renderer 引用集与 upstream-anchors.json 一致(过期 → 跑 gen 脚本)", () => {
    const manifestKeys = [...m.alive, ...m.knownDead].sort()
    expect(refKeys).toEqual(manifestKeys)
  })

  test("alive 锚点全部仍被渲染 —— 上游 sync 删/改名此处必红(静默回归 → 高声)", () => {
    const checks = checkAnchors(m.alive.map(parse), sources)
    const dead = checks.filter((c) => !c.rendered).map((c) => `${c.ref.kind}:${c.ref.value}`)
    // 红了怎么办:上游把锚点删/改名/搬包了。① 找到新名/新位置 → 更新 reskin CSS + 跑 gen 脚本;
    // ② 确认彻底消失 → 修接线后重新生成(它会迁入 knownDead 等 REQ-010 式处理)。不要直接改 json。
    expect(dead).toEqual([])
  })

  test("knownDead 保持死 —— 复活的锚点必须迁回 alive(清单双向诚实)", () => {
    const checks = checkAnchors(m.knownDead.map(parse), sources)
    const revived = checks.filter((c) => c.rendered).map((c) => `${c.ref.kind}:${c.ref.value}`)
    // 红了怎么办:上游把这个锚点带回来了(546 后 session-ui 整批复活是真实先例)——跑 gen 脚本刷新清单,
    // 顺带检查对应换肤是否需要恢复(REQ-010)。
    expect(revived).toEqual([])
  })

  test("故意断言一个不存在的锚点 → 检测器必报死(验收②:防护网真的会红)", () => {
    const fake: AnchorRef = { kind: "component", value: "req012-this-anchor-does-not-exist" }
    const [check] = checkAnchors([fake], sources)
    expect(check.rendered).toBe(false)
  })

  test("检测器不被选择器形态骗过:CSS/querySelector 引用不算渲染(首版假阳性回归线)", () => {
    const [check] = checkAnchors([{ kind: "component", value: "fake-selector-only" }], {
      upstream: "",
      alphaTsx: `el.querySelector('[data-component="fake-selector-only"]')`,
    })
    expect(check.rendered).toBe(false)
    const [rendered] = checkAnchors([{ kind: "component", value: "really-rendered" }], {
      upstream: "",
      alphaTsx: `<div data-component="really-rendered" />`,
    })
    expect(rendered.rendered).toBe(true)
  })
})
