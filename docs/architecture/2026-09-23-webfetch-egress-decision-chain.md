# 一次网页抓取到底经过哪几道判定,在哪一道被拒(`#1412`)

> 勘破,不是方案。本文只回答「今天跑一次 `webfetch` 会发生什么」,并把每一格的
> 判据来源、实测输入、实测输出钉在坐标上。修法的裁决不在本文。

## 0. 测量口径

| | |
| --- | --- |
| 仓 | `alpha-code@f56748c4f`(`origin/alpha`),worktree `.worktrees/1412-recon` |
| 现场出货件 | `/Applications/Code Puppy 0.1.14.app`(**目录名过时**):`CFBundleIdentifier=com.tide.alphacode`、`CFBundleShortVersionString=0.1.16`;日志自报 `app starting { version: '0.1.16', packaged: true }`、`environment: 'prod'` |
| 现场日志 | `~/Library/Application Support/ai.opencode.desktop/logs/20260923T022251/{main,server}.log` |
| 现场引擎日志 | `~/.local/share/opencode/log/opencode.log` |
| 现场会话存储 | `~/.local/share/opencode/opencode.db`(表 `part`) |
| 复跑运行时 | Electron **42.3.3** 的 `ELECTRON_RUN_AS_NODE`(= **node v24.15.0**),取自 `node_modules/.bun/electron@42.3.3+759ce506b1ed1a42/.../Electron.app`;与出货包 `Electron Framework.framework` 的 `CFBundleVersion=42.3.3` 同版本 |
| 复跑模块 | **生产模块本体**(`network-egress-proxy.ts` / `network-egress-derived.ts` / `network-egress-registry.ts` / `sidecar-env.ts`),不写替身 |
| 日期 | 2026-09-23 |

**票面两处坐标需要更正(读票前先看这两条)**:

1. 工具实现**不是** `packages/core/src/tool/webfetch.ts`。桌面端 sidecar 装载的引擎是
   `packages/opencode`(`packages/ui-mac/src/main/env.d.ts:11-19` 指向
   `../../../opencode/dist/types/src/node`),现场日志里那行 `evaluated permission=…`
   的发出点是 `packages/opencode/src/permission/index.ts:169`。生产的工具实现是
   **`packages/opencode/src/tool/webfetch.ts`**;`packages/core` 下那份是并行实现,不在这条路径上。
2. 现场证据来自**正式渠道 0.1.16**(`com.tide.alphacode`),不是票面说的 dev 渠道 0.1.11
   (`com.tide.alphacode.dev`,`/Applications/Code Puppy.app`)。

## 1. 一次抓取经过的判定链

| # | 闸 | 判据来源(file:line) | 这次的输入 | 这次的输出 |
| --- | --- | --- | --- | --- |
| G1 | 工具策略(`builtin::webfetch`) | `packages/opencode/src/tool/registry.ts:277`(`source: "builtin"`) | `builtin::webfetch` | `action.action=allow` |
| G2 | 引擎权限(`webfetch`) | 请求点 `packages/opencode/src/tool/webfetch.ts:39-48`;裁决与日志 `packages/opencode/src/permission/index.ts:169` | `https://en.wikipedia.org/wiki/Jev_(AI_model)` | `action.action=allow action.pattern=*` |
| G3 | 出网路由(不是判定) | `packages/ui-mac/src/main/sidecar-env.ts:283-295`;装载点 `packages/ui-mac/src/main/sidecar.ts:145` (`useEnvProxy()` → node 内建 `http.setGlobalProxyFromEnv()`) | 八个代理变量**整份改写**为 `http://127.0.0.1:<策略代理端口>`,`NO_PROXY=127.0.0.1,localhost,::1` | 引擎的全局 `fetch` 对任何非 loopback 目的地改发 `CONNECT host:443` 给策略代理 |
| G4 | seatbelt 网络行 | `packages/ui-mac/src/main/process-fence-profile.ts:175-178`(N1 `(deny network*)` / N4 只放行 `localhost:<egressProxyPort>`) | — | **本次不命中**:请求走了代理,没有直连。它的作用是让 G3 绕不过去 |
| G5 | CONNECT authority 解析 | `packages/ui-mac/src/main/network-egress-proxy.ts:92-113`,调用点 `:183-184` | `en.wikipedia.org:443` | 解析通过(`{host:"en.wikipedia.org",port:443}`) |
| **G6** | **授权判定** | `packages/ui-mac/src/main/network-egress-derived.ts:191-193`(静态 ∪ 动态);拒绝点 **`packages/ui-mac/src/main/network-egress-proxy.ts:185`** | `("en.wikipedia.org", 443)` | **`false` ⇒ 403 `reason:"unregistered"`,一次 DNS 都不发、一次拨号都不做** |
| G7 | 错误呈现 | undici 丢弃 403 正文(见 §4);`packages/opencode/src/session/processor.ts:200-208` 落盘 | 隧道未建立 | 会话里存下的是 `Transport error (GET <url>)` |

被拒的那一格,判据的两个半场是:

- **静态半场** `packages/ui-mac/src/main/network-egress-registry.ts:76-100` —— 14 条冻结常量;
- **动态半场** `packages/ui-mac/src/main/network-egress-derived.ts:122-149` —— 只从两处派生
  (`packages/ui-mac/src/main/server.ts:194-197`):①注入面的 provider 表
  (`buildAlphaModelConfig(userDataPath).provider`),②远程 MCP 真源 `mcp-servers/<env>.json`。

## 2. 现场证据(owner 本机,2026-09-23,正式包 0.1.16)

围栏当代确实装上了(`server.log`):

```
process fence applied: addon=fence-20260923T012413298Z libsandbox=/usr/lib/libsandbox.1.dylib profile=2035B
  — every process this engine spawns inherits it
```

那一代的**全部**放行集合 = 14 条静态 + 3 条动态(`main.log`,本次启动共复算 35 次,内容逐次相同):

```
network egress: 3 configured destination(s) authorized for this generation —
  api.deepseek.com:443 (deepseek-byok), open.bigmodel.cn:443 (zhipuai-byok), alpha-gateway.tidelabs.click:443 (alpha)
```

### 2.1 十次抓取,十次被拒,零例外

引擎日志的权限放行 与 主进程日志的代理拒绝**毫秒级一一对应**(引擎只记「允不允许发起」,
不记连接成败;拒绝只写在主进程日志里):

| 引擎 `evaluated permission=webfetch`(UTC) | 代理 `egress.connect`(UTC) | 目的地 | 判定 |
| --- | --- | --- | --- |
| 06:19:26.210 | 06:19:26.213 | `en.wikipedia.org:443` | deny / unregistered / 403 |
| 06:19:52.834 | 06:19:52.835 | `typesafe.ai:443` | 同上 |
| 06:19:52.960 | 06:19:52.962 | `www.datacamp.com:443` | 同上 |
| 06:19:53.064 | 06:19:53.065 | `dev.to:443` | 同上 |
| 06:19:53.238 | 06:19:53.239 | `techcrunch.com:443` | 同上 |
| 06:31:57.710 | 06:31:57.713 | `huggingface.co:443` | 同上 |
| 06:31:57.783 | 06:31:57.785 | `pydantic.dev:443` | 同上 |
| 06:31:57.885 | 06:31:57.885 | `openrouter.ai:443` | 同上 |
| 07:06:39.153 | 07:06:39.155 | `docs.typesafe.ai:443` | 同上 |
| 07:06:39.238 | 07:06:39.239 | `docs.typesafe.ai:443` | 同上 |

(票面评论写的是八次;逐条枚举是 **10 次**,`docs.typesafe.ai` 那两条在票面里没列。)

**对照臂(同一次启动、同一道代理、同一条链)**:`alpha-cloud.tidelabs.click:443` 154 次
`allow`、`github.com:443` 70 次、`api.deepseek.com:443` 21 次、`pypi.org:443` 与
`files.pythonhosted.org:443` 各 1 次 —— 全部 `status:200`。**代理是好的,机器出得了网;
唯一的变量是目的地在不在名单里。**

### 2.2 会话里存下来的是什么

`opencode.db` 的 `part` 表(`json_extract(data,'$.tool')='webfetch'`),全表 13 行:

```
https://news.google.com                       | completed |                                                | 1378ms
https://www.bbc.com/news                      | completed |                                                |  773ms
https://www.reuters.com                       | completed |                                                |  893ms
https://en.wikipedia.org/wiki/Jev_(AI_model)  | error     | Transport error (GET https://en.wikipedia…)    |    7ms
…(其余 9 条同形,2–9 ms)
```

两件事同时被这张表钉住:

- **它曾经是好的**:2026-08-31 三次抓取全 `completed`(耗时 0.8–1.4 s,是真的取回了内容)。
  出网围栏随 **v0.1.13**(tag 日期 2026-09-11)出货 —— 此后本机再没有一次成功的抓取。
- **失败的形态**:2–9 ms 返回,错误文案里**没有任何一个字**提到出网策略。

## 3. 本机复跑:同一条链,单一变量

三个探针都 import **生产模块本体**并在**生产运行时**(Electron 42.3.3 的 node 24.15.0)里发真请求。

### 3.1 判据本身(生产函数,不是替身)

```
=== 动态半场为空(冷启动,没有 BYOK / MCP)===
   DENY   en.wikipedia.org:443   (静态表: out)     …9 个现场目的地全部 DENY
   allow  alpha-cloud.tidelabs.click:443 (静态表: in)
   allow  github.com:443 / pypi.org:443 / files.pythonhosted.org:443
   DENY   api.deepseek.com:443   (静态表: out)     ← 证明 deepseek 是靠动态半场过的

=== 装上 owner 本机那份 BYOK 后 ===
   deriveEgressDestinations({"deepseek-byok":{options:{baseURL:"https://api.deepseek.com"}}})
     -> [{"host":"api.deepseek.com","port":443,"providerId":"deepseek-byok","baseURL":"https://api.deepseek.com/"}]
   allow  api.deepseek.com:443
   DENY   en.wikipedia.org:443

=== 已知的坏(证明探针不是恒 deny)===
   把 en.wikipedia.org:443 塞进动态半场 -> allow
```

### 3.2 端到端:真代理 + 真 CONNECT

```
--- CONNECT en.wikipedia.org:443
    HTTP/1.1 403 Forbidden
    Proxy-Agent: alpha-egress-policy

    alpha egress policy: en.wikipedia.org:443 denied (reason=unregistered) — blocked by this app's
    local egress policy — the destination is neither a registered app endpoint
    (packages/ui-mac/src/main/network-egress-registry.ts) nor one of the built-in model providers
    this machine holds a key for

--- CONNECT github.com:443        HTTP/1.1 200 Connection Established
--- CONNECT api.deepseek.com:443  HTTP/1.1 200 Connection Established
```

### 3.3 单一变量:同一个 URL,只改放行集合

在 Electron 的 node 里按生产接线 `sidecarEgressProxyEnv(port)` 设八个代理变量 +
`http.setGlobalProxyFromEnv()`,再 `fetch()`:

| 动态半场 | `fetch("https://en.wikipedia.org/wiki/Jev_(AI_model)")` | `fetch("https://github.com/")` |
| --- | --- | --- |
| 只有 deepseek(= owner 本机) | `TypeError: fetch failed` ← `AbortError UND_ERR_ABORTED: "Proxy response (403) !== 200 when HTTP Tunneling"` | `status=200`,576 779 B |
| 额外登记 `en.wikipedia.org` | **`status=200`,129 511 B** | `status=200`,576 774 B |

代理侧记录同步从 `verdict:"deny"` 变成 `verdict:"allow"` + `tunnel-closed bytesDown=36969`。
**同一台机器、同一条链、同一个 URL,只改「在不在名单里」这一个变量,结果就从失败变成取回整页。**

## 4. 为什么用户与模型都看不出是我们拦的

`#1382` 做的归因面,在这条路径上**结构性地够不着**,两处各断一次:

1. **正文在传输层就被丢掉了。** 拒绝理由写在 CONNECT 的 403 正文里,而 undici(node 24 的 `fetch`)
   对失败的隧道只保留状态码:`AbortError UND_ERR_ABORTED: "Proxy response (403) !== 200 when HTTP Tunneling"`。
   `packages/ui-mac/src/shared/egress-denial.ts:51` 的 `egressPolicyDenialOf()` 认的是正文里那串前缀 ——
   **它永远等不到那串字节**。(`network-egress-proxy.ts:20` 的头注说「bun 的 fetch 会把代理的 403 当目标响应返回」——
   那是 bun;出货包的引擎跑在 Electron 的 node 上,行为不同。)
2. **消费端只看模型请求那一格。** `egressPolicyDenialOf` 全仓唯一的生产消费者是
   `packages/ui-mac/src/renderer/alpha-ui/session-timeline/timeline-model.ts:710`,它读的是
   **`AssistantMessage.error`**(`turnErrorOf`,`:702-716`)。工具失败不走那里:它落在
   `part.state.status = "error"`(`packages/opencode/src/session/processor.ts:200-208`),
   于是 `#1379` 那次「自带 Key 九天没人发现」的归因修复,对 `webfetch` 一格都没覆盖到。

结果就是会话里那句 `Transport error (GET https://…)` —— 与「那个网站打不开」逐字同形。

## 5. 判定:**设计问题,不是配置问题**

不是「围栏规则写错了」,也不是「漏了几行白名单」。理由三条,每条都可复核:

1. **放行集合的输入是封闭且可枚举的,里面没有一个能装下抓取目标。**
   `server.ts:194-197` 只喂两样东西进去:注入面的 provider 表、远程 MCP 真源。
   `webfetch` 的目的地来自**模型在调用那一刻生成的参数**(`webfetch.ts:39-41` 的 `params.url`),
   它没有、也不该有任何「配置来源」。要它进名单,只能先存在一个「用户事先声明过这个网址」的真源 ——
   而那个真源不存在,因为「事先不知道要读哪个链接」正是这个工具的定义。
2. **匹配语义结构上不接受通配。** `network-egress-registry.ts:42-45` 写死:精确
   `lowercase(host):port`,不做后缀/通配、不做 IP↔名字等价。「补几个域名」在这里不是不够好,
   是**下一个链接照样 403**。
3. **它从来没被枚举过。** 两份网络轴勘破 `docs/architecture/2026-08-25-network-egress-seam.md`
   与 `docs/architecture/2026-09-10-network-egress-on-process-fence.md` 里,`webfetch` 命中数
   **各 0**(同一命令对 `CONNECT` 各命中 22 / 20 条,证明检索手段有效)。§2.2 那张「一次典型会话
   会碰的目的地」表是按**配置来源**组织的(平台 / BYOK / 远程 MCP / 包管理 / git / LSP / 本机模型),
   而 `webfetch` 的目的地**没有配置来源** —— 它整类掉出了那张表。

因此这不是「把某一行改对」,而是「这条路径从设计上就没有位置」。修法必须是一次裁决
(票面已列的四个方向),不是改配置。同源的第三块墙:`#1379`(BYOK)与 `#1381`(远程 MCP)
都靠「给目的地找一个围栏外的真源」解决 —— **这一块没有真源可找**,所以不能照抄前两块。

## 6. 同一堵墙上还有谁(未逐条实测)

- 引擎自带的三个联网工具里:`websearch` 已被 `#1411` 有意关掉;`mcp-websearch` 打的是
  `alpha-cloud.tidelabs.click`(在静态表里,现场日志 `cloud_web_search` 确实返回了结果);
  **`webfetch` 是唯一一个目的地由模型即时决定的**。
- **推论、未实测**:围栏罩住引擎派生的全部子进程,所以 `bash` 工具里 `curl https://<任意站点>`
  撞的是同一道判定。本轮没有跑这一格,不要当成实测结论引用。

## 7. 本轮没有测的

- **界面上到底显示什么**。已钉住的是存进会话的那条文案(`Transport error (GET …)`)与
  `#1382` 归因面够不着的结构原因;renderer 的实际呈现没有取证。
- **模型收到的工具结果文本**是否逐字等于 part 里的 `error` 字段。
- **0.1.13 是不是第一个带围栏的版本**:依据是仓内 `CHANGELOG.md`(#1379 / #1381 两条正文)与
  `network-egress-registry.ts` 抬头的自述,没有在 0.1.13 的包上实跑。

## 8. 复现

前两步只读现场日志与会话库,不动任何进程。

```bash
# ① 现场:引擎侧「允许发起」与主进程侧「被拒」的一一对应
grep -a "webfetch" ~/.local/share/opencode/log/opencode.log | grep -a "2026-09-23"
grep -a "egress.connect" \
  ~/Library/Application\ Support/ai.opencode.desktop/logs/20260923T022251/main.log | grep -a '"deny"'

# ② 现场:会话里存下来的工具结果
sqlite3 ~/.local/share/opencode/opencode.db \
  "select json_extract(data,'\$.state.input.url'), json_extract(data,'\$.state.status'),
          json_extract(data,'\$.state.error')
   from part where json_extract(data,'\$.tool')='webfetch';"

# ③ 本机复跑(生产模块 + 生产运行时);脚本见本节末
cd <repo> && bun run /tmp/probe-1412.ts     # 判据 + 真 CONNECT 正反臂(附录 A)
cd <repo> && bun run /tmp/probe2-1412.ts    # Electron-as-node 端到端(附录 B;拒 / 过两臂)
```

复跑脚本的三条纪律(照抄,别省):

- **不要用出货包做 `ELECTRON_RUN_AS_NODE`。** `/Applications/Code Puppy 0.1.14.app` 的
  `RunAsNode` fuse 是关的:带着 `ELECTRON_RUN_AS_NODE=1` 执行它**不会**跑你的脚本,
  而是**真的把应用起起来**(本轮实测:多出一个 `logs/20260923T081047/` 目录,里面只有一行
  `app starting`,第二实例撞上 SingletonLock 后退出,没有 spawn sidecar、没有写配置)。
  用 `node_modules/.bun/electron@<同版本>/.../Electron.app/Contents/MacOS/Electron`,它的 fuse 是开的。
- **本机 `node` 不行**:v22.22.3 没有 `http.setGlobalProxyFromEnv`(生产用的是 Electron 内建的 node 24)。
  用 bun 也不行:bun 的 fetch 对代理 403 的处理与 node 不同,会量到另一个现象。
- **每一臂都要带一个已知该反向的对照**(登记过的目的地 / 把被拒目的地临时登记进去),
  否则「全是 deny」既可能是判据,也可能是探针坏了。


## 附录 A:判据与真 CONNECT 探针(`/tmp/probe-1412.ts`,用 `bun run` 跑)

```ts
import * as net from "node:net"
const R = "<repo>/packages/ui-mac/src/main"
const { isEgressAuthorizedForSidecar, setConfiguredEgressDestinations, deriveEgressDestinations } =
  await import(`${R}/network-egress-derived.ts`)
const { EGRESS_REGISTRY, isEgressAuthorized } = await import(`${R}/network-egress-registry.ts`)
const { startEgressPolicyProxy } = await import(`${R}/network-egress-proxy.ts`)

const DENIED = ["en.wikipedia.org","typesafe.ai","www.datacamp.com","dev.to","techcrunch.com",
                "huggingface.co","pydantic.dev","openrouter.ai","docs.typesafe.ai"]
const ALLOWED_IN_LOG = ["alpha-cloud.tidelabs.click","github.com","api.deepseek.com","pypi.org",
                        "files.pythonhosted.org"]

for (const e of EGRESS_REGISTRY) console.log(`static ${e.host}:${e.port}`)

setConfiguredEgressDestinations([])                       // 冷启动:动态半场为空
for (const h of [...DENIED, ...ALLOWED_IN_LOG])
  console.log(`${isEgressAuthorizedForSidecar(h,443)?"allow":"DENY "} ${h}:443 (static:${isEgressAuthorized(h,443)})`)

const derived = deriveEgressDestinations({ "deepseek-byok": { options: { baseURL: "https://api.deepseek.com" } } })
setConfiguredEgressDestinations(derived)                  // = owner 本机那一代
console.log("deepseek:", isEgressAuthorizedForSidecar("api.deepseek.com",443),
            "wikipedia:", isEgressAuthorizedForSidecar("en.wikipedia.org",443))

// 已知的坏:塞进去应当变 allow —— 不变就是探针坏了,上面那些 DENY 一格都不算数
setConfiguredEgressDestinations([...derived,
  { host: "en.wikipedia.org", port: 443, providerId: "probe", baseURL: "https://en.wikipedia.org/" }])
console.log("mutation:", isEgressAuthorizedForSidecar("en.wikipedia.org",443))

setConfiguredEgressDestinations(derived)
const records: any[] = []
const proxy = await startEgressPolicyProxy({ log: (r) => records.push(r) })
function connect(authority: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ port: proxy.port, host: "127.0.0.1" })
    let buf = ""
    const done = (v: string) => { try { s.destroy() } catch {}; resolve(v) }
    s.on("connect", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    s.on("data", (c) => { buf += c.toString("utf8"); if (buf.includes("\r\n\r\n")) done(buf) })
    s.on("error", (e) => done(`ERR ${e}`))
    setTimeout(() => done(buf || "TIMEOUT"), 15000)
  })
}
for (const a of ["en.wikipedia.org:443", "github.com:443", "api.deepseek.com:443"])
  console.log(a, "=>", (await connect(a)).split("\r\n")[0])
await proxy.close()
for (const r of records) console.log(JSON.stringify(r))
```

## 附录 B:端到端探针(`/tmp/probe2-1412.ts` + `/tmp/client-probe.cjs`)

`probe2-1412.ts`(`bun run`)起真代理、按生产函数算出 env、把客户端派进 Electron 的 node:

```ts
import { spawn } from "node:child_process"
const R = "<repo>/packages/ui-mac/src/main"
const { setConfiguredEgressDestinations, deriveEgressDestinations } = await import(`${R}/network-egress-derived.ts`)
const { startEgressPolicyProxy } = await import(`${R}/network-egress-proxy.ts`)
const { sidecarEgressProxyEnv } = await import(`${R}/sidecar-env.ts`)

// 拒臂:只有 deepseek。过臂:把 "probe-wikipedia": { options: { baseURL: "https://en.wikipedia.org/" } } 也加进去。
setConfiguredEgressDestinations(deriveEgressDestinations({
  "deepseek-byok": { options: { baseURL: "https://api.deepseek.com" } },
}))
const records: any[] = []
const proxy = await startEgressPolicyProxy({ log: (r) => records.push(r) })
const env = sidecarEgressProxyEnv(proxy.port)     // 八个代理变量,生产函数算的

// fuse 的缘故:必须用 node_modules 里那份 Electron,不能用 /Applications 里的出货包
const ELECTRON = "<repo>/node_modules/.bun/electron@42.3.3+759ce506b1ed1a42/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
const child = spawn(ELECTRON, ["/tmp/client-probe.cjs"],
  { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] })
child.stdout.on("data", (d) => process.stdout.write("[client] " + d))
child.stderr.on("data", (d) => process.stdout.write("[client-err] " + d))
await new Promise((r) => child.on("exit", r))
await proxy.close()
for (const r of records) console.log(JSON.stringify(r))
```

`client-probe.cjs`(在 Electron 的 node 里跑,= 引擎 sidecar 的运行时):

```js
const http = require("node:http")
console.log("node:", process.versions.node, "electron:", process.versions.electron)
http.setGlobalProxyFromEnv()
;(async () => {
  for (const url of ["https://en.wikipedia.org/wiki/Jev_(AI_model)", "https://github.com/"]) {
    try {
      const r = await fetch(url, { redirect: "manual" })
      console.log(`OK   ${url} -> status=${r.status} bytes=${(await r.text()).length}`)
    } catch (e) {
      console.log(`FAIL ${url} -> ${e.name} ${JSON.stringify(e.message)}`)
      let c = e.cause, d = 0
      while (c && d++ < 4) { console.log(`   cause[${d}] ${c.name} ${c.code} ${JSON.stringify(String(c.message))}`); c = c.cause }
    }
  }
})()
```
