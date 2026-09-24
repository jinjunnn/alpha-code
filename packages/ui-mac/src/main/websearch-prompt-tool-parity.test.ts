// `#1414` 基线 §三 **S4** 的四格闸门(子票 `#1431` / CODE-2 的退出条件)。
//
// 守的是一件事:**开场白里说的「你能搜网」,必须与模型这一轮手里真有的工具对得上。**
// 勘破(`docs/architecture/2026-09-23-web-tools-account-routing-recon.md` §6 第 6 行)测出
// 全仓有**四处**在判「能不能搜网」,其中 `buildAlphaCapabilities` 把结论**直接写进系统提示**,
// 而它与真闸不同源 —— 于是可以「提示说有、工具表里其实没有」,模型要么去调一个不存在的工具,
// 要么凭印象编一个答案。CODE-2 的修法是让提示**消费真闸的判决**而不是自己再判一遍;
// 本文件是那条保证的执行者。
//
// 判官看的是**生产自己写出来的两样东西**,不是两份都由本文件算的期望值:
//   · 「提示里那一行」= 真 `injectAlphaConfig` 写到盘上的 `alpha-identity.md` 正文里,
//     有没有生产 `buildAlphaIdentity` 的 web search 那一行(行本身也从生产取,不抄措辞);
//   · 「工具表的在场性」= 同一次注入写进 `OPENCODE_CONFIG_CONTENT` 的 permission deny 表
//     (引擎 `Permission.disabled` 按它把工具从模型工具表里摘掉,
//     `packages/opencode/src/session/llm/request.ts:234-244`)与 `mcp.cloud` 的 `enabled`。
// 两边来自**不同的代码路径**,所以「它们相等」不是自指等价链。
//
// 四格 = 登出/BYOK · 登录有额度 · 登录无额度 · kill-switch。
// **「有额度 / 无额度」在桌面侧是同一组输入**,这不是取巧:基线 §二选定的形状就是
// 「额度只在调用那一刻由 account 的 preauth 回答」,桌面不持有额度判据(否决 A:那会造出
// 第二个权威,而且必然过期)。所以第三格断言的是**桌面对额度结构性失明** —— 往环境里塞额度
// 信号,注入产物必须逐字不变。诚实边界:这一条只拦「把额度信号塞进 env 就能改变注入」这一形态;
// 真正的无额度现场(402 的 wire body)归 VERIFY-1,勘破 §9 第 5 条记着那一格还没有真账户。
//
// keyless flag(`OPENCODE_ENABLE_EXA`)不写死成某一格的常量,而是**当成自由变量跑两遍** ——
// 它的值由 main 的 `applyWebSearchSovereignty` 落定,而那一处正是 `#1411`/CODE-1 要改的地方。
// 把它量化掉,本闸门对 CODE-1 前后两种 base 都成立,也就不会变成一条「迎合当下」的期望值。
//
// **与 CODE-1(`#1411` / PR `#1442`,已合)的分工**:代付态下本地 `websearch` 到底在不在工具表里
// 由它决定,它自己也有一条从真 fork env 一路跑到真 `Permission.disabled` 的闸。本文件因此**不重跑
// 那条链**,只钉住它在**注入面**留下的事实(代付态一个 local deny 都不产生 ⇒ 本地腿随 keyless 在场),
// 并要求提示那一行跟着它走。本文件的 parity 断言对 CODE-1 **前后两种 base 都成立** ——
// 提示那一边是**读**真闸的判决算出来的,不是手抄它的条件。
//
// **与 ADR-046 措辞的差(诚实登记)**:ADR-046 的不变量写的是「**本地** web search 此刻在不在
// 模型工具表里」与提示那一行逐一相符。本文件判的是「提示那一行」⟺「**那一行指得到的**工具里
// 至少有一个在场」(两条腿都对每个 provider 可见,所以那句 "not just the default provider" 对
// 云腿同样成立)。`#1411` 之后,两种读法在**生产会走到的每一格**里都重合 —— main 的
// `applyWebSearchSovereignty` 在非 kill-switch 分支把 `OPENCODE_ENABLE_EXA` 设成 `"1"`,
// 所以本地腿恒在场。唯一还能分叉的是「代付 + 用户自己 export 了 `OPENCODE_ENABLE_EXA=0`」
// 这一臂(本文件的 keyless=0 自由变量正是它):那时 `cloud_cloud_web_search` 在工具表里而本地腿不在。
// **不按字面收窄成「只看本地腿」的理由**:那一臂会**少报** —— 云工具明明在模型手里而提示不说,
// 等于把同一个缺陷翻到另一面;而且它会让 `+websearch+cloudDispatch` 这个 identity 形状在
// keyless=0 时不可达,打红 config 咽喉那条「形状集合 == 登记簿变体集合」的双向锁。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildAlphaIdentity } from "./alpha-identity"
import { injectAlphaConfig } from "./alpha-config-injection"
import { secretFilePath } from "./alpha-secret-files"
import { CLOUD_MCP_SERVER_NAME, CLOUD_WEB_SEARCH_TOOL_ID, LOCAL_WEB_SEARCH_TOOL_ID } from "./cloud-web-search"

// 注入读到的 env 输入 + 它自己写出的 env 输出:逐个快照/清空/还原(与同目录两个注入测试同一份清单)。
const MANAGED = [
  "ALPHA_JSONC_TRUTH_DISABLE",
  "ALPHA_LEGACY_INSTALL_ROOT",
  "ALPHA_GLOBAL_DIR",
  "ALPHA_OPENCODE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_MODELS_PATH",
  "ALPHA_IDENTITY_DISABLE",
  "ALPHA_BEHAVIOR_DISABLE",
  "ALPHA_MODELS_DISABLE",
  "ALPHA_AUTOMATION_DISABLE",
  "ALPHA_READONLY_DISABLE",
  "ALPHA_WEBSEARCH_DISABLE",
  "ALPHA_CLOUD_MCP_URL",
  "ALPHA_CLOUD_MCP_ARM",
  "ALPHA_CLOUD_MCP_DEF",
  "ALPHA_CLOUD_MCP_SERVER",
  "ALPHA_BASE_URL",
  "ALPHA_DEFAULT_MODEL",
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_EXPERIMENTAL",
] as const

const saved: Record<string, string | undefined> = {}
let tmp = ""
let userData = ""

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-ws-parity-")))
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
  for (const d of [process.env.ALPHA_GLOBAL_DIR, process.env.XDG_CONFIG_HOME, process.env.ALPHA_OPENCODE_HOME, process.env.XDG_DATA_HOME])
    fs.mkdirSync(d!, { recursive: true })
  userData = path.join(tmp, "userdata")
  fs.mkdirSync(userData, { recursive: true })
})

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** 按 main 的 syncSecretFiles 姿势把密钥种进 {file:} 通道(A6:env 里从不出现密钥值)。 */
const plantSecret = (varName: string, value: string) => {
  const file = secretFilePath(userData, varName)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value, { mode: 0o600 })
}

// 提示里那两行**从生产取**,不抄措辞:用「打开某个能力前后的差集」把行本身解出来。
// 抄一份字面量 = 第二份真源,改了文案这道闸会静默失明。
const lineAddedBy = (caps: { websearch?: boolean; cloudDispatch?: boolean }) => {
  const base = buildAlphaIdentity({}).split("\n")
  const added = buildAlphaIdentity(caps)
    .split("\n")
    .filter((l) => l.trim().startsWith("- ") && !base.includes(l))
  return added
}
const WEBSEARCH_LINE = lineAddedBy({ websearch: true })[0]
const CLOUD_DISPATCH_LINE = lineAddedBy({ cloudDispatch: true })[0]

type Cfg = Record<string, any>

/** 一次真注入之后,生产写出来的两样东西。 */
function observe() {
  const config: Cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!)
  const identityFile = (config.instructions as string[]).find((f) => f.endsWith("alpha-identity.md"))!
  const identity = fs.readFileSync(identityFile, "utf8")

  // 一个工具在不在模型工具表里:顶层 deny 摘掉它,agent 级规则排在全局之后(`Permission.evaluate`
  // 取 findLast),所以任一层 deny 都等于「模型看不到」。
  const denied = (toolId: string) => {
    const top = (config.permission as Cfg | undefined)?.[toolId] === "deny"
    const agents = Object.values((config.agent as Record<string, Cfg | undefined> | undefined) ?? {})
    const anyAgent = agents.some((a) => (a?.permission as Cfg | undefined)?.[toolId] === "deny")
    return { top, anyAgent, either: top || anyAgent }
  }
  const localDeny = denied(LOCAL_WEB_SEARCH_TOOL_ID)
  const cloudDeny = denied(CLOUD_WEB_SEARCH_TOOL_ID)
  const cloudServer = (config.mcp as Cfg | undefined)?.[CLOUD_MCP_SERVER_NAME] as Cfg | undefined

  return {
    config,
    identity,
    promptClaimsWebSearch: identity.includes(WEBSEARCH_LINE),
    promptClaimsCloudDispatch: identity.includes(CLOUD_DISPATCH_LINE),
    // 本地腿还要先被引擎注册才谈得上在场(`opencode/src/tool/registry.ts` 的 `webSearchEnabled`),
    // keyless flag 是 main 在 fork 前两个方向都写的那一个。
    localWebSearchPresent: !localDeny.either && process.env.OPENCODE_ENABLE_EXA !== "0",
    cloudWebSearchPresent: !cloudDeny.either && cloudServer?.enabled === true,
    localDeny,
    cloudDeny,
    cloudServer,
  }
}

const givenLoggedOut = () => {
  // 登出/BYOK:`ALPHA_CLOUD_MCP_URL` 由登录时的 applyAuthEnv 写入,登出态它不在;也没有 mcp_access 凭证。
  plantSecret("DEEPSEEK_API_KEY", "sk-byok-parity")
  process.env.ALPHA_BASE_URL = "https://gateway.example.invalid/v1"
  process.env.ALPHA_DEFAULT_MODEL = "deepseek/deepseek-chat"
}
const givenLoggedIn = () => {
  givenLoggedOut()
  plantSecret("ALPHA_API_KEY", "sk-platform-parity")
  plantSecret("ALPHA_MCP_TOKEN", "mcp-access-parity")
  process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp"
}

/** 每格都在 keyless flag 的两个值上各跑一遍 —— 它的值由 CODE-1 正在改的那一处落定,不当常量。 */
const KEYLESS_ARMS = ["1", "0"] as const

const silently = <T,>(run: () => T): T => {
  const error = console.error
  const log = console.log
  console.error = () => {}
  console.log = () => {}
  try {
    return run()
  } finally {
    console.error = error
    console.log = log
  }
}

describe("S4:系统提示里的「能搜网」与模型工具表的在场性,在四种账户态下逐一相符", () => {
  test("先证明判官不瞎:两行都解得出来、互不相同、且开关翻面时真的进出正文", () => {
    expect(lineAddedBy({ websearch: true })).toHaveLength(1)
    expect(lineAddedBy({ cloudDispatch: true })).toHaveLength(1)
    expect(WEBSEARCH_LINE).toContain("Web search")
    expect(WEBSEARCH_LINE).not.toBe(CLOUD_DISPATCH_LINE)
    expect(buildAlphaIdentity({ websearch: true })).toContain(WEBSEARCH_LINE)
    expect(buildAlphaIdentity({ websearch: false })).not.toContain(WEBSEARCH_LINE)
    expect(buildAlphaIdentity({ cloudDispatch: true })).not.toContain(WEBSEARCH_LINE)
  })

  for (const keyless of KEYLESS_ARMS) {
    describe(`OPENCODE_ENABLE_EXA=${keyless}`, () => {
      test("① 登出 / BYOK:本地腿在场(随 keyless),云腿整条不在;提示与工具表相符", () => {
        givenLoggedOut()
        process.env.OPENCODE_ENABLE_EXA = keyless

        silently(() => injectAlphaConfig(userData, undefined, "stable"))
        const o = observe()

        // 真闸:登出态一个 deny 都不写(不误伤登出兜底)
        expect(o.localDeny.either).toBe(false)
        expect(o.cloudDeny.either).toBe(false)
        // 云腿整条不在:没有 URL ⇒ 连 server 定义都不写
        expect(o.cloudServer).toBeUndefined()
        expect(o.cloudWebSearchPresent).toBe(false)
        expect(o.localWebSearchPresent).toBe(keyless === "1")
        // 相符
        expect(o.promptClaimsWebSearch).toBe(o.localWebSearchPresent || o.cloudWebSearchPresent)
        expect(o.promptClaimsWebSearch).toBe(keyless === "1")
        expect(o.promptClaimsCloudDispatch).toBe(false)
      })

      test("② 登录(有额度):两条腿都在场(#1411 之后),提示与工具表相符", () => {
        givenLoggedIn()
        process.env.OPENCODE_ENABLE_EXA = keyless

        silently(() => injectAlphaConfig(userData, undefined, "stable"))
        const o = observe()

        // 云腿这一半 CODE-1 一个字不改(基线 §二 落地方向 2)
        expect(o.cloudServer?.enabled).toBe(true)
        expect(o.cloudDeny.either).toBe(false)
        expect(o.cloudWebSearchPresent).toBe(true)
        // 本地腿:`#1411`(PR `#1442`)之后代付态**一个 local deny 都不产生**,所以它只随 keyless
        // 走。生产会走到的那一臂是 keyless="1"(main 的 applyWebSearchSovereignty 在非 kill-switch
        // 分支 `OPENCODE_ENABLE_EXA ??= "1"`)⇒ 两条腿同时在模型工具表里 = ADR-046 目标态表格第二行。
        // 这一条在 `#1411` 之前是红的(那时代付即 deny),不是一条迎合现状的期望值。
        expect(o.localDeny.top).toBe(false)
        expect(o.localDeny.anyAgent).toBe(false)
        expect(o.localWebSearchPresent).toBe(keyless === "1")
        // 相符
        expect(o.promptClaimsWebSearch).toBe(o.localWebSearchPresent || o.cloudWebSearchPresent)
        expect(o.promptClaimsWebSearch).toBe(true)
        expect(o.promptClaimsCloudDispatch).toBe(true)
      })

      test("③ 登录(无额度):额度信号进不了桌面 ⇒ 注入产物与有额度态逐字相同,提示不多说也不少说", () => {
        givenLoggedIn()
        process.env.OPENCODE_ENABLE_EXA = keyless
        silently(() => injectAlphaConfig(userData, undefined, "stable"))
        const withQuota = observe()

        // 换一份干净的起点重跑,唯一的差别是环境里多了「这个账户没钱了」的信号。
        delete process.env.OPENCODE_CONFIG_CONTENT
        process.env.ALPHA_ACCOUNT_BALANCE_FEN = "0"
        process.env.ALPHA_ACCOUNT_PLAN_STATUS = "expired"
        try {
          silently(() => injectAlphaConfig(userData, undefined, "stable"))
          const noQuota = observe()

          // 桌面对额度结构性失明:同一组桌面输入 ⇒ 同一份产物。基线 §二否决 A —— 桌面持有额度判据
          // 会造出第二个权威,而且必然过期(fork 时算、整个会话恒定,充值也不会变)。
          expect(noQuota.identity).toBe(withQuota.identity)
          expect(noQuota.promptClaimsWebSearch).toBe(withQuota.promptClaimsWebSearch)
          expect(noQuota.config.permission).toEqual(withQuota.config.permission)
          expect(noQuota.config.mcp).toEqual(withQuota.config.mcp)
          // 而且仍然相符:拒绝发生在调用那一刻(gateway 的 402),不是在工具表里
          expect(noQuota.cloudWebSearchPresent).toBe(true)
          expect(noQuota.promptClaimsWebSearch).toBe(noQuota.localWebSearchPresent || noQuota.cloudWebSearchPresent)
        } finally {
          delete process.env.ALPHA_ACCOUNT_BALANCE_FEN
          delete process.env.ALPHA_ACCOUNT_PLAN_STATUS
        }
      })

      test("④ kill-switch:两条腿都不在场,提示里那一行必须消失", () => {
        givenLoggedIn()
        process.env.OPENCODE_ENABLE_EXA = keyless
        process.env.ALPHA_WEBSEARCH_DISABLE = "1"

        silently(() => injectAlphaConfig(userData, undefined, "stable"))
        const o = observe()

        // kill-switch 半场逐字保留(基线 §三 S3):两个工具 id 都被钉 deny,云 server 是中和条目
        expect(o.localDeny.top).toBe(true)
        expect(o.localDeny.anyAgent).toBe(true)
        expect(o.cloudDeny.top).toBe(true)
        expect(o.cloudDeny.anyAgent).toBe(true)
        expect(o.cloudServer?.enabled).toBe(false)
        expect(o.localWebSearchPresent).toBe(false)
        expect(o.cloudWebSearchPresent).toBe(false)
        expect(o.promptClaimsWebSearch).toBe(false)
      })
    })
  }

  test("先证明这道闸测得出已知的坏:一个只看 keyless flag、丢掉真闸判决的假判据,在四格里必然与工具表对不上", () => {
    // 这正是本票要消灭的形态 —— 提示自己算一遍「能不能搜网」,不问真闸。
    const naive = () => process.env.OPENCODE_ENABLE_EXA !== "0"
    const mismatches: string[] = []

    for (const [label, arrange] of [
      ["登出", givenLoggedOut],
      ["kill-switch", () => (givenLoggedIn(), void (process.env.ALPHA_WEBSEARCH_DISABLE = "1"))],
    ] as const) {
      for (const keyless of KEYLESS_ARMS) {
        // 每一轮换一份干净的 userData 与 config 起点
        userData = fs.mkdtempSync(path.join(tmp, "ud-"))
        delete process.env.OPENCODE_CONFIG_CONTENT
        delete process.env.ALPHA_CLOUD_MCP_URL
        delete process.env.ALPHA_WEBSEARCH_DISABLE
        arrange()
        process.env.OPENCODE_ENABLE_EXA = keyless

        silently(() => injectAlphaConfig(userData, undefined, "stable"))
        const o = observe()
        const truth = o.localWebSearchPresent || o.cloudWebSearchPresent
        // 生产(已修)必须与真相一致
        expect(o.promptClaimsWebSearch, `${label}/keyless=${keyless}`).toBe(truth)
        // 假判据在哪几格与真相不符 —— 至少要有一格,否则本文件的 parity 断言是空对空
        if (naive() !== truth) mismatches.push(`${label}/keyless=${keyless}`)
      }
    }

    expect(mismatches).toEqual(["kill-switch/keyless=1"])
  })
})
