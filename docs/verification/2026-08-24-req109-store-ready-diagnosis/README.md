---
title: "REQ-109 #1104 诊断:connect→store_ready 的 1.2–7.1 秒在等什么"
kind: verification
status: complete
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-08-24
review_after: 2026-11-24
---

# 结论:渲染端零责任;整段是引擎进程 fork 后 2.1–8.1 秒才对请求可服务的「启动尾巴」,且它不是写死的常量

`alpha-code#1104`(父票 `#857`,数据来自 `#1102`)。三句话:

1. **构成**:`renderer.projects.connect → renderer.projects.store_ready` 之间,渲染端只做一件事——
   一次 `project.list()` HTTP 往返(无重试、无定时器、无兜底路径)。整段耗时都在这**一次调用的响应到达时刻**上。
2. **在等谁**:引擎(sidecar)在 fork 后约 0.87s 就完成监听 + 预热、0.95s 还能 2ms 答复 main 的探针,
   但对**此后**到达的请求集体不答,直到 fork 后 **2.13–8.06s**(中位 3.45s)的某个共同释放时刻;
   窗口里并发的另一条请求(model list)同样挂起、与 `store_ready` 在 ~35ms 内同刻释放、复试后 5ms 内返回。
   等待完全在引擎侧(`packages/opencode`,上游路径),渲染端与 main 全程毫秒级。
3. **不是固定值**:三条互相独立的证据(见 §3)。它是真实等待,且含一个**随时段而非负载**漂移的外部成分。

## 0. 口径

| | |
| --- | --- |
| 数据 | `#1102` 的 78 个样本(clean/noisy 各 39,含各 3 个首启样本),**未重测** —— 见 [`2026-08-24-req109-p95-post1098-1099`](../2026-08-24-req109-p95-post1098-1099/README.md) |
| 代码 | `alpha@3c2c2451e`(含 `#1098`/`#1099`) |
| 补充证据 | ① 本机引擎日志 `~/.local/share/opencode/log/opencode.log`(同日 00:26–04:26Z,owner 桌面应用的 25 次 sidecar 轮换 boot);② 工作树源码裸引擎实验(bun serve,同一套真实配置);③ 本机 `uv`/代理/系统状态实测 |
| 本轮没做 | 打包复测(交由后续 VERIFY 票);任何生产代码改动 |

## 1. AC1 —— 这段时间的构成

### 1.1 渲染端:单次 HTTP 往返,别无他物

坐标:`packages/ui-mac/src/renderer/sidebar/use-projects.ts`。

- `connect()`(:642,mark 在 :651)发 `renderer.projects.connect` 后立即 `void loadProjects()` 与 `void subscribe()`;
- `loadProjects()`(:248)就是 `await c.project.list()` → 本地过滤/reconcile(纯内存)→
  首次翻真时发 `renderer.projects.store_ready`(:288);
- **无重试**:失败只置 `error`,不会再发 `store_ready`;78 个样本全部成功返回(`projects:1`);
- **SDK 无重试**:`@opencode-ai/sdk/src/v2/client.ts`(93 行)对非 SSE 调用没有任何 backoff;
- **1s 兜底路径被排除**:78/78 样本 `connect.reason=generation-event`,`bridge-fallback-timer` 一次都没走。

⇒ 区间 = 请求发出(~1.17s,78 个样本 connect 时刻 span 仅 100ms)到响应到达。拆分只能发生在引擎侧。

### 1.2 引擎侧:一个「fork 后 T 秒才可服务」的窗口,T 多峰分布

窗口两端的既有事实(样本内事件,main 侧时钟):

| 时刻(典型) | 事件 | 含义 |
| --- | --- | --- |
| ~0.20s | `main.sidecar.boot.fork.start` | 引擎进程 fork |
| ~0.87s | `main.sidecar.ready_ipc`(prewarm 150–157ms,status 200) | 监听完成,`~/Alpha` location 图预热**已收敛**(marker+model 两个进程内请求都 200) |
| ~0.92–0.95s | `main.sidecar.catalog_liveness.confirmed`(elapsed 2–6ms,probes 1) | main 对引擎发的**真 HTTP** marker 探针,首探即 200 |
| ~1.17s | `renderer.projects.connect` + `project.list` 发出 | 此后引擎不再答复任何观测到的请求 |
| fork+2.13–8.06s | `renderer.projects.store_ready` | 共同释放时刻;其后一切请求 1–42ms |

以 fork.start 为锚,36 个 clean 稳态样本的 `store_ready` 落点:

```
2130 2159 2393 | 3155 | 3367…3555(24 个,span 188ms)| 3785 | 4584 | 6922 7017 7044 7327 | 8040 8055
```

### 1.3 「集体不答」的两个并发写照

首启样本里 composer 走恢复路径、在窗口**中途**就 mount 并发起 model list——它成了第二个证人:

| 样本 | project.list 挂起 | model list(并发) | 释放差 | 复试 |
| --- | --- | --- | --- | --- |
| clean-r1 s1 | 18,887ms | **6,831ms,outcome=cancelled** | 35ms | **5.7ms** |
| noisy-r1 s1 | 16,681ms | **4,674ms,outcome=cancelled** | 33ms | **4.7ms** |

两条不同端点的请求同挂、同释放、复试即毫秒级 ⇒ 不是 `project.list` 这一条路的成本,
是引擎在该窗口对请求**整体**不可服务。稳态样本窗口内只有 `project.list` 一条请求可观测,
但其释放时刻的模态结构与首启完全同构,归同一机制。

### 1.4 引擎内部:能圈到哪一段,坐标是什么

打包应用的嵌入式引擎**不写文件日志**、也没有可开启的 span 导出(见 §5),
`#1102` 的采样对引擎内部是盲的。可用的最近证据是**同一天、同一台机、owner 真实桌面应用**
的引擎日志(应用每 ~10 分钟 token 轮换重启 sidecar,25 次 boot 全被记录):

- 每次 boot 的阻塞段都落在 **per-directory location-services 构建**内
  (`packages/core/src/location-services.ts:101` "booting location services"),
- 该段以 **v1 MCP 全量连接**为界(`packages/opencode/src/mcp/index.ts` `MCP.state` 初始化
  `Effect.forEach(..., concurrency: "unbounded")` **await 每一个已配置 server**;
  本机配置 = 4 个 `uv run` 本地 office server(timeout 5000)+ 登录态下的 remote cloud MCP),
  终于 `server unavailable key=cloud status=needs_auth`,随后 skill 装载(`init count=20`)立即完成;
- 25 次的阻塞时长:**1.79–9.67s**(众数 ~2.0s,尾 2.9/3.5/3.8/5.0/9.0/9.7s)——
  与渲染端观测(1.2–7.1s)同量级、同形状。

**边界诚实声明**:上述日志出自登录态(cloud MCP 在配),而 `#1102` 是 byok-only(登出,
按 `alpha-config-injection.ts:309` `platformPays=false` 时不注入 cloud MCP)。byok-only 窗口内
引擎具体在哪个节点上花掉 2.1–8.1s,**本轮没有直接证据**——量它需要一次带引擎侧观测的
app 形态运行(§5)。已能排除的候选见 §4。

## 2. 为什么裸引擎复现不出来(以及这说明什么)

用工作树源码起引擎(bun serve),喂**同一套真实配置**
(`OPENCODE_CONFIG=env/prod/alpha.jsonc` 含 4 个 office MCP、`OPENCODE_CONFIG_DIR`、
`OPENCODE_MODELS_PATH`、ext 插件、factory skills env),复刻 prewarm→active-dir→`/project` 的时序:

| 变体 | `/project` 首答 |
| --- | --- |
| 仅配置 | 24ms |
| + prewarm 双请求并发 | 39–70ms |
| + `/mcp` 状态、`/experimental/tool/ids` 并发触发 | **12ms**(mcp-status 自身 776ms,不传染) |
| bun 首轮 transpile 冷缓存(混杂因素) | 1,057ms(与 boot 同释放——证明「并发 boot 可押住它」的形态存在) |

⇒ 慢不是 `/project` 端点或这套配置的固有属性;它只在**打包应用的组合形态**
(Electron utilityProcess 的 Node 运行时 + dist bundle + 完整注入 + 真渲染端流量)下出现。
这与「引擎侧启动尾巴」结论一致,同时把「渲染端代码问题」「配置本身慢」两类解释关死。

## 3. AC2 —— 不是固定值(三证)

1. **模态宽度**:主模态 2,425–2,588ms(24 个样本,span 163ms,±3.3%);慢模态 5,996–7,080(span >1s)。
   `#1098` 那种写死常量的指纹是 5,010/5,008/5,010/5,007(span 3ms,±0.03%)——差两个数量级。
2. **多峰**:clean 稳态 36 个 = 1,182/1,187/1,392 | 2,183–2,849 ×26 | 3,611 | 5,996–6,352 ×4 |
   7,072/7,080(首启另有 16.7s/18.9s)。单一定时器给不出这个结构;它更像
   「少数几个秒级成分,逐次运行取不同子集/次数」。
3. **负载免疫 + 时段漂移**:noisy 批(load 4.84–11.05)与 clean 批(load 1.69–6.78)的稳态中位数
   分别是 2,513 与 2,515ms(差 0.1%)——CPU 争用解释被杀死;而 ≥5.9s 的样本 noisy 批 1/36、
   clean 批(更晚、更空闲)6/36——慢模态随**时段**出现,指向网络/外部状态,不是本机算力。

## 4. 已排除清单

| 候选 | 排除证据 |
| --- | --- |
| 渲染端重试/轮询/兜底定时器 | 代码单射(§1.1);78/78 `reason=generation-event` |
| SDK 客户端重试 | `sdk/src/v2/client.ts` 无 backoff |
| `#1098` 式写死周期 | §3 第 1 证 |
| 本机 CPU 争用 | §3 第 3 证(load 11 与 load 1.7 主模态同心) |
| 渲染端主线程卡死 | 首启样本窗口中途 composer.mount/model_list.start 正常发出 |
| 系统代理 / Clash | 实测窗口内 Clash core 无日志(止于前夜 22:39)、`scutil --proxy` 全关;127.0.0.1 在例外表 |
| mDNS / DNS | baseUrl 为字面 `127.0.0.1`(`index.ts:985`) |
| office MCP 的 uv 启动链(单独) | 温缓存实测 60–130ms ×4,量级差 20 倍——**但**4 路并发 + Node + 冷态未测,只排除「单独成因」 |
| models.dev 全量解码(#857 老病) | `OPENCODE_MODELS_PATH` 已治理(governed base 4.8KB);且 fork 锚分布与 marker 早收敛(0.95s)都不合 |
| 引擎「catalog 未就绪」压住 `/project` | `store_ready` 与 `renderer.home.catalog_ready` 的 r=0.9998 是**下游同构**(launch draft gate 在 `store.ready` 上、barrier 探针在 store_ready 之后才发、首探即中),不是上游原因——首启样本里 marker 早在 0.95s 已 200 |

## 5. 残余与下一步(给 VERIFY 票的输入)

**未定:byok-only 窗口内,引擎在哪个节点上花掉 2.1–8.1s。** 定它需要一次 app 形态的引擎侧观测,两条现成通道:

1. 引擎原生支持 `OTEL_EXPORTER_OTLP_ENDPOINT`(`packages/core/src/observability/otlp.ts`,http/json,
   全代码已带 `Effect.withSpan`)——但 `packages/ui-mac/src/main/sidecar-env.ts` 的 allowlist
   **不放行**该变量,打包运行下引擎收不到它。放行这一个非密钥变量(headers 不放,可能载凭证),
   下一轮就能对着本地 collector 拿到逐节点耗时。
2. 或临时打开引擎文件日志(嵌入式服务器现在不落盘)。

两者都是一行级改动,但不属于本票的「缺陷修复」范畴,**本轮未实施**(见票面第三条边界)。

## 6. 顺带发现(记录,不在本票处理)

- `packages/ui-mac/src/main/index.ts:570`:`app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")`
  **无注释**。`<-loopback>` 的语义是**从隐式豁免中减去回环** —— 一旦渲染端 session 有生效的代理配置,
  它会把 renderer→sidecar 的 127.0.0.1 流量推进代理。本轮已证明它**不是**这批样本的成因
  (实测窗口代理未运行),但它是一颗待爆雷:开着系统代理的用户,首屏每一条 renderer→engine
  请求都可能绕道代理进程。
- owner 桌面应用每 ~10 分钟 token 轮换即重启 sidecar,每次重启都重付整个 boot 尾巴
  (日志实测 1.79–9.67s 的 location+MCP 段)——运行中的应用会周期性出现同源卡顿,
  与本票的「启动第一次」是同一笔钱按次数付。
