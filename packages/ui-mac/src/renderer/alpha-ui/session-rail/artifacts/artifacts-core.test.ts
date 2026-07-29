import { describe, expect, test } from "bun:test"
import type { ArtifactCard, RunArtifactUsage } from "../../artifact-workbench/workbench-core"
import {
  artifactsIdentityKeyOf,
  artifactsPhaseOf,
  findArtifactCard,
  runMomentOf,
  runRowModelOf,
  shortRunId,
} from "./artifacts-core"

function card(input: Partial<ArtifactCard> & { key: string }): ArtifactCard {
  return { name: input.key, state: "verified", bytes: 1, warnings: [], downloadable: false, ...input }
}

describe("REQ-125 C4 artifacts phase (fail-closed)", () => {
  test("nothing proven readable renders as loading, failures as error", () => {
    expect(artifactsPhaseOf({ usage: undefined, runId: undefined, list: undefined, cardCount: 0 })).toBe("loading")
    expect(artifactsPhaseOf({ usage: { ok: false }, runId: undefined, list: undefined, cardCount: 0 })).toBe("error")
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: "job_1", list: undefined, cardCount: 0 })).toBe("loading")
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: "job_1", list: { ok: false }, cardCount: 0 })).toBe("error")
  })

  test("两种空是两个相位:没有任何 run = empty;这一次没有产物 = empty-run(#660)", () => {
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: undefined, list: undefined, cardCount: 0 })).toBe("empty")
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: "job_1", list: { ok: true }, cardCount: 0 })).toBe("empty-run")
    expect(artifactsPhaseOf({ usage: { ok: true }, runId: "job_1", list: { ok: true }, cardCount: 2 })).toBe("cards")
  })
})

describe("#660 B1 run 时刻(纯函数,now 注入,失败关闭)", () => {
  // 用本地时区构造,断言不依赖机器时区。
  const now = new Date(2026, 6, 28, 16, 0) // 2026-07-28 16:00 local

  test("同日/昨日/同年/跨年四档,时间两位补零", () => {
    expect(runMomentOf(new Date(2026, 6, 28, 15, 2).toISOString(), now)).toEqual({ kind: "today", time: "15:02" })
    expect(runMomentOf(new Date(2026, 6, 27, 18, 20).toISOString(), now)).toEqual({ kind: "yesterday", time: "18:20" })
    expect(runMomentOf(new Date(2026, 6, 26, 11, 5).toISOString(), now)).toEqual({
      kind: "date",
      month: 7,
      day: 26,
      time: "11:05",
    })
    expect(runMomentOf(new Date(2025, 11, 3, 9, 0).toISOString(), now)).toEqual({
      kind: "date-year",
      year: 2025,
      month: 12,
      day: 3,
      time: "09:00",
    })
  })

  test("缺失/空串/解析不出 → null(回落显示编号,绝不渲染错时间)", () => {
    expect(runMomentOf(null, now)).toBeNull()
    expect(runMomentOf(undefined, now)).toBeNull()
    expect(runMomentOf("", now)).toBeNull()
    expect(runMomentOf("not-a-timestamp", now)).toBeNull()
  })

  test("月初跨月的『昨天』按日历算,不是减 24 小时", () => {
    const monthStart = new Date(2026, 7, 1, 0, 30) // 2026-08-01 00:30 local
    expect(runMomentOf(new Date(2026, 6, 31, 23, 50).toISOString(), monthStart)).toEqual({
      kind: "yesterday",
      time: "23:50",
    })
  })

  test("shortRunId 中段截断,短编号原样", () => {
    expect(shortRunId("job_7f3a01bc")).toBe("job_7f3a01bc")
    expect(shortRunId("job_7f3a01b9d2c4c21e")).toBe("job_7f3a…c21e")
  })

  test("runRowModelOf:位次标记只到第二行,事实字段原样透传", () => {
    const usage: RunArtifactUsage = {
      runId: "job_abc123def456",
      artifactCount: 5,
      recordedBytes: 100,
      diskBytes: 1200,
      legacyBytes: 0,
      missingCount: 2,
      readOnly: false,
      updatedAt: new Date(2026, 6, 28, 15, 2).toISOString(),
    }
    expect(runRowModelOf(usage, 0, now)).toEqual({
      runId: "job_abc123def456",
      moment: { kind: "today", time: "15:02" },
      ordinal: "latest",
      artifactCount: 5,
      diskBytes: 1200,
      missingCount: 2,
      readOnly: false,
    })
    expect(runRowModelOf(usage, 1, now).ordinal).toBe("previous")
    expect(runRowModelOf(usage, 2, now).ordinal).toBeUndefined()
    expect(runRowModelOf({ ...usage, updatedAt: null, readOnly: true }, 2, now)).toMatchObject({
      moment: null,
      readOnly: true,
    })
  })
})

describe("REQ-125 C4 focus-target resolution", () => {
  const cards = [
    card({ key: "art-1", descriptor: { id: "art-1" } as never }),
    card({ key: "legacy:report.md" }),
  ]

  test("matches by descriptor id first, card key as fallback, nothing on unknown ids", () => {
    expect(findArtifactCard(cards, "art-1")?.key).toBe("art-1")
    expect(findArtifactCard(cards, "legacy:report.md")?.key).toBe("legacy:report.md")
    expect(findArtifactCard(cards, "art-unknown")).toBeUndefined()
    expect(findArtifactCard([], "art-1")).toBeUndefined()
  })
})

describe("REQ-125 C4 identity key (I8)", () => {
  test("binds the full triple and distinguishes every component", () => {
    const identity = { serverKey: "s", directory: "/d", sessionID: "x" }
    const key = artifactsIdentityKeyOf(identity)!
    expect(artifactsIdentityKeyOf(undefined)).toBeUndefined()
    expect(artifactsIdentityKeyOf({ ...identity })).toBe(key)
    expect(artifactsIdentityKeyOf({ ...identity, serverKey: "s2" })).not.toBe(key)
    expect(artifactsIdentityKeyOf({ ...identity, directory: "/d2" })).not.toBe(key)
    expect(artifactsIdentityKeyOf({ ...identity, sessionID: "y" })).not.toBe(key)
  })
})
