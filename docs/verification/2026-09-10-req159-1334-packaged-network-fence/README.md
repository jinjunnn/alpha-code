---
title: REQ-137 网络轴重勘破 —— 出货形态下给整进程围栏加网络行的取证(alpha-code#1334)
kind: verification
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-10
---

# alpha-code#1334 · 网络轴在整进程围栏上的取证

票:[alpha-code#1334](https://github.com/jinjunnn/alpha-code/issues/1334) ·
父需求:[alpha-code#1073](https://github.com/jinjunnn/alpha-code/issues/1073)(REQ-137)·
结论文档:[`docs/architecture/2026-09-10-network-egress-on-process-fence.md`](../../architecture/2026-09-10-network-egress-on-process-fence.md) ·
被重测的老勘破:[`2026-08-25-network-egress-seam.md`](../../architecture/2026-08-25-network-egress-seam.md)(`#1077`)·
新接缝:[`2026-09-09-req159-process-fence.md`](../../architecture/2026-09-09-req159-process-fence.md) ·
隔离与驱动的先例:[`2026-09-10-req159-1323-packaged-fence/README.md`](../2026-09-10-req159-1323-packaged-fence/README.md)

**未改任何生产代码。** 本目录只有取证脚本 [`run.ts`](run.ts)、四个夹具
([`fixture/`](fixture/):实验分支专用的网络行补丁 + 三个独立探针)与结果 JSON。
`fixture/network-arm.patch` **只存在于实验分支,不合入** —— 打包完即
`git checkout -- packages/ui-mac/src/main/process-fence-profile.ts` 还原,提交前 `git diff` 为空。

## 0. 判据

- 网络轴只记「**流量到底通没通**」:代理日志里的 CONNECT 行、HTTP 状态码、provider 目录里到底有没有包、
  内核 Sandbox 拒绝日志里到底有没有那一行。**不记有没有报错。**
- 文件轴仍记「探针文件到底落没落盘」(runner 进程 `existsSync` 实读)。
- 每条会派生进程的探针第一句 `echo AC1334-STARTED`;输出里看不见它就不许把「没读数」读成「被拦住了」。
- **控制臂先行**:`open`(不追加任何网络行 = 今天出货的形状)必须整套通,而且代理日志必须是 **0 条** ——
  它同时证明「仪器读得到通」和「仪器不会幻觉命中」。
- 内核 Sandbox 日志这个手段自己先自证:`nc -U /var/run/syslog` 在 `(deny network*)` 下
  `Sandbox: nc(PID) deny(1) network-outbound /private/var/run/syslog`,同一条 profile 下
  `touch /private/tmp/…` 落 `file-write-create` 拒绝行 —— 已知的坏它看得见。

## 1. 四条臂

同一份签名包,网络行由 `fixture/network-arm.patch` 按 env 追加(**env 不设 = 出货形状,一个字节不变**)。

| 臂 | 追加的网络行 | 代理 | 用来回答 |
| --- | --- | --- | --- |
| `open` | 无 | 起着但不设 `HTTP(S)_PROXY` | 控制臂 |
| `deny` | `(deny network*)` + loopback `network-bind` / `network-inbound` + 只放行 `<chokePort>` 出网 | 起着但不设 env | Q1:装了强制汇流层而没有策略层,哪一格还活着 |
| `choke` | 同 `deny` | 起着且 `HTTP(S)_PROXY=http://127.0.0.1:<chokePort>` | Q4:打包产物里 `useEnvProxy()` 把哪些流量汇过来了 |
| `sec5` | 老勘破 §5 那两行**逐字**(`(deny network*)` + 只放行 `<chokePort>` 出网,**不放 bind/inbound**) | 起着但不设 env | 照老裁决原样立闸会怎样 |

## 2. 结论

| | `open` | `deny` | `choke` | `sec5` |
| --- | --- | --- | --- | --- |
| runner 汇总 | **32 pass / 0 fail / 9 obs** | **32 pass / 0 fail / 11 obs** | **32 pass / 0 fail / 10 obs** | **3 pass / 0 fail / 2 obs**(引擎没起来,后面的格没跑) |
| 围栏装上了吗 | 是,`profile=2040B`(1 ws)/`2218B`(3 ws) | 是,`2308B` / `2486B` | 是,`2322B` / `2502B` | **是**(`process fence applied … profile=2174B`),但引擎随即死 |
| 格 1 冷启动 health | 200 | 200 | 200 | **从来没有 200**;`sidecar spawn failed before health handshake` + `sidecar exited { code: 1 }`,fork 后 **560 ms** |
| 格 2 连接器(MCP stdio) | connected | connected | connected | — |
| 格 2 **provider 安装**(W7 静默路径) | **26 包 / 62 636 KB × 2 处,`~/.npm/_cacache` 在** | **0 包 × 2 处,`_cacache` 不在**,而 health 仍 200 | **26 包 / 62 636 KB × 2 处** | — |
| 格 3 开终端(登录 shell + 命令) | 通 | 通 | 通 | — |
| 格 4 shell 工具 | 通 | 通 | 通 | — |
| 格 5 写配置 + ext 装载 | 通 | 通 | 通 | — |
| 格 6 三工作区并集(SIGKILL → self-heal → 重算) | 通,`workspaces=3` | 通,`workspaces=3`;但**第一条命令 120 s 超时**(见 §4) | 通,`workspaces=3` | — |
| 集合外落盘 | 0 | 0 | 0 | — |
| 代理日志 | **0 条** | **0 条** | **32 条**(见 §5) | 0 条 |
| 内核 Sandbox `network-*` 拒绝行 | **0 条** | **22 条,全部是 `network-outbound /private/var/run/mDNSResponder`** | 1 条(只有显式 DNS 探针那一次) | 1 条 |
| 真 HOME 六个哨兵 mtime 前后 | 逐字相同 | 逐字相同 | 逐字相同 | 逐字相同 |
| 残留进程 | 0 | 0 | 0 | 0 |

原始输出:[`results/open.json`](results/open.json) · [`results/deny.json`](results/deny.json) ·
[`results/choke.json`](results/choke.json) · [`results/sec5.json`](results/sec5.json)。

## 3. 测量口径

| | |
| --- | --- |
| 树 | `.worktrees/ac-1334`,base = `origin/alpha` `6a6f4bd37` |
| 被测产物 | `packages/ui-mac/dist/mac-arm64/Code Puppy.app`,`com.tide.alphacode` **0.1.12**。构建 `OPENCODE_CHANNEL=prod bun run --cwd packages/ui-mac build`(exit 0,**3 行 `✓ built in`**);打包同 U1 §7 的发版命令,只用 CLI 覆盖关公证 / 换 `dir` target |
| 签名读数 | app:`flags=0x10000(runtime)` · `Authority=Developer ID Application: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)` · `TeamIdentifier=RQX6X6A635`;`alpha_fence.node`:`flags=0x10000(runtime)` · `TeamIdentifier=RQX6X6A635` · `lipo -archs` = `x86_64 arm64`;`codesign --verify --deep --strict` **exit 0** |
| 被测字节的标记检索 | `app.asar` 里 `ALPHA_AC1334_NETWORK` ×**1**(证明跑的就是带实验开关的那份字节),对照针 `AC1334-NONEXISTENT-NEEDLE` ×**0** |
| addon buildId | `.node` 里烤的 `fence-20260910T071823160Z`,与四条臂 sidecar 日志 `process fence applied: addon=fence-20260910T071823160Z` 逐字相同 |
| 隔离 | 逐条照 [`#1323` README §2.1–§2.3](../2026-09-10-req159-1323-packaged-fence/README.md#21-布局):一次性 `~/.ac1334-<arm>-XXXXXX/`,`OPENCODE_TEST_ONBOARDING=1` + 启动时 `TMPDIR=<iso>/tmp` + 隔离 `.zshrc` 把生产 `TMPDIR` export 回去;每臂实读 sidecar 的 `$HOME` / `$TMPDIR` / `$XDG_CONFIG_HOME` 才开始判 |
| 宿主 | macOS Darwin 25.3.0 arm64;`/bin/zsh`;runner 跑在 bun 1.3.14;`navigator.userAgent` 读回 `Electron/42.3.3` |
| 网络拓扑 | 系统代理关;DNS 答 fake-IP(`open` 臂实读 `example.com` = `198.18.7.158`)—— 与老勘破 §2.1 第二种形态一致 |

## 4. `deny` 臂里那条不是「拦住了」的读数

格 6 在 `deny` 臂跑了两轮,两轮都在同一处出现异常,而 `open` / `choke` 两臂各零次:

- 第一轮:并集重算之后往三个工作区写的那条 shell 命令**输出里没有 `AC1334-STARTED`** ⇒ 按本仓判据不许读成
  「被拦住了」,当轮记为不可判,并给 runner 补了「重试一次并记录两次的 status/raw」;
- 第二轮:第一次 `POST /session` + `/session/:id/shell` 走满 120 s 预算,`status=0` /
  `FETCH-FAILED TimeoutError: The operation timed out.`;**5 秒后重试 `status=200`**,四个探针随即按预期落盘 / 不落盘。

同臂另一条同向读数:`renderer.home.catalog_ready` 的时间戳在 `deny` 臂是 **488 223 ms**,
`open` / `choke` 两臂分别是 **23 402 ms** / **23 541 ms**;`main.sidecar.catalog_liveness.confirmed`
在 `deny` 臂本次窗口内**一次都没出现**,另两臂各出现一次(`elapsedMs` 369 / 364)。

这两条都记为**观测**,不是判定:本轮没有做重复采样,也没有把它们做成阈值判据。

## 5. `choke` 臂代理日志(32 条,按目的地)

| 目的地 | 条数 | 结局 |
| --- | --- | --- |
| `registry.npmjs.org:443` | 17 | tunnelled |
| `codepuppy.cn:443` | 5 | tunnelled |
| `alpha-gateway.tidelabs.click:443` | 2 | tunnelled |
| `github.com:443` | 2 | tunnelled |
| `ac1334-probe.invalid:80` | 2 | `upstream ENOTFOUND` |
| `ac1334-probe.invalid:443` | 2 | `upstream ENOTFOUND` |
| `release-assets.githubusercontent.com:443` | 1 | tunnelled |
| `example.com:443` | 1 | tunnelled |

**代理日志不区分发起进程。** 能确定归**引擎进程内 fetch** 的只有 `ac1334-probe.invalid` 两族
(远端 MCP 只在引擎侧发起);`registry.npmjs.org` 归 sidecar 里的 `@npmcli/arborist`;
`github.com` / `example.com` / `release-assets…` 归 shell 工具的子进程。
`codepuppy.cn` / `alpha-gateway.tidelabs.click` **无法从日志区分是 main 还是 sidecar** ——
main 自己也调 `useEnvProxy()` 且继承了同一份 env,记为未验(见结论文档 §Q4)。

`models.opencode.ai`(引擎的模型目录源)**在四条臂里一次都没有出现在代理日志里**,
`<XDG_CACHE_HOME>/opencode/models.json` 四条臂都不存在 —— 本轮窗口内那条 fetch 根本没发生,
所以「模型目录拉取是否经代理」**本轮未验**,不许从「没看见」推出任何结论。

## 6. 三个独立探针(不需要打包,秒级可复跑)

- [`fixture/seatbelt-listen-probe.mjs`](fixture/seatbelt-listen-probe.mjs) —— 被围栏的进程能不能
  `listen()` / 被外面连上。四种 profile 形状的读数在结论文档 §Q1.1。
- [`fixture/unix-socket-probe.mjs`](fixture/unix-socket-probe.mjs) —— 七个系统 unix socket 在
  「无围栏 / `(deny network*)` / `(deny network*)` + 逐条 `(literal …)` 放行」三条臂下的 `connect()` 结果。
- [`fixture/profile-byte-budget.ts`](fixture/profile-byte-budget.ts) —— 用**生产渲染器**与**真编译器**
  量加网络行之后离 65535 那道墙还有多远,并演示 `trimUntilCompiles` 碰上语法坏的网络行会怎么报错。

## 7. 跑法

```bash
# ① 打实验包(网络行按 env 追加;不改配置文件里的任何签名项)
git apply docs/verification/2026-09-10-req159-1334-packaged-network-fence/fixture/network-arm.patch
OPENCODE_CHANNEL=prod bun run --cwd packages/ui-mac build          # 核对 3 行 `✓ built in`
cd packages/ui-mac && OPENCODE_CHANNEL=prod ALPHA_SIGN=1 ./node_modules/.bin/electron-builder --mac \
  -c.mac.notarize=false -c.mac.target=dir --config electron-builder.config.ts
cd - && git checkout -- packages/ui-mac/src/main/process-fence-profile.ts   # 立刻还原

# ② 先控制臂,再三条实验臂(runner 退出码 = 有没有 FAIL;不要用 `cmd | tail; echo $?` 读它)
for arm in open deny choke sec5; do
  bun docs/verification/2026-09-10-req159-1334-packaged-network-fence/run.ts \
    --app "packages/ui-mac/dist/mac-arm64/Code Puppy.app" --arm "$arm"
done
```

`dist/` 不入仓。每臂 3–8 分钟(`deny` 臂最慢:后台 provider 安装要把 DNS 超时走完)。

## 8. 没测的(如实记账)

1. **没有发过一次真的模型请求**(与 `#1323` / `#1321` 同一条)。所以票面担心的「提问没反应」这条
   用户可观察面**本轮没有直接测到**;测到的是它上游的两件事:provider 装不上(格 2)与 catalog 就绪
   慢一个量级(§4)。
2. **模型目录(`models.opencode.ai`)那条 fetch 本轮没有发生**(§5),因此它是否经代理未验。
3. **代理日志不区分 main 与 sidecar**(§5),`codepuppy.cn` / gateway 两族的归属未验。
4. **没有实现任何策略层**。`choke` 臂的代理是取证替身:它对所有 CONNECT 一律转发并记账,不做目的地判定。
5. **公证 / staple 没做**;**x86_64 那一片没有被执行过**(本机 arm64)。
6. **单机单配置**:一台 arm64 Mac、一份签名身份、一个用户、一种网络拓扑(系统代理关 + 网关侧透明代理)。
7. `deny` 臂的两条时序读数(§4)**只跑了两轮**,没有按《时序门需 ≥3 轮采样》做重复采样。
