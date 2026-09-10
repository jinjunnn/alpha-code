// REQ-137 (`#1336`) · AC2 —— 注册表这张**唯一权威**的形状与初值。
//
// 期望值是独立字面量(从勘破 §2.2 抄下来、逐条对着今天的代码坐标复核),**不是**从被测模块推出来的:
// 注册表多一行 / 少一行 / 改一个域名,这里的 diff 就是评审要读的那份。授权函数的语义(精确 host:port、
// 端口是键的一部分、不做通配 / 后缀 / 尾点归一)在这里钉死 —— 把 isEgressAuthorized 改成恒答 true 的那一刻,
// 「未登记 ⇒ 拒」那条当场红;行为层(真代理 + 真 TCP 靶站)的正反两臂在 network-egress-proxy.test.ts。

import { describe, expect, test } from "bun:test"
import { ALPHA_ENDPOINTS } from "../shared/alpha-config"
import { EGRESS_REGISTRY, egressKey, isEgressAuthorized } from "./network-egress-registry"

/** 勘破 §2.2 的清单,按今日代码坐标校正(见注册表抬头逐条说明)。独立锚,不 import 被测对象。 */
const EXPECTED_INITIAL_SET = [
  "127.0.0.1:11434",
  "account.codepuppy.cn:443",
  "alpha-cloud.tidelabs.click:443",
  "alpha-gateway.tidelabs.click:443",
  "api.github.com:443",
  "api.releases.hashicorp.com:443",
  "codepuppy.cn:443",
  "download-cdn.jetbrains.com:443",
  "files.pythonhosted.org:443",
  "github.com:443",
  "models.opencode.ai:443",
  "pypi.org:443",
  "registry.npmjs.org:443",
  "www.eclipse.org:443",
]

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
    expect(isEgressAuthorized("127.0.0.1", 11434)).toBe(true)

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
})
