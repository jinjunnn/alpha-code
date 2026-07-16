// Unit tests for MCP connector secret file-ification (REQ-018 T5). Real temp userData dir; asserts
// secrets land 0600 in their own namespace, config carries only {file:} refs (no plaintext), and
// uninstall revokes the dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  claimMcpSecretVersionDir,
  resolveMcpRefPath,
  collectMcpFileRefPaths,
  fileifyMcpSecretsVersioned,
  gcMcpSecretVersionsLocked,
  isFileRef,
  mcpSecretRef,
  mcpSecretVersionedRef,
  newMcpSecretVersionId,
  pathIdentity,
  removeMcpSecretVersionDir,
  removeMcpServerSecrets,
  substituteMcpSecretRefsPure,
  writeMcpSecret,
  writeMcpSecretVersioned,
} from "./alpha-mcp-secrets"

let userData = ""
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-mcpsec-"))
})
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

const secretFile = (server: string, v: string) => path.join(userData, "alpha-mcp-secrets", server, v)

describe("writeMcpSecret", () => {
  test("writes 0600 and returns a {file:} ref to the abs path", () => {
    const r = writeMcpSecret(userData, "github", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_realtoken")
    expect(r.ok).toBe(true)
    expect(r.ok && r.ref).toBe(`{file:${secretFile("github", "GITHUB_PERSONAL_ACCESS_TOKEN")}}`)
    expect(fs.readFileSync(secretFile("github", "GITHUB_PERSONAL_ACCESS_TOKEN"), "utf8")).toBe("ghp_realtoken")
    expect(fs.statSync(secretFile("github", "GITHUB_PERSONAL_ACCESS_TOKEN")).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(secretFile("github", "x"))).mode & 0o777).toBe(0o700)
  })

  test("rejects unsafe server / var / empty value", () => {
    expect(writeMcpSecret(userData, "../evil", "V", "x").ok).toBe(false)
    expect(writeMcpSecret(userData, "srv", "1BAD", "x").ok).toBe(false)
    expect(writeMcpSecret(userData, "srv", "OK", "").ok).toBe(false)
  })

  test("overwrite keeps 0600", () => {
    writeMcpSecret(userData, "yuque", "YUQUE_TOKEN", "old")
    writeMcpSecret(userData, "yuque", "YUQUE_TOKEN", "new")
    expect(fs.readFileSync(secretFile("yuque", "YUQUE_TOKEN"), "utf8")).toBe("new")
    expect(fs.statSync(secretFile("yuque", "YUQUE_TOKEN")).mode & 0o777).toBe(0o600)
  })
})

describe("isFileRef / mcpSecretRef", () => {
  test("recognizes file refs", () => {
    expect(isFileRef("{file:/a/b}")).toBe(true)
    expect(isFileRef("ghp_plain")).toBe(false)
    expect(mcpSecretRef(userData, "s", "V")).toBe(`{file:${secretFile("s", "V")}}`)
  })
})

// ── #378(Codex 裁决 Q1):版本化布局 —— 只增不覆盖、硬化写、纯替换、引用收集、锁内 GC ──────────

const verFile = (server: string, verId: string, v: string) => path.join(userData, "alpha-mcp-secrets", server, verId, v)
const strMap = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a string map")
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]))
}

describe("writeMcpSecretVersioned — 硬化写(tmp→rename、0600/0700、lstat 圈禁)", () => {
  test("writes 0600 under the version dir and returns the matching ref", () => {
    const vid = newMcpSecretVersionId()
    const r = writeMcpSecretVersioned(userData, "github", vid, "TOKEN", "ghp_realtoken")
    expect(r.ok).toBe(true)
    expect(r.ok && r.ref).toBe(mcpSecretVersionedRef(userData, "github", vid, "TOKEN"))
    expect(fs.readFileSync(verFile("github", vid, "TOKEN"), "utf8")).toBe("ghp_realtoken")
    expect(fs.statSync(verFile("github", vid, "TOKEN")).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(verFile("github", vid, "TOKEN"))).mode & 0o777).toBe(0o700)
  })

  test("rejects unsafe server / var / verId / empty value", () => {
    const vid = newMcpSecretVersionId()
    expect(writeMcpSecretVersioned(userData, "../evil", vid, "V", "x").ok).toBe(false)
    expect(writeMcpSecretVersioned(userData, "srv", vid, "1BAD", "x").ok).toBe(false)
    expect(writeMcpSecretVersioned(userData, "srv", vid, "OK", "").ok).toBe(false)
    expect(writeMcpSecretVersioned(userData, "srv", "not-a-verid", "OK", "x").ok).toBe(false)
    expect(writeMcpSecretVersioned(userData, "srv", "v-XYZ", "OK", "x").ok).toBe(false) // 非 hex
  })

  test("symlinked server dir is refused (lstat confinement),且拒绝前零圈禁外副作用(链接目标权限不被 chmod)", () => {
    const outside = path.join(userData, "outside")
    fs.mkdirSync(outside, { recursive: true, mode: 0o755 })
    fs.chmodSync(outside, 0o755)
    fs.mkdirSync(path.join(userData, "alpha-mcp-secrets"), { recursive: true })
    fs.symlinkSync(outside, path.join(userData, "alpha-mcp-secrets", "linked"))
    const r = writeMcpSecretVersioned(userData, "linked", newMcpSecretVersionId(), "V", "x")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("symlink")
    // r1 Major 回归锁:chmod 追链 —— 拒绝路径绝不改链接目标目录的权限
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755)
    expect(fs.readdirSync(outside)).toEqual([]) // 也没有写入任何文件
  })

  test("claimMcpSecretVersionDir:排他认领 —— 同 verId 二次认领 exists,绝不复用(append-only 最终强制)", () => {
    const vid = newMcpSecretVersionId()
    expect(claimMcpSecretVersionDir(userData, "s", vid).ok).toBe(true)
    const again = claimMcpSecretVersionDir(userData, "s", vid)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.exists).toBe(true)
    expect(fs.statSync(path.join(userData, "alpha-mcp-secrets", "s", vid)).mode & 0o777).toBe(0o700)
    // 认领 + 写:既有版本内容不被后续安装触碰
    writeMcpSecretVersioned(userData, "s", vid, "TOK", "v1")
    const vid2 = newMcpSecretVersionId()
    expect(claimMcpSecretVersionDir(userData, "s", vid2).ok).toBe(true)
    writeMcpSecretVersioned(userData, "s", vid2, "TOK", "v2")
    expect(fs.readFileSync(verFile("s", vid, "TOK"), "utf8")).toBe("v1")
  })

  test("不同版本互不接触(只增不覆盖)", () => {
    const v1 = newMcpSecretVersionId()
    const v2 = newMcpSecretVersionId()
    writeMcpSecretVersioned(userData, "s", v1, "TOK", "old")
    writeMcpSecretVersioned(userData, "s", v2, "TOK", "new")
    expect(fs.readFileSync(verFile("s", v1, "TOK"), "utf8")).toBe("old")
    expect(fs.readFileSync(verFile("s", v2, "TOK"), "utf8")).toBe("new")
    // removeMcpSecretVersionDir 只删指定版本
    expect(removeMcpSecretVersionDir(userData, "s", v2).ok).toBe(true)
    expect(fs.existsSync(verFile("s", v1, "TOK"))).toBe(true)
    expect(fs.existsSync(path.join(userData, "alpha-mcp-secrets", "s", v2))).toBe(false)
  })
})

describe("substituteMcpSecretRefsPure — 零写盘的引用替换", () => {
  test("environment 键匹配 + headers 内嵌子串;granted 未落位进 skipped", () => {
    const config: Record<string, unknown> = {
      type: "remote",
      url: "https://x/sse",
      environment: { TOK: "real-tok", KEEP: "plain" },
      headers: { Authorization: "Bearer real-tok" },
    }
    const r = substituteMcpSecretRefsPure(config, { TOK: "real-tok", ORPHAN: "never-lands" }, (v) => `{file:/refs/${v}}`)
    expect(r.substituted).toEqual({ TOK: "{file:/refs/TOK}" })
    expect(r.skipped).toEqual(["ORPHAN"])
    expect(strMap(config.environment).TOK).toBe("{file:/refs/TOK}")
    expect(strMap(config.environment).KEEP).toBe("plain")
    expect(strMap(config.headers).Authorization).toBe("Bearer {file:/refs/TOK}")
    expect(JSON.stringify(config)).not.toContain("real-tok")
    expect(fs.readdirSync(userData)).toEqual([]) // 零写盘
  })

  test("空值 skipped;无 env/headers 不崩", () => {
    const config: Record<string, unknown> = { type: "local", command: ["x"] }
    const r = substituteMcpSecretRefsPure(config, { EMPTY: "", ABSENT: "v" }, (v) => `{file:/r/${v}}`)
    expect(r.skipped.sort()).toEqual(["ABSENT", "EMPTY"])
  })
})

describe("resolveMcpRefPath — 引擎解析语义(r5)", () => {
  test("~/ 展开为 home;相对按 config 目录;绝对规范化", () => {
    expect(resolveMcpRefPath("~/secrets/TOK", "/cfg")).toBe(path.join(os.homedir(), "secrets", "TOK"))
    expect(resolveMcpRefPath("alpha-mcp-secrets/s/v-aa/TOK", "/cfg/dir")).toBe("/cfg/dir/alpha-mcp-secrets/s/v-aa/TOK")
    expect(resolveMcpRefPath("/a/./b/TOK", "/cfg")).toBe("/a/b/TOK")
  })
})

describe("collectMcpFileRefPaths", () => {
  test("深收集 env 精确值与 headers 内嵌引用", () => {
    const leaf = {
      environment: { A: "{file:/p/a}", B: "plain" },
      headers: { Authorization: "Bearer {file:/p/b} suffix" },
      nested: [{ deep: "{file:/p/c}" }],
    }
    expect(collectMcpFileRefPaths(leaf).sort()).toEqual(["/p/a", "/p/b", "/p/c"])
    expect(collectMcpFileRefPaths(undefined)).toEqual([])
  })
})

describe("gcMcpSecretVersionsLocked — 引用对账 + 宽限", () => {
  const old = new Date(Date.now() - 3600_000) // 1h 前 = 过宽限
  const age = (p: string) => fs.utimesSync(p, old, old)

  test("未引用且过宽限的版本目录/flat 文件/.bak 快照收走;被引用与宽限内保留;未知形态零接触", () => {
    const vKeep = newMcpSecretVersionId()
    const vDrop = newMcpSecretVersionId()
    const vFresh = newMcpSecretVersionId()
    writeMcpSecretVersioned(userData, "s", vKeep, "TOK", "keep")
    writeMcpSecretVersioned(userData, "s", vDrop, "TOK", "drop")
    writeMcpSecretVersioned(userData, "s", vFresh, "TOK", "fresh")
    writeMcpSecret(userData, "s", "LEGACY_FLAT", "legacy") // flat 布局残留
    const sDir = path.join(userData, "alpha-mcp-secrets", "s")
    fs.mkdirSync(`${sDir}.bak-deadbeef`, { recursive: true }) // 历史快照 = 兄弟级(r3/r4)
    fs.writeFileSync(path.join(sDir, "unknown.file!"), "x") // 未知名(不匹配 SAFE_VAR/版本)
    for (const p of [path.join(sDir, vKeep), path.join(sDir, vDrop), path.join(sDir, "LEGACY_FLAT"), `${sDir}.bak-deadbeef`]) age(p)
    const referenced = [verFile("s", vKeep, "TOK")]
    const r = gcMcpSecretVersionsLocked(userData, "s", referenced)
    expect(r.warnings).toEqual([])
    expect(fs.existsSync(verFile("s", vKeep, "TOK"))).toBe(true) // 被引用
    expect(fs.existsSync(path.join(sDir, vDrop))).toBe(false) // 未引用 + 过宽限 → 收
    expect(fs.existsSync(verFile("s", vFresh, "TOK"))).toBe(true) // 宽限内(在途安装保护)
    expect(fs.existsSync(path.join(sDir, "LEGACY_FLAT"))).toBe(false) // flat 残留 → 收
    expect(fs.existsSync(`${sDir}.bak-deadbeef`)).toBe(false) // 兄弟级历史快照残留 → 收
    expect(fs.existsSync(path.join(sDir, "unknown.file!"))).toBe(true) // 未知形态零接触
  })

  test("r3:兄弟级 <server>.bak-* 历史快照 —— GC 过宽限收、卸载连带吊销", () => {
    const base = path.join(userData, "alpha-mcp-secrets")
    const bak = path.join(base, "s.bak-deadbeef")
    fs.mkdirSync(bak, { recursive: true })
    fs.writeFileSync(path.join(bak, "TOK"), "old-secret")
    const vid = newMcpSecretVersionId()
    writeMcpSecretVersioned(userData, "s", vid, "TOK", "cur")
    // 宽限内不收(fail-safe)
    gcMcpSecretVersionsLocked(userData, "s", [verFile("s", vid, "TOK")])
    expect(fs.existsSync(bak)).toBe(true)
    // 过宽限收(备份从不被 config 引用)
    fs.utimesSync(bak, old, old)
    const r = gcMcpSecretVersionsLocked(userData, "s", [verFile("s", vid, "TOK")])
    expect(r.warnings).toEqual([])
    expect(fs.existsSync(bak)).toBe(false)
    expect(fs.existsSync(verFile("s", vid, "TOK"))).toBe(true) // 被引用版本不受影响
    // 卸载吊销覆盖兄弟级
    const bak2 = path.join(base, "s.bak-cafebabe")
    fs.mkdirSync(bak2, { recursive: true })
    // r4:恰巧叫 <server>.bak-live 的另一合法 server 绝不能被前缀误伤(后缀须恰 .bak-<hex8>);
    // r8:恰巧叫 <server>.bak-<hex8> 的**在册 server** 由活体排除保护(isLiveServer)。
    const decoy = path.join(base, "s.bak-live")
    const vidDecoy = newMcpSecretVersionId()
    writeMcpSecretVersioned(userData, "s.bak-live", vidDecoy, "TOK", "decoy-live")
    const liveHex = path.join(base, "s.bak-feedf00d")
    const vidLiveHex = newMcpSecretVersionId()
    writeMcpSecretVersioned(userData, "s.bak-feedf00d", vidLiveHex, "TOK", "live-hex-server")
    removeMcpServerSecrets(userData, "s", (cand) => cand === "s.bak-feedf00d") // 在册集只含活体
    expect(fs.existsSync(bak2)).toBe(false)
    expect(fs.existsSync(path.join(base, "s"))).toBe(false)
    expect(fs.readFileSync(path.join(decoy, vidDecoy, "TOK"), "utf8")).toBe("decoy-live") // 后缀不匹配零接触
    expect(fs.readFileSync(path.join(liveHex, vidLiveHex, "TOK"), "utf8")).toBe("live-hex-server") // 在册活体零接触
  })

  test("r13:引用经 symlink 别名到达版本文件 → realpath 身份对账保留(词法不等也不删)", () => {
    const vid = newMcpSecretVersionId()
    writeMcpSecretVersioned(userData, "s", vid, "TOK", "v")
    const old2 = new Date(Date.now() - 3600_000)
    fs.utimesSync(path.join(userData, "alpha-mcp-secrets", "s", vid), old2, old2)
    // 别名链:引用指向 symlink,symlink 指向真实版本文件
    const aliasDir = path.join(userData, "alias")
    fs.mkdirSync(aliasDir, { recursive: true })
    const alias = path.join(aliasDir, "TOK-link")
    fs.symlinkSync(verFile("s", vid, "TOK"), alias)
    const r = gcMcpSecretVersionsLocked(userData, "s", [alias])
    expect(r.removed).toEqual([]) // realpath 命中 → 保留
    expect(fs.existsSync(verFile("s", vid, "TOK"))).toBe(true)
  })

  test("r15:引用路径身份不可判(EACCES)→ 本轮整体跳过不删(fail-closed),恢复后照常收", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return // root 无视权限,场景不可构造
    const vid = newMcpSecretVersionId()
    writeMcpSecretVersioned(userData, "s", vid, "TOK", "v")
    age(path.join(userData, "alpha-mcp-secrets", "s", vid)) // 未引用 + 过宽限 = 正常应收
    const lockedDir = path.join(userData, "locked")
    fs.mkdirSync(lockedDir, { recursive: true })
    const unresolvable = path.join(lockedDir, "ref")
    fs.writeFileSync(unresolvable, "x")
    fs.chmodSync(lockedDir, 0o000)
    try {
      const r = gcMcpSecretVersionsLocked(userData, "s", [unresolvable])
      expect(r.removed).toEqual([]) // fail-open 旧行为会把过宽限版本收走
      expect(r.warnings.join(" ")).toContain("unresolvable")
      expect(fs.existsSync(verFile("s", vid, "TOK"))).toBe(true)
    } finally {
      fs.chmodSync(lockedDir, 0o700)
    }
    // 权限恢复后引用可判(且不指向版本文件)→ 正常收
    const r2 = gcMcpSecretVersionsLocked(userData, "s", [unresolvable])
    expect(r2.warnings).toEqual([])
    expect(fs.existsSync(verFile("s", vid, "TOK"))).toBe(false)
  })

  test("目录缺席 = 无事;版本目录内任一文件被引用即整目录保留", () => {
    expect(gcMcpSecretVersionsLocked(userData, "absent", []).removed).toEqual([])
    const vid = newMcpSecretVersionId()
    writeMcpSecretVersioned(userData, "s", vid, "A", "1")
    writeMcpSecretVersioned(userData, "s", vid, "B", "2")
    age(path.join(userData, "alpha-mcp-secrets", "s", vid))
    const r = gcMcpSecretVersionsLocked(userData, "s", [verFile("s", vid, "B")])
    expect(r.removed).toEqual([])
    expect(fs.existsSync(verFile("s", vid, "A"))).toBe(true)
  })
})

describe("pathIdentity — 文件系统身份(r15:缺席可判,其余 fail-closed)", () => {
  test("存在:词法 + realpath 双形态 certain;symlink 别名两侧交集命中", () => {
    const real = path.join(userData, "real.txt")
    fs.writeFileSync(real, "x")
    const alias = path.join(userData, "alias.txt")
    fs.symlinkSync(real, alias)
    const a = pathIdentity(alias)
    expect(a.certain).toBe(true)
    expect(a.forms).toContain(path.resolve(alias))
    const r = pathIdentity(real)
    expect(r.certain).toBe(true)
    expect(a.forms.some((f) => r.forms.includes(f))).toBe(true) // realpath 形态交集
  })

  test("缺席(ENOENT/ENOTDIR)= certain,词法即完整身份", () => {
    const missing = pathIdentity(path.join(userData, "no", "such", "file"))
    expect(missing.certain).toBe(true)
    expect(missing.forms).toEqual([path.join(userData, "no", "such", "file")])
    fs.writeFileSync(path.join(userData, "plainfile"), "x")
    const notdir = pathIdentity(path.join(userData, "plainfile", "child")) // ENOTDIR
    expect(notdir.certain).toBe(true)
  })

  test("非缺席类失败(EACCES)= certain=false(调用侧 fail-closed)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    const lockedDir = path.join(userData, "locked2")
    fs.mkdirSync(lockedDir, { recursive: true })
    fs.writeFileSync(path.join(lockedDir, "f"), "x")
    fs.chmodSync(lockedDir, 0o000)
    try {
      expect(pathIdentity(path.join(lockedDir, "f")).certain).toBe(false)
    } finally {
      fs.chmodSync(lockedDir, 0o700)
    }
  })
})

describe("fileifyMcpSecretsVersioned — 未策展通道(flat 语义,版本化落盘)", () => {
  test("moves environment secrets to versioned files, replaces with refs, leaves non-secret env alone", () => {
    const vid = newMcpSecretVersionId()
    const config: Record<string, unknown> = {
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      environment: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret", npm_config_registry: "https://registry.npmmirror.com" },
    }
    const r = fileifyMcpSecretsVersioned(userData, "github", config, ["GITHUB_PERSONAL_ACCESS_TOKEN"], vid)
    expect(r.fileified).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"])
    const env = strMap(config.environment)
    expect(isFileRef(env.GITHUB_PERSONAL_ACCESS_TOKEN)).toBe(true)
    expect(JSON.stringify(config)).not.toContain("ghp_secret")
    expect(fs.readFileSync(verFile("github", vid, "GITHUB_PERSONAL_ACCESS_TOKEN"), "utf8")).toBe("ghp_secret")
  })

  test("already-fileref / 空值 = 良性跳过(不入 failed,不改 config;r8 fail-closed 语义)", () => {
    const vid = newMcpSecretVersionId()
    const ref = mcpSecretRef(userData, "s", "TOK")
    const config: Record<string, unknown> = { type: "local", command: ["x"], environment: { TOK: ref } }
    const r = fileifyMcpSecretsVersioned(userData, "s", config, ["TOK", "ABSENT"], vid)
    expect(r.failed).toEqual([]) // 无明文风险 → 不阻断
    expect(r.fileified).toEqual([])
    expect(strMap(config.environment).TOK).toBe(ref)
  })
})

describe("removeMcpServerSecrets", () => {
  test("removes the connector's whole secret dir (全部版本 + flat)", () => {
    writeMcpSecret(userData, "github", "GITHUB_PERSONAL_ACCESS_TOKEN", "t")
    const vid = newMcpSecretVersionId()
    writeMcpSecretVersioned(userData, "github", vid, "TOKEN", "v")
    removeMcpServerSecrets(userData, "github")
    expect(fs.existsSync(path.join(userData, "alpha-mcp-secrets", "github"))).toBe(false)
  })
})
