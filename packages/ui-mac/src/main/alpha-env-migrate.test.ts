// REQ-098 单测:旧 ~/.alpha 单根 → 环境根的只读导入。AC#3(幂等 + crash 可重试 + 用户文件不动)、
// AC#4(回滚可读 + 再升级不重复复制/不丢状态)、AC#5(空格/Unicode/Windows 盘符路径)、
// 交付⑤(外域 MCP secret 绝对路径再派生,绝不跨环境引用)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse } from "jsonc-parser"
import {
  ENV_MIGRATION_RECEIPT_FILE,
  ENV_ROLLBACK_MARKER_FILE,
  isPathUnder,
  readEnvMigrationReceipt,
  rewriteUnderRoot,
  runEnvMigration,
  transformAlphaJsoncForEnv,
  transformInstallsJsonForEnv,
} from "./alpha-env-migrate"
import { readLedger } from "./alpha-installs"

let base = ""
let sourceRoot = ""
let targetRoot = ""
let userDataPath = ""
let foreignUserData = ""

beforeEach(() => {
  // AC#5:全链路 fixture 都带空格 + Unicode
  base = fs.mkdtempSync(path.join(os.tmpdir(), "alpha env 迁移-"))
  sourceRoot = path.join(base, "旧 .alpha 布局")
  targetRoot = path.join(base, "env", "prod 环境")
  userDataPath = path.join(base, "userData 目标 β")
  foreignUserData = path.join(base, "userData 旧渠道 α")
  fs.mkdirSync(sourceRoot, { recursive: true })
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function buildLegacyLayout() {
  // 外域 secret 文件(另一环境的 userData)
  fs.mkdirSync(path.join(foreignUserData, "alpha-mcp-secrets", "github"), { recursive: true })
  fs.writeFileSync(path.join(foreignUserData, "alpha-mcp-secrets", "github", "GITHUB_TOKEN"), "tok-123")
  fs.mkdirSync(path.join(foreignUserData, "alpha-mcp-secrets", "wiki"), { recursive: true })
  fs.writeFileSync(path.join(foreignUserData, "alpha-mcp-secrets", "wiki", "AUTH"), "hdr-tok")

  const jsonc = `{
  // 用户注释:导入必须保留
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "gh-mcp@1.0.0"],
      "environment": {
        "GITHUB_TOKEN": "{file:${path.join(foreignUserData, "alpha-mcp-secrets", "github", "GITHUB_TOKEN")}}",
        "PLAIN": "not-a-secret"
      }
    },
    "wiki": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer {file:${path.join(foreignUserData, "alpha-mcp-secrets", "wiki", "AUTH")}}" }
    },
    "dead": {
      "type": "local",
      "command": ["npx", "dead-mcp"],
      "environment": { "TOKEN": "{file:${path.join(foreignUserData, "alpha-mcp-secrets", "gone", "MISSING")}}" }
    }
  },
  "plugin": ["${path.join(sourceRoot, "plugins", "vendored", "plugin.js")}", "npm-pkg@1.0.0"],
  "skills": { "paths": ["${path.join(sourceRoot, "skills")}"] }
}
`
  fs.writeFileSync(path.join(sourceRoot, "alpha.jsonc"), jsonc)

  const installs = {
    v: 1,
    receipts: [
      {
        id: "cat:my-skill",
        name: "my-skill",
        type: "skill",
        scope: "global",
        origin: "catalog",
        installedAt: "2026-07-01T00:00:00.000Z",
        files: [path.join(sourceRoot, "skills", "my-skill")],
      },
    ],
  }
  fs.writeFileSync(path.join(sourceRoot, "installs.json"), JSON.stringify(installs, null, 2) + "\n")

  fs.mkdirSync(path.join(sourceRoot, "skills", "my-skill"), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n技能内容")
  fs.mkdirSync(path.join(sourceRoot, "agents"), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, "agents", "代理 agent.md"), "# agent")
  fs.mkdirSync(path.join(sourceRoot, "plugins", "vendored"), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, "plugins", "vendored", "plugin.js"), "export default {}")
  // symlink 原样保留(不解引用)
  fs.symlinkSync(path.join(sourceRoot, "plugins", "vendored", "plugin.js"), path.join(sourceRoot, "plugins", "链接.js"))
}

/** source 树快照(相对路径 → 文件内容/链接目标),用于「源绝不被改动」断言。 */
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e)
      const st = fs.lstatSync(p)
      const rel = path.relative(root, p)
      if (st.isSymbolicLink()) out.set(rel, `link:${fs.readlinkSync(p)}`)
      else if (st.isDirectory()) walk(p)
      else out.set(rel, fs.readFileSync(p, "utf8"))
    }
  }
  walk(root)
  return out
}

const runOpts = () => ({
  sourceRoot,
  targetRoot,
  userDataPath,
  environment: "prod",
  appVersion: "1.2.3",
  now: () => new Date("2026-07-12T08:00:00.000Z"),
})

describe("runEnvMigration — 首次导入", () => {
  test("五件套导入 + receipt 版本化落盘 + 旧根 rollback 标记", () => {
    buildLegacyLayout()
    const outcome = runEnvMigration(runOpts())
    expect(outcome.status).toBe("migrated")
    if (outcome.status !== "migrated") return

    // receipt:版本化 + 源清单 + 逐项结果
    expect(outcome.receipt.v).toBe(1)
    expect(outcome.receipt.appVersion).toBe("1.2.3")
    expect(outcome.receipt.migratedAt).toBe("2026-07-12T08:00:00.000Z")
    const byName = Object.fromEntries(outcome.receipt.results.map((r) => [r.name, r.outcome]))
    expect(byName).toEqual({
      "alpha.jsonc": "imported",
      "installs.json": "imported",
      skills: "imported",
      agents: "imported",
      plugins: "imported",
    })
    const onDisk = readEnvMigrationReceipt(targetRoot)
    expect(onDisk?.migratedAt).toBe("2026-07-12T08:00:00.000Z")

    // 内容就位(Unicode 文件名 + symlink 原样)
    expect(fs.readFileSync(path.join(targetRoot, "skills", "my-skill", "SKILL.md"), "utf8")).toContain("技能内容")
    expect(fs.existsSync(path.join(targetRoot, "agents", "代理 agent.md"))).toBe(true)
    const link = path.join(targetRoot, "plugins", "链接.js")
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(link)).toBe(path.join(sourceRoot, "plugins", "vendored", "plugin.js"))

    // 旧根 rollback 标记(additive 新文件)
    const marker = JSON.parse(fs.readFileSync(path.join(sourceRoot, ENV_ROLLBACK_MARKER_FILE), "utf8"))
    expect(marker.v).toBe(1)
    expect(marker.environments.prod.targetRoot).toBe(targetRoot)
  })

  test("导入的 alpha.jsonc:旧根路径改写进环境根 + 注释保留 + 非路径条目不动", () => {
    buildLegacyLayout()
    runEnvMigration(runOpts())
    const text = fs.readFileSync(path.join(targetRoot, "alpha.jsonc"), "utf8")
    expect(text).toContain("用户注释:导入必须保留")
    const parsed = parse(text) as { plugin: string[]; skills: { paths: string[] } }
    expect(parsed.plugin[0]).toBe(path.join(targetRoot, "plugins", "vendored", "plugin.js"))
    expect(parsed.plugin[1]).toBe("npm-pkg@1.0.0")
    expect(parsed.skills.paths).toEqual([path.join(targetRoot, "skills")])
    // 源文件本体没被改(仍指旧根)
    const src = parse(fs.readFileSync(path.join(sourceRoot, "alpha.jsonc"), "utf8")) as { plugin: string[] }
    expect(src.plugin[0]).toBe(path.join(sourceRoot, "plugins", "vendored", "plugin.js"))
  })

  test("交付⑤:外域 secret 引用再派生进当前 userData;不可读的整键摘除(fail-closed)", () => {
    buildLegacyLayout()
    const outcome = runEnvMigration(runOpts())
    expect(outcome.status).toBe("migrated")
    if (outcome.status !== "migrated") return
    const parsed = parse(fs.readFileSync(path.join(targetRoot, "alpha.jsonc"), "utf8")) as {
      mcp: Record<string, { environment?: Record<string, string>; headers?: Record<string, string> }>
    }
    // environment var:新 ref 指向当前 userData,值已复制
    const ghRef = parsed.mcp.github.environment!.GITHUB_TOKEN
    const expectedGh = path.join(userDataPath, "alpha-mcp-secrets", "github", "GITHUB_TOKEN")
    expect(ghRef).toBe(`{file:${expectedGh}}`)
    expect(fs.readFileSync(expectedGh, "utf8")).toBe("tok-123")
    expect((fs.statSync(expectedGh).mode & 0o777)).toBe(0o600)
    // 非 secret 值不动
    expect(parsed.mcp.github.environment!.PLAIN).toBe("not-a-secret")
    // header 内嵌 ref:同样再派生(HDR_ 前缀命名)
    const auth = parsed.mcp.wiki.headers!.Authorization
    const expectedHdr = path.join(userDataPath, "alpha-mcp-secrets", "wiki", "HDR_Authorization")
    expect(auth).toBe(`Bearer {file:${expectedHdr}}`)
    expect(fs.readFileSync(expectedHdr, "utf8")).toBe("hdr-tok")
    // 不可读外域引用:整键摘除,receipt 记账
    expect(parsed.mcp.dead.environment?.TOKEN).toBeUndefined()
    expect(outcome.receipt.secretRefs.rederived).toEqual([
      { server: "github", key: "environment.GITHUB_TOKEN" },
      { server: "wiki", key: "headers.Authorization" },
    ])
    expect(outcome.receipt.secretRefs.dropped).toEqual([
      { server: "dead", key: "environment.TOKEN", reason: "foreign secret file unreadable" },
    ])
    // 导入结果里不残留任何指向外域 userData 的引用
    const text = fs.readFileSync(path.join(targetRoot, "alpha.jsonc"), "utf8")
    expect(text).not.toContain(foreignUserData)
  })

  test("导入的 installs.json:receipts.files[] 改写进环境根,账本可读", () => {
    buildLegacyLayout()
    runEnvMigration(runOpts())
    const ledger = readLedger(targetRoot)
    expect(ledger.warning).toBeUndefined()
    expect(ledger.receipts).toHaveLength(1)
    expect(ledger.receipts[0]!.files).toEqual([path.join(targetRoot, "skills", "my-skill")])
  })

  test("空旧根(全 absent)→ 也落 receipt(此后不再扫源),不写 rollback 标记", () => {
    const outcome = runEnvMigration(runOpts())
    expect(outcome.status).toBe("migrated")
    if (outcome.status !== "migrated") return
    expect(outcome.receipt.results.every((r) => r.outcome === "absent")).toBe(true)
    expect(fs.existsSync(path.join(sourceRoot, ENV_ROLLBACK_MARKER_FILE))).toBe(false)
  })

  test("同根(dev/覆盖态)→ skipped-same-root,不产生任何文件", () => {
    buildLegacyLayout()
    const outcome = runEnvMigration({ ...runOpts(), targetRoot: sourceRoot })
    expect(outcome.status).toBe("skipped-same-root")
    expect(fs.existsSync(path.join(sourceRoot, ENV_MIGRATION_RECEIPT_FILE))).toBe(false)
  })
})

describe("AC#3 幂等 + crash 可重试 + 源不动", () => {
  test("执行两次结果相同:第二次 already-migrated,目标与 receipt 字节不变", () => {
    buildLegacyLayout()
    const first = runEnvMigration(runOpts())
    expect(first.status).toBe("migrated")
    const receiptBytes = fs.readFileSync(path.join(targetRoot, ENV_MIGRATION_RECEIPT_FILE), "utf8")
    const targetSnap = snapshotTree(targetRoot)

    const second = runEnvMigration(runOpts())
    expect(second.status).toBe("already-migrated")
    expect(fs.readFileSync(path.join(targetRoot, ENV_MIGRATION_RECEIPT_FILE), "utf8")).toBe(receiptBytes)
    expect(snapshotTree(targetRoot)).toEqual(targetSnap)
  })

  test("源绝不被修改/删除:导入前后源树逐字节一致(唯一新增 = rollback 标记)", () => {
    buildLegacyLayout()
    const before = snapshotTree(sourceRoot)
    runEnvMigration(runOpts())
    const after = snapshotTree(sourceRoot)
    after.delete(ENV_ROLLBACK_MARKER_FILE) // 唯一允许的 additive 新文件
    expect(after).toEqual(before)
  })

  test("crash 重试①:半成品 tmp + 部分条目已 rename 就位 → 重跑补齐,tmp 清除,不覆盖已就位内容", () => {
    buildLegacyLayout()
    // 模拟上次运行:skills 已完整 rename 就位(并带本地改动指纹),agents 只留半成品 tmp,无 receipt
    fs.mkdirSync(path.join(targetRoot, "skills", "my-skill"), { recursive: true })
    fs.writeFileSync(path.join(targetRoot, "skills", "my-skill", "SKILL.md"), "已就位的环境内容(不得被覆盖)")
    fs.mkdirSync(path.join(targetRoot, "agents.alpha-migrating"), { recursive: true })
    fs.writeFileSync(path.join(targetRoot, "agents.alpha-migrating", "半成品.md"), "partial")

    const outcome = runEnvMigration(runOpts())
    expect(outcome.status).toBe("migrated")
    if (outcome.status !== "migrated") return
    const byName = Object.fromEntries(outcome.receipt.results.map((r) => [r.name, r.outcome]))
    expect(byName.skills).toBe("already-present")
    expect(byName.agents).toBe("imported")
    // 已就位内容未被覆盖;半成品 tmp 清除
    expect(fs.readFileSync(path.join(targetRoot, "skills", "my-skill", "SKILL.md"), "utf8")).toBe("已就位的环境内容(不得被覆盖)")
    expect(fs.existsSync(path.join(targetRoot, "agents.alpha-migrating"))).toBe(false)
    expect(fs.existsSync(path.join(targetRoot, "agents", "代理 agent.md"))).toBe(true)
  })

  test("crash 重试②:全部就位但 receipt 未落盘 → 重跑全部 already-present,补 receipt,不重复复制", () => {
    buildLegacyLayout()
    runEnvMigration(runOpts())
    fs.rmSync(path.join(targetRoot, ENV_MIGRATION_RECEIPT_FILE))
    const snap = snapshotTree(targetRoot)
    const retry = runEnvMigration(runOpts())
    expect(retry.status).toBe("migrated")
    if (retry.status !== "migrated") return
    expect(retry.receipt.results.every((r) => r.outcome === "already-present" || r.outcome === "absent")).toBe(true)
    const after = snapshotTree(targetRoot)
    after.delete(ENV_MIGRATION_RECEIPT_FILE)
    snap.delete(ENV_MIGRATION_RECEIPT_FILE)
    expect(after).toEqual(snap)
  })

  test("坏 receipt(损坏 JSON)按缺失处理:重跑走逐项 already-present 自愈", () => {
    buildLegacyLayout()
    runEnvMigration(runOpts())
    fs.writeFileSync(path.join(targetRoot, ENV_MIGRATION_RECEIPT_FILE), "corrupt{{{")
    const retry = runEnvMigration(runOpts())
    expect(retry.status).toBe("migrated")
    expect(readEnvMigrationReceipt(targetRoot)?.v).toBe(1)
  })
})

describe("AC#4 回滚:旧布局仍可读;再升级不重复复制、不丢状态", () => {
  test("迁移后旧布局原样可读(旧版本继续用);回滚期改动不回流、环境内状态不丢", () => {
    buildLegacyLayout()
    runEnvMigration(runOpts())

    // 旧版本视角:旧根账本/配置照常可读(未被改写)
    const legacyLedger = readLedger(sourceRoot)
    expect(legacyLedger.receipts).toHaveLength(1)
    const legacyJsonc = parse(fs.readFileSync(path.join(sourceRoot, "alpha.jsonc"), "utf8")) as { mcp: Record<string, unknown> }
    expect(Object.keys(legacyJsonc.mcp)).toEqual(["github", "wiki", "dead"])

    // 回滚期:旧版本继续往旧根写;环境内也有新状态
    fs.writeFileSync(path.join(sourceRoot, "skills", "回滚期新增.md"), "downgrade-era")
    fs.writeFileSync(path.join(targetRoot, "skills", "环境内新状态.md"), "env-era")

    // 再升级:receipt 在场 → 整体 no-op;环境内新状态保留,回滚期文件不被重复导入
    const again = runEnvMigration(runOpts())
    expect(again.status).toBe("already-migrated")
    expect(fs.readFileSync(path.join(targetRoot, "skills", "环境内新状态.md"), "utf8")).toBe("env-era")
    expect(fs.existsSync(path.join(targetRoot, "skills", "回滚期新增.md"))).toBe(false)
    expect(fs.readFileSync(path.join(sourceRoot, "skills", "回滚期新增.md"), "utf8")).toBe("downgrade-era")
  })
})

describe("AC#5 路径逻辑:Windows 盘符/反斜杠(纯字符串,darwin 可测)", () => {
  test("isPathUnder:盘符大小写归一 + 反斜杠归一 + Unicode/空格", () => {
    expect(isPathUnder("C:\\Users\\Ünï code\\.alpha\\skills", "c:/Users/Ünï code/.alpha")).toBe(true)
    expect(isPathUnder("C:\\Users\\a\\.alpha", "C:\\Users\\a\\.alpha")).toBe(true)
    expect(isPathUnder("D:\\Users\\a\\.alpha\\x", "C:\\Users\\a\\.alpha")).toBe(false)
    expect(isPathUnder("/Users/tide/.alpha-其他", "/Users/tide/.alpha")).toBe(false)
    expect(isPathUnder("/Users/tide/.alpha/env/prod", "/Users/tide/.alpha")).toBe(true)
  })

  test("rewriteUnderRoot:跨盘符/跨根不改写(null);根内改写保留相对结构", () => {
    expect(rewriteUnderRoot("C:\\Users\\a\\.alpha\\plugins\\p.js", "C:\\Users\\a\\.alpha", "/env/prod")).toBe(
      path.join("/env/prod", "plugins", "p.js"),
    )
    expect(rewriteUnderRoot("D:\\elsewhere\\p.js", "C:\\Users\\a\\.alpha", "/env/prod")).toBeNull()
    expect(rewriteUnderRoot("npm-pkg@1.0.0", "/a/.alpha", "/env")).toBeNull()
    expect(rewriteUnderRoot("/旧 根/skills/技 能", "/旧 根", "/新 根 β")).toBe(path.join("/新 根 β", "skills", "技 能"))
  })

  test("transformAlphaJsoncForEnv:Windows 形态的外域引用也会被识别为外域(不放行)", () => {
    const text = `{"mcp":{"srv":{"environment":{"T":"{file:C:\\\\Users\\\\old env\\\\AppData\\\\alpha-mcp-secrets\\\\srv\\\\T}"}}}}`
    const r = transformAlphaJsoncForEnv(text, {
      sourceRoot: "C:\\Users\\old home\\.alpha",
      targetRoot: "C:\\Users\\old home\\.alpha\\env\\prod",
      userDataPath: "C:\\Users\\new env\\AppData",
    })
    // 外域文件在本机不可读 → fail-closed 摘除,绝不保留跨环境绝对路径
    expect(r.dropped).toHaveLength(1)
    expect(parse(r.text)).toEqual({ mcp: { srv: { environment: {} } } })
  })
})

describe("变换核的守边界行为", () => {
  test("不可解析的 alpha.jsonc 原样导入(绝不丢用户数据)", () => {
    const garbage = "!!!! not jsonc at all"
    const r = transformAlphaJsoncForEnv(garbage, { sourceRoot: "/s", targetRoot: "/t", userDataPath: "/u" })
    expect(r.text).toBe(garbage)
  })

  test("不可解析的 installs.json 原样导入 + loud 警告", () => {
    const garbage = "corrupt{{{"
    const r = transformInstallsJsonForEnv(garbage, { sourceRoot: "/s", targetRoot: "/t" })
    expect(r.text).toBe(garbage)
    expect(r.warnings).toHaveLength(1)
  })
})
