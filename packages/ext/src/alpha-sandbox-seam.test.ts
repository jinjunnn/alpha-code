// REQ-138 / #1075 · AC1 —— 派生 shell 只有一条通路,缺失即响亮失败。
//
// 本文件测**接线与不变量**,不需要真 sandbox-exec,所以 platform 用 seam 强制 "darwin",
// fs 用捕获式 mock —— 于是 Linux CI 也照跑,能抓住「cfg.shell 没被改指 wrapper」「profile
// 允许集被拓宽」「装不上时回落裸 shell」这几类回归。真 sandbox-exec 的正反语料是 darwin-only
// 的另一支(见 REQ-138 的 escape 语料),CI(ubuntu)上 skip、本机 macOS 真跑。
//
// 断言粒度纪律(CLAUDE.md):每条断言都问过「一个错误实现能不能满足它」——
// profile 用**逐 token 全等**而非「包含 deny」,fail-closed 断言的是 cfg.shell 的**确切值**
// 而非布尔,等价性锚点是**独立**的真 core Shell 而非本模块自己的常量。

import { describe, expect, test } from "bun:test"
import { basename, join } from "node:path"
import {
  BIN_DIRNAME,
  DENY_SHELL_BASENAME,
  DENY_SHELL_SCRIPT,
  PROFILE_BASENAME,
  SANDBOX_DIRNAME,
  SEATBELT_PROFILE,
  WRAPPER_SCRIPT,
  wrapEngineShell,
  type WrapEngineShellSeams,
} from "./shell-sandbox"

const ROOT = "/alpha/env/prod"
const BIN = join(ROOT, BIN_DIRNAME)
const SANDBOX = join(ROOT, SANDBOX_DIRNAME)
const PROFILE = join(SANDBOX, PROFILE_BASENAME)

type Capture = {
  writes: Map<string, string>
  dirs: string[]
  chmods: Map<string, number>
}

/** 捕获式 mock seams:记录所有 fs 副作用,statIsFile 对一组已知绝对 shell 返回真。 */
function captureSeams(overrides?: Partial<WrapEngineShellSeams>): { seams: WrapEngineShellSeams; cap: Capture } {
  const cap: Capture = { writes: new Map(), dirs: [], chmods: new Map() }
  const knownFiles = new Set(["/bin/zsh", "/bin/bash", "/bin/sh", "/opt/homebrew/bin/fish", "/usr/local/bin/nu"])
  const seams: WrapEngineShellSeams = {
    platform: "darwin",
    envShell: "/bin/zsh",
    statIsFile: (p) => knownFiles.has(p),
    which: () => undefined,
    mkdirSync: (p) => {
      cap.dirs.push(p)
    },
    writeFileSync: (p, data) => {
      cap.writes.set(p, data)
    },
    chmodSync: (p, mode) => {
      cap.chmods.set(p, mode)
    },
    ...overrides,
  }
  return { seams, cap }
}

describe("AC1 wrapEngineShell — one path, fail-closed", () => {
  test("cfg.shell 未设:改指 <root>/bin/zsh,写 wrapper + profile,设两个 env", () => {
    const { seams, cap } = captureSeams()
    const cfg: { shell?: string } = {}
    const env: NodeJS.ProcessEnv = {}
    const r = wrapEngineShell(cfg, ROOT, env, seams)

    expect(r.fenced).toBe(true)
    // cfg.shell 恒指向 wrapper —— 不是用户/裸 shell(I1)
    expect(cfg.shell).toBe(join(BIN, "zsh"))
    // wrapper 读的两个 env(I4 的运行时依赖)
    expect(env.ALPHA_SB_PROFILE).toBe(PROFILE)
    expect(env.ALPHA_REAL_SHELL).toBe("/bin/zsh")
    // wrapper 内容逐字节 = 常量(一行透传);可执行位
    expect(cap.writes.get(join(BIN, "zsh"))).toBe(WRAPPER_SCRIPT)
    expect(cap.chmods.get(join(BIN, "zsh"))).toBe(0o755)
    // profile 落在单一权威路径
    expect(cap.writes.get(PROFILE)).toBe(SEATBELT_PROFILE)
  })

  test("basename 与真 shell 对齐:cfg.shell=/bin/bash ⇒ wrapper 名 bash、real=/bin/bash", () => {
    const { seams, cap } = captureSeams()
    const cfg: { shell?: string } = { shell: "/bin/bash" }
    const env: NodeJS.ProcessEnv = {}
    const r = wrapEngineShell(cfg, ROOT, env, seams)
    expect(r.fenced && r.realShell).toBe("/bin/bash")
    expect(cfg.shell).toBe(join(BIN, "bash"))
    expect(env.ALPHA_REAL_SHELL).toBe("/bin/bash")
    expect(cap.writes.has(join(BIN, "bash"))).toBe(true)
  })

  test("denied shell(fish/nu)回落默认 zsh —— 与 core META deny 对齐,不给 fish 命名 wrapper", () => {
    for (const denied of ["/opt/homebrew/bin/fish", "/usr/local/bin/nu"]) {
      const { seams } = captureSeams()
      const cfg: { shell?: string } = { shell: denied }
      const env: NodeJS.ProcessEnv = {}
      const r = wrapEngineShell(cfg, ROOT, env, seams)
      expect(r.fenced && r.realShell).toBe("/bin/zsh")
      expect(cfg.shell).toBe(join(BIN, "zsh"))
    }
  })

  test("双重包裹防线:cfg.shell 已是本 bin 下的路径 ⇒ real 回落 zsh,绝不 exec 自己", () => {
    const wrapperPath = join(BIN, "zsh")
    // statIsFile 对 wrapperPath 返回真(它确实存在),但 resolveRealShell 必须丢弃它
    const { seams } = captureSeams({ statIsFile: (p) => p === wrapperPath || p === "/bin/zsh" })
    const cfg: { shell?: string } = { shell: wrapperPath }
    const env: NodeJS.ProcessEnv = {}
    const r = wrapEngineShell(cfg, ROOT, env, seams)
    expect(r.fenced && r.realShell).toBe("/bin/zsh")
    expect(env.ALPHA_REAL_SHELL).toBe("/bin/zsh")
  })

  test("fail-closed①:wrapper 写失败 ⇒ cfg.shell = deny stub,不留裸 shell", () => {
    const { cap } = captureSeams()
    const seams: WrapEngineShellSeams = {
      platform: "darwin",
      envShell: "/bin/zsh",
      statIsFile: () => true,
      which: () => undefined,
      mkdirSync: (p) => {
        cap.dirs.push(p)
      },
      // wrapper 写盘炸掉;deny stub 写盘正常
      writeFileSync: (p, data) => {
        if (basename(p) === "zsh") throw new Error("disk full")
        cap.writes.set(p, data)
      },
      chmodSync: (p, mode) => {
        cap.chmods.set(p, mode)
      },
    }
    const cfg: { shell?: string } = {}
    const env: NodeJS.ProcessEnv = {}
    const r = wrapEngineShell(cfg, ROOT, env, seams)
    expect(r.fenced).toBe(false)
    expect(cfg.shell).toBe(join(BIN, DENY_SHELL_BASENAME))
    expect(cap.writes.get(join(BIN, DENY_SHELL_BASENAME))).toBe(DENY_SHELL_SCRIPT)
  })

  test("fail-closed②:连 deny stub 都写不下 ⇒ cfg.shell = /usr/bin/false(仍零执行)", () => {
    const { seams } = captureSeams({
      writeFileSync: () => {
        throw new Error("disk full")
      },
    })
    const cfg: { shell?: string } = {}
    const env: NodeJS.ProcessEnv = {}
    const r = wrapEngineShell(cfg, ROOT, env, seams)
    expect(r.fenced).toBe(false)
    expect(cfg.shell).toBe("/usr/bin/false")
  })

  test("非 darwin:不动 cfg.shell(本接缝结构上不适用,不做前提为假的闸门)", () => {
    const { seams } = captureSeams({ platform: "linux" })
    const cfg: { shell?: string } = { shell: "/bin/bash" }
    const env: NodeJS.ProcessEnv = {}
    const r = wrapEngineShell(cfg, ROOT, env, seams)
    expect(r.fenced).toBe(false)
    expect(cfg.shell).toBe("/bin/bash")
    expect(env.ALPHA_SB_PROFILE).toBeUndefined()
  })
})

describe("AC1/I2 — profile 是可写集合的唯一权威,允许集是闭集", () => {
  test("profile 恒 deny file-write*", () => {
    expect(SEATBELT_PROFILE).toContain("(deny file-write*)")
  })

  test("写允许项 = 精确闭集(新增前缀不改这里就当场红)", () => {
    // 抽出 `(allow file-write* ...)` 块里逐行的 subpath/literal/regex —— 逐 token 全等,
    // 拓宽允许集(多一个 subpath)会立刻打破这条,而不是被「包含某项」放过。
    const block = SEATBELT_PROFILE.split("(allow file-write*")[1]
    expect(block).toBeDefined()
    const tokens = (block ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("(subpath") || l.startsWith("(literal") || l.startsWith("(regex"))
    expect(tokens).toEqual([
      '(subpath (param "WORKDIR"))',
      '(subpath "/private/tmp")',
      '(subpath "/private/var/folders")',
      '(literal "/dev/null")',
      '(literal "/dev/stdout")',
      '(literal "/dev/stderr")',
      '(literal "/dev/tty")',
      '(regex #"^/dev/fd/")',
    ])
  })

  test("WORKDIR 是运行时参数,不在 profile 里写死具体路径", () => {
    expect(SEATBELT_PROFILE).toContain('(subpath (param "WORKDIR"))')
    expect(SEATBELT_PROFILE).not.toMatch(/subpath\s+"\/Users\//)
  })

  test("wrapper 一行透传,argv 用 $@,不解析命令(I4)", () => {
    expect(WRAPPER_SCRIPT).toContain('exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"')
    // 不得出现任何对命令的解析/改写迹象
    expect(WRAPPER_SCRIPT).not.toContain("case ")
    expect(WRAPPER_SCRIPT).not.toContain("eval ")
  })
})
