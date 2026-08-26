// `ac#1116` —— main 侧 IPC 注册面 × preload 绑定面的**普查闸**。
//
// ── 被守的是什么(结构性事实,不是风格偏好)────────────────────────────────────────
// 主窗与 Recovery 窗都是 `contextIsolation: true` / `sandbox: true` / `nodeIntegration: false`
// (windows.ts,由 ext-security-boundaries 那道闸逐个钉住),renderer 里**没有** `ipcRenderer`。
// ⇒ 从 renderer 够到一条 `ipcMain.handle` / `ipcMain.on` 通道的**唯一**路径,是 preload 里
// 那一行 `ipcRenderer.invoke/send(<通道名>)`。少了那一行,这条通道 renderer **结构上到不了**。
//
// 这样一条通道不是「少了个 UI」,是**死代码**,而它长得像「已经有了的能力」:下一个人据它
// 以为某个视图已经可用,把新功能挂上去,再花一轮诊断才发现 renderer 那侧根本收不到。
// `ext-list-installs-v2` 就是活实例 —— REQ-099 注册了 main 侧机器,UI 从未接;`ac#319`
// (PR #1110)定位 receipt digest 丢失路径时改的是**扩 v1 投影**,v2 一直空转到 `ac#1116`。
//
// ── 为什么源码文本就是正确的粒度(而不是拿文本冒充行为)────────────────────────────
// 主语是**负全称**:「不存在一条注册了却没有 preload 绑定的通道」。跨进程的通道名是两个
// 独立编译单元里的两个字符串字面量,没有任何运行期对象能同时看到两边 —— 起真 Electron 也
// 只能证明「这一条通了」,证不了「没有第二条没通」。文本正是这条保证能有的最细粒度。
//
// ── 这道闸的三条自保(观测手段自己有盲区)──────────────────────────────────────────
//  ① **算不出通道名的注册点默认拒**,不是默认放行 —— 否则下一个人写 `ipcMain.handle(name,`
//     就自动出圈,而普查会安静地少数一条。间接注册器要出圈必须逐条登记,且登记要过四道校验。
//  ② **处理量对账**:用两套互不相干的机制各数一遍注册点(字符串 split vs 正则 exec),
//     两个数必须相等;文件数、通道数、独立手写的锚点通道也各有下界。扫了 0 个文件的
//     `0 offenders` 与真的没问题长得一模一样。
//  ③ **谓词自检**:合成语料里「注册了没绑定」必须被抓到、「注册了也绑定了」必须放行、
//     注释里的绑定不算绑定。先证明这个手段能测出已知的坏,再用它判未知的好。
//
// ── 边界(闸门不假装比自己强)──────────────────────────────────────────────────────
//  · 只判 main→preload 这一跳。preload 绑上了而 renderer 没人调用(死绑定),本闸不红 ——
//    那是反方向的普查,今天 preload 里 23 条 `ipcRenderer.on` 事件通道的对端是
//    `webContents.send`,与本闸的注册面不同源,合并进来会变成一张长期需要维护的例外表。
//  · 只扫 `packages/ui-mac/src/main`。别的包今天不注册 IPC。

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const MAIN_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = dirname(MAIN_DIR)

type SourceFile = { path: string; source: string }

/** 目录遍历(不是写死的文件清单)—— 新增的 main 模块默认进普查面,而不是默认在圈外。 */
function walkSources(dir: string): SourceFile[] {
  const out: SourceFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkSources(abs))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.(test|spec|cases)\.tsx?$/.test(entry.name)) continue
    out.push({ path: relative(SRC_DIR, abs).split("\\").join("/"), source: readFileSync(abs, "utf8") })
  }
  return out
}

type RegistrationSite = { file: string; line: number; kind: string; arg: string }

/** 注册面。`ipcMain.on` 一并算 —— 它同样只有 preload 的 `ipcRenderer.send` 够得到。 */
const REGISTRATION = /ipcMain\.(handle|on)\(\s*([^,)]+)/g

/** 绑定面。刻意**不**含 `removeListener`(它只解绑,单独出现不构成一条可达通道)。 */
const BINDING = /ipcRenderer\.(?:invoke|send|sendSync|sendTo|on|once)\(\s*([^,)]+)/g

/**
 * 注册面**不剥注释**(fail-closed 方向):一句被注释掉的注册会要求一条绑定,吵一次好过漏一条。
 * 绑定面**剥整行注释**(同样 fail-closed):注释里的 `ipcRenderer.invoke("x")` 不是绑定。
 * 今天树上注释行里的注册点实测 0 处。
 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
    .join("\n")
}

function collectRegistrations(files: SourceFile[]): RegistrationSite[] {
  const sites: RegistrationSite[] = []
  for (const file of files) {
    REGISTRATION.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = REGISTRATION.exec(file.source))) {
      sites.push({
        file: file.path,
        line: file.source.slice(0, match.index).split("\n").length,
        kind: match[1]!,
        arg: match[2]!.trim(),
      })
    }
  }
  return sites
}

/** `export const X = "lit"` 与 `export const T = { k: "lit" } as const` ⇒ `X` / `T.k` → 字面量。 */
function collectChannelConstants(files: SourceFile[]): Map<string, string> {
  const constants = new Map<string, string>()
  for (const file of files) {
    for (const decl of file.source.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)) {
      constants.set(decl[1]!, decl[2]!)
    }
    for (const table of file.source.matchAll(/export const ([A-Z][A-Z0-9_]*)\s*=\s*\{([\s\S]*?)\}\s*as const/g)) {
      for (const member of table[2]!.matchAll(/^[ \t]*([A-Za-z_$][\w$]*)\s*:\s*"([^"]+)"/gm)) {
        constants.set(`${table[1]!}.${member[1]!}`, member[2]!)
      }
    }
  }
  return constants
}

function resolveArg(arg: string, constants: Map<string, string>): string | null {
  const literal = /^"([^"]+)"$/.exec(arg)
  if (literal) return literal[1]!
  return constants.get(arg) ?? null
}

/**
 * 间接注册器的**登记**(默认拒的唯一出口)。
 *
 * 形态:`ipcMain.handle` 的第一实参是个形参(注册器把 `ipcMain.handle` 当回调收下),
 * 真正的通道名字面量住在注册器自己那个模块里。登记一条不是免费的 —— 下面第 ④ 条测试逐条校验:
 * 真的对上了一个注册点、真的从 `via` 派生出了通道名、`via` 里注册器还在、`site` 里调用还在。
 * 四条里任何一条断掉(注册器改名/被删/通道名改成动态拼接)当场红,而不是安静地少数几条通道。
 */
type IndirectRegistration = {
  /** 注册点所在文件(相对 `src/`)。 */
  site: string
  /** 那一处第一实参的源码文本。 */
  arg: string
  /** 通道名字面量真正住在哪个模块。 */
  via: string
  /** `via` 导出的注册器函数名。 */
  registrar: string
  /** `via` 内部用来注册的调用文本。 */
  registerCall: string
  why: string
}

const INDIRECT_REGISTRATIONS: IndirectRegistration[] = [
  {
    site: "main/artifact-ipc.ts",
    arg: "channel",
    via: "main/artifact-quick-look.ts",
    registrar: "registerArtifactQuickLookIpcHandler",
    registerCall: "deps.handle",
    why: "REQ-097(#189):Quick Look 注册器收一个 handle 回调,通道名在 via 里既是字面量又是形参的字面量类型。",
  },
  {
    site: "main/ext-ipc.ts",
    arg: "channel",
    via: "main/remote-catalog.ts",
    registrar: "registerPackageCatalogReadIpcHandlers",
    registerCall: "register",
    why: "REQ-128:catalog 只读通道由 remote-catalog 自己声明(其中一条经 PACKAGE_DETAIL_IPC_CHANNEL 常量),ext-ipc 只把 ipcMain.handle 递进去。",
  },
]

function callPattern(call: string): RegExp {
  const escaped = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`${call.includes(".") ? "(?<![\\w$])" : "(?<![\\w$.])"}${escaped}\\(\\s*([^,)]+)`, "g")
}

function channelsFromRegistrar(source: string, registerCall: string, constants: Map<string, string>): string[] {
  const channels = new Set<string>()
  for (const match of stripLineComments(source).matchAll(callPattern(registerCall))) {
    const resolved = resolveArg(match[1]!.trim(), constants)
    if (resolved) channels.add(resolved)
  }
  return [...channels].sort()
}

type Census = {
  /** 通道名 → 注册点坐标。 */
  registered: Map<string, string[]>
  /** 算不出通道名、又没被登记出圈的注册点。非空 = 普查有盲区。 */
  unresolved: RegistrationSite[]
  bound: Set<string>
  /** 注册了却没有 preload 绑定 —— renderer 结构上到不了的死通道。 */
  offenders: string[]
  siteCount: number
}

function census(mainFiles: SourceFile[], preloadFiles: SourceFile[], indirect: IndirectRegistration[]): Census {
  const mainConstants = collectChannelConstants(mainFiles)
  const sites = collectRegistrations(mainFiles)
  const registered = new Map<string, string[]>()
  const unresolved: RegistrationSite[] = []
  const record = (channel: string, where: string) => {
    registered.set(channel, [...(registered.get(channel) ?? []), where])
  }
  for (const site of sites) {
    const direct = resolveArg(site.arg, mainConstants)
    if (direct !== null) {
      record(direct, `${site.file}:${site.line}`)
      continue
    }
    const entry = indirect.find((candidate) => candidate.site === site.file && candidate.arg === site.arg)
    const derived = entry
      ? channelsFromRegistrar(mainFiles.find((file) => file.path === entry.via)?.source ?? "", entry.registerCall, mainConstants)
      : []
    if (derived.length === 0) {
      unresolved.push(site)
      continue
    }
    for (const channel of derived) record(channel, `${site.file}:${site.line} → ${entry!.via}`)
  }

  const preloadConstants = collectChannelConstants(preloadFiles)
  const bound = new Set<string>()
  for (const file of preloadFiles) {
    for (const match of stripLineComments(file.source).matchAll(BINDING)) {
      const resolved = resolveArg(match[1]!.trim(), preloadConstants)
      if (resolved !== null) bound.add(resolved)
    }
  }

  return {
    registered,
    unresolved,
    bound,
    offenders: [...registered.keys()].filter((channel) => !bound.has(channel)).sort(),
    siteCount: sites.length,
  }
}

const MAIN_FILES = walkSources(MAIN_DIR)
const PRELOAD_FILES = walkSources(join(SRC_DIR, "preload"))
const REAL = census(MAIN_FILES, PRELOAD_FILES, INDIRECT_REGISTRATIONS)

describe("ac#1116 IPC 注册面 × preload 绑定面普查", () => {
  test("① 每条注册的 IPC 通道都有 preload 绑定(没有绑定 = renderer 结构上到不了的死通道)", () => {
    expect(
      REAL.offenders.map((channel) => `${channel}  ← ${REAL.registered.get(channel)!.join(", ")}`),
      [
        "下列通道在 main 侧注册了,但 preload 里没有任何 ipcRenderer.invoke/send 绑定。",
        "窗口是 contextIsolation + sandbox + nodeIntegration:false,renderer 里没有 ipcRenderer ⇒",
        "**没有 preload 绑定就没有任何调用路径**,这条通道是死代码,而它长得像一个已有的能力。",
        "两条出路,不留第三态:",
        "  · 它该被用 → 在 preload/index.ts 里加绑定,并让至少一个 renderer 调用点真的用上;",
        "  · 它没人用 → 把注册删掉(连同只有它用得到的 main 侧机器)。",
      ].join("\n"),
    ).toEqual([])
  })

  test("② 算不出通道名的注册点默认拒(不是默认放行,否则普查会安静地少数一条)", () => {
    expect(
      REAL.unresolved.map((site) => `${site.file}:${site.line}  ipcMain.${site.kind}(${site.arg}`),
      [
        "下列注册点的通道名不是字面量、也不是可解析的常量,普查算不出它注册了什么。",
        "默认拒:算不出来的注册点如果直接跳过,这道闸就有一个任何人都能无意走进去的盲区。",
        "改法二选一:",
        "  · 通道名写成字面量,或写进一张 `export const … as const` 表;",
        "  · 确实是间接注册器 → 在 INDIRECT_REGISTRATIONS 里登记(要过第 ④ 条的四道校验)。",
      ].join("\n"),
    ).toEqual([])
  })

  test("③ 普查真的扫到了东西(处理量对账 + 独立手写锚点;扫了 0 个文件的 0 offenders 与真没问题长得一样)", () => {
    // 下界:今天实测 199 个 main 文件 / 4 个 preload 文件。walk 断了就当场红,而不是空绿。
    expect(MAIN_FILES.length).toBeGreaterThanOrEqual(150)
    expect(PRELOAD_FILES.length).toBeGreaterThanOrEqual(3)

    // 处理量对账:两套互不相干的机制各数一遍注册点(纯字符串 split vs 正则 exec)。
    const bySplit = MAIN_FILES.reduce(
      (total, file) => total + file.source.split("ipcMain.handle(").length - 1 + file.source.split("ipcMain.on(").length - 1,
      0,
    )
    expect(REAL.siteCount).toBe(bySplit)
    expect(REAL.siteCount).toBeGreaterThanOrEqual(150)
    expect(REAL.registered.size).toBeGreaterThanOrEqual(150)

    // 锚点是**手写的独立字面量**,不从生产模块 import —— 否则改错生产常量时锚点跟着改,一起自洽。
    // 五条各代表一种解析路径:纯字面量 / 常量表成员 / ipcMain.on / 两个间接注册器各一条。
    for (const anchor of [
      "ext-list-installs",
      "ext-install-catalog",
      "open-link",
      "run-artifact-quick-look",
      "ext-package-detail",
    ]) {
      expect(REAL.registered.has(anchor), `锚点通道 ${anchor} 没被普查到 —— 解析路径断了`).toBe(true)
      expect(REAL.bound.has(anchor), `锚点通道 ${anchor} 的 preload 绑定没被普查到 —— 绑定面解析断了`).toBe(true)
    }
  })

  test("④ 间接注册器的登记不是橡皮图章(对不上注册点 / 派生不出通道 / 注册器不在了,都当场红)", () => {
    const bad: string[] = []
    const sites = collectRegistrations(MAIN_FILES)
    const constants = collectChannelConstants(MAIN_FILES)
    for (const entry of INDIRECT_REGISTRATIONS) {
      const siteSource = MAIN_FILES.find((file) => file.path === entry.site)?.source
      const viaSource = MAIN_FILES.find((file) => file.path === entry.via)?.source
      if (!siteSource) bad.push(`${entry.site}: 登记的注册点文件不存在`)
      if (!viaSource) bad.push(`${entry.via}: 登记的注册器模块不存在`)
      if (!sites.some((site) => site.file === entry.site && site.arg === entry.arg))
        bad.push(`${entry.site}: 没有任何 ipcMain.handle/on 的第一实参是 \`${entry.arg}\` —— 死登记`)
      if (viaSource && channelsFromRegistrar(viaSource, entry.registerCall, constants).length === 0)
        bad.push(`${entry.via}: \`${entry.registerCall}(\` 派生不出任何通道名 —— 出圈的那几条通道现在无人普查`)
      if (viaSource && !viaSource.includes(`export function ${entry.registrar}`))
        bad.push(`${entry.via}: 找不到 \`export function ${entry.registrar}\``)
      if (siteSource && !siteSource.includes(`${entry.registrar}(`))
        bad.push(`${entry.site}: 没有调用 \`${entry.registrar}(\` —— 登记指向一条已经不存在的接线`)
      if (entry.why.trim().length <= 20) bad.push(`${entry.site}: why 过短`)
    }
    expect(bad, "间接注册器的登记是默认拒的唯一出口,它自己必须先站得住。").toEqual([])
  })

  test("⑤ 谓词自检:合成语料里已知的坏必须被抓到,已知的好必须放行", () => {
    const mainOf = (source: string): SourceFile[] => [{ path: "main/synthetic.ts", source }]
    const preloadOf = (source: string): SourceFile[] => [{ path: "preload/synthetic.ts", source }]

    // (a) 注册了、没绑定 ⇒ 必须被抓到。这一条是本闸存在的理由,先证明它真的会开火。
    const orphan = census(
      mainOf('ipcMain.handle("synthetic-orphan", () => 1)\n'),
      preloadOf("export const api = {}\n"),
      [],
    )
    expect(orphan.offenders).toEqual(["synthetic-orphan"])

    // (b) 注册了、也绑定了 ⇒ 必须放行(否则这道闸只是恒红,谁都会学会忽略它)。
    const wired = census(
      mainOf('ipcMain.handle("synthetic-wired", () => 1)\n'),
      preloadOf('const api = { f: () => ipcRenderer.invoke("synthetic-wired") }\n'),
      [],
    )
    expect(wired.offenders).toEqual([])

    // (c) 注释里的绑定不是绑定 —— 否则把实现删成注释就能骗过本闸。
    const commented = census(
      mainOf('ipcMain.handle("synthetic-commented", () => 1)\n'),
      preloadOf('  // f: () => ipcRenderer.invoke("synthetic-commented"),\n'),
      [],
    )
    expect(commented.offenders).toEqual(["synthetic-commented"])

    // (d) `ipcMain.on` 与 `ipcRenderer.send` 是同一条可达性,一并普查。
    const sendPath = census(
      mainOf('ipcMain.on("synthetic-send", () => {})\nipcMain.on("synthetic-send-orphan", () => {})\n'),
      preloadOf('const api = { f: () => ipcRenderer.send("synthetic-send") }\n'),
      [],
    )
    expect(sendPath.offenders).toEqual(["synthetic-send-orphan"])

    // (e) 常量表成员解析得出来,而且解析出来之后照样吃第 ① 条的判据。
    const viaTable = census(
      mainOf('export const T_CHANNELS = {\n  a: "synthetic-table-a",\n} as const\nipcMain.handle(T_CHANNELS.a, () => 1)\n'),
      preloadOf("export const api = {}\n"),
      [],
    )
    expect(viaTable.offenders).toEqual(["synthetic-table-a"])

    // (f) 算不出名字的注册点进 unresolved,**不进** registered —— 默认拒,不是默认放行。
    const dynamic = census(mainOf("ipcMain.handle(computeName(), () => 1)\n"), preloadOf(""), [])
    expect(dynamic.registered.size).toBe(0)
    expect(dynamic.unresolved.map((site) => site.arg)).toEqual(["computeName("])

    // (g) 间接注册器:登记之后通道从 via 派生;`via` 空掉就掉回 unresolved(而不是消失)。
    const indirectEntry: IndirectRegistration = {
      site: "main/synthetic.ts",
      arg: "channel",
      via: "main/synthetic-via.ts",
      registrar: "registerSynthetic",
      registerCall: "register",
      why: "自检用的合成登记,不指向树上任何真实模块。",
    }
    const indirectFiles: SourceFile[] = [
      { path: "main/synthetic.ts", source: "registerSynthetic((channel, handler) => ipcMain.handle(channel, handler))\n" },
      { path: "main/synthetic-via.ts", source: 'export function registerSynthetic(register) {\n  register("synthetic-indirect", () => 1)\n}\n' },
    ]
    const indirect = census(indirectFiles, preloadOf(""), [indirectEntry])
    expect(indirect.unresolved).toEqual([])
    expect(indirect.offenders).toEqual(["synthetic-indirect"])
    const emptied = census(
      [indirectFiles[0]!, { path: "main/synthetic-via.ts", source: "export function registerSynthetic() {}\n" }],
      preloadOf(""),
      [indirectEntry],
    )
    expect(emptied.offenders).toEqual([])
    expect(emptied.unresolved.map((site) => site.arg)).toEqual(["channel"])
  })
})
