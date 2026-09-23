// REQ-137 (`#1336`) · AC2 —— 注册表这张**唯一权威**的形状与初值。
//
// 期望值是独立字面量(从勘破 §2.2 抄下来、逐条对着今天的代码坐标复核),**不是**从被测模块推出来的:
// 注册表多一行 / 少一行 / 改一个域名,这里的 diff 就是评审要读的那份。授权函数的语义(精确 host:port、
// 端口是键的一部分、不做通配 / 后缀 / 尾点归一)在这里钉死 —— 把 isEgressAuthorized 改成恒答 true 的那一刻,
// 「未登记 ⇒ 拒」那条当场红;行为层(真代理 + 真 TCP 靶站)的正反两臂在 network-egress-proxy.test.ts。
//
// `#1415` 追加一节:websearch 那两行的**值**不归本表所有 —— 它是两条传输里的源码常量。
// 独立字面量锚仍然留在 EXPECTED_INITIAL_SET(评审读的是那份 diff),但另有三条从**那两个文件的
// 源码**派生期望值再比对,于是「引擎改了端点而白名单没跟」不再是一条无人变红的静默漂移。

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { ALPHA_ENDPOINTS } from "../shared/alpha-config"
import { EGRESS_REGISTRY, egressKey, isEgressAuthorized } from "./network-egress-registry"

/** 勘破 §2.2 的清单,按今日代码坐标校正(见注册表抬头逐条说明)。独立锚,不 import 被测对象。 */
const EXPECTED_INITIAL_SET = [
  "account.codepuppy.cn:443",
  "alpha-cloud.tidelabs.click:443",
  "alpha-gateway.tidelabs.click:443",
  "api.github.com:443",
  "api.releases.hashicorp.com:443",
  "codepuppy.cn:443",
  "download-cdn.jetbrains.com:443",
  "files.pythonhosted.org:443",
  "github.com:443",
  // `#1415`:本地 keyless websearch 的两个端点(登出 / BYOK 态该工具是广告给模型的)。
  // 这两行在本文件里是**独立字面量锚**(评审要读的 diff);它们与真源不许漂由下面
  // 「#1415 websearch 目的地」那一节从两条传输的源码派生后比对。
  "mcp.exa.ai:443",
  "models.opencode.ai:443",
  "pypi.org:443",
  "registry.npmjs.org:443",
  // `#1337`:#1073 owner 裁决二 —— #1334 Q4 实拍的真实开发流量(shell 工具子进程下载 release 资产)
  "release-assets.githubusercontent.com:443",
  "search.parallel.ai:443",
  "www.eclipse.org:443",
]

// ── `#1415`:websearch 两个端点的真源 = 两条传输里的 URL 常量 ─────────────────────────
// 注册表里那两行不许是「第二份手写清单」。这里的期望值因此**从那两个文件的源码读出来**,
// 而不是再抄一次域名:任一侧改了端点而另一侧没跟,下面三条里至少一条当场红。
// (两条传输都是 ADR-035 收编面;它们各自的主权闸判据在 websearch-copies.test.ts。)
const WEBSEARCH_TRANSPORTS = ["packages/opencode/src/tool/mcp-websearch.ts", "packages/core/src/tool/websearch.ts"] as const
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")

/**
 * 一个传输文件里出现的全部 https 端点 host(去重、排序)。
 * **先证明手段测得出已知的坏**:抓不到 ≥2 条字面量就判「本次测量作废」而不是给一个空集 ——
 * 空集会让下面每一条断言都空对空地绿(本仓《观测手段自己有盲区》那一类)。
 */
function websearchHostsOf(relativePath: string): string[] {
  const body = readFileSync(join(REPO_ROOT, relativePath), "utf8")
  const urls = body.match(/https:\/\/[^"'`\s)}]+/g) ?? []
  expect(urls.length, `${relativePath}: 抓不到 https 端点字面量 —— 本次测量作废,不是「没有端点」`).toBeGreaterThanOrEqual(2)
  // `EXA_URL` 有一支是带 `${…}` 的模板串,占位符替成常量再解析(只取 host,query 不参与登记)。
  const hosts = urls.map((url) => new URL(url.replaceAll(/\$\{[^}]*\}/g, "X")).hostname.toLowerCase())
  return [...new Set(hosts)].sort()
}

describe("AC2 注册表:初值与形状", () => {
  test("初值 = 勘破 §2.2 清单(按今日代码坐标校正),一行不多一行不少", () => {
    const actual = EGRESS_REGISTRY.map((e) => egressKey(e.host, e.port)).sort()
    expect(actual).toEqual(EXPECTED_INITIAL_SET)
  })

  test("每一行:host 小写、无 scheme / path / 通配 / 尾点;port 1..65535;类别与出处非空;无重复", () => {
    const seen = new Set<string>()
    for (const e of EGRESS_REGISTRY) {
      expect(e.host, e.host).toBe(e.host.toLowerCase())
      expect(e.host, e.host).not.toMatch(/[*/:\s]|^\.|\.$|^https?/)
      expect(Number.isInteger(e.port) && e.port >= 1 && e.port <= 65535, `${e.host} port ${e.port}`).toBe(true)
      expect(e.category.trim().length, `${e.host} category`).toBeGreaterThan(0)
      expect(e.source.trim().length, `${e.host} source`).toBeGreaterThan(0)
      const key = egressKey(e.host, e.port)
      expect(seen.has(key), `duplicate ${key}`).toBe(false)
      seen.add(key)
    }
  })

  test("平台四族的 host 跟着 shared/alpha-config 的 ALPHA_ENDPOINTS 走(注册表不自持第二份平台域名)", () => {
    for (const url of [ALPHA_ENDPOINTS.web, ALPHA_ENDPOINTS.platform, ALPHA_ENDPOINTS.account, ALPHA_ENDPOINTS.cloud]) {
      const host = new URL(url).hostname.toLowerCase()
      expect(isEgressAuthorized(host, 443), `${host}:443 should follow ALPHA_ENDPOINTS`).toBe(true)
    }
  })
})

describe("AC2 授权语义(fail-closed)", () => {
  test("已登记 host:port 放行;同 host 别的端口拒;未登记 host 拒;大小写归一;尾点 / 前导空白 / scheme / 子域一律拒", () => {
    expect(isEgressAuthorized("registry.npmjs.org", 443)).toBe(true)
    expect(isEgressAuthorized("REGISTRY.NPMJS.ORG", 443)).toBe(true)
    expect(isEgressAuthorized("github.com", 443)).toBe(true)
    // owner 2026-09-10 裁决:本机目的地刻意不登记(围栏只放行代理端口,登记也到不了)。
    expect(isEgressAuthorized("127.0.0.1", 11434)).toBe(false)

    expect(isEgressAuthorized("registry.npmjs.org", 80)).toBe(false)
    expect(isEgressAuthorized("github.com", 22)).toBe(false)
    expect(isEgressAuthorized("ac1336-unregistered.invalid", 443)).toBe(false)
    expect(isEgressAuthorized("github.com.", 443)).toBe(false)
    expect(isEgressAuthorized(" github.com", 443)).toBe(false)
    expect(isEgressAuthorized("https://github.com", 443)).toBe(false)
    expect(isEgressAuthorized("evil.github.com", 443)).toBe(false)
    expect(isEgressAuthorized("github.com.evil.example", 443)).toBe(false)
    expect(isEgressAuthorized("127.0.0.1", 11435)).toBe(false)
    expect(isEgressAuthorized("::1", 11434)).toBe(false)
    expect(isEgressAuthorized("", 443)).toBe(false)
    expect(isEgressAuthorized("github.com", 0)).toBe(false)
    expect(isEgressAuthorized("github.com", 65536)).toBe(false)
    expect(isEgressAuthorized("github.com", 443.5)).toBe(false)
  })

test("本机目的地不得登记(owner 2026-09-10 裁决)—— 围栏只放行代理端口,登记它等于写一句做不到的话", () => {
  const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"])
  const offenders = EGRESS_REGISTRY.filter((d) => LOOPBACK.has(d.host.toLowerCase()))
  expect(
    offenders.map((d) => `${d.host}:${d.port}`),
    "注册表里出现了 loopback 目的地。围栏只放行 (remote ip \"localhost:<代理端口>\"),别的 loopback 端口一律 EPERM;" +
      "且 NO_PROXY 含 loopback ⇒ 这类目的地根本不经代理。登记它不会让它可达,只会让登记簿说假话。" +
      "要支持本机目的地请先设计『本机目的地怎么走』,不要往表里加行。",
  ).toEqual([])
})
})

describe("`#1415` websearch 目的地:期望值从两条传输的源码派生,本表不自持第二份端点", () => {
  test("两条传输给出同一组端点(派生自检:抓不到字面量即判测量作废)", () => {
    const [legacy, v2] = WEBSEARCH_TRANSPORTS.map(websearchHostsOf)
    expect(legacy).toEqual(v2!)
    expect(legacy!.length, "websearch 端点应恰好两个(Exa + Parallel)").toBe(2)
  })

  test("AC1:派生出来的每个端点都被静态表放行 —— 登出 / BYOK 态不再 403 unregistered", () => {
    for (const host of websearchHostsOf(WEBSEARCH_TRANSPORTS[0])) {
      expect(isEgressAuthorized(host, 443), `${host}:443 应由静态表放行(否则 websearch 每次必失败)`).toBe(true)
      // 端口是键的一部分:放行 443 不等于放行别的端口。
      expect(isEgressAuthorized(host, 80), `${host}:80 不该被放行`).toBe(false)
    }
  })

  test("反向:表里挂在这两条传输名下的行恰好是派生出来的那些(多一行 / 少一行 / 改域名都红)", () => {
    const rows = EGRESS_REGISTRY.filter((entry) => entry.source.includes("mcp-websearch.ts"))
    expect(rows.map((entry) => egressKey(entry.host, entry.port)).sort()).toEqual(websearchHostsOf(WEBSEARCH_TRANSPORTS[0]).map((host) => `${host}:443`))
  })
})
