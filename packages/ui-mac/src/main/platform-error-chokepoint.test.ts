// #940 —— 平台错误分类码咽喉的**出口枚举闸**。
//
// 类(与 #918 同源,第二实例是显式上传派发):src/main 里「读平台 Response 并产出 error
// 字符串」的每个点,都必须经 platform-http-error.ts 的分类码提取;新增出口默认拒 ——
// 没在下面的成员表里归类的新出口,本文件当场红,而不是等下一次编排者复核。
//
// ── 诚实声明:这是**减速带,不是安全边界** ─────────────────────────────────────
// 本文件断言的是源码文本(两条互相独立的检索轴),而源码文本闸可以被新奇写法绕过
// (动态拼接 "ht"+"tp-"、经变量转手的 fetch、自带 http 客户端……)。行为层的真判据
// 不在这里:上传派发的分类码提取与 fail-closed 回退,由派发/上传两个模块各自的
// 用例文件在假平台上驱动**生产函数**验证;咽喉自身的形状域(两种平台信封、坏形状
// 回退)由它旁边的单测枚举。本文件只保证:已知的产出习语不在咽喉之外复活,
// 以及每个**含已知 fetch 形状**(直呼 / fetchImpl / fetcher / typeof fetch 签名)的
// 新出网文件都被强制归一次类 —— 形状表之外的写法(经变量转手、自带 http 客户端)
// 本闸看不见,这正是上面「减速带不是安全边界」的那一半。
//
// ── 两条检索轴(互相独立;单轴的盲区见 CLAUDE.md「观测手段自己有盲区」)────────
//   轴 A(习语轴):`http-<status>` 字符串的**产出**习语(模板字面量 / 字符串拼接)
//     只允许出现在 platform-http-error.ts。消费(如与 "http-404" 比较)不受限。
//   轴 B(来源轴):每个含 fetch 调用形状的生产文件,必须恰好落进三张表之一:
//     MEMBERS(平台出口,必须真 import 咽喉)/ PLATFORM_NON_STRING(读平台但不产
//     error 字符串)/ NON_PLATFORM(不打平台)。表是**恰好相等**的集合判据:
//     多一个未归类的 = 红(默认拒),表里挂着已消失的文件 = 红(表不许烂)。

import { expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const MAIN_DIR = join(import.meta.dir)

/** src/main 的生产 .ts 文件(测试与用例文件不进闸 —— typecheck 也排除它们,别指望编译器)。 */
function productionFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!p.endsWith(".ts") || p.endsWith(".test.ts") || p.endsWith(".cases.ts")) continue
      out.push(p)
    }
  }
  walk(MAIN_DIR)
  return out.sort()
}

const rel = (p: string) => relative(MAIN_DIR, p)
// 读文件走 readFileSync(不是 grep 子进程)—— 字面 NUL 不会让 String 检索静默返回空(ac#760)。
const text = (p: string) => readFileSync(p, "utf8")

const CHOKEPOINT = "platform-http-error.ts"
/** 真 import(不是注释里提一句):`from "./platform-http-error"`。 */
const IMPORTS_CHOKEPOINT = /from\s+["']\.\/platform-http-error["']/

/** 轴 B 的候选谓词:文件里存在 fetch 调用形状,含 DI 写法(fetchImpl / fetcher /
 *  `typeof fetch` 签名)。审计反例(#940 R1):`(deps.fetcher ?? fetch)(` 直呼不匹配
 *  `\bfetch\s*\(`,本仓 alpha-web-upload-consent.ts 就是这么写的 —— DI 形状漏了,
 *  「新出网文件默认拒」就只对直呼成立。 */
const FETCH_SHAPE = /\bfetch\s*\(|\bfetchImpl\b|\bfetcher\b|typeof fetch/

/** 平台出口:读 alpha-platform(gateway / account-server)Response 并产出 error 字符串。 */
const MEMBERS: Record<string, string> = {
  "alpha-cloud-jobs.ts": "authed 派发面(#918)+ 显式上传派发(#940 的第二实例)",
  "alpha-cloud-schedules.ts": "schedules authed(404 恒 http-404 保幂等键;其余散文优先,REQ-025「错误原样呈现」;理由钉在调用点)",
  "alpha-platform-models.ts": "/v1/models(嵌套信封形状 { error: { message, code } })",
  "alpha-artifact-download.ts": "artifact content 端点(429 带 rate_limited;其余回退 http-<status>)",
  "alpha-account-request.ts":
    "account-server(**有意不提取**:accountResultState 按 http-<status> 数字类别判 transient,例外理由钉在调用点;经咽喉的 httpStatusFallback 走,产出习语仍只在咽喉)",
}

/** 读平台但结构上不产 error 字符串的文件。开始产了(轴 A 会抓习语)就必须挪进 MEMBERS。 */
const PLATFORM_NON_STRING: Record<string, string> = {
  "alpha-cloud-events.ts": "SSE 流:非 2xx 走退避重连或 { status: <number> },不产 error 字符串",
}

/** 不打平台的出网/伪出网文件。归类理由 = 它的对端是谁。 */
const NON_PLATFORM: Record<string, string> = {
  "alpha-auth.ts": "alpha-web(C)OAuth token 端点 —— 另一个服务、OAuth 错误形状,失败走 throw 不产 CloudResult",
  "alpha-web-upload-consent.ts":
    "alpha-web(C)上传同意签发端点(DI fetcher)—— 失败 throw UploadAdmissionError 本地准入码,不读平台信封不产 CloudResult",
  "catalog-channels.ts": "alpha-web(C)静态 catalog 发布(alphacodeone.com),自有 FetchFailure 分类",
  "catalog-liveness.ts": "本地引擎 base(127.0.0.1)liveness 探针",
  "curation-blobs.ts": "alpha-web(C)content-addressed blob 静态拉取",
  "ext-mcp-activation.ts": "外部 MCP server 端点(DI fetchImpl)",
  "package-admission.ts": "catalog 声明的第三方 package 资产 URL",
  "package-installability.ts": "catalog 声明的第三方 package payload URL",
  "provider-test.ts": "BYOK 第三方 provider 端点",
  "remote-catalog.ts": "alpha-web(C)静态 catalog 发布(alphacodeone.com)",
  "renderer-security.ts": "无出网 —— 只是注释里提到 ghostty 的 data: fetch",
  "server.ts": "本地引擎 health 探针",
  "tabs-preclean-io.ts": "本地引擎 session API",
  "windows.ts": "net.fetch(file:// URL)本地资源",
}

test("轴 A:`http-<status>` 的产出习语只存在于咽喉模块(上传那行改回 `http-${status}` = 这里红)", () => {
  const producers = [/`http-\$\{/, /["']http-["']\s*\+/, /\+\s*["']http-["']/]
  const offenders = productionFiles()
    .filter((p) => rel(p) !== CHOKEPOINT)
    .filter((p) => producers.some((re) => re.test(text(p))))
    .map(rel)
  expect(
    offenders,
    "这些生产文件在咽喉之外自造 http-<status> error 字符串。走 ./platform-http-error 的 httpErrorCode(或例外时 httpStatusFallback),别复活 #918/#940 修掉的那一类。",
  ).toEqual([])
})

test("轴 B:每个含 fetch 形状的生产文件恰好归类一次;新出网文件默认拒", () => {
  const candidates = productionFiles()
    .filter((p) => rel(p) !== CHOKEPOINT)
    .filter((p) => FETCH_SHAPE.test(text(p)))
    .map(rel)
    .sort()
  const classified = [...Object.keys(MEMBERS), ...Object.keys(PLATFORM_NON_STRING), ...Object.keys(NON_PLATFORM)].sort()
  // 恰好相等,两个方向都拒:新出网文件必须先归类(它读不读平台、产不产 error 字符串),
  // 已消失/不再出网的文件必须从表里摘掉(否则表烂了没人知道)。
  expect(candidates).toEqual(classified)
})

test("MEMBERS 每个都真的 import 咽喉(注释里提一句不算)", () => {
  const missing = Object.keys(MEMBERS).filter((name) => !IMPORTS_CHOKEPOINT.test(text(join(MAIN_DIR, name))))
  expect(missing).toEqual([])
})

test("元判据:两条轴的谓词各自测得出已知的坏(轴 A = #940 修掉的原文;轴 B = 本仓真实的 DI fetch 写法)", () => {
  const producers = [/`http-\$\{/, /["']http-["']\s*\+/, /\+\s*["']http-["']/]
  // eslint-disable-next-line no-template-curly-in-string
  const knownBad = 'if (!response.ok) return { error: `http-${response.status}` }'
  expect(producers.some((re) => re.test(knownBad))).toBe(true)
  expect(producers.some((re) => re.test('"http-" + res.status'))).toBe(true)
  // 消费不误伤:与既有字符串比较是读,不是产。
  expect(producers.some((re) => re.test('r.error !== "http-404"'))).toBe(false)
  // 轴 B:DI 写法必须落进候选集(审计 R1 反例 —— alpha-web-upload-consent.ts:11 的原文形状,
  // 以及新出口最可能的两种 DI 签名)。直呼形状与 fetchImpl 也各钉一条,防谓词被换掉半边。
  expect(FETCH_SHAPE.test("const res = await (deps.fetcher ?? fetch)(url, init)")).toBe(true)
  expect(FETCH_SHAPE.test("deps: { fetcher?: typeof fetch } = {}")).toBe(true)
  expect(FETCH_SHAPE.test("await fetch(`${base}${path}`, init)")).toBe(true)
  expect(FETCH_SHAPE.test("constructor(private fetchImpl = fetch) {}")).toBe(true)
  // 不误伤:与 fetch 无关的标识符不进候选集(prefetched 之类)。
  expect(FETCH_SHAPE.test("const prefetched = cache.get(key)")).toBe(false)
})
