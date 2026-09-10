// REQ-137 (`#1336`) —— 授权目的地注册表:**唯一权威**。
//
// 引擎 sidecar 那棵进程树的出网只有一条路:loopback 上的策略代理(network-egress-proxy.ts)。代理对每一条
// CONNECT 只问一个问题 ——「这个 `host:port` 在不在本表里」—— 不在就 403 并留下结构化记录。它**只读本表**;
// 本仓不存在第二张目的地清单(散文、JSON、env 都不算),要放行一个新目的地只能改这里,并在 PR 里
// 带上它的出处坐标。这是 `#1073` AC2 的形状:单一权威 + 咽喉点。
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
//     本轮注册表是静态的;它们经代理会被 403(可观察)。让注册表吃运行时来源是下一张票的事,不在这里预留抽象。
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
  { host: "127.0.0.1", port: 11434, category: "子进程:本机模型(ollama)", source: "§2.2 lsof 实拍" },
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

/** 代理的唯一裁决输入:`host:port` 是否在注册表里。任何别的地方不得再回答这个问题。 */
export function isEgressAuthorized(host: string, port: number): boolean {
  if (typeof host !== "string" || host.length === 0) return false
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  return KEYS.has(egressKey(host, port))
}
