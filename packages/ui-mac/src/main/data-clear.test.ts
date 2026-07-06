// data-clear 单测(S23/C16)—— 内存 fs,验:分级清单、体积统计、桥链判别(只摘自有链)、
// 守卫根复核(越界拒删)、shared opt-in、单项失败不中断、logs 最后删。

import { describe, expect, test } from "bun:test"
import * as path from "node:path"

import * as DataClear from "./data-clear"

// ── 内存 fs:node = { kind: "file"|"dir"|"link", size?, target?, children? } ────────────
type MemNode =
  | { kind: "file"; size: number }
  | { kind: "dir" }
  | { kind: "link"; target: string }

class MemFs {
  nodes = new Map<string, MemNode>()
  failOn = new Set<string>()

  addFile(p: string, size = 10) {
    this.mkdirs(path.dirname(p))
    this.nodes.set(p, { kind: "file", size })
  }
  addLink(p: string, target: string) {
    this.mkdirs(path.dirname(p))
    this.nodes.set(p, { kind: "link", target })
  }
  mkdirs(p: string) {
    let cur = "/"
    for (const seg of p.split("/").filter(Boolean)) {
      cur = path.join(cur, seg)
      if (!this.nodes.has(cur)) this.nodes.set(cur, { kind: "dir" })
    }
  }
  /** link 解析(单跳,够用):realpath 语义 */
  private resolve(p: string): string | null {
    const node = this.nodes.get(p)
    if (!node) return null
    if (node.kind === "link") {
      const target = path.isAbsolute(node.target) ? node.target : path.resolve(path.dirname(p), node.target)
      return this.nodes.has(target) ? target : null
    }
    return p
  }

  deps(): DataClear.FsDeps {
    return {
      exists: (p) => this.nodes.has(p),
      lstat: (p) => {
        const n = this.nodes.get(p)
        if (!n) return null
        return { isSymlink: n.kind === "link", isDir: n.kind === "dir", size: n.kind === "file" ? n.size : 0 }
      },
      readdir: (p) => {
        const out: string[] = []
        for (const key of this.nodes.keys()) {
          if (path.dirname(key) === p) out.push(path.basename(key))
        }
        return out.sort()
      },
      readlink: (p) => {
        const n = this.nodes.get(p)
        return n?.kind === "link" ? n.target : null
      },
      realpath: (p) => this.resolve(p),
      remove: (p) => {
        if (this.failOn.has(p)) throw new Error(`EACCES: ${p}`)
        for (const key of [...this.nodes.keys()]) {
          if (key === p || key.startsWith(p + "/")) this.nodes.delete(key)
        }
      },
    }
  }
}

const ROOTS: DataClear.ClearRoots = {
  userData: "/ud",
  alphaGlobal: "/home/.alpha",
  opencodeHome: "/home/.opencode",
  engineData: "/home/.local/share/opencode",
}

function seed(): MemFs {
  const fs = new MemFs()
  fs.addFile("/ud/alpha-auth.json", 100)
  fs.addFile("/ud/alpha-byok-keys.json", 50)
  fs.addFile("/ud/alpha-secrets/ALPHA_API_KEY", 20)
  fs.addFile("/ud/alpha-mcp-secrets/feishu/APP_SECRET", 20)
  fs.addFile("/ud/alpha.env", 30)
  fs.addFile("/ud/opencode.settings", 5)
  fs.addFile("/ud/logs/main.log", 1000)
  fs.addFile("/ud/alpha-db-backups/opencode-backup-1.db", 5000)
  fs.addFile("/home/.alpha/installs.json", 40)
  fs.addFile("/home/.alpha/skills/foo/SKILL.md", 10)
  fs.addFile("/home/.local/share/opencode/opencode.db", 9000)
  fs.addFile("/home/.local/share/opencode/auth.json", 60)
  return fs
}

describe("planClear · credentials", () => {
  test("只列凭证白名单;缺席项 present=false;体积按 lstat 递归", () => {
    const fs = seed()
    const plan = DataClear.planClear(fs.deps(), "credentials", ROOTS)
    const ids = plan.items.map((i) => i.id)
    expect(ids).toEqual(["alpha-auth", "alpha-pkce", "byok-keys", "secret-files", "mcp-secrets", "alpha-env", "engine-auth"])
    const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]))
    expect(byId["alpha-pkce"]!.present).toBe(false)
    expect(byId["alpha-auth"]!.bytes).toBe(100)
    expect(byId["secret-files"]!.bytes).toBe(20)
    // 会话 DB / 设置 / 日志 不在凭证级
    expect(plan.items.some((i) => i.path.includes("opencode.db"))).toBe(false)
    expect(plan.bridgeLinks).toEqual([])
  })

  test("engine-auth 标 shared;includeShared=false 时 skipped(不静默)", () => {
    const fs = seed()
    const plan = DataClear.planClear(fs.deps(), "credentials", ROOTS)
    const results = DataClear.executeClear(fs.deps(), plan, ROOTS, { includeShared: false })
    const engineAuth = results.find((r) => r.id === "engine-auth")
    expect(engineAuth?.outcome).toBe("skipped")
    expect(fs.deps().exists("/home/.local/share/opencode/auth.json")).toBe(true)
    // 非 shared 凭证已删
    expect(fs.deps().exists("/ud/alpha-auth.json")).toBe(false)
    expect(fs.deps().exists("/ud/alpha-secrets")).toBe(false)
  })
})

describe("planClear · data(全部)", () => {
  test("userData 逐子项 + ~/.alpha + 引擎数据(shared);logs 排最后;总体积正确", () => {
    const fs = seed()
    const plan = DataClear.planClear(fs.deps(), "data", ROOTS)
    const ids = plan.items.map((i) => i.id)
    expect(ids[ids.length - 1]).toBe("userdata:logs")
    expect(ids).toContain("alpha-global")
    expect(ids).toContain("engine-data")
    const engine = plan.items.find((i) => i.id === "engine-data")!
    expect(engine.shared).toBe(true)
    expect(engine.bytes).toBe(9060)
    expect(plan.totalBytes).toBe(100 + 50 + 20 + 20 + 30 + 5 + 1000 + 5000 + 50 + 9060)
  })

  test("includeShared=false:引擎数据 skipped、其余全删;=true 全删", () => {
    const fs = seed()
    const deps = fs.deps()
    const plan = DataClear.planClear(deps, "data", ROOTS)
    const results = DataClear.executeClear(deps, plan, ROOTS, { includeShared: false })
    expect(results.find((r) => r.id === "engine-data")?.outcome).toBe("skipped")
    expect(deps.exists("/home/.local/share/opencode/opencode.db")).toBe(true)
    expect(deps.exists("/ud/logs")).toBe(false)
    expect(deps.exists("/home/.alpha")).toBe(false)

    const fs2 = seed()
    const deps2 = fs2.deps()
    const plan2 = DataClear.planClear(deps2, "data", ROOTS)
    const results2 = DataClear.executeClear(deps2, plan2, ROOTS, { includeShared: true })
    expect(results2.every((r) => r.outcome === "ok" || r.outcome === "missing")).toBe(true)
    expect(deps2.exists("/home/.local/share/opencode")).toBe(false)
  })
})

describe("findAlphaOwnedLinks · 桥链判别", () => {
  test("kind 级整目录链 + 条目级链均入列;真实目录/外来链/普通文件不碰", () => {
    const fs = seed()
    // kind 级整目录链(REQ-036 形态):~/.opencode/skill → ~/.alpha/skills
    fs.mkdirs("/home/.alpha/skills")
    fs.addLink("/home/.opencode/skill", "/home/.alpha/skills")
    // 真实目录内的条目级链
    fs.mkdirs("/home/.opencode/agent")
    fs.addLink("/home/.opencode/agent/alpha-bot.md", "/home/.alpha/agents/alpha-bot.md")
    fs.addFile("/home/.alpha/agents/alpha-bot.md", 10)
    // 用户自建内容:真实文件 + 指向别处的链
    fs.addFile("/home/.opencode/agent/mine.md", 10)
    fs.addLink("/home/.opencode/agent/other.md", "/somewhere/else.md")
    fs.addFile("/home/.opencode/opencode.jsonc", 10)

    const links = DataClear.findAlphaOwnedLinks(fs.deps(), ROOTS.opencodeHome, ROOTS.alphaGlobal)
    expect(links.sort()).toEqual(["/home/.opencode/agent/alpha-bot.md", "/home/.opencode/skill"])
  })

  test("目标已失效(~/.alpha 已删)仍按字面解析识别自有链", () => {
    const fs = new MemFs()
    fs.mkdirs("/home/.opencode")
    fs.addLink("/home/.opencode/skill", "/home/.alpha/skills") // 目标不存在
    const links = DataClear.findAlphaOwnedLinks(fs.deps(), ROOTS.opencodeHome, ROOTS.alphaGlobal)
    expect(links).toEqual(["/home/.opencode/skill"])
  })

  test("执行时链被换成真实体 → 拒删留痕(用户内容红线)", () => {
    const fs = seed()
    fs.addLink("/home/.opencode/skill", "/home/.alpha/skills")
    fs.mkdirs("/home/.alpha/skills")
    const deps = fs.deps()
    const plan = DataClear.planClear(deps, "data", ROOTS)
    expect(plan.bridgeLinks).toEqual(["/home/.opencode/skill"])
    // 计划后、执行前:链被换成真实目录(TOCTOU)
    fs.nodes.set("/home/.opencode/skill", { kind: "dir" })
    fs.addFile("/home/.opencode/skill/user-own.md", 10)
    const results = DataClear.executeClear(deps, plan, ROOTS, { includeShared: true })
    const bridge = results.find((r) => r.id === "bridge:skill")
    expect(bridge?.outcome).toBe("failed")
    expect(deps.exists("/home/.opencode/skill/user-own.md")).toBe(true)
  })
})

describe("executeClear · 守卫与失败语义", () => {
  test("realpath 逃逸守卫根 → 拒删", () => {
    const fs = seed()
    // /ud/evil 是指向守卫根外的目录链 —— lstat 是链 → 只删链本身(安全);
    // 构造非链逃逸:直接把 item.path 的 realpath 指向根外(用 override deps 模拟挂载点/firmlink)
    const deps = fs.deps()
    fs.addFile("/outside/precious.txt", 10)
    fs.mkdirs("/ud/mount")
    const evil: DataClear.FsDeps = {
      ...deps,
      realpath: (p) => (p === "/ud/mount" ? "/outside" : deps.realpath(p)),
    }
    const plan = DataClear.planClear(evil, "data", ROOTS)
    const results = DataClear.executeClear(evil, plan, ROOTS, { includeShared: true })
    const mount = results.find((r) => r.id === "userdata:mount")
    expect(mount?.outcome).toBe("failed")
    expect(mount?.error).toContain("escapes guard roots")
    expect(deps.exists("/outside/precious.txt")).toBe(true)
  })

  test("单项 EACCES 失败不中断批次,逐项结果如实", () => {
    const fs = seed()
    fs.failOn.add("/ud/alpha.env")
    const deps = fs.deps()
    const plan = DataClear.planClear(deps, "credentials", ROOTS)
    const results = DataClear.executeClear(deps, plan, ROOTS, { includeShared: true })
    expect(results.find((r) => r.id === "alpha-env")?.outcome).toBe("failed")
    expect(results.find((r) => r.id === "alpha-auth")?.outcome).toBe("ok")
    expect(results.find((r) => r.id === "engine-auth")?.outcome).toBe("ok")
  })

  test("缺席项记 missing,不算失败", () => {
    const fs = new MemFs()
    fs.mkdirs("/ud")
    const deps = fs.deps()
    const plan = DataClear.planClear(deps, "credentials", ROOTS)
    const results = DataClear.executeClear(deps, plan, ROOTS, { includeShared: true })
    expect(results.every((r) => r.outcome === "missing")).toBe(true)
  })
})

describe("辅助", () => {
  test("engineDataDir:XDG 优先,回退 ~/.local/share(与 db-safety 同规则)", () => {
    expect(DataClear.engineDataDir({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg/opencode")
    expect(DataClear.engineDataDir({}, "/home/u")).toBe("/home/u/.local/share/opencode")
  })

  test("sizeOf 不跟随 symlink(链计 0,不重复计目标)", () => {
    const fs = new MemFs()
    fs.addFile("/a/big.bin", 1000)
    fs.addLink("/b/link-to-a", "/a")
    expect(DataClear.sizeOf(fs.deps(), "/b")).toBe(0)
  })

  test("formatBytes 人类可读", () => {
    expect(DataClear.formatBytes(500)).toBe("500 B")
    expect(DataClear.formatBytes(2048)).toBe("2 KB")
    expect(DataClear.formatBytes(5 * 1024 * 1024)).toBe("5 MB")
    expect(DataClear.formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB")
  })
})
