// REQ-137 · `#1412` —— 授权目的地的**第三个半场**:用户当场批准的目的地。
//
// ── 为什么前两个半场装不下它 ──────────────────────────────────────────────────────────
// 静态表装常量,动态半场装「从围栏外的真源派生出来的值」。两者共用一条规则:**一个目的地能进
// 放行集合,当且仅当它有一个围栏外的真源**。`webfetch` 的 URL(packages/opencode/src/tool/webfetch.ts:39-41
// 的 `params.url`)与 `bash` 里命令自带的目的地,都由模型在调用那一刻产生 —— 它们**没有、也不该有**
// 配置来源(「事先不知道要读哪个链接 / 跑哪条命令」正是这两个工具的定义)。`#1414` 的全表实测把它们
// 归为唯二的一类:没有真源,于是连「用户想让它过」都没有任何地方可以表态,整类不可用。
// 实测(`#1412`,真 sandbox-exec + 真 curl + 生产代理):`en.wikipedia.org` / `example.com` /
// `raw.githubusercontent.com` 一律 `curl: (56) CONNECT tunnel failed, response 403`,而同一批里
// 静态表内的 `github.com` 取回 576 869 B —— 唯一的变量就是「在不在名单里」。
//
// ── 本半场的真源是「用户点的那一下」,不是某个文件里的字符串 ────────────────────────
// 形状照搬文件轴那个已经在跑的解法(工作区并集 + `external_directory` 出口):**有真源 + 有出口**。
//   真源:`<casBaseRoot>/egress-grants/<env>.json`(egress-grant-truth.ts)—— 与 mcp-servers/ 、
//         custom-providers/ 、fence-workspaces/ 同父目录,**不在 seatbelt 可写集的任何一行之下**,
//         只有 main 写(写端 egress-grant-truth-write.ts 刻意不进 sidecar 的 import 闭包)。
//   出口:代理判出 `unregistered` 的那一刻先问用户(main 进程的原生对话框,围栏之外),
//         答「允许」才建隧道;勾了「记住」才落进真源,否则只活在本次运行。
// 读它的人只有一个:network-egress-derived.ts 的 `isEgressAuthorizedForSidecar`(三场并集)。
// 写它的人只有一个:本模块的 `requestUserEgressGrant`,而它唯一的信息来源是注入进来的 approver。
// **围栏内没有任何写入路径**:配置文件不算数(理由逐字同 network-egress-derived.ts 抬头),
// env 不算数,引擎说什么都不算数 —— 引擎给的 URL 与代理看到的 authority 是两个值,可以分叉。
//
// ── 批准的语义,说清楚而不是说好听 ────────────────────────────────────────────────────
// 代理看到的是 TCP,loopback 上没有可信的调用方身份(围栏内是同一棵树:bash 子进程、MCP stdio、
// 仓库自带 plugin 与引擎本体完全同形)。所以能被批准的最小单位就是**目的地**:
//   · 批准一个目的地 = **把它交给整棵围栏内的进程树**,不是「只给 webfetch」;
//   · 一条 CONNECT 是**裸双向管道**,批准 = 交出一条到该目的地的双向通道(可以往外发字节)。
// 这两句必须与文案一致;说窄了就是把披露做成假话(与 network-egress-proxy.ts 拒绝文案同条纪律)。
//
// ── fail-closed 的方向 ────────────────────────────────────────────────────────────────
// 没接 approver(默认状态,含全部单测与非 darwin)、没有窗口、超时、并发超上限、用户答拒绝 ——
// **全部**落回今天那条 403 unregistered,字节逐字不变。没有任何一条降级路径的方向是放行。
//
// electron-free、零 fs、零 import 副作用:approver / 落盘 / 时钟都靠注入,所以整个编排在 bun 里
// 对着真代理可测(network-egress-grants.test.ts + network-egress-proxy.test.ts 的批准臂)。

import { isEgressHostShape, isLoopbackHost } from "./network-egress-registry"

/** 用户批准过的一个精确目的地。语义与另外两个半场逐字相同:精确 `lowercase(host):port`。 */
export type UserEgressGrant = {
  host: string
  port: number
}

/** 用户对一次询问的答复。`allow-session` = 只活到应用退出;`allow-persist` = 同时落进真源。 */
export type EgressGrantDecision = "deny" | "allow-session" | "allow-persist"

/**
 * 一次询问的结局。`not-asked` 与 `refused` 行为相同(都不放行),但只有 `refused` 表示**真的问过人**——
 * 代理据此决定要不要为它写一行记录(见 requestUserEgressGrant 的抬头)。
 */
export type EgressGrantOutcome = "granted" | "refused" | "not-asked"

/** 询问用户的那一问。生产绑定是 main 的原生对话框(egress-approval-dialog.ts);测试注入自己的。 */
export type EgressGrantApprover = (destination: UserEgressGrant) => Promise<EgressGrantDecision>

/** 询问的上限:超过它就不再等人,直接拒(`webfetch` 自己 30 s 就放弃了,这里留出人类反应时间)。 */
export const EGRESS_GRANT_PROMPT_TIMEOUT_MS = 45_000
/** 同时最多有几个**不同**目的地在等答复。再多就直接拒 —— 一个循环不该能刷出无限个系统框。 */
export const EGRESS_GRANT_MAX_PENDING = 3
/** 被拒 / 超时的目的地在这段时间内不再问(否则同一个框会被刷)。到期后可以再问一次(误点不是终身判决)。 */
export const EGRESS_GRANT_REFUSAL_MEMO_MS = 5 * 60_000

const key = (host: string, port: number): string => `${host.toLowerCase()}:${port}`

/**
 * 私网 / 链路本地 / CGNAT / 组播与保留段的 **IPv4 字面量,点分四段写法**。
 *
 * ── 覆盖面到哪为止(照实写,别照好听写)──────────────────────────────────────────
 * **只判点分四段的文本形状**,而拨号走 `getaddrinfo`(network-egress-proxy.ts 的 defaultDial →
 * `net.connect` → `dns.lookup`),它接受 inet_aton 的**全部短写**。两套解析器不一致 ⇒ 同一个地址
 * 有多种拼法,而只有一种被判。本机实测(Darwin 25.3,生产判据实跑):
 *   `2130706433` → 127.0.0.1   `127.1` → 127.0.0.1   `0x7f.1` → 127.0.0.1   `10.1` → 10.0.0.1
 *   `192.168.1` → 192.168.0.1  `169.254.43518` → **169.254.169.254**  `0300.0250.1.1` → 192.168.1.1
 * 七条**全部**通过本函数与 `parseConnectAuthority`。**owner 2026-09-24 裁决:接受这个绕过。**
 * 不要「顺手」把它修掉 —— 要修的落点与最小修法写在
 * docs/design/2026-09-23-model-chosen-egress-baseline.md §5.1 的 K3′,判据也该落在那里。
 *
 * ── 为什么不在解析结果上判(这一条此前写错过,更正后的版本)──────────────────────
 * 与已发布基线同口径:network-egress-registry.ts 匹配语义段「不做 IP ↔ 名字的等价 —— fake-IP 拓扑下
 * 按 IP 授权结构性无意义」。**此前这里写的理由是「照解析结果立闸会拒载真实配置」,那句不成立**:
 * 本机所有出网都经透明代理,`dns.lookup` 恒返回 fake-IP(本轮实测 `en.wikipedia.org` → `198.18.7.205`),
 * 所以一个「解析后落在私网就拒」的判据在这台机器上**永不触发**,它是空转,不是拒载。
 * **真实理由只有一条**:那样一道闸只保护**非 fake-IP 拓扑**的机器,而今天整个 portfolio 没有那样的租户
 * (R1 审计实跑 `127.0.0.1.nip.io` 一族:三个名字都解成 198.18.8.x,loopback 靶站 0 连接)。
 * 前提为假的论证比没有论证更贵,所以按实情记。将来要关它:给 `defaultDial` 的 `net.connect` 传
 * `lookup` 钩子,在解析结果上判,**并且必须放行 198.18/15** —— 否则「拒载真实配置」那个错才真的发生。
 * 198.18/15 因此不在下面的拒绝集里。
 */
function isNonPublicV4Literal(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 0) return true // 0.0.0.0/8 「本网络」
  if (a === 10) return true // RFC1918
  if (a === 127) return true // loopback(isLoopbackHost 也拦,这里是同一条边界的另一半)
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT / tailscale 一类覆盖网
  if (a === 169 && b === 254) return true // 链路本地,含 169.254.169.254 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a >= 224) return true // 组播 + 保留 + 广播
  return false
}

/**
 * 准入(fail-closed:四条全中才收下)。判据**不抄第二份** —— host 形状与 loopback 都问
 * network-egress-registry.ts 里那两个函数,与静态表 / 动态半场同源。
 * 不合格返回 undefined(不猜、不修补),合格返回归一后的目的地。
 *
 * ⚠️ **已知覆盖缺口(owner 2026-09-24 接受,不要顺手补)**:下面三道判据全部只认**点分四段**的
 * IPv4 字面量,而拨号器走 `getaddrinfo` ⇒ inet_aton 短写(`0x7f.1` / `127.1` / `10.1` …)批得出,
 * 而框里只显示那个串、没有人判得出它指向本机。受影响的是 `bash` 轴里不归一的客户端
 * (`python3` urllib / `nc` / `openssl` / `wget` / 手写 socket);`webfetch` / `curl` / `git` 都在
 * 发出前归一,不受影响。成因、实测读数与最小修法在上面 isNonPublicV4Literal 的抬头与基线 §5.1 K3′。
 */
export function admitUserEgressGrant(host: unknown, port: unknown): UserEgressGrant | undefined {
  if (typeof host !== "string" || host.length === 0) return undefined
  const h = host.toLowerCase()
  if (isLoopbackHost(h)) return undefined
  if (!isEgressHostShape(h)) return undefined
  if (isNonPublicV4Literal(h)) return undefined
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return undefined
  return { host: h, port: port as number }
}

let granted: ReadonlyMap<string, UserEgressGrant> = new Map()
let approver: EgressGrantApprover | undefined
let persist: ((grant: UserEgressGrant) => void) | undefined
let now: () => number = Date.now
let promptTimeoutMs: number = EGRESS_GRANT_PROMPT_TIMEOUT_MS
const pending = new Map<string, Promise<EgressGrantOutcome>>()
const refused = new Map<string, number>()

/**
 * 整份替换本次运行的批准集合(启动时从真源装载)。返回**真正被收下**的那些(去重后)。
 * 准入在这里再判一次而不是信调用方:真源文件可能被人手改坏,登记簿只登记得下它说得出口的东西。
 */
export function setUserEgressGrants(grants: readonly { host: string; port: number }[]): UserEgressGrant[] {
  const next = new Map<string, UserEgressGrant>()
  for (const g of grants) {
    const admitted = admitUserEgressGrant(g?.host, g?.port)
    if (!admitted) continue
    const k = key(admitted.host, admitted.port)
    if (!next.has(k)) next.set(k, admitted)
  }
  granted = next
  return [...next.values()]
}

/** 本次运行已批准的内容(日志 / 测试用;调用方拿到的是拷贝)。 */
export function getUserEgressGrants(): UserEgressGrant[] {
  return [...granted.values()]
}

/** 本半场的成员判定。语义与另外两场逐字相同:精确 `host:port`,大小写归一,端口是键的一部分。 */
export function isUserGrantedEgressDestination(host: string, port: number): boolean {
  if (typeof host !== "string" || host.length === 0) return false
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  return granted.has(key(host, port))
}

/**
 * 接上生产的询问通道与落盘通道(main 在起策略代理时调一次)。**不调它 = 没有出口**,
 * 每个未登记目的地照旧 403 —— 这是默认值,也是全部单测与非 darwin 的状态。
 */
export function configureEgressGrantApproval(deps: {
  approver?: EgressGrantApprover
  persist?: (grant: UserEgressGrant) => void
  now?: () => number
  /** 只有测试传它。生产用 EGRESS_GRANT_PROMPT_TIMEOUT_MS —— 不可注入的超时没有判据,I7 就成了散文。 */
  timeoutMs?: number
}): void {
  approver = deps.approver
  persist = deps.persist
  now = deps.now ?? Date.now
  promptTimeoutMs = deps.timeoutMs ?? EGRESS_GRANT_PROMPT_TIMEOUT_MS
}

/**
 * 代理判出 `unregistered` 之后唯一的出口:问用户。只有 `granted` 才建隧道。
 *
 * 结局是**三态**而不是布尔:`not-asked` 与 `refused` 在行为上相同(都不放行),但它们不是同一件事 ——
 * 「这次真的问了人、人说不」值得在日志里出声,「根本没问」(没接通道 / 准入不过 / 超并发 / 记忆期内)
 * 不值得,否则每一条被拒的 CONNECT 都会多出一行假装有人拒过的记录(空输出与零命中同一类病)。
 *
 * 六条纪律,每条都对应一类边界(见 docs/design/2026-09-23-model-chosen-egress-baseline.md §5.1):
 *   · 准入不过 ⇒ 不问(K3/K4:批不出 loopback、批不出内网字面量);
 *   · 没有 approver ⇒ not-asked(I2:默认 fail-closed);
 *   · 记忆期内被拒过 ⇒ not-asked,不再弹(K6);
 *   · 同一目的地同时只问一次,并发的 CONNECT 等同一个答案(K6);
 *   · 待答的**不同**目的地封顶,超了直接 not-asked(K6);
 *   · 超时 ⇒ refused,但**那一问不取消**:用户后来答「允许」照样落账,下一次重试就通(I7)。
 */
export function requestUserEgressGrant(host: string, port: number): Promise<EgressGrantOutcome> {
  const destination = admitUserEgressGrant(host, port)
  if (!destination) return Promise.resolve("not-asked")
  const k = key(destination.host, destination.port)
  if (granted.has(k)) return Promise.resolve("granted")
  const ask = approver
  if (!ask) return Promise.resolve("not-asked")
  const refusedAt = refused.get(k)
  if (refusedAt !== undefined) {
    if (now() - refusedAt < EGRESS_GRANT_REFUSAL_MEMO_MS) return Promise.resolve("not-asked")
    refused.delete(k)
  }
  const inFlight = pending.get(k)
  if (inFlight) return inFlight
  if (pending.size >= EGRESS_GRANT_MAX_PENDING) return Promise.resolve("not-asked")

  // 答复到达时**总是**落账,哪怕问的人早就走了(I7)。所以 apply 挂在 ask() 本身上,
  // 而超时只影响本次调用的返回值,不影响那一问的去向。
  const answered = ask(destination).then(
    (decision) => applyDecision(k, destination, decision),
    () => applyDecision(k, destination, "deny"),
  )
  const raced = new Promise<EgressGrantOutcome>((resolve) => {
    let settled = false
    const finish = (value: EgressGrantOutcome) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      // 超时也记进记忆:否则一个没人看的机器会为每一条 CONNECT 各挂 45 秒。
      if (!granted.has(k)) refused.set(k, now())
      finish("refused")
    }, promptTimeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    void answered.then((value) => {
      clearTimeout(timer)
      finish(value)
    })
  })
  pending.set(k, raced)
  void answered.finally(() => {
    if (pending.get(k) === raced) pending.delete(k)
  })
  return raced
}

function applyDecision(k: string, destination: UserEgressGrant, decision: EgressGrantDecision): EgressGrantOutcome {
  if (decision !== "allow-session" && decision !== "allow-persist") {
    refused.set(k, now())
    return "refused"
  }
  refused.delete(k)
  const next = new Map(granted)
  next.set(k, destination)
  granted = next
  if (decision === "allow-persist" && persist) {
    try {
      persist(destination)
    } catch {
      // 落盘失败不该让这一次连接失败:批准在本次运行里仍然成立,只是下次要再问一次。
      // 出声由注入的 persist 自己负责(它拿得到 logger,本模块拿不到)。
    }
  }
  return "granted"
}

/** 仅测试:把三份进程内状态清回默认(没有批准、没有 approver、没有记忆)。 */
export function __resetEgressGrantsForTests(): void {
  granted = new Map()
  approver = undefined
  persist = undefined
  now = Date.now
  promptTimeoutMs = EGRESS_GRANT_PROMPT_TIMEOUT_MS
  pending.clear()
  refused.clear()
}
