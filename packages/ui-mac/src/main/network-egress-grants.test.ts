// `#1412` —— 授权判据**第三个半场**(用户批准的目的地)的判据。方案基线:
// docs/design/2026-09-23-model-chosen-egress-baseline.md(不变量 I1 / I2 / I4 / I5 / I6 / I7,类边界 K3 / K4 / K6 / K7 / K9)。
//
//   ① 准入(K3/K4/I4):loopback 名字与 `127.x`、私网 / 链路本地 / CGNAT / 组播 IPv4 字面量、畸形 host、
//      越界端口逐条拒;公网名字与公网 IPv4 字面量收下;**198.18/15 必须收下** —— 本机所有出网经透明代理
//      (fake-IP),照「保留段」一刀切会拒载真实配置(前提为假的闸门比没有闸门更贵)。
//   ② 并集(I1/I5/K7/K9):三个半场只做并集;精确 `host:port`、大小写归一、端口是键的一部分;
//      批准一个目的地不会让静态表或动态半场多出或少掉任何一条。
//   ③ 编排(I2/I6/I7/K6):没接 approver ⇒ 恒拒(默认状态);拒绝进记忆且记忆到期后可再问;
//      同一目的地并发合并成一问;不同目的地封顶;超时判拒但**那一问不取消**,晚到的「允许」照样落账。
// 全平台、electron-free、零文件系统:approver / 落盘 / 时钟都注入。

import { afterEach, describe, expect, test } from "bun:test"
import {
  EGRESS_GRANT_MAX_PENDING,
  EGRESS_GRANT_PROMPT_TIMEOUT_MS,
  EGRESS_GRANT_REFUSAL_MEMO_MS,
  __resetEgressGrantsForTests,
  admitUserEgressGrant,
  configureEgressGrantApproval,
  getUserEgressGrants,
  isUserGrantedEgressDestination,
  requestUserEgressGrant,
  setUserEgressGrants,
  type EgressGrantDecision,
  type UserEgressGrant,
} from "./network-egress-grants"
import { isEgressAuthorizedForSidecar, setConfiguredEgressDestinations } from "./network-egress-derived"

afterEach(() => {
  __resetEgressGrantsForTests()
  setConfiguredEgressDestinations([])
})

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

// ── ① 准入 ────────────────────────────────────────────────────────────────────

describe("准入(K3/K4/I4):用户批得出什么,批不出什么", () => {
  test("收下:公网名字、大小写归一、显式端口、公网 IPv4 字面量,以及 198.18/15(本机 fake-IP 的那一段)", () => {
    expect(admitUserEgressGrant("en.wikipedia.org", 443)).toEqual({ host: "en.wikipedia.org", port: 443 })
    expect(admitUserEgressGrant("EN.Wikipedia.ORG", 443)).toEqual({ host: "en.wikipedia.org", port: 443 })
    expect(admitUserEgressGrant("git.example.com", 22)).toEqual({ host: "git.example.com", port: 22 })
    expect(admitUserEgressGrant("93.184.216.34", 443)).toEqual({ host: "93.184.216.34", port: 443 })
    // 前提为假的闸门比没有闸门更贵:这台机器上每一个公网名字都解析成 198.18.x.x
    expect(admitUserEgressGrant("198.18.0.7", 443)).toEqual({ host: "198.18.0.7", port: 443 })
  })

  test("拒:loopback 的每一种写法(名字与 127.x)", () => {
    for (const host of ["localhost", "LOCALHOST", "localhost.", "app.localhost", "127.0.0.1", "127.9.9.9", "0.0.0.0", "::1", "[::1]"])
      expect(admitUserEgressGrant(host, 443), host).toBeUndefined()
  })

  test("拒:私网 / 链路本地(含云元数据) / CGNAT / 组播 / 广播 的 IPv4 字面量", () => {
    for (const host of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.1", "224.0.0.1", "255.255.255.255", "0.1.2.3"])
      expect(admitUserEgressGrant(host, 443), host).toBeUndefined()
    // 边界对照:这两个**不是**私网,必须收下 —— 否则上一条是「整段一刀切」而不是判据
    expect(admitUserEgressGrant("172.15.0.1", 443)).toEqual({ host: "172.15.0.1", port: 443 })
    expect(admitUserEgressGrant("100.63.255.255", 443)).toEqual({ host: "100.63.255.255", port: 443 })
  })

  test("拒:畸形 host(带 scheme / 路径 / 通配 / 尾点 / 空)与越界端口", () => {
    for (const host of ["https://example.com", "example.com/x", "*.example.com", "example.com.", "", "[::]", "exa mple.com"])
      expect(admitUserEgressGrant(host, 443), JSON.stringify(host)).toBeUndefined()
    for (const port of [0, -1, 65536, 1.5, "443", null, undefined]) expect(admitUserEgressGrant("example.com", port as never), String(port)).toBeUndefined()
  })
})

// ── ② 并集与成员判定 ──────────────────────────────────────────────────────────

describe("并集(I1/I5/K7/K9):第三个半场进了 isEgressAuthorizedForSidecar,语义与另外两场逐字相同", () => {
  test("批准前后:只有被批准的那一个 host:port 变了,静态表与动态半场一格不动", () => {
    setConfiguredEgressDestinations([{ host: "api.deepseek.com", port: 443, providerId: "deepseek-byok", baseURL: "https://api.deepseek.com/" }])
    expect(isEgressAuthorizedForSidecar("en.wikipedia.org", 443)).toBe(false)
    setUserEgressGrants([{ host: "en.wikipedia.org", port: 443 }])
    expect(isEgressAuthorizedForSidecar("en.wikipedia.org", 443)).toBe(true)
    // 另外两场不受影响:静态表内的 github.com 仍在,动态半场的 deepseek 仍在,没批准的仍然不在
    expect(isEgressAuthorizedForSidecar("github.com", 443)).toBe(true)
    expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(true)
    expect(isEgressAuthorizedForSidecar("example.com", 443)).toBe(false)
  })

  test("端口是键的一部分;大小写归一;整份替换会收走上一份", () => {
    setUserEgressGrants([{ host: "GitHub.COM", port: 22 }])
    expect(isUserGrantedEgressDestination("github.com", 22)).toBe(true)
    expect(isUserGrantedEgressDestination("github.com", 443)).toBe(false)
    expect(getUserEgressGrants()).toEqual([{ host: "github.com", port: 22 }])
    setUserEgressGrants([])
    expect(isUserGrantedEgressDestination("github.com", 22)).toBe(false)
  })

  test("装载时再判一次准入:手改进真源的 loopback / 私网 / 畸形记录当场丢掉,只留合格的", () => {
    const accepted = setUserEgressGrants([
      { host: "localhost", port: 443 },
      { host: "192.168.0.9", port: 443 },
      { host: "not a host", port: 443 },
      { host: "example.com", port: 70000 },
      { host: "example.com", port: 443 },
      { host: "EXAMPLE.com", port: 443 },
    ])
    expect(accepted).toEqual([{ host: "example.com", port: 443 }])
    expect(isEgressAuthorizedForSidecar("localhost", 443)).toBe(false)
    expect(isEgressAuthorizedForSidecar("192.168.0.9", 443)).toBe(false)
  })
})

// ── ③ 编排 ────────────────────────────────────────────────────────────────────

describe("编排(I2/I6/I7/K6):问、记、合并、封顶、超时", () => {
  test("默认状态(没接 approver)恒答 false —— 全部单测与非 darwin 都在这个状态,行为与本票之前逐字相同", async () => {
    expect(await requestUserEgressGrant("en.wikipedia.org", 443)).toBe("not-asked")
    expect(isEgressAuthorizedForSidecar("en.wikipedia.org", 443)).toBe(false)
  })

  test("准入不过的目的地根本不问(loopback / 私网不该弹框)", async () => {
    const asked: string[] = []
    configureEgressGrantApproval({
      approver: async (d) => {
        asked.push(`${d.host}:${d.port}`)
        return "allow-session"
      },
    })
    expect(await requestUserEgressGrant("localhost", 443)).toBe("not-asked")
    expect(await requestUserEgressGrant("192.168.1.1", 443)).toBe("not-asked")
    expect(asked).toEqual([])
  })

  test("allow-session:本次运行放行,不落盘;allow-persist:放行并落盘一次", async () => {
    const persisted: UserEgressGrant[] = []
    let answer: EgressGrantDecision = "allow-session"
    configureEgressGrantApproval({ approver: async () => answer, persist: (g) => persisted.push(g) })
    expect(await requestUserEgressGrant("en.wikipedia.org", 443)).toBe("granted")
    expect(isEgressAuthorizedForSidecar("en.wikipedia.org", 443)).toBe(true)
    expect(persisted).toEqual([])
    answer = "allow-persist"
    expect(await requestUserEgressGrant("example.com", 443)).toBe("granted")
    expect(persisted).toEqual([{ host: "example.com", port: 443 }])
  })

  test("已经批准过的目的地不再问(第二次零询问)", async () => {
    let asks = 0
    configureEgressGrantApproval({
      approver: async () => {
        asks += 1
        return "allow-session"
      },
    })
    expect(await requestUserEgressGrant("example.com", 443)).toBe("granted")
    expect(await requestUserEgressGrant("example.com", 443)).toBe("granted")
    expect(asks).toBe(1)
  })

  test("I6 拒绝有记忆:拒过之后记忆期内直接拒且不再弹框;记忆到期后可以再问一次", async () => {
    let asks = 0
    let answer: EgressGrantDecision = "deny"
    let clock = 1_000
    configureEgressGrantApproval({
      approver: async () => {
        asks += 1
        return answer
      },
      now: () => clock,
    })
    expect(await requestUserEgressGrant("evil.example.com", 443)).toBe("refused")
    expect(await requestUserEgressGrant("evil.example.com", 443)).toBe("not-asked")
    expect(asks).toBe(1)
    clock += EGRESS_GRANT_REFUSAL_MEMO_MS + 1
    answer = "allow-session"
    expect(await requestUserEgressGrant("evil.example.com", 443)).toBe("granted")
    expect(asks).toBe(2)
  })

  test("K6 同一目的地并发合并成一问;不同目的地封顶后直接拒(不排队刷框)", async () => {
    const pending: Array<(d: EgressGrantDecision) => void> = []
    const asked: string[] = []
    configureEgressGrantApproval({
      approver: (d) =>
        new Promise<EgressGrantDecision>((resolve) => {
          asked.push(`${d.host}:${d.port}`)
          pending.push(resolve)
        }),
    })
    const same = [requestUserEgressGrant("a.example", 443), requestUserEgressGrant("a.example", 443), requestUserEgressGrant("a.example", 443)]
    await tick()
    expect(asked).toEqual(["a.example:443"]) // 三条 CONNECT,一个框
    // 再占满余下的名额,然后第 (MAX+1) 个不同目的地必须**立刻**被拒
    const others = []
    for (let i = 1; i < EGRESS_GRANT_MAX_PENDING; i += 1) others.push(requestUserEgressGrant(`b${i}.example`, 443))
    await tick()
    expect(asked.length).toBe(EGRESS_GRANT_MAX_PENDING)
    expect(await requestUserEgressGrant("overflow.example", 443)).toBe("not-asked")
    expect(asked.length).toBe(EGRESS_GRANT_MAX_PENDING) // 溢出的那个连问都没问
    for (const resolve of pending) resolve("allow-session")
    expect(await Promise.all(same)).toEqual(["granted", "granted", "granted"])
    expect(await Promise.all(others)).toEqual(others.map(() => "granted"))
  })

  test("I7 超时判拒,但那一问不取消:晚到的「允许」照样落账,下一次重试就通", async () => {
    let resolveAnswer: ((d: EgressGrantDecision) => void) | undefined
    let asks = 0
    configureEgressGrantApproval({
      timeoutMs: 20, // 生产是 45 s;没有可注入的超时,I7 就只能是散文
      approver: () =>
        new Promise<EgressGrantDecision>((resolve) => {
          asks += 1
          resolveAnswer = resolve
        }),
    })
    // ① 人没在超时之内回答 ⇒ 这一次判拒(客户端那条 CONNECT 就是在这里 403 的)
    expect(await requestUserEgressGrant("slow.example", 443)).toBe("refused")
    expect(isEgressAuthorizedForSidecar("slow.example", 443)).toBe(false)
    // ② 人后来点了「允许」——框还开着,答案照样落账
    resolveAnswer!("allow-session")
    await tick()
    expect(isEgressAuthorizedForSidecar("slow.example", 443)).toBe(true)
    // ③ 下一次重试直接通过,而且不再问一遍
    expect(await requestUserEgressGrant("slow.example", 443)).toBe("granted")
    expect(asks).toBe(1)
  })

  test("超时之后没人回答 ⇒ 进记忆,不会为每一条 CONNECT 各挂一次", async () => {
    let asks = 0
    configureEgressGrantApproval({
      timeoutMs: 20,
      approver: () =>
        new Promise<EgressGrantDecision>(() => {
          asks += 1
        }),
    })
    expect(await requestUserEgressGrant("nobody.example", 443)).toBe("refused")
    // 第二次连问都不问:超时已经进了记忆(所以是 not-asked,不是又问了一遍再被拒)
    expect(await requestUserEgressGrant("nobody.example", 443)).toBe("not-asked")
    expect(asks).toBe(1)
  })

  test("超时常量与并发上限是显式常量(改小改大都要在 diff 里看得见)", () => {
    expect(EGRESS_GRANT_PROMPT_TIMEOUT_MS).toBe(45_000)
    expect(EGRESS_GRANT_MAX_PENDING).toBe(3)
    expect(EGRESS_GRANT_REFUSAL_MEMO_MS).toBe(300_000)
  })

  test("approver 自己抛异常 ⇒ 拒并进记忆(降级方向永远朝 fail-closed)", async () => {
    let asks = 0
    configureEgressGrantApproval({
      approver: async () => {
        asks += 1
        throw new Error("dialog exploded")
      },
    })
    expect(await requestUserEgressGrant("boom.example", 443)).toBe("refused")
    expect(await requestUserEgressGrant("boom.example", 443)).toBe("not-asked")
    expect(asks).toBe(1)
    expect(isEgressAuthorizedForSidecar("boom.example", 443)).toBe(false)
  })

  test("落盘失败不影响本次放行(下次再问一遍,而不是这次连不上)", async () => {
    configureEgressGrantApproval({
      approver: async () => "allow-persist",
      persist: () => {
        throw new Error("disk full")
      },
    })
    expect(await requestUserEgressGrant("example.com", 443)).toBe("granted")
    expect(isEgressAuthorizedForSidecar("example.com", 443)).toBe(true)
  })
})
