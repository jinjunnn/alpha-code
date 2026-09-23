# 引擎原生工具的全表:每一个今天在出货桌面端里能不能用,被哪一道挡住(`#1414`)

> 勘破,不是方案。本文回答「今天打开出货的桌面端,模型手里有哪些工具、其中哪些还能用」,
> 并把每一格的判据来源、实测输入、实测输出钉在坐标上。修法的裁决不在本文。
>
> 本文**引用**两份同日勘破,不重做它们的结论:
> [`2026-09-23-webfetch-egress-decision-chain.md`](2026-09-23-webfetch-egress-decision-chain.md)(`#1412`,出网拒绝点)与
> [`2026-09-23-runtime-permission-tiers.md`](2026-09-23-runtime-permission-tiers.md)(`#1413`,权限档位)。
>
> **合并次序**:那两份写这一行时还在各自分支上(`feat/1412-egress-recon` @ `dfca0be4e`、
> `docs/1413-permission-tiers-recon` @ `3f4afcdbd`),**尚未进 `alpha`**。本文先合会让 docs 闸报
> 两条 broken link —— 那是次序问题不是链接写错:把两份 sibling 复制进同一棵树后
> `python3 scripts/check-doc-links.py` 当场 `✓ 2 relative link(s) resolve`(已实测两个方向)。
> **本文应排在那两份之后合。**

## 0. 测量口径

| | |
| --- | --- |
| 仓 | `alpha-code@f56748c4f`(`origin/alpha`),worktree `.worktrees/1414-tools` |
| 探针运行时 | `bun test`(引擎服务)与 `bun run`(生产模块本体)+ `/usr/bin/sandbox-exec` + `/usr/bin/curl` |
| 隔离 | 全部探针把 `ALPHA_GLOBAL_DIR` / `XDG_*` / `ALPHA_OPENCODE_HOME` / `userDataPath` 钉进 `mkdtemp` 临时目录;**没有起过任何打包实例,没有写过 owner 的任何配置** |
| 日期 | 2026-09-23 |

**本轮没有在打包实例上跑过任何一个工具。** 表里的判定来自两样东西:①**运行时**枚举出的工具集合
(真引擎服务,不是静态 grep);②对每一道闸的**生产判据函数 / 生产 profile** 的实跑。
唯一有现场端到端证据的是 `webfetch`(`#1412` 的 10 次现场拒绝)。每一行的证据等级在表里标出。

## 1. 先找到「注册为工具」的单一权威

散文枚举与静态 grep 都不够,两条都实测到了漏洞:

**静态 grep 会漏掉算出来的 id。** `grep -ran 'Tool\.define(' packages/*/src/` 命中 15 条,
其中 3 条是**带类型参数**的形态(`Tool.define<...>(`)被正则漏掉:`read` / `todowrite` / `question`。
改成 `Tool\.define[<(]` 之后 17 条。而这 17 条里又有 **3 个 id 是表达式不是字面量**:

```
packages/opencode/src/tool/code-mode.ts:223   id = CODE_MODE_TOOL   → "execute"   (code-mode.ts:15)
packages/opencode/src/tool/shell.ts:338       id = ShellID.ToolID   → "bash"      (tool/shell/id.ts:16)
packages/opencode/src/tool/task.ts:81         id = id               → "task"      (task.ts:24)
```

⇒ **静态清单不是权威**。权威是运行时的装配点。

### 1.1 到底有几条注册路径

`ADR-035` 记着两条(`packages/opencode/src/tool/registry.ts` 与
`packages/core/src/tool/builtins.ts`)。实读之后是**四条**,而且**只有三条汇进桌面端**:

| # | 路径 | 内容 | 在出货桌面端的地位 |
| --- | --- | --- | --- |
| R1 | `packages/opencode/src/tool/registry.ts`(v1 引擎) | 17 个 `Tool.define` 叶子 | **活的主路径** |
| R2 | `Plugin.Service` → `registry.ts:221,229` 的 `custom.push` | `@alpha-code/ext` 的 4 个工具 + `.opencode/tool{,s}/*.ts` 目录插件 | 活;与 R1 汇进同一个 `ToolRegistry.all()` |
| R3 | `MCP.Service` → `session/tools.ts:480` | 云 `cloud_*` + 用户配置的 MCP | 活;**不经 `ToolRegistry`**,在 `session/tools.ts` 才合流 |
| R4 | `packages/core/src/tool/builtins.ts`(v2 引擎) | 12 个 `export const name` | **挂载了但桌面端不驱动** —— 见 §1.2 |

因此「模型手里有哪些工具」的**单一权威是 `packages/opencode/src/session/tools.ts`**
(`:162` 取 R1+R2,`:480` 取 R3),不是任何一个 registry。照 `registry.ts` 一条路径列表会漏掉 R3。

`@alpha-code/ext` 的 4 个工具(`packages/ext/src/plugin.ts:232,248,320,335`):
`alpha_reload` / `alpha_register` / `alpha_echo` / `alpha_ping`。它经
`alpha-config-injection.ts:108-110` 无条件并进引擎的 `plugin` 列表。

### 1.2 v2 那份注册今天到不了桌面端的聊天路径

`packages/core` 的 `BuiltInTools` 确实被 `location-services.ts:75` 装载,`SessionV2.node` 也确实被
`server/routes/instance/httpapi/server.ts:299` 挂上。但 alpha 自己的 composer **不走那条路**:

- `composer-state.ts:37-40` 的注释逐字写着「**回到 v1 `promptAsync` 后**,agent 是每条消息自带的字段」,
  并说明 v2 durable 发送那套账本已随之退役;
- `#1412` 的现场日志里,放行记录的发出点是 **v1** 的 `packages/opencode/src/permission/index.ts:169`,
  工具结果落在 **v1** 的 `session/processor.ts:200-208`。

⇒ R4 的 12 份注册在桌面端聊天里**一个都不进模型的工具表**。ADR-035 给它加的主权闸仍然有意义
(纵深),但它不是本表的被测面。**本表的全部行都指 R1/R2/R3。**

### 1.3 运行时权威(实测)

探针跑**真 `ToolRegistry.Service`**(真 `injectAlphaConfig` + 真 `Agent.Service`),
flags 按出货桌面端 sidecar 的真实值(`packages/ui-mac/src/main/server.ts:408-422`:
`OPENCODE_CLIENT=desktop`、`OPENCODE_ENABLE_EXA` 默认 `"1"`、umbrella `OPENCODE_EXPERIMENTAL` **不设**):

```
ALL        ["builtin::apply_patch","builtin::bash","builtin::edit","builtin::glob","builtin::grep",
            "builtin::invalid","builtin::question","builtin::read","builtin::skill","builtin::task",
            "builtin::todowrite","builtin::webfetch","builtin::websearch","builtin::write"]        ← 14
ADVERTISED ["bash","edit","glob","grep","invalid","question","read","skill","task","todowrite",
            "webfetch","websearch","write"]                                                        ← 13
HIDDEN_BY_PERMISSION []
```

(`ALL` 里没有 ext 的 4 个,是因为探针没装插件宿主;生产里它们在。)

**手段自证(先证明它测得出已知的差异)**,三条对照臂全部按预期翻面:

| 自变量 | 期望 | 实测 |
| --- | --- | --- |
| `enableExa` 由 true → false(= 登录后平台代付) | `websearch` 从表里消失 | 消失 ✅ |
| provider 由 `alpha` → `opencode`(`webSearchEnabled()` 的另一半条件) | `websearch` 又出现 | 出现 ✅ |
| `client` 由 `desktop` → `tui` | `question` 消失 | 消失 ✅ |

## 2. 全表

**列的读法**

- **在工具表里** = 今天默认状态下,模型的工具清单里有没有它(§1.3 的 `ADVERTISED`)。
- **判定** = 能用 / 部分 / 不能用 / 未测。`未测` 表示本轮拿不到足以定性的证据,**不猜**。
- **挡它的那一道**:出网围栏 = `network-egress-proxy.ts:185`(判据 `network-egress-derived.ts:191-193`);
  进程围栏 = `process-fence-profile.ts:150-180`;权限规则集 = agent ruleset / `alpha-tool-policy.ts`;
  主权闸 = `webSearchEnabled()` / `ALPHA_LOCAL_WEBSEARCH_DENY`;注册闸 = `RuntimeFlags` / `client` / 模型 id。
- **模型即时生成?** = 这个工具要触碰的**资源标识**是不是由模型在调用那一刻产生的。
  这一列决定「补白名单」是不是一个可能的修法。

| # | 工具 | 在工具表里 | 判定 | 挡它的那一道 | 模型即时生成? | 用户/模型看到什么 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `read` | 是 | **能用** | 权限规则集(工作区外 `external_directory: ask`) | 路径,是 —— 但**有真源**(工作区并集 + 审批) | 工作区外弹审批 | `#1413` 实测 |
| 2 | `glob` | 是 | **能用** | 同上 | 同上 | 同上 | `#1413` 实测 |
| 3 | `grep` | 是 | **能用** | 同上 | 同上 | 同上 | `#1413` 实测 |
| 4 | `edit` | 是 | **能用**(限工作区) | 进程围栏写盘 | 路径,是 —— 有真源 | 工作区外 `Operation not permitted` | 本轮实测 §4.3 |
| 5 | `write` | 是 | **能用**(限工作区) | 进程围栏写盘 | 同上 | 同上 | 本轮实测 §4.3 |
| 6 | `todowrite` | 是 | **能用** | 无 | 否 | — | 判据实测(零闸命中) |
| 7 | `skill` | 是 | **能用**(范围被收窄) | 注册闸:`OPENCODE_DISABLE_EXTERNAL_SKILLS=1` 出厂默认(`ecosystem-import.ts:30`) | 否 | 外部 `.claude`/`.agents` 技能不出现 | 读码 + 默认值实测 |
| 8 | `invalid` | 是 | **能用**(它本身是兜底) | 无 | 否 | — | 判据实测 |
| 9 | `task` | 是 | **未测** | 继承子 agent 的全部闸 | 否(自身);子工具各自算 | — | 整回合未跑 |
| 10 | `question` | 是 | **未测** | 注册闸(`client ∈ {app,cli,desktop}`,桌面满足) | 否 | 渲染与应答链本轮未跑 | 注册面实测,呈现面未测 |
| 11 | **`bash`** | 是 | **部分不能用** | **出网围栏**(网络那一面恒拒);进程围栏(写盘) | **是 —— 命令与目的地全由模型即时生成** | `curl: (56) CONNECT tunnel failed, response 403` | **本轮实测 §4.2** |
| 12 | **`webfetch`** | 是 | **不能用** | **出网围栏** | **是 —— URL 就是模型的入参** | `Transport error (GET <url>)` | `#1412` 现场 10/10 + 本轮复验 |
| 13 | **`websearch`** | 是(登出/BYOK 态) | **不能用** | 登出/BYOK:**出网围栏**;登录代付:**主权闸**(有意关) | 否 —— 目的地是**常量** | 推导:同 `webfetch` 的 undici 形态 | 目的地判据本轮实测;模型面文案未跑 |
| 14 | `apply_patch` | 否(默认) | **未测** | 注册闸:模型 id 含 `gpt-` 且不含 `oss`/`gpt-4`(`registry.ts:340-343`) | 路径,是 —— 有真源 | 模型 id 不匹配时工具不存在 | 过滤实测;**本机无任何 `gpt-` 模型可选,能否走到未测** |
| 15 | `lsp` | 否 | **不能用**(出厂) | 注册闸:`experimentalLspTool`(需 `OPENCODE_EXPERIMENTAL`) | 否 | 工具不存在 | 本轮实测 §4.1 |
| 16 | `execute`(code-mode) | 否 | **不能用**(出厂) | 注册闸:`experimentalCodeMode`;**且**开了之后无 MCP 工具时仍被 `registry.ts:351` 滤掉 | 否 | 工具不存在 | 本轮实测 §4.1 |
| 17 | **`plan_exit`** | 否 | **不能用**(结构性) | 注册闸:`registry.ts:273` 要求 **`flags.client === "cli"`** | 否 | 工具不存在;**开 umbrella 也进不来** | 本轮实测 §4.1 |

### 2.1 非原生但同在这张墙上的(不计入上表计数)

| 类 | 目的地 | 判定 | 依据 |
| --- | --- | --- | --- |
| `@alpha-code/ext` 4 个(`alpha_reload` / `alpha_register` / `alpha_echo` / `alpha_ping`) | 不出网 | 推导:能用 | 读码;本轮未跑 |
| 云 MCP `cloud_web_search` / `cloud_dispatch` / `cloud_status` / `cloud_await` / `cloud_artifacts` | `alpha-cloud.tidelabs.click:443` | **能用**(在静态表里) | 本轮实测 CONNECT 200 |
| owner 本机的 4 个 Office MCP(`alpha-word` / `alpha-excel` / `alpha-powerpoint` / `alpha-pdf`) | 本地 stdio,不出网 | 未测 | 读 owner 配置(只读) |
| 用户自配的远程 MCP | 由 `mcp-servers/<env>.json` 真源派生放行(`#1381`) | 未测 | — |

### 2.2 三个数

按 §2 的 17 个原生工具计:

- **能用 = 8**(`read` `glob` `grep` `edit` `write` `todowrite` `skill` `invalid`)
- **不能用 = 5,外加 1 个部分不能用 = 6**(`webfetch` `websearch` `lsp` `execute` `plan_exit`;
  `bash` 是部分 —— 本地命令能跑,凡是要连非注册目的地的命令恒拒)
- **未测 = 3**(`task` `question` `apply_patch`)

**「不能用 / 部分不能用」这 6 个里,属于「资源由模型临时生成」那一类的是 2 个:`webfetch` 与 `bash` 的出网面。**
其余 4 个各有一个**存在的真源或开关**(常量端点、实验 flag、client 类型),不是同构问题。

## 3. 这张表最有价值的一列:哪些是「资源由模型临时生成」

`#1412` 的结论是:出网放行集合的输入**在构造上封闭**(全部来自 `server.ts:194-197` 两处),
而 `webfetch` 的目的地由模型调用那一刻产生,因此**结构上进不了白名单**。
本轮把这条判据推到全表,得到一个比「webfetch 坏了」更准的分界:

**分界不在「资源由不由模型生成」,而在「这条轴有没有一个围栏之外的真源」。**

| 轴 | 资源由模型生成? | 有没有真源 | 结果 |
| --- | --- | --- | --- |
| 文件路径(`read`/`write`/`edit`/`glob`/`grep`) | **是** | **有** —— 工作区并集(`fence-workspaces/<env>.json`,`#1394`)+ `external_directory` 审批通道 | 能用,越界时**有出口**(审批 / 加工作区) |
| 模型 API 目的地 | 否(来自配置) | 有 —— provider 表(`#1379`) | 能用 |
| 远程 MCP 目的地 | 否(来自配置) | 有 —— `mcp-servers/<env>.json`(`#1381`) | 能用 |
| `websearch` 端点 | 否(源码常量) | **有,但没登记** —— `mcp.exa.ai` / `search.parallel.ai` 是 `mcp-websearch.ts:147,150` 的字面量 | 不能用,但**补两行就好** |
| **`webfetch` 的 URL** | **是** | **没有** | 不能用,**补白名单解决不了** |
| **`bash` 里命令自带的目的地** | **是** | **没有** | 不能用,**补白名单解决不了** |

`webfetch` 与 `bash` 是同一类的两个成员:它们的目的地**没有、也不该有配置来源** ——
「事先不知道要读哪个链接 / 要跑哪条命令」正是这两个工具的定义。
`websearch` 长得像但**不是**同类:它的两个端点是源码里的常量,只是没人把它们登记进
`network-egress-registry.ts`。

## 4. 实测

每一臂都带**已知该成功**与**已知该失败**的对照;缺对照的那一版结果在 §5 被判作废。

### 4.1 注册闸(真 `ToolRegistry`)

```
ADVERTISED plain model=deepseek-chat ["bash","edit","glob","grep","invalid","question","read",
                                      "skill","task","todowrite","webfetch","websearch","write"]
ADVERTISED plain model=gpt-5         ["apply_patch","bash","glob","grep","invalid","question","read",
                                      "skill","task","todowrite","webfetch","websearch"]
                                      ↑ apply_patch 进来,edit/write 同时消失
ALL        umbrella-desktop          [... ,"execute", ... ,"lsp", ...]        ← 开 umbrella 后注册
ADVERTISED umbrella-desktop          [... ,"lsp", ...]  且**没有** execute、**没有** plan_exit
```

三件事被这一格钉住:①`apply_patch` 与 `edit`/`write` 互斥,自变量是模型 id;
②`execute` 即使注册了,无 MCP 工具时仍被滤出工具表;
③**`plan_exit` 在桌面端结构性到不了** —— 开了 umbrella 也进不来,因为条件是 `client === "cli"`。

### 4.2 出网围栏:判据 + 真代理 + 真 seatbelt 子进程

**(a) 生产判据函数**(`isEgressAuthorizedForSidecar`,动态半场 = owner 本机那一代):

```
DENY   webfetch             en.wikipedia.org:443            ← 模型即时生成(#1412 现场实拍)
DENY   websearch(exa)       mcp.exa.ai:443                  ← mcp-websearch.ts:147 常量
DENY   websearch(parallel)  search.parallel.ai:443          ← mcp-websearch.ts:150 常量
DENY   bash(任意站点)        example.com:443 / raw.githubusercontent.com:443
DENY   bash(git over ssh)   github.com:22                   ← 表里只有 :443,端口是键的一部分
ALLOW  lsp(下载)            github.com / api.github.com / download-cdn.jetbrains.com
                            / www.eclipse.org / api.releases.hashicorp.com   (5/5 在静态表里)
ALLOW  cloud_web_search     alpha-cloud.tidelabs.click:443
ALLOW  模型调用             api.deepseek.com:443(动态半场) / alpha-gateway.tidelabs.click:443(静态)
```

自证三条,全部按预期:把 `en.wikipedia.org` 塞进动态半场 ⇒ `true`;冷启动 `github.com` ⇒ `true`;
冷启动 `api.deepseek.com` ⇒ `false`(证明它只靠动态半场,不是恒 allow)。

**(b) 真 CONNECT 走生产代理本体**(`startEgressPolicyProxy`):

```
mcp.exa.ai:443                 => HTTP/1.1 403 Forbidden   verdict:"deny" reason:"unregistered"
search.parallel.ai:443         => HTTP/1.1 403 Forbidden
en.wikipedia.org:443           => HTTP/1.1 403 Forbidden
example.com:443                => HTTP/1.1 403 Forbidden
raw.githubusercontent.com:443  => HTTP/1.1 403 Forbidden
github.com:443                 => HTTP/1.1 200 Connection Established     ← 反样本
api.deepseek.com:443           => HTTP/1.1 200 Connection Established     ← 反样本
alpha-cloud.tidelabs.click:443 => HTTP/1.1 200 Connection Established     ← 反样本
```

**(c) `bash` 那一类的端到端**(`#1412` §6 把这一格标为「推论、未实测」;本轮把它变成实测):
真 `sandbox-exec` + 生产渲染的 profile + 真 `/usr/bin/curl` 子进程 + 真策略代理。

```
S1 无围栏无代理 github        exit=0  HTTPCODE=200        ← 自证:机器出得了网,curl 是好的
S2 无围栏无代理 example       exit=0  HTTPCODE=200        ← 自证
S3 围栏 + 忽略代理 github     exit=6  "Could not resolve host: github.com"
                                                          ← 已知的坏:(deny network*) 连 DNS 一起拦
P1 围栏 + 代理 github         exit=0  HTTPCODE=200        bytesDown=587098
P2 围栏 + 代理 example        exit=56 "CONNECT tunnel failed, response 403"
P3 围栏 + 代理 wikipedia      exit=56 "CONNECT tunnel failed, response 403"
P4 围栏 + 代理 mcp.exa.ai     exit=56 "CONNECT tunnel failed, response 403"
P5 围栏 + 代理 api.deepseek   exit=0  HTTPCODE=401        ← 隧道通了,401 是上游在答(无 Key)
P6 围栏 + 代理 github:22      exit=56 "CONNECT tunnel failed, response 403"
```

**结论:`bash` 里任何连非注册目的地的命令恒被拒,与 `webfetch` 撞的是同一道判定。**
`git clone https://github.com/...` 能过(表内),`git clone git@github.com:...`(:22)过不去,
`curl`/`wget`/`pip install --index-url <任意>` 打非注册主机全部过不去。

### 4.3 进程围栏:写盘

```
W1 围栏 + 写工作区内      exit=0 rc=0                                      文件落盘
W2 围栏 + 写 $HOME 直下   rc=1  "Operation not permitted"                  文件**没有**落盘
W3 围栏 + 写 ~/.npm(W7)  rc=0                                             文件落盘
                          ↑ 证明不是「HOME 下一律拒」,是精确的可写集
W4 无围栏 + 写 $HOME 直下 rc=0                                             文件落盘(自证)
读:围栏是 `(allow default)` + `(deny file-write*)` ⇒ **读不受限**,工作区外照样读得到
```

(W1–W4 的临时文件跑完已删除并核对 `exists === false`。)

### 4.4 一条顺带闭合的:owner 真机上没有覆盖默认权限

`#1413` §10 把「owner 机器上的 `alpha.jsonc` 有没有 `permission` 键」列为未测。
只读实查 `~/Library/Application Support/alpha-code-state/env/prod/alpha.jsonc`:

```
TOP KEYS: ['$schema', 'mcp', 'provider', 'skills']
has permission key: False        agent keys: []        provider ids: []
mcp ids: ['alpha-excel', 'alpha-pdf', 'alpha-powerpoint', 'alpha-word']
```

⇒ **`#1413` 的「出厂默认」那张表在 owner 真机上原样成立**,没有用户级 `permission` 覆盖它。

## 5. 本轮作废过的两次测量(留着,因为下一个人会照样踩)

**① `spawnSync` 冻住了跑代理的那个事件循环。** 第一版 `bash` 臂用 `spawnSync` 起 curl,
结果**所有**臂(包括表内的 `github.com`)都 20 秒超时,而代理侧**零条记录**。
读成「围栏把子进程全拦了」是错的:代理跑在同一个 bun 进程里,`spawnSync` 同步阻塞 ⇒
代理永远没机会 accept。诊断臂给出了指纹:放行**别的**端口的 profile 下 curl 是
`exit=7 "Couldn't connect ... after 0 ms"`(真被 seatbelt 拦),放行**本**端口时连得上却收不到响应 ——
两种失败长得完全不同。改成异步 `spawn` 之后 8 臂全部给出可解释的结果。
**判据:被测进程与观测服务同进程时,一律用异步 spawn;代理侧零记录 = 先怀疑测量,不是先怀疑被测面。**

**② 「工作区外」选在了 `$TMPDIR` 下,而那正是可写集里的 W12。** 第一版写盘臂的 outside 目录是
`mkdtemp` 产物(`/private/var/folders/...`),`process-fence-profile.ts` 的 W12 是
`(subpath "/private/var/folders")` ⇒ 它**本来就该写得进去**,rc=0 不是「围栏没生效」。
换成 `$HOME` 直下之后才拿到真答案。
**判据:测「集合外」之前,先把被测路径拿去和可写集逐行比一遍 —— 「外」是相对那份清单说的,不是相对直觉。**

## 6. 本轮**没有**测的(不要当成已知)

- **打包实例上的任何一个工具**。本文没有起过 `.app`,全部是引擎层 + 生产模块 + 真 seatbelt。
- **`websearch` 失败时模型看到的文案**。目的地被拒是实测的;模型面文本是**推导** ——
  传输是 node/undici(与 `webfetch` 同一条),`#1412` §4.1 已实测 undici 丢弃 CONNECT 403 的正文,
  故推断 `websearch` 同样拿不到那 292 字节的解释。**未跑,不要引用为实测。**
- **`task` 的整回合**、**`question` 的渲染与应答链**。
- **`apply_patch` 能不能真被选到**:本机缓存与出货资源里**零个** `gpt-` 模型 id,
  而模型目录是运行时从平台取的。判据已给出(`registry.ts:340-343`),一条命令就能定性。
- **ext 的 4 个工具、owner 的 4 个 Office MCP** 的实际执行。
- **`bash` 的 403 正文能不能到模型**:`curl -v` 实测能看到 `Proxy-Agent: alpha-egress-policy` 与
  `Content-Length: 292` 两行响应头,但**正文没有被 curl 打印**;工具把 stderr 怎么交给模型本轮未跑。

## 7. 复现

```bash
# 前置(一次):
bash scripts/worktree-bootstrap.sh 1414-tools

# ① 注册权威 —— 真 ToolRegistry,出货桌面端的 flags(探针源码见 §8)
cd .worktrees/1414-tools/packages/opencode
bun test test/tool/alpha-1414-inventory.test.ts test/tool/alpha-1414-variants.test.ts

# ② 静态清单的两个漏洞(证明为什么不能用 grep 当权威)
grep -ran 'Tool\.define('   packages/*/src/ --include='*.ts' | grep -v '\.test\.ts' | wc -l   # 15
grep -ran 'Tool\.define[<(]' packages/*/src/ --include='*.ts' | grep -v '\.test\.ts' | wc -l  # 17

# ③ 出网判据 + 真 CONNECT + 真 seatbelt(探针源码见 §8)
cd .worktrees/1414-tools
bun run /tmp/probe-1414-egress.ts      # 判据,含 3 条自证臂
bun run /tmp/probe-1414-connect.ts     # 真代理 CONNECT,正反各 5/3 条
bun run /tmp/probe-1414-bash2.ts       # 真 seatbelt + 真 curl,8 臂(必须用异步 spawn,见 §5①)
bun run /tmp/probe-1414-write.ts       # 写盘围栏,4 臂(「外」不能选 $TMPDIR,见 §5②)
```

**新增工具会不会自己长出来**:会。①`ToolRegistry.all()` 是运行时装配,新叶子加进
`registry.ts` 的 `builtin[]` 就出现在 `ALL` 里;②`session/tools.ts:480` 那一路同理。
但**注意**:`ADR-035` R4 已给出一个两张静态网都看不见的构造(算出来的 id + 复用已有传输),
所以**只有运行时枚举是权威**,§7② 那两条 grep 只用来证明静态手段不够,不要拿它当清单。

## 8. 探针源码

四份探针**刻意不进 `main`** —— 它们是勘破仪器,不是闸门。落点:
`packages/opencode/test/tool/alpha-1414-*.test.ts` 与 `/tmp/probe-1414-*.ts`。
全文见本次 worktree(`.worktrees/1414-tools`),要点:

- **注册权威探针**:`LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]),
  [[RuntimeFlags.node, RuntimeFlags.layer({client:"desktop", enableExa:true, ...})]])`,
  再 `registry.all()` / `registry.tools({providerID, modelID, agent})` /
  `Permission.disabled(ids, build.permission)`。三条自证臂见 §1.3。
- **出网探针**:只 import 生产模块本体(`network-egress-derived.ts` /
  `network-egress-registry.ts` / `network-egress-proxy.ts` / `sidecar-env.ts` /
  `process-fence-profile.ts`),不写替身。
- **seatbelt 探针**:`renderProcessFenceProfile(...)` 渲染出的字节直接喂
  `/usr/bin/sandbox-exec -f <profile>`;**不经 `npm run`**,子进程用异步 `spawn`,
  每一臂都检查 `spawned === true` 与文件是否真的落盘(空输出不算拦住)。

## 附录:四份探针的源码(照抄可复跑)

> 路径里的 `<repo>` 换成你的 checkout。判据探针只 import 生产模块本体,不写替身。

<details><summary>A. 注册权威(`packages/opencode/test/tool/alpha-1414-inventory.test.ts`,`bun test`)</summary>

```ts
// 勘破探针(ac#1414)—— 不进 main。
// 目的:拿到「出货桌面端的引擎到底把哪些工具交给模型」的**运行时权威**,
// 而不是靠静态 grep 枚举(静态枚举漏 computed id:code-mode/shell/task 三个)。
import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { injectAlphaConfig } from "../../../ui-mac/src/main/alpha-config-injection"

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1414-")))
process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
for (const d of [
  process.env.ALPHA_GLOBAL_DIR,
  process.env.XDG_CONFIG_HOME,
  process.env.ALPHA_OPENCODE_HOME,
  process.env.XDG_DATA_HOME,
])
  fs.mkdirSync(d!, { recursive: true })
const userData = path.join(tmp, "userdata")
fs.mkdirSync(userData, { recursive: true })
console.log("INJECT", JSON.stringify(injectAlphaConfig(userData)))

const root = LayerNode.group([ToolRegistry.node, Agent.node])

// 出货桌面端 sidecar 的真实 flags(packages/ui-mac/src/main/server.ts:408-422):
//   OPENCODE_CLIENT=desktop、OPENCODE_ENABLE_EXA 默认 "1"(登出/BYOK 态)。
//   OPENCODE_EXPERIMENTAL 桌面**不设** ⇒ codeMode/lspTool/planMode 全 false。
const DESKTOP = {
  client: "desktop",
  enableExa: true,
  enableParallel: false,
  experimentalCodeMode: false,
  experimentalLspTool: false,
  experimentalPlanMode: false,
} as const

const desktop = testEffect(LayerNode.compile(root, [[RuntimeFlags.node, RuntimeFlags.layer(DESKTOP)]]))
// 对照臂 1:平台付费态(登录后 applyWebSearchSovereignty 把 4 个 keyless flag 全关)
const paid = testEffect(
  LayerNode.compile(root, [[RuntimeFlags.node, RuntimeFlags.layer({ ...DESKTOP, enableExa: false })]]),
)
// 对照臂 2:CLI(证明 client 这一格真的在动 —— question 只在 app/cli/desktop 下注册)
const cliFlags = testEffect(
  LayerNode.compile(root, [[RuntimeFlags.node, RuntimeFlags.layer({ ...DESKTOP, client: "tui", enableExa: false })]]),
)

afterEach(async () => {
  await disposeAllInstances()
})

const dumpFor = (label: string, providerID: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const build = yield* agents.get("build")
    const all = yield* registry.all()
    console.log(
      `ALL ${label} ${JSON.stringify(all.map((t) => `${t.identity.source}::${t.id}`).sort())}`,
    )
    const advertised = yield* registry.tools({
      providerID: ProviderV2.ID.make(providerID),
      modelID: ModelV2.ID.make("deepseek-chat"),
      agent: build!,
    })
    console.log(`ADVERTISED ${label} provider=${providerID} ${JSON.stringify(advertised.map((t) => t.id).sort())}`)
    const hidden = Permission.disabled(
      all.map((t) => t.id),
      build!.permission,
    )
    console.log(`HIDDEN_BY_PERMISSION ${label} ${JSON.stringify([...hidden].sort())}`)
    return advertised.map((t) => t.id)
  })

desktop.instance("desktop 出货形态的工具清单", () =>
  Effect.gen(function* () {
    const alpha = yield* dumpFor("desktop-exa-on", "alpha")
    // 自证:这个手段测得出已知的差异 —— websearch 在 alpha provider 上靠 enableExa 才在。
    expect(alpha).toContain("websearch")
    expect(alpha).toContain("webfetch")
  }),
)

paid.instance("平台付费态(keyless flag 全关)", () =>
  Effect.gen(function* () {
    const alpha = yield* dumpFor("desktop-exa-off", "alpha")
    const oc = yield* dumpFor("desktop-exa-off", "opencode")
    // 已知的坏:同一棵树、同一 agent,只改 provider/flag,websearch 必须消失/出现。
    expect(alpha).not.toContain("websearch")
    expect(oc).toContain("websearch")
  }),
)

cliFlags.instance("非 desktop client:question 应当消失", () =>
  Effect.gen(function* () {
    const ids = yield* dumpFor("tui", "alpha")
    expect(ids).not.toContain("question")
  }),
)

```

</details>

<details><summary>B. 注册闸变量臂(`packages/opencode/test/tool/alpha-1414-variants.test.ts`,`bun test`)</summary>

```ts
// 勘破探针 2(ac#1414)—— 不进 main。自变量:模型 id、实验 flag、client。
import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { injectAlphaConfig } from "../../../ui-mac/src/main/alpha-config-injection"

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1414b-")))
process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
for (const d of [process.env.ALPHA_GLOBAL_DIR, process.env.XDG_CONFIG_HOME, process.env.ALPHA_OPENCODE_HOME, process.env.XDG_DATA_HOME])
  fs.mkdirSync(d!, { recursive: true })
const userData = path.join(tmp, "userdata")
fs.mkdirSync(userData, { recursive: true })
injectAlphaConfig(userData)

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const mk = (o: Record<string, unknown>) => testEffect(LayerNode.compile(root, [[RuntimeFlags.node, RuntimeFlags.layer(o as never)]]))

const base = { client: "desktop", enableExa: true, enableParallel: false } as const
const plain = mk({ ...base })
// 用户在自己的 shell 里 `export OPENCODE_EXPERIMENTAL=1` 之后(preferAppEnv 第 1 步会导入它)
const umbrella = mk({ ...base, experimentalCodeMode: true, experimentalLspTool: true, experimentalPlanMode: true })

afterEach(async () => { await disposeAllInstances() })

const advertise = (label: string, modelID: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const build = yield* agents.get("build")
    const all = yield* registry.all()
    console.log(`ALL ${label} ${JSON.stringify(all.map((t) => t.id).sort())}`)
    const adv = yield* registry.tools({
      providerID: ProviderV2.ID.make("alpha"),
      modelID: ModelV2.ID.make(modelID),
      agent: build!,
    })
    const ids = adv.map((t) => t.id).sort()
    console.log(`ADVERTISED ${label} model=${modelID} ${JSON.stringify(ids)}`)
    return ids
  })

plain.instance("模型 id 决定 apply_patch vs edit/write", () =>
  Effect.gen(function* () {
    const ds = yield* advertise("plain", "deepseek-chat")
    const gpt = yield* advertise("plain", "gpt-5")
    expect(ds).toContain("edit"); expect(ds).not.toContain("apply_patch")
    expect(gpt).toContain("apply_patch"); expect(gpt).not.toContain("edit"); expect(gpt).not.toContain("write")
  }),
)

umbrella.instance("OPENCODE_EXPERIMENTAL=1 之后:lsp / execute 进来,plan_exit 仍不进(client!=cli)", () =>
  Effect.gen(function* () {
    const ids = yield* advertise("umbrella-desktop", "deepseek-chat")
    expect(ids).toContain("lsp")
    // plan_exit 在 desktop 上结构性到不了:registry.ts 的条件是 flags.client === "cli"
    expect(ids).not.toContain("plan_exit")
  }),
)

```

</details>

<details><summary>C. 出网判据 + 真 CONNECT(`bun run`)</summary>

```ts
// ac#1414 勘破探针:每个工具需要的目的地,过**生产判据函数**。
const R = "<repo>/packages/ui-mac/src/main"
const { isEgressAuthorizedForSidecar, setConfiguredEgressDestinations, deriveEgressDestinations } =
  await import(`${R}/network-egress-derived.ts`)
const { EGRESS_REGISTRY, isEgressAuthorized } = await import(`${R}/network-egress-registry.ts`)

console.log("STATIC_REGISTRY_SIZE", EGRESS_REGISTRY.length)
for (const e of EGRESS_REGISTRY) console.log(`  static ${e.host}:${e.port}`)

// owner 本机那一代的动态半场(#1412 §2 现场日志:deepseek + zhipuai + alpha-gateway)
const derived = deriveEgressDestinations({
  "deepseek-byok": { options: { baseURL: "https://api.deepseek.com" } },
  "zhipuai-byok": { options: { baseURL: "https://open.bigmodel.cn" } },
})
setConfiguredEgressDestinations(derived)
console.log("DYNAMIC", JSON.stringify(derived.map((d: any) => `${d.host}:${d.port}`)))

const CASES: [string, string, number, string][] = [
  // [工具, host, port, 这个目的地从哪来]
  ["webfetch",  "en.wikipedia.org", 443, "模型即时生成(#1412 现场实拍)"],
  ["webfetch",  "docs.typesafe.ai", 443, "模型即时生成(#1412 现场实拍)"],
  ["websearch(exa)",      "mcp.exa.ai",        443, "tool/mcp-websearch.ts:148 常量"],
  ["websearch(parallel)", "search.parallel.ai",443, "tool/mcp-websearch.ts:150 常量"],
  ["lsp(下载)", "github.com",                   443, "lsp/server.ts:183"],
  ["lsp(下载)", "api.github.com",               443, "lsp/server.ts:600"],
  ["lsp(下载)", "download-cdn.jetbrains.com",   443, "lsp/server.ts:1330"],
  ["lsp(下载)", "www.eclipse.org",              443, "lsp/server.ts:1207"],
  ["lsp(下载)", "api.releases.hashicorp.com",   443, "lsp/server.ts:1632"],
  ["bash(git/https)",  "github.com",         443, "子进程 git"],
  ["bash(git/ssh)",    "github.com",          22, "子进程 git over ssh"],
  ["bash(npm)",        "registry.npmjs.org", 443, "子进程包管理"],
  ["bash(pip/uv)",     "pypi.org",           443, "子进程包管理"],
  ["bash(任意站点)",   "example.com",        443, "模型即时生成"],
  ["bash(任意站点)",   "raw.githubusercontent.com", 443, "模型即时生成(常见)"],
  ["cloud_web_search", "alpha-cloud.tidelabs.click", 443, "平台 cloud MCP(静态表)"],
  ["模型调用(BYOK)",  "api.deepseek.com",   443, "动态半场"],
  ["模型调用(平台)",  "alpha-gateway.tidelabs.click", 443, "静态表"],
]
console.log("\n--- 判据:isEgressAuthorizedForSidecar(host, port) ---")
for (const [tool, host, port, src] of CASES) {
  const dyn = isEgressAuthorizedForSidecar(host, port)
  const stat = isEgressAuthorized(host, port)
  console.log(`${dyn ? "ALLOW" : "DENY "}  ${tool.padEnd(20)} ${host}:${port}  (static=${stat})  ← ${src}`)
}

// ── 自证 ①(已知的坏):把 wikipedia 塞进动态半场必须变 ALLOW,不变 = 探针坏了 ──
setConfiguredEgressDestinations([...derived, { host: "en.wikipedia.org", port: 443, providerId: "probe", baseURL: "https://en.wikipedia.org/" }])
console.log("\nSELFTEST mutation en.wikipedia.org:443 =>", isEgressAuthorizedForSidecar("en.wikipedia.org", 443), "(必须 true)")
// ── 自证 ②(已知的好):github.com 在静态表里,冷启动(动态半场为空)也必须 ALLOW ──
setConfiguredEgressDestinations([])
console.log("SELFTEST cold github.com:443 =>", isEgressAuthorizedForSidecar("github.com", 443), "(必须 true)")
console.log("SELFTEST cold api.deepseek.com:443 =>", isEgressAuthorizedForSidecar("api.deepseek.com", 443), "(必须 false —— 它只靠动态半场)")
console.log("SELFTEST cold mcp.exa.ai:443 =>", isEgressAuthorizedForSidecar("mcp.exa.ai", 443), "(本轮被测项)")

```

</details>

<details><summary>D. 真 seatbelt + 真 curl 子进程(`bun run`;**必须异步 spawn**)</summary>

```ts
// ac#1414:bash 工具那一类的端到端臂(修正版 —— 用**异步** spawn;spawnSync 会冻住跑代理的那个事件循环,
// 上一版因此所有臂都超时且代理零记录:那是测量故障,不是结果)。
import { spawn } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
const R = "<repo>/packages/ui-mac/src/main"
const { setConfiguredEgressDestinations, deriveEgressDestinations } = await import(`${R}/network-egress-derived.ts`)
const { startEgressPolicyProxy } = await import(`${R}/network-egress-proxy.ts`)
const { renderProcessFenceProfile } = await import(`${R}/process-fence-profile.ts`)
const { sidecarEgressProxyEnv } = await import(`${R}/sidecar-env.ts`)

setConfiguredEgressDestinations(
  deriveEgressDestinations({ "deepseek-byok": { options: { baseURL: "https://api.deepseek.com" } } }),
)
const records: any[] = []
const proxy = await startEgressPolicyProxy({ log: (r: any) => records.push(r) })
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1414-bash-")))
const ws = path.join(tmp, "w"); fs.mkdirSync(ws); const ud = path.join(tmp, "u"); fs.mkdirSync(ud)
const mk = (port: number) => renderProcessFenceProfile({
  workspaces: [ws], alphaGlobalRoot: path.join(tmp,"a"), userDataPath: ud, stateHome: ud,
  roots: { home: os.homedir(), dataHome: path.join(tmp,"d"), cacheHome: path.join(tmp,"c"), configHome: path.join(tmp,"g") },
  egressProxyPort: port,
})
const pf = path.join(tmp,"f.sb"); fs.writeFileSync(pf, mk(proxy.port))
const PROXY_ENV = sidecarEgressProxyEnv(proxy.port)
console.log("PROXY_PORT", proxy.port, "PROXY_ENV", JSON.stringify(PROXY_ENV))

function run(label: string, argv: string[], env: Record<string,string>): Promise<void> {
  return new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore","pipe","pipe"] })
    let out = "", err = "", spawned = false
    c.on("spawn", () => { spawned = true })
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d))
    c.on("error", (e) => { console.log(`${label}\n   SPAWN_ERROR ${e.message}`); resolve() })
    c.on("close", (code) => {
      console.log(`${label}\n   spawned=${spawned} exit=${code} out=${JSON.stringify(out.trim().slice(0,120))} err=${JSON.stringify(err.trim().slice(0,200))}`)
      resolve()
    })
  })
}
const CURL = "/usr/bin/curl"
const BASE = { PATH: "/usr/bin:/bin", HOME: os.homedir() }
const W = (u: string, extra: string[] = []) => ["-sS","--max-time","25","-o","/dev/null","-w","HTTPCODE=%{http_code}",...extra,u]

// ── 自证:先证明这套手段测得出「已知的好」与「已知的坏」 ────────────────────────
await run("S1 无围栏无代理 github(必须 200 —— 否则本轮测量作废)", [CURL, ...W("https://github.com/",["--noproxy","*"])], BASE)
await run("S2 无围栏无代理 example(必须 200)",                    [CURL, ...W("https://example.com/",["--noproxy","*"])], BASE)
await run("S3 围栏 + 忽略代理 github(已知该被围栏拦:DNS 死)",    ["/usr/bin/sandbox-exec","-f",pf,CURL,...W("https://github.com/",["--noproxy","*"])], BASE)

// ── 生产形态:围栏 + 继承的代理 env(bash 工具的子进程就是这样) ──────────────────
const PENV = { ...BASE, ...PROXY_ENV }
await run("P1 围栏+代理 github(静态表内)",       ["/usr/bin/sandbox-exec","-f",pf,CURL,...W("https://github.com/")], PENV)
await run("P2 围栏+代理 example(表外,模型即时生成的典型)", ["/usr/bin/sandbox-exec","-f",pf,CURL,...W("https://example.com/")], PENV)
await run("P3 围栏+代理 wikipedia(表外)",        ["/usr/bin/sandbox-exec","-f",pf,CURL,...W("https://en.wikipedia.org/")], PENV)
await run("P4 围栏+代理 mcp.exa.ai(websearch 的目的地)", ["/usr/bin/sandbox-exec","-f",pf,CURL,...W("https://mcp.exa.ai/mcp")], PENV)
await run("P5 围栏+代理 api.deepseek.com(动态半场内)", ["/usr/bin/sandbox-exec","-f",pf,CURL,...W("https://api.deepseek.com/")], PENV)
// git over ssh:端口 22,静态表只有 443
await run("P6 围栏+代理 github:22(git over ssh;表里只有 :443)", ["/usr/bin/sandbox-exec","-f",pf,CURL,...W("https://github.com:22/")], PENV)

await proxy.close()
console.log("\n--- 代理侧记录 ---"); for (const r of records) console.log(JSON.stringify(r))
fs.rmSync(tmp,{recursive:true,force:true})

```

</details>

<details><summary>E. 写盘围栏(`bun run`;「外」不能选 $TMPDIR)</summary>

```ts
// ac#1414 写盘围栏(修正版)。上一版的「工作区外」落在 $TMPDIR = /private/var/folders 之下,
// 而那正是可写集的 W12 —— 测的是一个本来就该放行的位置,rc=0 不是结论。
// 本版的「外」用 HOME 直下(HOME 本身被排除,只有 .npm/.zsh_history/.opencode/... 等少数几条在集合里)。
import { spawn } from "node:child_process"
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path"
const R = "<repo>/packages/ui-mac/src/main"
const { renderProcessFenceProfile } = await import(`${R}/process-fence-profile.ts`)
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1414-w-")))
const ws = path.join(tmp,"w"); fs.mkdirSync(ws); const ud = path.join(tmp,"u"); fs.mkdirSync(ud)
const HOME = os.homedir()
const OUT  = path.join(HOME, ".alpha-1414-probe-outside.txt")          // HOME 直下 = 集合外
const IN_NPM = path.join(HOME, ".npm", ".alpha-1414-probe.txt")        // W7,集合内(对照)
const pf = path.join(tmp,"f.sb")
fs.writeFileSync(pf, renderProcessFenceProfile({
  workspaces: [ws], alphaGlobalRoot: path.join(tmp,"a"), userDataPath: ud, stateHome: ud,
  roots: { home: HOME, dataHome: path.join(tmp,"d"), cacheHome: path.join(tmp,"c"), configHome: path.join(tmp,"g") },
  egressProxyPort: 61000,
}))
const run = (label: string, argv: string[]) => new Promise<void>((res) => {
  const c = spawn(argv[0], argv.slice(1), { env: { PATH: "/usr/bin:/bin", HOME }, stdio: ["ignore","pipe","pipe"] })
  let o = "", e = ""
  c.stdout.on("data", d => o += d); c.stderr.on("data", d => e += d)
  c.on("close", (code) => { console.log(`${label}\n   exit=${code} stdout=${JSON.stringify(o.trim())} stderr=${JSON.stringify(e.trim().slice(0,240))}`); res() })
  c.on("error", (err) => { console.log(`${label}\n   SPAWN_ERROR ${err.message}`); res() })
})
const SB = ["/usr/bin/sandbox-exec","-f",pf]
for (const p of [OUT, IN_NPM]) { try { fs.unlinkSync(p) } catch {} }

console.log("OUT =", OUT, " exists_before =", fs.existsSync(OUT))
await run("W1 围栏 + 写工作区内(应成功)",        [...SB,"/bin/sh","-c",`echo STARTED; echo hi > ${ws}/in.txt; echo rc=$?`])
await run("W2 围栏 + 写 HOME 直下(已知该被拦)",  [...SB,"/bin/sh","-c",`echo STARTED; echo hi > ${OUT}; echo rc=$?`])
console.log("   → 文件真的落盘了吗:", fs.existsSync(OUT))
await run("W3 围栏 + 写 ~/.npm(W7,集合内 —— 证明不是「HOME 下一律拒」)", [...SB,"/bin/sh","-c",`echo STARTED; echo hi > ${IN_NPM}; echo rc=$?`])
console.log("   → 文件真的落盘了吗:", fs.existsSync(IN_NPM))
await run("W4 无围栏写 HOME 直下(自证:这一格本来写得了)", ["/bin/sh","-c",`echo hi > ${OUT}; echo rc=$?`])
console.log("   → 文件真的落盘了吗:", fs.existsSync(OUT))
for (const p of [OUT, IN_NPM]) { try { fs.unlinkSync(p) } catch {} }
console.log("cleanup: OUT exists =", fs.existsSync(OUT), " IN_NPM exists =", fs.existsSync(IN_NPM))
fs.rmSync(tmp,{recursive:true,force:true})

```

</details>
