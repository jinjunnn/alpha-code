// REQ-137 (`#1336`) —— 授权目的地注册表:**静态半场**(应用自己总会去连的那些地址)。
//
// 引擎 sidecar 那棵进程树的出网只有一条路:loopback 上的策略代理(network-egress-proxy.ts)。代理对每一条
// CONNECT 只问一个问题 ——「这个 `host:port` 授权了吗」—— 没授权就 403 并留下结构化记录。
//
// ── 授权有两个半场,合起来才是权威(`#1379` 起)────────────────────────────────────────
//   **静态半场 = 本表**。常量、冻结、评审逐行可读。要放行一个「应用自己会去连」的新目的地,只能改这里,
//   并在 PR 里带上它的出处坐标。本表之外不存在第二张**手写**清单(散文、JSON、env 都不算)。
//   **动态半场 = network-egress-derived.ts**。BYOK 直连的目的地由**用户配置了谁**决定,没有静态值可登记
//   (见下方「刻意不在表里的」)。它不是第二张手写清单,而是从**引擎真正会去连的那个值**
//   (有效配置里 `provider.<id>.options.baseURL`,回退 `api`)派生出来的,每次 fork 前整份替换。
//   代理问的是两者的并集(`isEgressAuthorizedForSidecar`);本文件的 `isEgressAuthorized` 只答静态半场。
// 这是 `#1073` AC2 的形状:单一权威 + 咽喉点 —— 权威从「一张表」变成「一张表 + 一条派生规则」,
// 但仍然只有一处回答「这个目的地授权了吗」,而且两个半场用的是同一套匹配语义与同一个 host 形状判据。
//
// ── 行的来源 ────────────────────────────────────────────────────────────────────────
// 初值照勘破 `docs/architecture/2026-08-25-network-egress-seam.md` §2.2 那份清单(类别 × 出处),逐条
// 对着**今天树上的代码坐标**复核过再抄(全称命题跑一遍再写,不照散文立闸):
//   · §2.2 写 `models.dev:443`(引 models-dev.ts:154);今天 `packages/core/src/models-dev.ts:160` 的默认源是
//     `https://models.opencode.ai`(`OPENCODE_MODELS_URL` 可覆写)—— 登记的是代码里那个,不是散文里那个。
//   · §2.2 写 `alphacodeone.com` / `account.alphacodeone.com`;平台域名已迁(shared/alpha-config.ts 的
//     `ALPHA_ENDPOINTS`:codepuppy.cn / account.codepuppy.cn / alpha-gateway.tidelabs.click /
//     alpha-cloud.tidelabs.click)。这四条**从 ALPHA_ENDPOINTS 派生**而不是再抄一份域名 —— 那个常量
//     本来就是「Change a domain HERE only」的唯一落点;本表只裁决「平台族是授权目的地」,不自持第二份域名。
//   · LSP 自动下载那一行 §2.2 说的出处是「packages/opencode/src/lsp/*.ts 静态枚举」;今天枚举出五个 host
//     (多了 `www.eclipse.org`,server.ts:1207 的 jdtls),按出处如实登记。
//   · 与 `#1334` Q4 代理侧实拍逐条对得上:registry.npmjs.org / codepuppy.cn / alpha-gateway.tidelabs.click /
//     github.com 都在表里。Q4 还拍到 `release-assets.githubusercontent.com:443`(shell 工具子进程)与
//     `example.com:443`(Q3 语料的探针目标)—— 两条都不在 §2.2,`#1336` 没自作主张,交 `#1073` 裁。
//     owner 2026-09-10 裁决(`#1073` 评论「注册表初值的三条边界」):前者**加**(真实开发流量:装工具 / 下二进制
//     都走它,不加则封路之后这类下载被拒 = 误伤,`#1337` 出货复跑再次实拍到它被 403 ×2);后者**不加**
//     (它只是探针靶子,不是开发流量;为了让测试过而放宽策略是把闸门做假 —— AC3 语料改用注册表里已有的目的地)。
//
// ── 刻意不在表里的 ──────────────────────────────────────────────────────────────────
//   · BYOK provider 的 baseURL、用户配置的远程 MCP URL:§2.2 列为「动态」类别,没有静态值可登记。
//     `#1336`/`#1337` 当时只做静态半场,于是它们经代理一律 403 —— `#1379` 实测这不是「可观察的空缺」,
//     而是**自带 Key 直连整类不可用**(0.1.13 起九天,日志见 network-egress-derived.ts 抬头)。
//     BYOK 的公网 baseURL 自 `#1379` 起由**动态半场**放行(network-egress-derived.ts,从有效配置派生,
//     每代整份替换),**仍然不进本表**:本表只装常量。用户配置的远程 MCP URL 尚未覆盖(另票)。
//   · ssh(`*:22`):§2.2 写「用户仓可能」,`*` 与按 host 授权互斥;老勘破 §6 已列为「不覆盖(响亮失败)」。
//
// ── 匹配语义(fail-closed)────────────────────────────────────────────────────────────
// 精确匹配 `lowercase(host) + ":" + port`。不做后缀/通配、不做 IP ↔ 名字的等价(fake-IP 拓扑下按 IP 授权
// 结构性无意义,§2.1)、尾点形 `github.com.` 不归一(不在表里就是不在)。端口是键的一部分:
// `github.com:443` 在表里不代表 `github.com:22` 在。

import { ALPHA_ENDPOINTS } from "../shared/alpha-config"

export type EgressDestination = {
  /** 小写 DNS 名或 IP 字面量;不带 scheme / path / 通配。 */
  host: string
  port: number
  /** 勘破 §2.2 的类别列。 */
  category: string
  /** 出处坐标(代码 file:line 或勘破章节)。评审据此判「这一行凭什么在」。 */
  source: string
}

const HOST_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$|^(?:\d{1,3}\.){3}\d{1,3}$/

/**
 * 「这个字符串长得像一个可登记的 host 吗」—— 小写 DNS 名或 IPv4 字面量,无 scheme / path / 通配 / 尾点。
 * 导出是为了让**动态半场**(network-egress-derived.ts)过同一个判据,而不是抄一份正则:
 * 两个半场的 host 形状必须逐字同源,否则「派生出来的东西静态表登记不下」这种分叉没有任何闸会红。
 */
export const isEgressHostShape = (host: string): boolean => HOST_SHAPE.test(host)

/** 本机目的地的名字形(owner 2026-09-10 / 2026-09-21 裁决:绝不进任何放行集合)。 */
const LOOPBACK_NAMES = new Set(["localhost", "0.0.0.0", "::1", "[::1]", "::", "[::]"])
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * 「这个 host 指向本机吗」—— 与 `isEgressHostShape` 同理住在本文件:**动态半场**
 * (network-egress-derived.ts)与**用户批准半场**(network-egress-grants.ts)都要问它,
 * 而本文件是它们共同的叶子模块(反过来 import 会成环)。抄第二份正则 = 两个半场对
 * 「什么算本机」各自漂移,而没有任何东西会红。
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return LOOPBACK_NAMES.has(h) || h === "localhost." || h.endsWith(".localhost") || LOOPBACK_V4.test(h)
}

function fromEndpoint(url: string, category: string, source: string): EgressDestination {
  const u = new URL(url)
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
  return { host: u.hostname.toLowerCase(), port, category, source }
}

const https = (host: string, category: string, source: string): EgressDestination => ({ host, port: 443, category, source })

export const EGRESS_REGISTRY: readonly EgressDestination[] = Object.freeze([
  https("models.opencode.ai", "引擎:模型目录", "packages/core/src/models-dev.ts:160(§2.2 写 models.dev,以代码为准)"),
  fromEndpoint(ALPHA_ENDPOINTS.web, "引擎:平台 web(登录 / token / 上传同意)", "packages/ui-mac/src/shared/alpha-config.ts ALPHA_ENDPOINTS.web"),
  fromEndpoint(ALPHA_ENDPOINTS.platform, "引擎:平台 gateway(/v1 模型代理)", "packages/ui-mac/src/shared/alpha-config.ts ALPHA_ENDPOINTS.platform"),
  fromEndpoint(ALPHA_ENDPOINTS.account, "引擎:平台 account(余额 / 会员 / 用量)", "packages/ui-mac/src/shared/alpha-config.ts ALPHA_ENDPOINTS.account"),
  fromEndpoint(ALPHA_ENDPOINTS.cloud, "引擎:平台 cloud(云任务 + MCP facade)", "packages/ui-mac/src/shared/alpha-config.ts ALPHA_ENDPOINTS.cloud"),
  https("registry.npmjs.org", "子进程:包管理(npm / bun;sidecar 内 @npmcli/arborist 装 provider)", "§2.2 E13 实测 CONNECT;#1334 Q1.3 provider 安装"),
  https("pypi.org", "子进程:包管理(uv)", "§2.2 E13 实测 CONNECT"),
  https("files.pythonhosted.org", "子进程:包管理(uv)", "§2.2 E13 实测 CONNECT"),
  https("github.com", "子进程:git(https 形态)+ LSP 下载", "§2.2 E13;packages/opencode/src/lsp/server.ts:183"),
  https("api.github.com", "子进程:gh + LSP 下载", "§2.2 E13;packages/opencode/src/lsp/server.ts:600"),
  https("download-cdn.jetbrains.com", "子进程:LSP 自动下载", "packages/opencode/src/lsp/server.ts:1330"),
  https("api.releases.hashicorp.com", "子进程:LSP 自动下载", "packages/opencode/src/lsp/server.ts:1632"),
  https("www.eclipse.org", "子进程:LSP 自动下载(jdtls)", "packages/opencode/src/lsp/server.ts:1207(§2.2 静态枚举漏列,按出处补)"),
  https("release-assets.githubusercontent.com", "子进程:GitHub release 资产下载(装工具 / 下二进制)", "#1334 Q4 choke 臂实拍(shell 工具子进程发起);#1073 owner 裁决二(2026-09-10)"),
  // `#1415` —— 本地 keyless `websearch` 的两个目的地。登出 / BYOK 态下这个工具**是广告给模型的**
  // (`OPENCODE_ENABLE_EXA` 默认开,alpha-config-injection.ts:130 的 `keylessWebsearch`),而它的端点是
  // **编译进包的源码常量** ⇒ 按本表抬头的定义,这正是「应用自己总会去连的地址」= 静态半场。
  // 实测(`#1414` 原生工具全表勘破 + 本票探针):两条在静态与动态两个半场都不在 ⇒ 真 CONNECT 403 ×2,
  // 于是那个按钮装着但**每一次都失败**。
  // 登录代付态**一个字不变**:主权闸(`ALPHA_LOCAL_WEBSEARCH_DENY`)在两条传输 `call()` / `callMcp()`
  // 构造请求**之前**就拒(零出网,判据 websearch-copies.test.ts),那一态下这两行永远不会被问到;
  // 云侧 `cloud_web_search` 的目的地是上面的平台四族,与本条无关。
  // **这两行不是第二份清单**:值的真源是下面 source 点名的两条传输,`network-egress-registry.test.ts`
  // 的 `#1415` 那一节**从那两个文件的源码派生**期望值再与本表比对 —— 任一侧改了域名,当场红。
  https("mcp.exa.ai", "引擎:本地 keyless websearch(Exa MCP 端点)", "EXA_URL @ packages/opencode/src/tool/mcp-websearch.ts + packages/core/src/tool/websearch.ts(两条传输同值,派生闸在 network-egress-registry.test.ts)"),
  https("search.parallel.ai", "引擎:本地 keyless websearch(Parallel MCP 端点)", "PARALLEL_URL @ packages/opencode/src/tool/mcp-websearch.ts + packages/core/src/tool/websearch.ts(两条传输同值,派生闸在 network-egress-registry.test.ts)"),
  // 本机模型(ollama 一类)**刻意不登记** —— owner 2026-09-10 裁决。登记它会写下一句做不到的话:
  //   围栏只放行 `(allow network-outbound (remote ip "localhost:<代理端口>"))`,别的 loopback 端口一律 EPERM
  //   (主 session 实测:围栏下连 127.0.0.1:11434 = EPERM,连放行端口 = ECONNREFUSED,无围栏对照 = CONNECTED);
  //   而 NO_PROXY 含 127.0.0.1/localhost/::1 ⇒ 这类目的地本来就不经代理。两边一夹,注册表对它永远不生效。
  // **BYOK 指向 loopback 的 baseURL 撞的是同一堵墙**,且本就属于「动态」类别、静态表里登记不了。
  // **owner 2026-09-21 裁决:不再支持本地模型(ollama 一类),本机目的地这件事不做了。**
  // 9-10 那条「要单独设计本机目的地怎么走」就此作废 —— 不要再为它开票、也不要凭「以后可能要支持」
  // 把 loopback 加回任何放行集合。产品面当前没有任何本地模型入口(实查:全仓 ollama 只出现在注释与文档里)。
  // 判据:network-egress-registry.test.ts 里那条「表内不得出现 loopback 目的地」——有人凭印象加回来即红。
])

export const egressKey = (host: string, port: number): string => `${host.toLowerCase()}:${port}`

const KEYS: ReadonlySet<string> = (() => {
  const keys = new Set<string>()
  for (const entry of EGRESS_REGISTRY) {
    if (!HOST_SHAPE.test(entry.host)) throw new Error(`egress registry: malformed host ${JSON.stringify(entry.host)}`)
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw new Error(`egress registry: bad port for ${entry.host}: ${entry.port}`)
    if (!entry.category.trim() || !entry.source.trim()) throw new Error(`egress registry: ${entry.host}:${entry.port} lacks category/source`)
    const key = egressKey(entry.host, entry.port)
    if (keys.has(key)) throw new Error(`egress registry: duplicate ${key}`)
    keys.add(key)
  }
  return keys
})()

/**
 * 静态半场的裁决:`host:port` 是否在本表里。**不含**动态半场 —— 代理用的是
 * `isEgressAuthorizedForSidecar`(network-egress-derived.ts)那个并集。
 * 除这两处之外,任何别的地方不得再回答「这个目的地授权了吗」。
 */
export function isEgressAuthorized(host: string, port: number): boolean {
  if (typeof host !== "string" || host.length === 0) return false
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  return KEYS.has(egressKey(host, port))
}
