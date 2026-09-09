---
title: REQ-159 U1 决定书:自己写的原生模块在签名后的正式包里加载得了
kind: architecture
status: accepted
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-09
review_after: 2026-12-09
---

# U1 —— 自己写的 `.node` 在签名 + hardened runtime 的出货包里能不能加载

需求与验收在票面(`alpha-code#1316`);方案基线是
[`../design/2026-09-09-req159-process-fence-baseline.md`](../design/2026-09-09-req159-process-fence-baseline.md) §四 U1;
先验事实在 [`2026-09-08-derived-process-spawn-paths.md`](2026-09-08-derived-process-spawn-paths.md) §6.6 / §8.7。

## 结论

**能。路一的这一格闭合,方案继续。**

一个我们自己写、我们自己的流水线签的最小 N-API 附加模块,在**打包 + Developer ID 签名 +
hardened runtime + 库校验开着**的 `Code Puppy.app` 里,被**引擎 sidecar 进程**(`Code Puppy
Helper` / `node.mojom.NodeService`,即 §6.6 P1 的落点)和主进程**各加载成功一次**,
`sandbox_init` / `sandbox_init_with_parameters` / `sandbox_free_error` 三个符号全部解析到。

**不需要开 `cs.disable-library-validation`,也不需要动任何签名配置。** 库校验照旧开着 ——
本轮的三条反例臂全部被它按预期拒掉(见 §2),所以「加载成功」不是因为闸门没生效。

顺带闭合了一格 §6.8 记为「推断」的东西:同一个模块在同一个出货 sidecar 里**真的调通了**
`sandbox_init_with_parameters`(`rc=0`),并且围栏**真的生效**(装前两个目录都可写,装后
被 deny 的那个 `EPERM`、没被 deny 的那个仍可写)。详见 §3 —— 但这**不等于** U3 闭合,理由在 §6。

## 0. 测量口径

| | |
| --- | --- |
| 树 | `.worktrees/ac-1316`(`bash scripts/worktree-bootstrap.sh` 建),base = `origin/alpha` `8a8e1e56d` |
| 被测产物 | `packages/ui-mac/dist/mac-arm64/Code Puppy.app`,**本机跑真发版命令产出**(runbook §1 步骤 ② 的同一条 `electron-builder`,只用 CLI 覆盖关掉公证与换 target,**没有改配置文件里的任何签名项**) |
| 签名身份 | `Developer ID Application: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)`(owner 2026-08-27 已授权用于本机打包验证;公证不在授权范围) |
| 频道 / 架构 | `OPENCODE_CHANNEL=prod` · arm64(出货只有 `mac-arm64`,见 `../runbooks/distribution.md` §2) |
| 运行时 | electron `42.3.3` / node `24.15.0` / `process.versions.modules=146` |
| 隔离 | `OPENCODE_TEST_ONBOARDING=1`(仓内既有的 packaged-VERIFY 隔离开关)—— 本机另一条 lane 当时正开着 `/Applications/Code Puppy.app`,两边 userData 与单实例锁因此不共享;跑完 `ps` 复查 `ac-1316` 残留进程 **0** |
| 本轮量的是哪份代码 | 附加模块编译期烤进 `buildId`,回读到的是 `u1b-20260909T092109Z` = 本轮那次编译 |

**附加模块**(约 140 行 C,`clang -shared -undefined dynamic_lookup -I/opt/homebrew/include/node`,
`#define NAPI_VERSION 8`):`dlopen` 系统沙箱库 → `dlsym` 取三个符号 → 把结果作为普通 JS 对象返回。
它**不实现围栏**,§3 那一发是额外加的一次 SPI 调用。落点走 `extraResources`
(`Contents/Resources/alpha-sandbox-probe/alpha_sandbox_probe.node`),不进 asar。

## 1. 加载矩阵:五条臂,同一个进程里同时跑

同一次运行、同一个进程,依次 `process.dlopen()` 五个文件,只有签名不同:

| 臂 | 文件 | 签名 | 主进程 | **sidecar 进程** |
| --- | --- | --- | --- | --- |
| A | 包内 `Contents/Resources/alpha-sandbox-probe/…` | 流水线签的 Developer ID,team `RQX6X6A635`,`flags=0x10000(runtime)` | **加载成功**,3/3 符号 | **加载成功**,3/3 符号 |
| B | 包外 `/tmp/…/devid/` 同一份字节 | 手签同一个 Developer ID | 加载成功 | 加载成功 |
| C | 包外 `/tmp/…/adhoc/` | ad-hoc(`codesign -s -`) | **拒绝** | **拒绝** |
| D | 包外 `/tmp/…/otherteam/` | 真的另一个 Team(`UBF8T346G9`,取自 VS Code 的 `os_proxy_resolver.node`) | **拒绝** | **拒绝** |
| E | 包外 `/tmp/…/unsigned/` | `codesign --remove-signature` | **拒绝** | **拒绝** |

拒绝的原文(dyld,两进程逐字相同):

```
C / D: code signature in <…> '…' not valid for use in process:
       mapping process and mapped file (non-platform) have different Team IDs
E:     code signature in <…> '…' not valid for use in process:
       Trying to load an unsigned library
```

**C/D/E 就是这台仪器的「已知的坏」**:库校验确实开着、确实按 Team 判、确实会拒。
A 通过因此是结果,不是「闸门没生效」。B 通过则说明判据是**签名身份**而不是「在不在包里」——
这对将来把模块放进 `node_modules`(走 `app.asar.unpacked`,与 `pty.node` 同形)一样成立。

生产 entitlements 逐字未变,仍然只有三条,**没有** `cs.disable-library-validation`:

```
com.apple.security.cs.allow-jit
com.apple.security.cs.allow-unsigned-executable-memory
com.apple.security.device.audio-input
```

## 2. 打包链自己会把它签好 —— 不是我事后补签的

`extraResources` 放进去的这个 `.node`,由发版那条命令**自己**签的,签成与 `pty.node` 同形:

```
alpha_sandbox_probe.node : CodeDirectory flags=0x10000(runtime)  TeamIdentifier=RQX6X6A635  Timestamp=…
pty.node                 : CodeDirectory flags=0x10000(runtime)  TeamIdentifier=RQX6X6A635  Timestamp=…
```

并且它被封进了 bundle 的 `CodeResources`(`files2` 里有
`Resources/alpha-sandbox-probe/alpha_sandbox_probe.node` 的 `hash2`);整包
`codesign --verify --deep --strict` **exit 0**(`valid on disk` + `satisfies its Designated
Requirement`),单文件 `codesign --verify --strict` 也 **exit 0**。`spctl` 判 `rejected /
source=Unnotarized Developer ID` —— 这正是「签了但没公证」的预期读数,不是签名问题。

## 3. 加码一格:SPI 在出货 sidecar 里真的调得动

§6.6 P1 只在 dev 树上用 bun:ffi 验过机制,§6.8 明写「node 侧真能调通」是推断。本轮在**出货
sidecar 进程**里,经我们自己那个已签名的模块调了一次
`sandbox_init_with_parameters(profile, 0, NULL, &err)`:

```json
{ "beforeDeny": {"wrote": true}, "beforeAllow": {"wrote": true},
  "applyResult": {"rc": 0, "sandboxError": ""},
  "afterDeny": {"wrote": false, "error": "EPERM"}, "afterAllow": {"wrote": true} }
```

profile 是 `(version 1)(allow default)(deny file-write* (subpath "/private/tmp/alpha-u1/fence-deny"))`
—— 刻意只关一个目录,不动引擎。**装之前两个目录都写得进(正样本臂),装之后只有被 deny 的
那个 `EPERM`** ⇒ 围栏真的装上了,而不是「rc=0 但什么也没发生」。

## 4. 进不进自动更新链路,有没有额外麻烦

跑了一次真的 `zip` target(更新包就是它):

```
dist/alpha-code-mac-arm64.zip            168,841,676 B
dist/alpha-code-mac-arm64.zip.blockmap   已生成
dist/latest-mac.yml                      version/sha512/size 齐全
unzip -l | grep alpha-sandbox-probe
  → Code Puppy.app/Contents/Resources/alpha-sandbox-probe/alpha_sandbox_probe.node  69008
```

**没有额外麻烦,但有四条要记账的**:

1. **公证这一格本轮没跑**(不在 owner 的授权范围内)。风险低但**不是零**:公证要求
   Developer ID 签名 + hardened runtime + **安全时间戳**,这三样本轮在这个文件上都实测到了。
   它若被拒,是在发版时**响亮**地拒,不是运行期静默 —— 但第一个带这个模块的真发版必须核对
   `xcrun stapler validate` 与 `spctl -a -t install`(runbook §1 步骤 ③ 已经在要求这两条)。
2. **asar 完整性不受影响**:`extraResources` 本来就在 asar 外;走 `node_modules` 那条路
   electron-builder 会把 `*.node` 拆到 `app.asar.unpacked`(`pty.node` 今天就是),同样在 asar 外。
   两条路都不会动 `enableEmbeddedAsarIntegrityValidation` 那个哈希。
3. **只有 arm64。** 出货只出 `mac-arm64`(runbook §2),所以单架构 prebuild 与出货面**当前**是对齐的;
   将来要 Intel/universal,这个模块要跟着出第二份,否则 x64 包里它不存在 ⇒ 围栏静默不装。
   **这是路一将来最容易被漏掉的一格**,建议在实现票里用判据钉住「产物里必须有它」。
4. **`assert-seed-assets.sh` 罩不到它。** 那道门明写只断言**源码里追踪的**资产,构建产物
   (如 `packages/ext/dist`)不归它管。`.node` 是构建产物 ⇒ 需要一条自己的判据(实现票的事)。

顺带:`@electron/rebuild` 在打包时跑了(`buildFromSource=false`),对预编译好的
`extraResources` `.node` 不做任何事;走 `node_modules` 那条路则要确认它不会去重编。

## 5. 本轮没测的(如实记账)

- **公证 / staple 没做**(见 §4.1)。
- **只有 arm64、只有 darwin。** win/linux 的打包配置也吃同一份 config,实现票要保证那两个
  平台上这条 `extraResources`(或依赖)不存在时**不炸打包**。
- **模块用的是 Homebrew node 25 的 `node_api.h` 配 `NAPI_VERSION 8`**,靠 N-API 的 ABI 稳定
  跨到 Electron 42 的 node 24 —— 实测通过,但实现票应当把头文件钉进仓里(`node-api-headers`
  或 Electron 头),不要依赖本机装了什么。
- **没有跑一次完整的 REQ-159 可写集 profile**,§3 只是一条窄 deny 的活性证明。
- **没有发过真的模型请求**(与 §6.8 / §8.8 同一条)。
- **测的是 `extraResources` 那条落点**;`node_modules` → `app.asar.unpacked` 那条只有
  `pty.node` 的旁证(同 Team、同 runtime flag、今天在出货包里正常加载)。

## 6. 对 REQ-159 的影响

- **U1 闭合 = 能加载。** 基线 §四 U1 那句「从未写过、签过、在打包 app 里加载过任何新 addon」
  自本文档起不再成立。
- **U3 仍然开着。** §3 证明的是「SPI 在出货 sidecar 里调得动、围栏装得上」;U3 要的是
  **node 运行时 + 打包产物 + §8.2 那份 19 行可写集 + 真实工作负载**合成一次跑通,那是
  另一张 VERIFY 票的活。**「能装上一个只关一个目录的围栏」推不出「装上真围栏引擎还活着」。**
- **U2(多工作区)不受本票影响**,仍按基线 §五第 2 条走。
- **不需要 owner 就安全边界做任何裁决** —— 本票没有、也不需要放宽任何一条。

## 7. 复现配方

```bash
# ① 建模块(约 140 行 C;只 dlopen + dlsym,不实现围栏)
clang -O2 -fPIC -shared -undefined dynamic_lookup -mmacosx-version-min=11.0 \
  -I/opt/homebrew/include/node -DALPHA_PROBE_BUILD_ID='"<id>"' \
  -o build/alpha_sandbox_probe.node src/probe.c

# ② 走真发版命令打包 + 签名(只用 CLI 覆盖关掉公证 / 换 target,不改配置文件)
OPENCODE_CHANNEL=prod bun run --cwd packages/ui-mac build     # 需核对 3 行 `✓ built in`
cd packages/ui-mac && OPENCODE_CHANNEL=prod ALPHA_SIGN=1 \
  ./node_modules/.bin/electron-builder --mac \
  -c.mac.notarize=false -c.mac.target=dir --config electron-builder.config.ts

# ③ 五条臂:同一份字节分别按 Developer ID / ad-hoc / 别的 Team / 去签名 摆到包外
codesign -f -s "Developer ID Application: …(RQX6X6A635)" --options runtime --timestamp=none …
codesign -f -s - …
codesign --remove-signature …

# ④ 起包、在主进程与 sidecar 顶层各 dlopen 一遍,把结果写盘再读
OPENCODE_TEST_ONBOARDING=1 "dist/mac-arm64/Code Puppy.app/Contents/MacOS/Code Puppy"
```

第 ④ 步需要一小段**只存在于实验分支**的探针(sidecar 模块顶层 + main 顶层各一行调用)。
它不随本文档合入 —— 本票的产物是结论,不是探针。要复跑就照上面重建;**判据是
「C/D/E 三条臂必须红」**,它们不红说明你量的不是一个库校验开着的进程。
