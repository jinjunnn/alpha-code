// REQ-137 (`#1379`) —— 出网授权的**动态半场**:自带 Key 直连的目的地由用户的有效配置派生。
//
// 本文件守四件事,每一件都带一条「本该被拒」的对照臂:
//   AC1 用户配过的那一家,它的 baseURL 的 `host:port` 真的被授权 —— 而且是从 **buildAlphaModelConfig 产出的
//       那份真配置**派生的(不是手打一个 provider 字面量喂给派生函数:那样测的是夹具,不是生产供数方)。
//   AC2 没配过的地址仍被拒。对照臂不是一句断言,是一组 MUST_DENY 加一个**判据函数**,再拿三种
//       「本该被拒却放行」的变异证明这个判据会把它们逐个点名 —— 空数组不是结论,先证明这个手段测得出已知的坏。
//   B1  配置文件里的 provider 一条都进不了放行集合(`#1380` R1 Blocker:那三条路径在围栏的可写集里,
//       读它等于让被围栏的引擎给自己铸出网通道)。控制臂照旧实现读那三个文件,证明断言不是空跑。
//   边界 loopback 一条都派生不出来,连绕过派生直接塞也塞不进去(owner 2026-09-10 裁决:本机目的地另行设计)。
//
// 静态半场的形状与初值仍由 network-egress-registry.test.ts 守;那边断言的「未登记 ⇒ 拒」在这里依然成立,
// 因为每条用例跑完都把动态半场清空(afterEach)—— 两个半场不许互相污染,同进程的别的测试文件也不许被污染。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildAlphaModelConfig } from "./alpha-models"
import { secretFilePath } from "./alpha-secret-files"
import { parse } from "jsonc-parser"
import { persistProvider } from "./ext-config"
import {
  deriveEgressDestinations,
  egressDestinationFromBaseUrl,
  getConfiguredEgressDestinations,
  isConfiguredEgressDestination,
  isEgressAuthorizedForSidecar,
  setConfiguredEgressDestinations,
} from "./network-egress-derived"
import { isEgressAuthorized } from "./network-egress-registry"

// 刻意不像密钥的测试值(与 alpha-models.test.ts 同一颗);断言里不出现它。
const NOT_A_KEY = "test-value-not-a-real-key-Zq81"

const MANAGED = [
  "ALPHA_MODELS_DISABLE",
  "ALPHA_BASE_URL",
  "ALPHA_DEFAULT_MODEL",
  "DEEPSEEK_API_KEY",
  "ZHIPU_API_KEY",
  "MINIMAX_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
  "ALPHA_GLOBAL_DIR",
  "OPENCODE_CONFIG_DIR",
]
const saved: Record<string, string | undefined> = {}
let tmp = ""
let userData = ""

/** 按 main 的 syncSecretFiles 那样把密钥落进 {file:} 通道 —— 「用户配过这一家」在注入面就是这个文件在不在。 */
const plantSecret = (varName: string) => {
  fs.mkdirSync(path.dirname(secretFilePath(userData, varName)), { recursive: true })
  fs.writeFileSync(secretFilePath(userData, varName), NOT_A_KEY, { mode: 0o600 })
}

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "egress-derived-"))
  process.env.ALPHA_GLOBAL_DIR = path.join(fs.realpathSync(tmp), "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = tmp
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "egress-derived-userdata-"))
  setConfiguredEgressDestinations([])
})

afterEach(() => {
  // 动态半场是进程内单例:不清掉会漏给同进程的下一个测试文件(注册表测试正靠「未登记 ⇒ 拒」)。
  setConfiguredEgressDestinations([])
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const dir of [tmp, userData]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

/** 判据:给一个授权函数,回它**放行了**哪些「本该被拒」的目的地。空数组 = 这道闸这一刻是真的。 */
function leaks(authorize: (host: string, port: number) => boolean, cases: ReadonlyArray<readonly [string, number]>): string[] {
  return cases.filter(([host, port]) => authorize(host, port)).map(([host, port]) => `${host}:${port}`)
}

describe("AC1 用户配过的 BYOK 目的地被授权(从有效配置派生,不是手写域名清单)", () => {
  test("配了 DeepSeek 的 Key ⇒ api.deepseek.com:443 授权;静态表一行都没动", () => {
    plantSecret("DEEPSEEK_API_KEY")
    const config = buildAlphaModelConfig(userData)!

    // 前提自证:这份**真配置**里确实有那条 baseURL。缺了它下面的绿就是空的。
    const node = config.provider["deepseek-byok"] as { options: { baseURL: string } }
    expect(node.options.baseURL).toBe("https://api.deepseek.com/v1")

    // 装之前:两个半场都拒 —— 证明接下来那个 true 是派生来的,不是有人往静态表加了一行。
    expect(isEgressAuthorized("api.deepseek.com", 443)).toBe(false)
    expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(false)

    const accepted = setConfiguredEgressDestinations(deriveEgressDestinations(config.provider))
    expect(accepted.map((d) => `${d.host}:${d.port}`)).toEqual(["api.deepseek.com:443"])
    expect(accepted[0]!.providerId).toBe("deepseek-byok")
    expect(accepted[0]!.baseURL).toBe("https://api.deepseek.com/v1")

    expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(true)
    // 静态表不背这个锅:它仍然答「不在」。动态半场是并集里的另一格,不是往表里塞行。
    expect(isEgressAuthorized("api.deepseek.com", 443)).toBe(false)
  })

  test("配两家就放两家,顺序无关;`#1379` 现场那两个 authority 一起变成授权的", () => {
    plantSecret("DEEPSEEK_API_KEY")
    plantSecret("ZHIPU_API_KEY")
    const accepted = setConfiguredEgressDestinations(deriveEgressDestinations(buildAlphaModelConfig(userData)!.provider))
    expect(accepted.map((d) => `${d.host}:${d.port}`).sort()).toEqual(["api.deepseek.com:443", "open.bigmodel.cn:443"])
    // 票面现场证据里的那两条 CONNECT,正是这两个 authority。
    expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(true)
    expect(isEgressAuthorizedForSidecar("open.bigmodel.cn", 443)).toBe(true)
  })

  test("没配任何一家 ⇒ 派生出空集合(不是「配置读不到就全放行」)", () => {
    const config = buildAlphaModelConfig(userData)!
    expect(config.provider).toEqual({})
    expect(setConfiguredEgressDestinations(deriveEgressDestinations(config.provider))).toEqual([])
    expect(getConfiguredEgressDestinations()).toEqual([])
    expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(false)
  })
})

describe("AC2 没配过的地址仍被拒 —— 判据先证明它测得出已知的坏", () => {
  /** 只配 DeepSeek 一家。对照臂里最有说服力的那几条是**同一份目录里的另外几家**:同类、同来源,只差「用户配没配」。 */
  const MUST_DENY: ReadonlyArray<readonly [string, number]> = [
    ["open.bigmodel.cn", 443], // 目录里就有,但这台机器没配 Key
    ["api.minimaxi.com", 443],
    ["dashscope.aliyuncs.com", 443],
    ["ac1379-never-configured.invalid", 443], // 谁的配置里都不会有
    ["api.deepseek.com", 80], // 端口是键的一部分
    ["api.deepseek.com", 8443],
    ["evil.api.deepseek.com", 443], // 不做后缀匹配
    ["api.deepseek.com.evil.example", 443], // 不做前缀匹配
    ["api.deepseek.com.", 443], // 尾点不归一
    ["127.0.0.1", 11434], // 本机目的地另行设计
  ]

  beforeEach(() => {
    plantSecret("DEEPSEEK_API_KEY")
    setConfiguredEgressDestinations(deriveEgressDestinations(buildAlphaModelConfig(userData)!.provider))
  })

  test("生产判据:配过的那一条放行,MUST_DENY 十条一条不漏地拒", () => {
    expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(true)
    expect(leaks(isEgressAuthorizedForSidecar, MUST_DENY)).toEqual([])
  })

  test("控制臂:三种「本该被拒却放行」的放宽,同一个判据函数各自点名放行了什么", () => {
    const configured = getConfiguredEgressDestinations()
    expect(configured.length).toBe(1) // 控制臂拿来放宽的底料必须非空,否则三条全是空跑

    // ① 默认放行(把围栏拆了)
    const allowAll = () => true
    // ② 后缀匹配(注册表抬头明令不做的那种「好心」放宽)
    const suffixMatch = (host: string, port: number) =>
      configured.some((d) => (host === d.host || host.endsWith(`.${d.host}`)) && port === d.port)
    // ③ 忽略端口(端口不再是键的一部分)
    const portAgnostic = (host: string) => configured.some((d) => d.host === host)

    expect(leaks(allowAll, MUST_DENY)).toEqual(MUST_DENY.map(([h, p]) => `${h}:${p}`))
    expect(leaks(suffixMatch, MUST_DENY)).toEqual(["evil.api.deepseek.com:443"])
    expect(leaks(portAgnostic, MUST_DENY)).toEqual(["api.deepseek.com:80", "api.deepseek.com:8443"])
  })

  test("换代整份替换:上一代配过的,下一代没配就不再放行", () => {
    expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(true)
    fs.rmSync(secretFilePath(userData, "DEEPSEEK_API_KEY"), { force: true })
    plantSecret("ZHIPU_API_KEY")
    setConfiguredEgressDestinations(deriveEgressDestinations(buildAlphaModelConfig(userData)!.provider))
    expect(isEgressAuthorizedForSidecar("open.bigmodel.cn", 443)).toBe(true)
    expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(false)
  })
})

// ── `#1380` R1 Blocker:动态半场的输入里不许出现「被围栏的引擎树写得了的文件」 ──────────────
// provider 块的三条读取路径逐条落在 seatbelt 的可写集里:
//   alpha.jsonc                                   ← process-fence-profile.ts W2  (alphaGlobalRoot)
//   <OPENCODE_CONFIG_DIR | XDG_CONFIG_HOME>/opencode ← W6  (configHome/opencode)
//   ~/.opencode(ALPHA_OPENCODE_HOME 可重定向)       ← W16 (home/.opencode)
// 引擎树里任意一段代码(bash 工具 / 仓库自带 plugin / MCP stdio 子进程)写一行 baseURL,下一代 fork
// 就给它铸出一条出网通道 —— confused deputy,围栏对任意目的地开口,而产品披露「只能访问已登记的地址」
// (network-egress-disclosure.test.ts)当场变成假话。
// 这一格是本次修复的咽喉:下一个人想把「文件面」加回来时,先红的是这里。
describe("B1 配置文件里的 provider 一条都进不了放行集合(那三条路径在围栏的可写集里)", () => {
  const EXFIL = "https://exfil.example/v1"
  const IDS = ["exfil-alpha", "exfil-xdg", "exfil-home"] as const
  let opencodeHome = ""
  let savedOpencodeHome: string | undefined
  let files: string[] = []

  beforeEach(() => {
    savedOpencodeHome = process.env.ALPHA_OPENCODE_HOME
    opencodeHome = fs.mkdtempSync(path.join(os.tmpdir(), "egress-derived-ochome-"))
    process.env.ALPHA_OPENCODE_HOME = opencodeHome

    // ① alpha.jsonc —— 产品自己的写法(模型选择器「添加自定义节点」走的就是 persistProvider)
    const persisted = persistProvider({
      id: "exfil-alpha",
      name: "Exfil",
      compat: "openai",
      baseURL: EXFIL,
      apiKey: NOT_A_KEY,
      models: ["m1"],
    })
    expect(persisted.ok, JSON.stringify(persisted)).toBe(true)

    // ② / ③ 另外两条读取路径 —— 手写,正是围栏内一行 `printf … > file` 能做到的形状(没有 apiKey)。
    const xdg = path.join(process.env.OPENCODE_CONFIG_DIR!, "opencode.jsonc")
    const home = path.join(opencodeHome, "opencode.jsonc")
    fs.writeFileSync(xdg, JSON.stringify({ provider: { "exfil-xdg": { options: { baseURL: EXFIL } } } }))
    fs.writeFileSync(home, JSON.stringify({ provider: { "exfil-home": { options: { baseURL: EXFIL } } } }))
    files = [path.join(process.env.ALPHA_GLOBAL_DIR!, "alpha.jsonc"), xdg, home]
  })

  afterEach(() => {
    if (savedOpencodeHome === undefined) delete process.env.ALPHA_OPENCODE_HOME
    else process.env.ALPHA_OPENCODE_HOME = savedOpencodeHome
    try {
      fs.rmSync(opencodeHome, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  test("三条路径都写了 provider:引擎看得见这几个 id,而放行集合里只有目录 BYOK 那一条", () => {
    plantSecret("DEEPSEEK_API_KEY")
    const config = buildAlphaModelConfig(userData)!

    // 前提自证 ①:三个 id 真的进了引擎的 allowlist —— 文件确实被读到了,断言不是空跑。
    for (const id of IDS) expect(config.enabled_providers, id).toContain(id)
    // 前提自证 ②:注入面对这些 id **只给 apiKey,从不给 baseURL**。这正是「文件面不贡献目的地」的机制。
    for (const id of IDS) {
      const block = config.provider[id] as { options?: { baseURL?: unknown } } | undefined
      expect(block?.options?.baseURL, id).toBeUndefined()
    }

    const accepted = setConfiguredEgressDestinations(deriveEgressDestinations(config.provider))
    expect(accepted.map((d) => `${d.host}:${d.port}`)).toEqual(["api.deepseek.com:443"])
    expect(isEgressAuthorizedForSidecar("exfil.example", 443)).toBe(false)
    expect(isConfiguredEgressDestination("exfil.example", 443)).toBe(false)
  })

  test("控制臂:把文件面加回来(照旧实现读那三个文件)⇒ 同一条断言当场红", () => {
    // 不是空跑:先证明那三个文件里确实躺着一条可利用的 baseURL,而且读它就会授权 exfil.example。
    const fromFiles: Record<string, unknown> = {}
    for (const file of files) {
      const provider = (parse(fs.readFileSync(file, "utf8")) as { provider?: Record<string, unknown> } | undefined)?.provider
      for (const [id, block] of Object.entries(provider ?? {})) if (!(id in fromFiles)) fromFiles[id] = block
    }
    expect(Object.keys(fromFiles).sort()).toEqual([...IDS].sort())

    const leaked = setConfiguredEgressDestinations(deriveEgressDestinations(fromFiles))
    expect(leaked.map((d) => `${d.host}:${d.port}`)).toEqual(["exfil.example:443"])
    // ↑ 这正是 `#1380` 合并前那一版的行为:围栏内写一行文件 = 自己给自己开一条出网通道。
    expect(isEgressAuthorizedForSidecar("exfil.example", 443)).toBe(true)
  })
})

describe("边界:loopback / 非 https / 畸形一条都收不进来", () => {
  test("loopback 的四种写法都派生不出目的地(owner 2026-09-10 裁决:本机目的地另行设计)", () => {
    const providers = {
      "ollama-http": { options: { baseURL: "http://127.0.0.1:11434/v1" } },
      "ollama-https": { options: { baseURL: "https://127.0.0.1:11434/v1" } },
      "ollama-name": { options: { baseURL: "https://localhost:11434/v1" } },
      "ollama-v6": { options: { baseURL: "https://[::1]:11434/v1" } },
      "ollama-sub": { options: { baseURL: "https://ollama.localhost/v1" } },
      "ollama-alt": { options: { baseURL: "https://127.13.13.13:11434/v1" } },
    }
    expect(deriveEgressDestinations(providers)).toEqual([])
    // 绕过派生直接塞也塞不进去:登记簿自己再判一次,不信调用方。
    expect(
      setConfiguredEgressDestinations([
        { host: "127.0.0.1", port: 11434, providerId: "hand-written", baseURL: "https://127.0.0.1:11434" },
        { host: "localhost", port: 11434, providerId: "hand-written", baseURL: "https://localhost:11434" },
      ]),
    ).toEqual([])
    expect(isConfiguredEgressDestination("127.0.0.1", 11434)).toBe(false)
    expect(isEgressAuthorizedForSidecar("127.0.0.1", 11434)).toBe(false)
  })

  test("非 https / 解析不出 / 畸形 host / 端口越界:一条都不收,也不猜默认值", () => {
    expect(egressDestinationFromBaseUrl("http://api.example.com/v1", "x")).toBeUndefined()
    expect(egressDestinationFromBaseUrl("ws://api.example.com/v1", "x")).toBeUndefined()
    expect(egressDestinationFromBaseUrl("api.example.com/v1", "x")).toBeUndefined() // 没 scheme ⇒ URL 抛
    expect(egressDestinationFromBaseUrl("https://*.example.com/v1", "x")).toBeUndefined()
    expect(egressDestinationFromBaseUrl("https://api.example.com./v1", "x")).toBeUndefined() // 尾点不归一
    expect(egressDestinationFromBaseUrl("https://api.example.com:70000/v1", "x")).toBeUndefined()
    expect(egressDestinationFromBaseUrl("", "x")).toBeUndefined()
    expect(egressDestinationFromBaseUrl("   ", "x")).toBeUndefined()
    expect(egressDestinationFromBaseUrl(undefined, "x")).toBeUndefined()
    expect(egressDestinationFromBaseUrl(443, "x")).toBeUndefined()
    expect(deriveEgressDestinations(undefined)).toEqual([])
    expect(deriveEgressDestinations([{ options: { baseURL: "https://api.example.com" } }])).toEqual([])
    expect(deriveEgressDestinations({ a: null, b: "https://api.example.com", c: { options: 7 } })).toEqual([])
  })

  test("显式端口进键;大小写归一;userinfo / query / hash 不进出处坐标", () => {
    expect(egressDestinationFromBaseUrl("https://API.Example.COM:8443/v1", "p")).toEqual({
      host: "api.example.com",
      port: 8443,
      providerId: "p",
      baseURL: "https://api.example.com:8443/v1",
    })
    const withCreds = egressDestinationFromBaseUrl(`https://u:${NOT_A_KEY}@api.example.com/v1?k=${NOT_A_KEY}#f`, "p")!
    expect(withCreds.host).toBe("api.example.com")
    expect(JSON.stringify(withCreds)).not.toContain(NOT_A_KEY)
  })

  test("没有 options.baseURL 时回退读 `api`(与 alpha-config-injection 的 v2 桥同两个字段、同顺序)", () => {
    expect(deriveEgressDestinations({ p: { api: "https://api.fallback.example/v1" } }).map((d) => d.host)).toEqual([
      "api.fallback.example",
    ])
    // options.baseURL 在场时它赢 —— 顺序不是随手写的,v2 桥也是先 options.baseURL 后 api。
    expect(
      deriveEgressDestinations({ p: { api: "https://api.fallback.example/v1", options: { baseURL: "https://api.primary.example/v1" } } }).map(
        (d) => d.host,
      ),
    ).toEqual(["api.primary.example"])
  })
})
