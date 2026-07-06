// B16 云同意纯核单测(S25)+ prefs I/O 往返。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { CLOUD_CONSENT_VERSION, hasCloudConsent, parsePrefs, withCloudConsent } from "./alpha-cloud-consent"

describe("parsePrefs — 缺失/损坏/非对象一律 {}(不误判为已同意)", () => {
  test.each([[null], [undefined], [""], ["not json"], ["[]"], ["123"], ["null"]])("%p → {}", (input) => {
    expect(parsePrefs(input as string | null)).toEqual({})
  })
  test("合法对象原样返回", () => {
    expect(parsePrefs('{"cloudConsent":{"version":1,"acceptedAt":"x"},"other":true}')).toMatchObject({
      other: true,
      cloudConsent: { version: 1 },
    })
  })
})

describe("hasCloudConsent — 版本必须匹配", () => {
  test("无记录 = 未同意", () => {
    expect(hasCloudConsent({})).toBe(false)
  })
  test("当前版本 = 已同意", () => {
    expect(hasCloudConsent({ cloudConsent: { version: CLOUD_CONSENT_VERSION, acceptedAt: "t" } })).toBe(true)
  })
  test("旧版本告知 = 视作未同意(重新弹)", () => {
    expect(hasCloudConsent({ cloudConsent: { version: CLOUD_CONSENT_VERSION - 1, acceptedAt: "t" } })).toBe(false)
  })
})

describe("withCloudConsent — 合并保留其它字段", () => {
  test("写入当前版本 + iso,保留 other", () => {
    const merged = withCloudConsent({ other: 42 }, "2026-07-06T00:00:00.000Z")
    expect(merged).toEqual({ other: 42, cloudConsent: { version: CLOUD_CONSENT_VERSION, acceptedAt: "2026-07-06T00:00:00.000Z" } })
    expect(hasCloudConsent(merged)).toBe(true)
  })
})

describe("prefs I/O 往返(.alpha/prefs.json,守卫复用)", () => {
  let base = ""
  const prevAlpha = process.env.ALPHA_GLOBAL_DIR
  let readProjectPrefs: typeof import("./alpha-workdir").readProjectPrefs
  let writeProjectPrefs: typeof import("./alpha-workdir").writeProjectPrefs

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-prefs-"))
    ;({ readProjectPrefs, writeProjectPrefs } = await import("./alpha-workdir"))
  })
  afterEach(() => {
    if (prevAlpha === undefined) delete process.env.ALPHA_GLOBAL_DIR
    else process.env.ALPHA_GLOBAL_DIR = prevAlpha
    fs.rmSync(base, { recursive: true, force: true })
  })

  test("未写过 → {};写入后读回一致;.alpha 自忽略", () => {
    expect(readProjectPrefs(base)).toEqual({})
    const w = writeProjectPrefs(base, withCloudConsent({}, "2026-07-06T00:00:00.000Z"))
    expect(w.ok).toBe(true)
    expect(hasCloudConsent(readProjectPrefs(base))).toBe(true)
    expect(fs.readFileSync(path.join(base, ".alpha", ".gitignore"), "utf8")).toBe("*\n")
  })

  test("合并写不丢其它偏好字段", () => {
    writeProjectPrefs(base, { theme: "dark" })
    writeProjectPrefs(base, withCloudConsent(readProjectPrefs(base), "t"))
    const p = readProjectPrefs(base)
    expect(p.theme).toBe("dark")
    expect(hasCloudConsent(p)).toBe(true)
  })

  test("非法项目目录(根)拒写", () => {
    expect(writeProjectPrefs("/", { a: 1 })).toMatchObject({ ok: false })
    expect(readProjectPrefs("relative/path")).toEqual({})
  })
})
