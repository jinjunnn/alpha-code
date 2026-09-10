// REQ-159 (`#1321`) —— 可写集单一权威的**形状**判据 + 并集裁剪规则 + 试编译封顶(纯逻辑,全平台跑)。
//
// 断言粒度纪律:profile 用**逐行全等**(不是「包含 deny」);并集用**顺序相等**(不是集合);
// 裁剪用一个「只在 ≤N 条时通过」的假编译器,断言丢的是尾部、丢到底仍失败要抛且带原因。
// XDG 解析对着 node_modules 里**那份** xdg-basedir(packages/core/src/global.ts 真 import 的那个)
// 逐输入交叉验证 —— 基准是别人的包,不是本模块常量(非自指等价链)。

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import {
  COMPILE_BYTE_WALL,
  MAX_WORKSPACES,
  WRITABLE_ROOT_IDS,
  assertEgressProxyPort,
  assertSeatbeltSafePath,
  renderProcessFenceProfile,
  resolveEngineRoots,
  selectWorkspaceUnion,
  trimUntilCompiles,
  workspaceCandidatesFromStore,
  type ProcessFenceProfileInput,
} from "./process-fence-profile"

const HOME = "/Users/alpha"
const roots = { home: HOME, dataHome: `${HOME}/.local/share`, cacheHome: `${HOME}/.cache`, configHome: `${HOME}/.config` }
const base: ProcessFenceProfileInput = {
  workspaces: [`${HOME}/code-puppy`, "/Users/alpha/app/alpha-code"],
  alphaGlobalRoot: `${HOME}/Library/Application Support/alpha-code-state/env/prod`,
  userDataPath: `${HOME}/Library/Application Support/ai.opencode.desktop`,
  stateHome: `${HOME}/Library/Application Support/ai.opencode.desktop`,
  roots,
  egressProxyPort: 4443,
}

/** `#1334` Q1.2 的四行(逐字,独立字面量 —— 不从渲染器取);端口是唯一的参数。 */
const NETWORK_LINES = (port: number) => [
  "(deny network*)",
  '(allow network-bind (local ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  `(allow network-outbound (remote ip "localhost:${port}"))`,
]

/** 去掉每行的 `; Wn` 注释与多余空白,只比策略 token —— 注释在编译期被剥离(勘破 §6.5 第 9 行)。 */
const tokens = (profile: string) =>
  profile
    .split("\n")
    .map((l) => l.replace(/\s*;.*$/, "").trim())
    .filter(Boolean)

describe("renderProcessFenceProfile —— 勘破 §8.2 的 19 行,逐行全等", () => {
  test("两个工作区 + 生产根:输出 = §8.2 形状(参数已代入),无多无少", () => {
    expect(tokens(renderProcessFenceProfile(base))).toEqual([
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      "(allow file-write*",
      `(subpath "${HOME}/code-puppy")`,
      `(subpath "/Users/alpha/app/alpha-code")`,
      `(subpath "${HOME}/Library/Application Support/alpha-code-state/env/prod")`,
      `(subpath "${HOME}/Library/Application Support/ai.opencode.desktop")`,
      `(subpath "${HOME}/.local/share/opencode")`,
      `(subpath "${HOME}/.cache/opencode")`,
      `(subpath "${HOME}/.config/opencode")`,
      `(subpath "${HOME}/.npm")`,
      `(regex #"^/Users/alpha/\\.zsh_history")`,
      `(subpath "${HOME}/.zsh_sessions")`,
      `(regex #"^/Users/alpha/\\.zcompdump")`,
      `(subpath "/private/tmp")`,
      `(subpath "/private/var/folders")`,
      `(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")`,
      `(literal "/dev/tty") (regex #"^/dev/fd/")`,
      `(literal "/dev/ptmx") (regex #"^/dev/ttys")`,
      `(subpath "${HOME}/.opencode")`,
      `(subpath "${HOME}/Library/Caches/bun")`,
      `(subpath "${HOME}/.cache/bun")`,
      ")",
      ...NETWORK_LINES(4443),
    ])
  })

  test("`#1337` 网络行:Q1.2 四行逐字、顺序不变、deny 在前 allow 在后、N4 的端口就是传入的代理端口;只写加法(没有第二条 deny)", () => {
    const out = tokens(renderProcessFenceProfile({ ...base, egressProxyPort: 61234 }))
    expect(out.slice(-4)).toEqual(NETWORK_LINES(61234))
    expect(out.filter((l) => l.startsWith("(deny "))).toEqual(["(deny file-write*)", "(deny network*)"])
    expect(out.filter((l) => /network-outbound/.test(l))).toEqual([`(allow network-outbound (remote ip "localhost:61234"))`])
    // DNS 刻意不放行:没有 mDNSResponder 那一行(`#1334` Q3:解析搬到代理那一侧)
    expect(renderProcessFenceProfile(base)).not.toContain("mDNSResponder")
  })

  test("`#1337` fail-closed:代理端口不是 1..65535 的整数 ⇒ 拒绝渲染(没有那扇门就没有 profile)", () => {
    for (const bad of [0, 65536, -1, 1.5, Number.NaN, "4443", undefined, null]) {
      expect(() => assertEgressProxyPort(bad), String(bad)).toThrow(/egress proxy port must be an integer in 1\.\.65535/)
      expect(() => renderProcessFenceProfile({ ...base, egressProxyPort: bad as number }), String(bad)).toThrow(/egress proxy port/)
    }
    expect(assertEgressProxyPort(1)).toBe(1)
    expect(assertEgressProxyPort(65535)).toBe(65535)
  })

  test("每一行都带 §8.2 的 id 注释,且 id 集合 = WRITABLE_ROOT_IDS 的键(登记簿只能点名存在的行)", () => {
    const ids = new Set(
      renderProcessFenceProfile(base)
        .split("\n")
        .map((l) => /;\s*(W\d+)/.exec(l)?.[1])
        .filter((x): x is string => !!x),
    )
    expect([...ids].sort()).toEqual(Object.keys(WRITABLE_ROOT_IDS).sort())
  })

  test("XDG 根跟着 env 走:用户导出 XDG_DATA_HOME 时 W4 指向它,不再是 ~/.local/share", () => {
    const custom = resolveEngineRoots({ XDG_DATA_HOME: "/Volumes/data/xdg" }, HOME)
    const out = tokens(renderProcessFenceProfile({ ...base, roots: custom }))
    expect(out).toContain(`(subpath "/Volumes/data/xdg/opencode")`)
    expect(out).not.toContain(`(subpath "${HOME}/.local/share/opencode")`)
  })

  test("state 根:等于 userDataPath 时不出第二行;用户导出 XDG_STATE_HOME 时多一行 W3", () => {
    expect(tokens(renderProcessFenceProfile(base)).filter((l) => l.includes("/opencode\")") && l.includes("state"))).toEqual([])
    const out = tokens(renderProcessFenceProfile({ ...base, stateHome: "/Volumes/data/state" }))
    expect(out).toContain(`(subpath "/Volumes/data/state/opencode")`)
  })

  test("HOME 里的正则元字符在 regex 行被转义(/Users/j.doe 的 `.` 不是「任意字符」)", () => {
    const out = renderProcessFenceProfile({ ...base, roots: { ...roots, home: "/Users/j.doe" } })
    expect(out).toContain(`(regex #"^/Users/j\\.doe/\\.zsh_history")`)
  })

  test("fail-closed:含引号 / 反斜杠 / 控制字符 / 相对路径的根一律拒绝渲染", () => {
    expect(() => assertSeatbeltSafePath('/Users/a"b', "x")).toThrow(/cannot carry/)
    expect(() => assertSeatbeltSafePath("/Users/a\\b", "x")).toThrow(/cannot carry/)
    expect(() => assertSeatbeltSafePath("/Users/a\nb", "x")).toThrow(/cannot carry/)
    expect(() => assertSeatbeltSafePath("relative/x", "x")).toThrow(/must be absolute/)
    expect(() => renderProcessFenceProfile({ ...base, workspaces: ['/ws/"evil'] })).toThrow(/workspace\[0\]/)
    // 控制组:正常路径(含空格)通过
    expect(assertSeatbeltSafePath("/Users/a b/c", "x")).toBe("/Users/a b/c")
  })
})

describe("resolveEngineRoots == node_modules 里那份 xdg-basedir(packages/core/src/global.ts 的 import)", () => {
  // xdg-basedir 在模块装载时读 process.env / os.homedir(),所以每个输入形状起一个子进程真 import 它。
  const coreRequire = createRequire(resolve(import.meta.dir, "../../../core/package.json"))
  const xdgPath = coreRequire.resolve("xdg-basedir")

  const viaRealPackage = (env: Record<string, string>, home: string) => {
    const res = spawnSync(
      process.execPath,
      ["-e", `import("${xdgPath}").then(m => console.log(JSON.stringify({ data: m.xdgData, cache: m.xdgCache, config: m.xdgConfig })))`],
      { env: { PATH: process.env.PATH ?? "", HOME: home, ...env }, encoding: "utf8" },
    )
    if (res.status !== 0) throw new Error(`xdg-basedir probe failed: ${res.stderr}`)
    return JSON.parse(res.stdout.trim()) as { data: string; cache: string; config: string }
  }

  test("输入形状域:未设 / 全设 / 只设一个 / 设成空串 —— 四种形状逐点一致", () => {
    const shapes: Array<Record<string, string>> = [
      {},
      { XDG_DATA_HOME: "/x/data", XDG_CACHE_HOME: "/x/cache", XDG_CONFIG_HOME: "/x/config" },
      { XDG_CACHE_HOME: "/only/cache" },
      { XDG_DATA_HOME: "" },
    ]
    for (const env of shapes) {
      const real = viaRealPackage(env, "/Users/xdg-probe")
      const ours = resolveEngineRoots(env, "/Users/xdg-probe")
      expect({ data: ours.dataHome, cache: ours.cacheHome, config: ours.configHome }, JSON.stringify(env)).toEqual(real)
    }
  })
})

describe("selectWorkspaceUnion —— 并集裁剪规则(K=32,顺序 = 默认工作区 → recent → tab 栏 → info)", () => {
  const dirs = new Set([
    "/Users/alpha/code-puppy",
    "/Users/alpha/proj-a",
    "/Users/alpha/proj-b",
    "/Users/alpha/proj-c",
    "/Users/alpha/proj-recent",
    "/Volumes/ext/proj-x",
  ])
  const isDirectory = (p: string) => dirs.has(p)
  const sessionKey = (id: string) => `sidecar\n/session/${id}`
  const sources = {
    tabs: JSON.stringify([
      { type: "draft", draftID: "d1", server: "sidecar", directory: "/Users/alpha/proj-a" },
      { type: "session", server: "sidecar", sessionID: "s1" },
      { type: "draft", draftID: "d2", server: "wsl:ubuntu", directory: "/home/u/remote" },
      { type: "draft", draftID: "d3", server: "sidecar", directory: "/Users/alpha/proj-b" },
    ]),
    recent: JSON.stringify({ key: sessionKey("s9") }),
    info: {
      [sessionKey("s1")]: { directory: "/Users/alpha/proj-c" },
      [sessionKey("s9")]: { directory: "/Users/alpha/proj-recent" },
      "ssh:box\n/session/s2": { directory: "/home/u/other" },
      [sessionKey("gone")]: { directory: "/Users/alpha/deleted-project" },
      [sessionKey("home")]: { directory: "/Users/alpha" },
      [sessionKey("root")]: { directory: "/" },
      [sessionKey("users")]: { directory: "/Users" },
      [sessionKey("rel")]: { directory: "relative/path" },
    },
  }

  test("顺序:默认工作区第一,recent 第二,然后 tab 栏的 draft,再 info 的 session;非本地引擎 / 不存在 / HOME 及其祖先 / 相对路径逐条排除并给理由", () => {
    const union = selectWorkspaceUnion({ sources, defaultWorkspace: "/Users/alpha/code-puppy", homeDir: "/Users/alpha", isDirectory })
    expect(union.selected).toEqual([
      "/Users/alpha/code-puppy",
      "/Users/alpha/proj-recent",
      "/Users/alpha/proj-a",
      "/Users/alpha/proj-b",
      "/Users/alpha/proj-c",
    ])
    const reasons = Object.fromEntries(union.excluded.map((e) => [e.directory, e.reason]))
    expect(reasons["/Users/alpha/deleted-project"]).toMatch(/not a directory/)
    expect(reasons["/Users/alpha"]).toMatch(/HOME/)
    expect(reasons["/"]).toMatch(/HOME/)
    expect(reasons["/Users"]).toMatch(/HOME/)
    expect(reasons["relative/path"]).toMatch(/absolute/)
    // wsl / ssh 的目录根本不进候选(不是「排除」,是「不认」)
    expect(union.excluded.map((e) => e.directory)).not.toContain("/home/u/remote")
    expect(union.excluded.map((e) => e.directory)).not.toContain("/home/u/other")
  })

  test("去重:同一目录出现在 recent / tabs / info 三处只算一次", () => {
    const dup = {
      tabs: [{ type: "draft", draftID: "d", server: "sidecar", directory: "/Users/alpha/proj-a" }],
      recent: { key: "draft:d" },
      info: { [sessionKey("x")]: { directory: "/Users/alpha/proj-a/" } },
    }
    const union = selectWorkspaceUnion({ sources: dup, defaultWorkspace: "/Users/alpha/code-puppy", homeDir: "/Users/alpha", isDirectory })
    expect(union.selected).toEqual(["/Users/alpha/code-puppy", "/Users/alpha/proj-a"])
  })

  test("K 封顶:超过 MAX_WORKSPACES 的候选被排除并点名;默认工作区永远不会被顶掉", () => {
    const many = Array.from({ length: MAX_WORKSPACES + 5 }, (_, i) => `/Users/alpha/many-${i}`)
    const isDir = (p: string) => p === "/Users/alpha/code-puppy" || many.includes(p)
    const union = selectWorkspaceUnion({
      sources: { tabs: many.map((d, i) => ({ type: "draft", draftID: `d${i}`, server: "sidecar", directory: d })), recent: undefined, info: undefined },
      defaultWorkspace: "/Users/alpha/code-puppy",
      homeDir: "/Users/alpha",
      isDirectory: isDir,
    })
    expect(union.selected.length).toBe(MAX_WORKSPACES)
    expect(union.selected[0]).toBe("/Users/alpha/code-puppy")
    expect(union.excluded.filter((e) => /MAX_WORKSPACES/.test(e.reason)).map((e) => e.directory)).toEqual(many.slice(MAX_WORKSPACES - 1))
  })

  test("store 形状容错:非 JSON 字符串 / 非数组 tabs / 缺 info ⇒ 只剩默认工作区,不抛", () => {
    const union = selectWorkspaceUnion({
      sources: { tabs: "{not json", recent: 42, info: null },
      defaultWorkspace: "/Users/alpha/code-puppy",
      homeDir: "/Users/alpha",
      isDirectory,
    })
    expect(union.selected).toEqual(["/Users/alpha/code-puppy"])
    expect(workspaceCandidatesFromStore({ tabs: undefined, recent: undefined, info: undefined })).toEqual([])
  })

  test("默认工作区本身不是目录 ⇒ selected 为空(planner 据此拒绝 fork)", () => {
    const union = selectWorkspaceUnion({ sources: { tabs: undefined, recent: undefined, info: undefined }, defaultWorkspace: "/Users/alpha/missing", homeDir: "/Users/alpha", isDirectory })
    expect(union.selected).toEqual([])
  })
})

describe("trimUntilCompiles —— 试编译封顶,从尾部丢,丢到底仍失败要抛", () => {
  const ws = ["/Users/alpha/code-puppy", "/Users/alpha/a", "/Users/alpha/b", "/Users/alpha/c"]
  const compileAllowing = (max: number, reason = "sandbox-exec: data object length 70173 exceeds maximum (65535)") => (profile: string) =>
    (profile.match(/; W1$/gm)?.length ?? 0) <= max ? ({ ok: true } as const) : ({ ok: false, reason } as const)

  test("编译器一次通过:不丢、attempts=1、profile 含全部工作区", () => {
    const r = trimUntilCompiles({ ...base, workspaces: ws }, compileAllowing(99))
    expect(r.dropped).toEqual([])
    expect(r.attempts).toBe(1)
    expect(r.workspaces).toEqual(ws)
    expect(tokens(r.profile).filter((l) => ws.some((w) => l === `(subpath "${w}")`)).length).toBe(4)
  })

  test("只放得下 2 个:丢 c 再丢 b,attempts=3,lastFailure 是编译器原文,剩下的 profile 里没有被丢的目录", () => {
    const r = trimUntilCompiles({ ...base, workspaces: ws }, compileAllowing(2))
    expect(r.dropped).toEqual(["/Users/alpha/c", "/Users/alpha/b"])
    expect(r.workspaces).toEqual(["/Users/alpha/code-puppy", "/Users/alpha/a"])
    expect(r.attempts).toBe(3)
    expect(r.lastFailure).toMatch(/exceeds maximum \(65535\)/)
    expect(tokens(r.profile)).not.toContain(`(subpath "/Users/alpha/c")`)
    expect(tokens(r.profile)).not.toContain(`(subpath "/Users/alpha/b")`)
  })

  test("默认工作区不可丢:字节墙丢到只剩 1 个仍失败 ⇒ 抛,消息带编译器原文与账目(fail-closed 到「引擎不起」)", () => {
    expect(() => trimUntilCompiles({ ...base, workspaces: ws }, compileAllowing(0))).toThrow(
      /minimum writable set \(1 workspace, 3 dropped, 4 attempts\): sandbox-exec: data object length 70173 exceeds maximum \(65535\)/,
    )
  })

  test("`#1337` 归因:失败原因不是字节墙(语法坏 / unbound variable)⇒ 一个工作区都不丢、attempts=1 即抛,消息点名「丢工作区救不了」", () => {
    const seen: number[] = []
    const syntaxBad = (profile: string) => {
      seen.push(profile.match(/; W1$/gm)?.length ?? 0)
      return { ok: false as const, reason: "sandbox-exec: unbound variable: host … line 25, column 33" }
    }
    expect(() => trimUntilCompiles({ ...base, workspaces: ws }, syntaxBad)).toThrow(
      /not the 65535-byte data-object wall — dropping workspaces cannot fix it, so none were dropped \(4 workspaces, 0 dropped, 1 attempt\): sandbox-exec: unbound variable: host/,
    )
    expect(seen).toEqual([4]) // 只试编了一次,而且是全并集
    // 字节墙的原文由 process-fence-compile.test.ts 对真编译器钉住;这里只核对判别式认得它、不认别的
    expect(COMPILE_BYTE_WALL.test("sandbox-exec: data object length 65574 exceeds maximum (65535)")).toBe(true)
    expect(COMPILE_BYTE_WALL.test("sandbox-exec: unbound variable: host")).toBe(false)
    expect(COMPILE_BYTE_WALL.test("profile compilation failed")).toBe(false)
  })
})

describe("控制组:判据能测出已知的坏", () => {
  test("少一行(去掉 W15)⇒ 逐行全等判据红", () => {
    const rendered = tokens(renderProcessFenceProfile(base)).filter((l) => !l.includes("/dev/ptmx"))
    expect(rendered).not.toEqual(tokens(renderProcessFenceProfile(base)))
  })
  test("`#1337` 少 N3(inbound)或多一条减法 deny ⇒ 网络行判据红(老勘破 §5 那两行 / 减法组合正是 `#1334` 实测的两种坏)", () => {
    const good = tokens(renderProcessFenceProfile(base))
    const sec5 = good.filter((l) => !l.includes("network-inbound"))
    expect(sec5.slice(-4)).not.toEqual(NETWORK_LINES(4443))
    const subtractive = [...good, '(deny network-outbound (remote ip "localhost:1234"))']
    expect(subtractive.filter((l) => l.startsWith("(deny "))).not.toEqual(["(deny file-write*)", "(deny network*)"])
  })
  test("放宽一行(HOME 整个进 subpath)⇒ 并集规则红", () => {
    const union = selectWorkspaceUnion({
      sources: { tabs: [{ type: "draft", draftID: "d", server: "sidecar", directory: "/Users/alpha" }], recent: undefined, info: undefined },
      defaultWorkspace: join("/Users/alpha", "code-puppy"),
      homeDir: "/Users/alpha",
      isDirectory: () => true,
    })
    expect(union.selected).not.toContain("/Users/alpha")
  })
})
