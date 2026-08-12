// #879(REQ-125)— 共享 redactor 的 table tests(URL / path / free-text)。
// 锚点全部是独立字面量;负向夹具避开最退化形状(带端口/多段路径/混合文本)。
import { describe, expect, test } from "bun:test"
import { redactPath, redactText, redactUrl } from "./tool-redactor"

const URL_CAP = 500
const PATH_CAP = 1_024

describe("#879 redactUrl", () => {
  test("删除 userinfo / query / fragment;保留 scheme + host(:port) + pathname", () => {
    const table: Array<[string, string]> = [
      ["https://u:pw@a.example.com/x?k=v#f", "https://a.example.com/x"],
      ["http://b.example.org:8080/deep/path?q=1", "http://b.example.org:8080/deep/path"],
      ["https://c.example.net/#only-frag", "https://c.example.net"],
      ["https://plain.example.dev", "https://plain.example.dev"],
    ]
    for (const [raw, cleaned] of table) {
      expect({ raw, result: redactUrl(raw, URL_CAP) }).toEqual({
        raw,
        result: { ok: true, value: cleaned, truncated: false },
      })
    }
  })

  test("pathname 里的 secret sentinel 段被替换", () => {
    expect(redactUrl("https://h.example.com/v2/api-key/rotate?x=1", URL_CAP)).toEqual({
      ok: true,
      value: "https://h.example.com/v2/[已隐藏]/rotate",
      truncated: false,
    })
  })

  test("非 http(s) / 解析失败 / 超长 一律 fail-closed", () => {
    expect(redactUrl("file:///etc/passwd", URL_CAP)).toEqual({ ok: false })
    expect(redactUrl("javascript:alert(1)", URL_CAP)).toEqual({ ok: false })
    expect(redactUrl("http://[broken", URL_CAP)).toEqual({ ok: false })
    expect(redactUrl("", URL_CAP)).toEqual({ ok: false })
    expect(redactUrl(`https://long.example/${"a".repeat(URL_CAP)}`, URL_CAP)).toEqual({ ok: false })
  })
})

describe("#879 redactPath", () => {
  test("home 前缀折叠为 ~(POSIX 与 Windows 两种形态)", () => {
    expect(redactPath("/Users/carol/work/notes.md", PATH_CAP)).toEqual({
      ok: true,
      value: "~/work/notes.md",
      truncated: false,
    })
    expect(redactPath("/home/dave/svc/main.go", PATH_CAP)).toEqual({
      ok: true,
      value: "~/svc/main.go",
      truncated: false,
    })
    expect(redactPath("C:\\Users\\eve\\proj\\app.cs", PATH_CAP)).toEqual({
      ok: true,
      value: "~/proj/app.cs",
      truncated: false,
    })
  })

  test("sentinel 段替换;词界匹配不误伤 tokenizer/environment", () => {
    expect(redactPath("/srv/deploy/api-key/current", PATH_CAP)).toEqual({
      ok: true,
      value: "/srv/deploy/[已隐藏]/current",
      truncated: false,
    })
    expect(redactPath("/cfg/.env.production", PATH_CAP)).toEqual({
      ok: true,
      value: "/cfg/[已隐藏]",
      truncated: false,
    })
    expect(redactPath("/app/secrets.yaml", PATH_CAP)).toEqual({
      ok: true,
      value: "/app/[已隐藏]",
      truncated: false,
    })
    expect(redactPath("/ml/tokenizer.rs", PATH_CAP)).toEqual({ ok: true, value: "/ml/tokenizer.rs", truncated: false })
    expect(redactPath("/os/environment.d/x.conf", PATH_CAP)).toEqual({
      ok: true,
      value: "/os/environment.d/x.conf",
      truncated: false,
    })
  })

  test("控制字符 / 空串 / 超长 fail-closed", () => {
    expect(redactPath("/a/b\u0000c", PATH_CAP)).toEqual({ ok: false })
    expect(redactPath("", PATH_CAP)).toEqual({ ok: false })
    expect(redactPath(`/x/${"d".repeat(PATH_CAP)}`, PATH_CAP)).toEqual({ ok: false })
  })
})

describe("#879 redactText", () => {
  test("credential / token / env 赋值 / JWT / URL userinfo 的 span 替换", () => {
    const cases: Array<[string, string]> = [
      ["header Authorization: Bearer tok4567890abcdef done", "header Authorization: [已隐藏] done"],
      ["curl -u x --header 'Basic dXNlcjpwYXNz' end", "curl -u x --header '[已隐藏]' end"],
      ["export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI end", "export [已隐藏] end"],
      ['{"refresh_token": "rt-99887766"}', '{"[已隐藏]"}'],
      ["key sk-proj-abcdefghijklmnop1234 used", "key [已隐藏] used"],
      ["pat github_pat_11AABBCC22DDEEFF33445566 ok", "pat [已隐藏] ok"],
      ["aws AKIAIOSFODNN7EXAMPLE region", "aws [已隐藏] region"],
      ["jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhIn0.c2lnbmF0dXJl tail", "jwt [已隐藏] tail"],
      ["open https://root:toor@db.example.io/admin now", "open https://[已隐藏]db.example.io/admin now"],
      ["plain output without secrets", "plain output without secrets"],
    ]
    for (const [raw, cleaned] of cases) {
      expect({ raw, result: redactText(raw, 4_000) }).toEqual({
        raw,
        result: { ok: true, value: cleaned, truncated: false },
      })
    }
  })

  test("PEM 私钥:完整块替换;只有 BEGIN 没有 END 时从该点整体隐藏", () => {
    const whole = "a\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEII\n-----END EC PRIVATE KEY-----\nb"
    expect(redactText(whole, 4_000)).toEqual({ ok: true, value: "a\n[已隐藏]\nb", truncated: false })

    const dangling = "log start\n-----BEGIN PRIVATE KEY-----\nMIIEvGhalf"
    expect(redactText(dangling, 4_000)).toEqual({ ok: true, value: "log start\n[已隐藏]", truncated: false })
  })

  test("截断回退到空白边界:被切一半的 token 不进显示;无空白整窗丢弃", () => {
    // token 恰好横跨截断点:截断回退后 token 整个消失。
    const prefix = "safe words here "
    const secret = "ghp_ZZZZYYYYXXXXWWWW1111"
    const raw = prefix + "f".repeat(600 - prefix.length) + " tail " + secret
    const cut = redactText(raw, raw.length - 10)
    if (!cut.ok) throw new Error("expected ok")
    expect(cut.truncated).toBe(true)
    expect(cut.value.includes("ghp_")).toBe(false)

    const oneToken = redactText("Z".repeat(2_000), 700)
    expect(oneToken).toEqual({ ok: true, value: "Z".repeat(700 - 512), truncated: true })
  })

  test("行数帽仍然生效(与字符帽独立)", () => {
    const many = Array.from({ length: 30 }, (_, i) => `row${i}`).join("\n")
    const capped = redactText(many, 10_000, 5)
    if (!capped.ok) throw new Error("expected ok")
    expect(capped.truncated).toBe(true)
    expect(capped.value.split("\n").length).toBeLessThanOrEqual(5)
  })
})
