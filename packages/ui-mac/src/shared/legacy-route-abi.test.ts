// REQ-084 验收 #1:LegacyRouteAbiV1 金样矩阵。字面量金样是故意硬编码的 —— 编解码器一漂移这里必红;
// 语义锚 = 上游冻结 app.tsx 路由树 / core/util/encode / tabs.tsx draftHref(见 legacy-route-abi.ts 头注)。

import { describe, expect, test } from "bun:test"
import {
  LEGACY_ROUTE_ABI_VERSION,
  decodeDirectory,
  encodeDirectory,
  hrefFor,
  isDirectorySlug,
  parseRoute,
} from "./legacy-route-abi"

// 目录夹具:POSIX / Windows / Unicode / 空格+产生 `+ / =` 的字节 / 全局 "/" 桶(ADR-008 合法值)。
const GOLDEN = [
  { directory: "/Users/dev/proj", slug: "L1VzZXJzL2Rldi9wcm9q" },
  { directory: "C:\\Users\\dev\\proj", slug: "QzpcVXNlcnNcZGV2XHByb2o" },
  { directory: "/家/项目/试验", slug: "L-Wuti_pobnnm64v6K-V6aqM" },
  // 标准 base64 为 "L3cgcy9+fn4/Pg=="(含 + / = 三种需转义/剥除的字符)→ URL-safe 无填充:
  { directory: "/w s/~~~?>", slug: "L3cgcy9-fn4_Pg" },
  { directory: "/", slug: "Lw" },
] as const

const BAD_SLUG = "!!!not-base64!!!"

describe("LEGACY_ROUTE_ABI_VERSION", () => {
  test("v1", () => {
    expect(LEGACY_ROUTE_ABI_VERSION).toBe(1)
  })
})

describe("目录编解码(金样字面量)", () => {
  test.each(GOLDEN)("encodeDirectory($directory) === $slug,且可逆", ({ directory, slug }) => {
    expect(encodeDirectory(directory)).toBe(slug)
    expect(decodeDirectory(slug)).toBe(directory)
  })

  test("解码失败返回 undefined(镜像上游 decode64 try/catch)", () => {
    expect(decodeDirectory(BAD_SLUG)).toBeUndefined()
    expect(decodeDirectory("A")).toBeUndefined() // 长度 ≡ 1 (mod 4) 非法
  })

  test("isDirectorySlug 只认编码器字符集(形状检查,不解码)", () => {
    for (const { slug } of GOLDEN) expect(isDirectorySlug(slug)).toBe(true)
    expect(isDirectorySlug(BAD_SLUG)).toBe(false)
    expect(isDirectorySlug("")).toBe(false)
    expect(isDirectorySlug("Lw==")).toBe(false) // 带填充 = 非本方案产物
  })

  test("与 @opencode-ai/core/util/encode 逐字节交叉验证(可解析时)", async () => {
    // 非字面量 specifier:ui-mac 未声明该依赖(不新增),解析不到就跳过 —— 金样字面量兜底。
    const core = (await import("@opencode-ai/core" + "/util/encode").catch(() => null)) as {
      base64Encode: (v: string) => string
      base64Decode: (v: string) => string
    } | null
    if (!core) return
    for (const { directory } of GOLDEN) {
      expect(encodeDirectory(directory)).toBe(core.base64Encode(directory))
      expect(decodeDirectory(core.base64Encode(directory))).toBe(directory)
      expect(core.base64Decode(encodeDirectory(directory))).toBe(directory)
    }
  })
})

describe("parseRoute(上游冻结路由树语义)", () => {
  const DIR = GOLDEN[0]

  test.each(["/", "/index.html", ""])("home:%j", (p) => {
    expect(parseRoute(p)).toEqual({ kind: "home" })
  })

  test("/:dir → directory", () => {
    expect(parseRoute(`/${DIR.slug}`)).toEqual({ kind: "directory", directory: DIR.directory, slug: DIR.slug })
  })

  test("/:dir/session → session(无 id)", () => {
    expect(parseRoute(`/${DIR.slug}/session`)).toEqual({
      kind: "session",
      directory: DIR.directory,
      slug: DIR.slug,
      id: undefined,
    })
  })

  test("/:dir/session/:id → session(带 id)", () => {
    expect(parseRoute(`/${DIR.slug}/session/ses_123`)).toEqual({
      kind: "session",
      directory: DIR.directory,
      slug: DIR.slug,
      id: "ses_123",
    })
  })

  test("/new-session?draftId=x → newSession", () => {
    expect(parseRoute("/new-session", "draftId=x")).toEqual({ kind: "newSession", draftId: "x", prompt: undefined })
    // pathname 内嵌 query 同样可解(round-trip 用法)
    expect(parseRoute("/new-session?draftId=x")).toEqual({ kind: "newSession", draftId: "x", prompt: undefined })
  })

  test("/new-session?draftId=x&prompt=hello%20world → prompt 解码", () => {
    expect(parseRoute("/new-session?draftId=x&prompt=hello%20world")).toEqual({
      kind: "newSession",
      draftId: "x",
      prompt: "hello world",
    })
  })

  test("/new-session 无 draftId → 参数缺省(上游 DraftRoute 会 Navigate '/')", () => {
    expect(parseRoute("/new-session")).toEqual({ kind: "newSession", draftId: undefined, prompt: undefined })
  })

  test("目录段非法 base64 → invalidDirectory(上游 toast + replace '/')", () => {
    expect(parseRoute(`/${BAD_SLUG}`)).toEqual({ kind: "invalidDirectory", slug: BAD_SLUG })
    expect(parseRoute(`/${BAD_SLUG}/session/ses_1`)).toEqual({ kind: "invalidDirectory", slug: BAD_SLUG })
  })

  test("路由树之外的形状 → unknown", () => {
    expect(parseRoute(`/${DIR.slug}/not-session`)).toEqual({ kind: "unknown", pathname: `/${DIR.slug}/not-session` })
    expect(parseRoute(`/${DIR.slug}/session/ses_1/extra`)).toEqual({
      kind: "unknown",
      pathname: `/${DIR.slug}/session/ses_1/extra`,
    })
    expect(parseRoute("/new-session/extra")).toEqual({ kind: "unknown", pathname: "/new-session/extra" })
  })
})

describe("hrefFor(构造 ↔ 解析 round-trip)", () => {
  test("字面量锚", () => {
    expect(hrefFor.home()).toBe("/")
    expect(hrefFor.directorySession("/Users/dev/proj")).toBe("/L1VzZXJzL2Rldi9wcm9q/session")
    expect(hrefFor.session("/Users/dev/proj", "ses_123")).toBe("/L1VzZXJzL2Rldi9wcm9q/session/ses_123")
    expect(hrefFor.newSession("d 1", "a+b")).toBe("/new-session?draftId=d%201&prompt=a%2Bb")
    expect(hrefFor.newSession("d1")).toBe("/new-session?draftId=d1") // prompt 缺省不追加 &prompt=
  })

  test.each(GOLDEN)("session round-trip:$directory", ({ directory, slug }) => {
    expect(parseRoute(hrefFor.session(directory, "ses_123"))).toEqual({
      kind: "session",
      directory,
      slug,
      id: "ses_123",
    })
  })

  test.each(GOLDEN)("directorySession round-trip:$directory", ({ directory, slug }) => {
    expect(parseRoute(hrefFor.directorySession(directory))).toEqual({
      kind: "session",
      directory,
      slug,
      id: undefined,
    })
  })

  test("newSession round-trip(draftId + prompt 含需转义字符)", () => {
    expect(parseRoute(hrefFor.newSession("draft-1", "hello world & 中文?"))).toEqual({
      kind: "newSession",
      draftId: "draft-1",
      prompt: "hello world & 中文?",
    })
    expect(parseRoute(hrefFor.newSession("d/&? 1"))).toEqual({ kind: "newSession", draftId: "d/&? 1", prompt: undefined })
  })
})
