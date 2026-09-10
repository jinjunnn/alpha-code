---
title: REQ-137 把路封死 —— 出货形态下围栏只放行策略代理那一扇门的取证(alpha-code#1337)
kind: verification
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-10
---

# alpha-code#1337 · 出货形态:六格工作负载 + 误伤语料 + 逃逸语料

票:[alpha-code#1337](https://github.com/jinjunnn/alpha-code/issues/1337) ·
父需求:[alpha-code#1073](https://github.com/jinjunnn/alpha-code/issues/1073)(REQ-137)·
落地形状与覆盖面声明:[`docs/architecture/2026-09-10-network-egress-on-process-fence.md`](../../architecture/2026-09-10-network-egress-on-process-fence.md) §落地 ·
被闭合的勘破:同文 §Q1–Q5(`#1334`,取证在 [`../2026-09-10-req159-1334-packaged-network-fence/README.md`](../2026-09-10-req159-1334-packaged-network-fence/README.md))·
隔离与驱动的先例:[`../2026-09-10-req159-1323-packaged-fence/README.md`](../2026-09-10-req159-1323-packaged-fence/README.md)

本目录只有取证脚本 [`run.ts`](run.ts) 与结果 JSON [`results/shipped.json`](results/shipped.json)。
**没有补丁、没有实验开关、不设任何代理 env、不起外部代理** —— 被测的就是出货的那份字节:
网络行由生产渲染器渲染,策略代理由 Electron main 自己起,sidecar 的代理变量由 main 改写。

## 0. 判据

- 网络轴只记「**流量到底通没通**」:main.log 里产品自己的代理记录(`network egress {…}`,每条 CONNECT 的
  allow / deny 与原因)、HTTP 状态码、provider 目录里到底有没有包。**不记有没有报错。**
- 文件轴仍记「探针文件到底落没落盘」(runner 进程 `existsSync` 实读)。
- 每条会派生进程的探针第一句 `echo AC1337-STARTED`;看不见它就不许把「没读数」读成「被拦住了」。
- 逃逸语料每条自带进程已启动的证据与 curl / node **自己报的** errno / 错误文本;`$?` 经引擎 shell 工具读回恒 0
  (两轮实测,未追根),所以退出码只记不判。
- 内核 Sandbox 拒绝日志(`log show … deny(`)跑完后按时间窗抓一次,只做旁证。

## 1. 结论(`results/shipped.json`)

| | 读数 |
| --- | --- |
| runner 汇总 | **47 pass / 0 fail / 3 obs** |
| 被测件 | `com.tide.alphacode` 0.1.12,Developer ID + hardened runtime(app 与 `alpha_fence.node` 都读到 `flags=0x10000(runtime)` / `TeamIdentifier=RQX6X6A635`),`lipo -archs` = `x86_64 arm64`,`codesign --verify --deep --strict` exit 0;asar 里 `network egress policy proxy listening` ×1(生产接线的字节在场)、`ALPHA_AC1334_NETWORK` ×0(不是 `#1334` 那份实验字节) |
| 格 1 冷启动 | health **200**;main.log:`network egress policy proxy listening on 127.0.0.1:<P>` → `process fence planned: … egressProxyPort=<P>, profile=2531B` → server.log `process fence applied … profile=2531B`(同一个端口进了 profile;`#1334` `sec5` 臂那种「装上了但引擎 560 ms 死」没有出现) |
| 格 1 sidecar env | shell 工具里实读:`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` = `http://127.0.0.1:<P>`,`NO_PROXY` / `no_proxy` = `127.0.0.1,localhost,::1`;runner 自己**没设**任何代理 env —— 这份值只能来自 main 的改写 |
| 格 2 连接器(MCP stdio) | connected;界内落盘、界外 0 |
| 格 2 **provider 安装**(`#1334` 那条静默失败格) | **26 包 / 62 636 KB × 2 处**(`<XDG_CONFIG_HOME>/opencode/node_modules` 与 `<userDataPath>/alpha-engine-config/node_modules`,`@opencode-ai/plugin/package.json` 实读在场),`~/.npm/_cacache` 在;`registry.npmjs.org:443` 经代理 allow ≥15 条、deny 0 条;引擎日志里零 `NpmInstallFailedError` |
| 格 3 开终端(登录 shell) | 通;终端里 `$HTTPS_PROXY` 也是 `http://127.0.0.1:<P>`;界外写 `zsh: operation not permitted` |
| 格 4 shell 工具 | 通;界内落盘、界外 0、onboarding 根的兄弟目录 0 |
| 格 5 写配置 + ext 装载 | `alpha.jsonc` 在、`alpha-engine-config/` 在、`alpha_register` 在 |
| 格 6 三工作区并集(SIGKILL → self-heal → 重算) | `workspaces=3`,`profile=2715B`,第二代 `egressProxyPort=<P>` **与第一代相同**,`proxy listening` 行全程只有 **1** 条(代理跨代复用);并集重算后**第一条 shell 命令 100 ms 返回**(上一轮 98 ms;`#1334` `deny` 臂是走满 120 s 超时) |
| AC3 误伤语料(12 条) | 文件轴九条全通;`curl https://registry.npmjs.org/semver/latest` **`CURL=200`**;`npm view semver version` **`7.8.5`**;`git ls-remote https://github.com/git/git HEAD` **`b8242b0…`**;`node dns.lookup("example.com")` **`ENOTFOUND`**(预期:解析在代理那一侧,围栏里 DNS 不通,`#1334` Q3) |
| AC1 逃逸语料(6 条 + 引擎进程内 2 条) | 见 §2 |
| 真 HOME 六个哨兵 mtime 前后 | 逐字相同 |
| 残留进程 | 0 |

## 2. 逃逸语料(AC1 反臂):每条都「进程起了、然后响亮地失败」

| 语料 | 发起 | 读数 | 代理侧记录 |
| --- | --- | --- | --- |
| `curl https://example.com`(未登记目的地,经代理) | shell 工具 | `curl: (56) CONNECT tunnel failed, response 403` | `deny/unregistered example.com:443` ×1 |
| `curl --noproxy '*' https://1.1.1.1/`(绕代理,raw-IP:443) | shell 工具 | `curl: (7) Failed to connect to 1.1.1.1 port 443 after 0 ms` | —(没到代理;内核 `deny(1) network-outbound remote:*:443`) |
| `curl --noproxy '*' https://github.com/`(绕代理,按名字) | shell 工具 | `curl: (6) Could not resolve host: github.com` | —(死在 DNS:内核 `deny(1) network-outbound /private/var/run/mDNSResponder`) |
| `node net.connect(443,"1.1.1.1")` | shell 工具 → node | `TCP=EPERM` | — |
| `node dgram.send(… 53,"1.1.1.1")` | shell 工具 → node | `UDP=EPERM` | — |
| `node net.connect({host:"::1",port:<空闲端口>})` | shell 工具 → node | `V6=EPERM`(loopback 上非代理端口) | — |
| 远程 MCP `http://ac1337-probe.invalid/mcp` | **引擎进程内 fetch** | `fetch failed: … Proxy response (403) !== 200 when HTTP Tunneling` | `deny/unregistered ac1337-probe.invalid:80` ×2 |
| 远程 MCP `https://ac1337-probe.invalid/mcp` | **引擎进程内 fetch** | 同上 | `deny/unregistered ac1337-probe.invalid:443` ×2 |

最后两行是 `#1334` Q4 那条探针的升级:当时(取证替身代理)读到的是代理侧 `ENOTFOUND`,现在是**策略拒绝 403**
—— 引擎自己的出网确实经过闸门,而且闸门说的是「不在注册表」,不是「解析不了」。

## 3. 代理记录(main.log,按目的地)

| 目的地 | 裁决 | 条数 |
| --- | --- | --- |
| `registry.npmjs.org:443` | allow | 15–18(两处 provider 安装 + `npm view` + `curl`) |
| `github.com:443` | allow | 2–3(`git ls-remote`) |
| `release-assets.githubusercontent.com:443` | **allow** | 1 |
| `ac1337-probe.invalid:80` / `:443` | deny/unregistered | 2 / 2 |
| `example.com:443` | deny/unregistered | 1 |

`release-assets.githubusercontent.com:443` 那一行是本轮加进注册表的(`#1073` owner 裁决二):第一轮复跑时它还不在表里,
同一工作负载下被 **403 ×2**(shell 工具子进程发起,与 `#1334` Q4 实拍一致)—— 封路之后这类下载会被拒,属于误伤;加进表后同一负载 allow ×1。
`example.com` 按裁决一**不加**:它只是探针靶子,AC3 语料改用 `registry.npmjs.org`。

## 4. 测量口径

| | |
| --- | --- |
| 树 | `.worktrees/ac-1337`,base = `origin/alpha` `59b26f136`(`#1336` 已合) |
| 被测产物 | `packages/ui-mac/dist/mac-arm64/Code Puppy.app`。构建 `OPENCODE_CHANNEL=prod bun run --cwd packages/ui-mac build`(exit 0,3 行 `✓ built in`);打包同 U1 §7 的发版命令,只用 CLI 覆盖关公证 / 换 `dir` target(`ALPHA_SIGN=1`) |
| addon buildId | `.node` 里烤的与 sidecar 日志 `process fence applied: addon=fence-…` 逐字相同(见 JSON `identity.addonBuildId`) |
| 隔离 | 逐条照 `#1323` README §2.1–§2.3:一次性 `~/.ac1337-shipped-XXXXXX/`,`OPENCODE_TEST_ONBOARDING=1` + 启动时 `TMPDIR=<iso>/tmp` + 隔离 `.zshrc` 只把生产 `TMPDIR` export 回去;实读 sidecar 的 `$HOME` / `$TMPDIR` / `$XDG_CONFIG_HOME` 才开始判 |
| 宿主 | macOS Darwin 25.3.0 arm64;`/bin/zsh`;runner 跑在 bun 1.3.14;`navigator.userAgent` 读回 `Electron/42.3.3` |
| 网络拓扑 | 系统代理关;DNS 答 fake-IP —— 与 `#1334` 同 |

## 5. 跑法

```bash
OPENCODE_CHANNEL=prod bun run --cwd packages/ui-mac build          # 核对 3 行 `✓ built in`
cd packages/ui-mac && OPENCODE_CHANNEL=prod ALPHA_SIGN=1 ./node_modules/.bin/electron-builder --mac \
  -c.mac.notarize=false -c.mac.target=dir --config electron-builder.config.ts
cd - && bun docs/verification/2026-09-10-req137-1337-packaged-egress/run.ts \
  --app "packages/ui-mac/dist/mac-arm64/Code Puppy.app"           # 退出码 = 有没有 FAIL;不要用 `cmd | tail; echo $?` 读它
```

`dist/` 不入仓。一轮约 7 分钟(冷启动 + 后台 provider 安装 + 一次 self-heal respawn + 20 条 shell 语料)。

## 6. 没测的(如实记账)

1. **「杀掉代理」在出货形态上到不了**:代理住在 main 进程内,main 死则 sidecar 一起死(utilityProcess)。
   AC4「代理不在场时快速响亮地失败」的端到端判据在
   `packages/ui-mac/src/main/network-egress-fence.test.ts` A3(Electron 的 node + 真 seatbelt + 真代理,关掉代理再测:
   fetch / CONNECT 立刻 `ECONNREFUSED 127.0.0.1:<P>`,直连仍 EPERM)。
2. **没有发过一次真的模型请求**(与 `#1321` / `#1323` / `#1334` 同一条)。隔离环境没有凭据,`/config/providers` 读回 0 个 provider。
3. **模型目录 `models.opencode.ai` 那条 fetch 本轮仍没有发生**(`<XDG_CACHE_HOME>/opencode/models.json` 不存在;代理记录里没有它)。
4. `renderer.home.catalog_ready` / `catalog_liveness.confirmed` 这两条 `#1334` §4 的时序读数本轮**没取到**(main.log 里没有那两个键;
   runner 只 grep 了 main.log)。能替代的一条:并集重算后第一条 shell 命令 100 ms / 98 ms(两轮;`#1334` `deny` 臂 120 s 超时)—— 按《时序门需 ≥3 轮采样》仍不构成结论。
5. **单机单配置单拓扑**;公证 / staple 没做;x86_64 那一片没有被执行过。
6. `127.0.0.1:11434`(ollama)在注册表里,但围栏只放行 `localhost:<P>` 且 `NO_PROXY` 含 `127.0.0.1` ⇒ 客户端会直连 ⇒ EPERM。
   本轮没有 ollama 负载,**未测**;它是注册表与 profile 之间的一条已知张力,归 `#1073` 裁(加一行 `(allow network-outbound (remote ip "localhost:11434"))` 或删表行)。
