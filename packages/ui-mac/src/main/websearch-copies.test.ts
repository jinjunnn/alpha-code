// #223 R3 —— 「第三份 websearch 副本」防线(类闸,不是实例修补)。
//
// 本仓已经两次踩同一个病灶:引擎 v1/v2 断层让同一能力存在**多份并行注册**,alpha 的收口只覆盖
// 了其中一份。R2 收了 legacy `packages/opencode/src/tool/websearch.ts`;R3 发现打包 sidecar 同时
// 挂载 V2 Location 服务,`packages/core/src/tool/websearch.ts` 是**第二份活的**同名注册,不读主权
// 信号、直接打 Exa/Parallel。逐实例修下去只会等第三份。
//
// 于是这里做普查而不是断言某个文件:
//   Net A —— 全仓「注册了一个叫 websearch 的工具」的源文件。集合本身被钉住:多一份、少一份都红。
//            每一份都必须读同一个主权信号 `ALPHA_LOCAL_WEBSEARCH_DENY`,且闸在任何 permission
//            交互/出网调用**之前**。
//   Net B —— 全仓直接引用 Exa/Parallel 端点的源文件。它抓的是「换个名字接着打同一个后端」这一类
//            绕法:命中项要么本身在 Net A(带闸),要么是被钉住的纯传输辅助模块。
//
// 两张网都只认源文件(排除 test/dist/node_modules)。任何一张网变化 = 有人加了新的 web search
// 执行面,必须停下来分类,而不是让它静默上线。

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { describe, expect, test } from "bun:test"
import { CLOUD_WEBSEARCH_DENY_ENV, LOCAL_WEBSEARCH_DENY_ENV } from "./cloud-web-search"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", ".git", "gen", "generated"])

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.tsx?$/.test(entry.name)) continue
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
      found.push(join(dir, entry.name))
    }
  }
  for (const pkg of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory() || SKIP_DIRS.has(pkg.name)) continue
    const src = join(REPO_ROOT, "packages", pkg.name, "src")
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    walk(src)
  }
  return found
}

const FILES = sourceFiles().map((path) => ({ path: relative(REPO_ROOT, path).split(sep).join("/"), body: readFileSync(path, "utf8") }))

/** 「注册了一个叫 websearch 的工具」的三种现行写法(legacy `Tool.define` / V2 模块名约定 / 插件工具表)。 */
const REGISTRATION = [
  /Tool\.define\(\s*["'`]websearch["'`]/,
  /export const name\s*=\s*["'`]websearch["'`]/,
  /(^|[\s{,])websearch\s*:\s*(tool|Tool\.make)\(/m,
]
/** 主权闸必须排在这些「第一次真做事」的调用之前。 */
const FIRST_EFFECT = [/permission\.assert\(/, /ctx\.ask\(/, /callMcp\(/, /callProvider\(/]

const registrations = FILES.filter((file) => REGISTRATION.some((pattern) => pattern.test(file.body)))
const providerCallers = FILES.filter((file) => /mcp\.exa\.ai|search\.parallel\.ai/.test(file.body))

/** 纯传输辅助:自己不注册工具,只被带闸的注册方调用,因此允许不带闸。 */
const TRANSPORT_ONLY = ["packages/opencode/src/tool/mcp-websearch.ts"]

describe("websearch 执行副本普查(#223 R3 类闸)", () => {
  test("全仓注册为 websearch 的工具恰好是这两份", () => {
    expect(registrations.map((file) => file.path).sort()).toEqual([
      "packages/core/src/tool/websearch.ts",
      "packages/opencode/src/tool/websearch.ts",
    ])
  })

  test("每一份注册都读同一个主权信号,且闸排在任何 permission 交互/出网调用之前", () => {
    expect(registrations.length).toBeGreaterThan(0)
    for (const file of registrations) {
      expect(file.body).toContain(`export const LOCAL_WEBSEARCH_DENY_ENV = "${LOCAL_WEBSEARCH_DENY_ENV}"`)
      // 只在 execute 体内比较位置:文件顶部的辅助函数**定义**不是「做事」。
      const body = file.body.indexOf("execute:")
      expect(body, `${file.path} 没有可识别的 execute 入口`).toBeGreaterThanOrEqual(0)
      const gate = file.body.indexOf("if (localWebSearchDenied())", body)
      expect(gate, `${file.path} 的 execute 里缺少主权最终闸`).toBeGreaterThanOrEqual(0)
      for (const pattern of FIRST_EFFECT) {
        const match = pattern.exec(file.body.slice(body))
        if (!match) continue
        expect(gate, `${file.path}: 闸必须早于 ${pattern.source}`).toBeLessThan(body + match.index)
      }
    }
  })

  test("直接引用 Exa/Parallel 端点的文件要么带闸,要么是被钉住的纯传输模块", () => {
    const gated = new Set(registrations.map((file) => file.path))
    expect(providerCallers.map((file) => file.path).sort()).toEqual(
      ["packages/core/src/tool/websearch.ts", ...TRANSPORT_ONLY].sort(),
    )
    for (const file of providerCallers) {
      if (TRANSPORT_ONLY.includes(file.path)) continue
      expect(gated.has(file.path), `${file.path} 直接打 Exa/Parallel 却不在带闸的注册集合里`).toBe(true)
    }
  })

  test("主权信道名在四个包里逐字一致(没有共用依赖边,只能靠这条锁)", () => {
    expect(LOCAL_WEBSEARCH_DENY_ENV).toBe("ALPHA_LOCAL_WEBSEARCH_DENY")
    expect(CLOUD_WEBSEARCH_DENY_ENV).toBe("ALPHA_CLOUD_WEBSEARCH_DENY")
    const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8")
    for (const path of ["packages/opencode/src/tool/websearch.ts", "packages/core/src/tool/websearch.ts"])
      expect(read(path)).toContain(`export const LOCAL_WEBSEARCH_DENY_ENV = "${LOCAL_WEBSEARCH_DENY_ENV}"`)
    expect(read("packages/ext/src/cloud-websearch-kill.ts")).toContain(
      `export const CLOUD_WEBSEARCH_DENY_ENV = "${CLOUD_WEBSEARCH_DENY_ENV}"`,
    )
    // 两条判决都必须真的过得了 sidecar 白名单,否则闸在打包态恒不置位。
    const allowlist = read("packages/ui-mac/src/main/sidecar-env.ts")
    expect(allowlist).toContain(`"${LOCAL_WEBSEARCH_DENY_ENV}"`)
    expect(allowlist).toContain(`"${CLOUD_WEBSEARCH_DENY_ENV}"`)
  })

  test("云侧最终闸是 ext 钩子的第一句(排在契约校验与 ctx.ask 之前)", () => {
    const plugin = readFileSync(join(REPO_ROOT, "packages/ext/src/plugin.ts"), "utf8")
    const hook = plugin.indexOf('"tool.execute.before"')
    expect(hook).toBeGreaterThanOrEqual(0)
    const gate = plugin.indexOf("assertWebSearchToolAllowed(hookInput.tool)", hook)
    const contract = plugin.indexOf("validateCloudToolInput(", hook)
    expect(gate).toBeGreaterThan(hook)
    expect(gate).toBeLessThan(contract)
  })
})
