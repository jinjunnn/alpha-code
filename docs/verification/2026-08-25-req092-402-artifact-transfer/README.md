---
title: REQ-092 #402 —— descriptor-only 有界产物传输七格矩阵
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-25
review_after: 2026-11-25
---

# alpha-code#402 · REQ-092 传输矩阵取证

票:[alpha-code#402](https://github.com/jinjunnn/alpha-code/issues/402) ·
父需求:[alpha-work#1](https://github.com/jinjunnn/alpha-work/issues/1)(REQ-092,AC1–AC6)

被测树:`alpha-code` 分支 `ac-402`,base `alpha` @ `8ba7d11ec`。**未改任何生产代码**;
本目录只有探针、夹具说明与结果。

**覆盖边界**:本票只承载父需求 **AC1–AC6**。**AC7 不在这里** —— 父票 Evidence map 把它指给
`descriptor-only schema/forbidden-field CI gate`(每 PR 都跑的静态契约门),那不是运行期矩阵
能证的东西,本目录**没有**关于 AC7 的任何读数。

**base 在测量之后动过**:`alpha-platform#44`(sandbox 产物流式入 R2 + 流式哈希)已于本轮取证
之后合入。逐格复核过,**没有任何一格的结论以「平台侧仍整块 buffer」为前提**:格 2–7 全部跑在
本机独立进程的 origin 上,量的是桌面侧;格 1 的结论是「alpha-code 对 `result` 不做清洗」,
论断落在消费侧,而生产平台今天发不发内联内容本来就**没测**(见 §3 格 1 的 scope,
那一半归尚未交付的 `alpha-platform#51`)。⇒ 无需按新 base 重测。

## 0. 结论先说

| 格 | 覆盖 | 判定 |
| --- | --- | --- |
| 1 status/result/list/MCP/transcript 无内联字节 | AC1 | **部分 FAIL** —— descriptor 面结构性闭合(PASS);`result` 字段是**无约束透传**(FAIL);MCP/transcript 在本仓侧**测不到** |
| 2 100 MiB 正常流:摘要一致 + 额外峰值 RSS ≤ 32 MiB | AC2 | 摘要 **PASS**;峰值 **FAIL** —— Electron 42.3.3 实测 **+84.0 / +84.4 / +84.6 MiB**(3/3 轮),限速到 ~8 MB/s 仍 +81.2 MiB |
| 3 超大 Content-Length 读前拒 / 无长度·少报·chunked 首次越界 abort | AC3 | **部分 FAIL** —— 读前拒与 chunked 越界 abort **PASS**(两侧边界都测);**少报 Content-Length 且 descriptor 无 size 无 sha256 ⇒ 静默截断并报成功**(FAIL) |
| 4 断流 / 取消 / 摘要不符 / ENOSPC → typed error 且零残留 | AC4 | **PASS**(node + Electron 各 10 条,含真 ENOSPC) |
| 5 Range / 重复 / 同名 / 并发 | AC6 | **部分 FAIL** —— 空文件·重复下载·折叠同名·8 路并发·同窗去重全 PASS;**同名不同件 ⇒ 静默覆盖 + manifest 与盘面不符**(FAIL) |
| 6 slow consumer 与 envelope 边界 | AC2/AC3 | **PASS** —— 慢消费者峰值 +19.8 MiB(100 MiB)/ +18.3 MiB(25 MiB),不随文件大小增长;两个 envelope 上限**恰好 / 恰好+1** 两侧都对 |
| 7 renderer IPC / log / manifest / 文件名扫描 | AC5 | **PASS** —— 真 3 MiB 下载后五个观测面零发现,扫描器先用已知的坏标定过 |

四张窄票,各自 `Refs alpha-work#1`:
[#1111](https://github.com/jinjunnn/alpha-code/issues/1111)(格 3 静默截断)·
[#1112](https://github.com/jinjunnn/alpha-code/issues/1112)(格 5 同名覆盖)·
[#1113](https://github.com/jinjunnn/alpha-code/issues/1113)(格 1 `result` 透传)·
[#1114](https://github.com/jinjunnn/alpha-code/issues/1114)(格 2 峰值 RSS 超顶,带 `needs-decision`:
先要 owner 裁「32 MiB 量的是驻留高水位还是活内存」)。

## 1. 这轮里量错过两次 —— 两次都是观测手段自己坏了

写在最前面,因为它决定了后面每个数字该不该信。

**① 第一版 origin(`Bun.serve`)造不出它声称的条件。** 给一个 `ReadableStream` 响应手写
`content-length: 209715200` 时,Bun **不照发**,改用 `transfer-encoding: chunked`。于是
「超大 Content-Length 读 body 前拒绝」那一格实际走的是**另一条分支**(chunked 累计越界),
而它看上去是绿的 —— 客户端侧的 detail 是 `declared **unknown**`,那行字就是证据。
同一个 origin 还有两个盲区:响应流的 `cancel()` 在客户端断读时不必然触发(「上游被 cancel」
这个观测量恒为 0),客户端停读后 Bun 仍把剩余字节灌完(「abort 之后还发了多少」量不出来)。
**改成裸 socket 的 [`probes/origin-raw.ts`](probes/origin-raw.ts),并先跑
[`probes/origin-calibration.ts`](probes/origin-calibration.ts) 逐条证明每个模式真的被造了出来**
(9/9,结果在 [`results/origin-calibration.json`](results/origin-calibration.json))。
换掉之后 C3.3 的 detail 立刻变成 `content-length 209715200 > max 104857600`,origin 只被逼出
**524288** 字节(socket 缓冲那一口),对照臂的朴素客户端则收满 209715200 —— 这才是那一格的真绿。

**② 第一版内存测量跑在 bun 上,而桌面 main 跑的是 Electron 的 Node。**
bun 的 fetch 在同一条生产路径上给出 100 MiB / 峰值 **+249~393 MiB**,Electron 给出 **+84 MiB**。
两个数差 3~4 倍,**用 bun 那个数去判 AC2,判的是 bun**。最终判据一律取
`ELECTRON_RUN_AS_NODE=1 electron`(42.3.3 / node 24.15.0),同时并列记 node 22.22.3 作对照。

一条附带的:`ELECTRON_RUN_AS_NODE` **不接受** `--js-flags=--expose-gc`(实测 `bad option`),
gc 句柄改用 `v8.setFlagsFromString("--expose-gc")` + `vm.runInNewContext("gc")`,node 与 Electron 同一条路。

## 2. 怎么跑

```bash
# 夹具(不入仓;确定性 LCG 生成,摘要由 python hashlib 与 /usr/bin/shasum 各算一遍且逐字相同)
#   tiny.bin   1 KiB       8f967cb77d8493a8700d0362d4d4ba2c9abe1f92ff9913b6bd688f7914b9b2cc
#   empty.bin  0           e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
#   small.bin  3 MiB       3758d9e6a0f4fba5f4d4eb53f461ff2285f60ff36912d1c226646f68dcdd81fb
#   m25.bin    25 MiB      aa1c4c4cfbfd6666ad2ecd0f02b08170bcd3b6fb9e01c2cb0ceb413d31d1a877
#   m50.bin    50 MiB      c8f02df4bc16f3d6d35ca0c84a7f99a2c2337a6b60d31047370b2acd2cb533bb
#   big100.bin 100 MiB     5e9481e31f5fb6e4ba328a3d87063e22e4fcef4e9cc4931d9054bbcdbbeab5c0
export ALPHA_402_FIXTURES=/path/to/fixtures
export ALPHA_402_OUT="$PWD/docs/verification/2026-08-25-req092-402-artifact-transfer/results"
cd packages/ui-mac                      # 根 bunfig 把 `bun test` 指向一个不存在的 root

# 0. 先标定 origin —— 不过就别看后面的数
bun run ../../docs/verification/2026-08-25-req092-402-artifact-transfer/probes/origin-calibration.ts

# 格 1 + 格 7(真 IPC handler,bun)
bun test ../../docs/verification/2026-08-25-req092-402-artifact-transfer/probes/cell1-cell7.cases.ts
# 格 2 + 格 6 内存(node + Electron,一臂一进程)
bun run ../../docs/verification/2026-08-25-req092-402-artifact-transfer/probes/cell2-cell6.ts
# 格 3 / 格 4(node + Electron)
bun run ../../docs/verification/.../probes/run-arm.ts cell3-arm.ts cell3.json
DEV=$(hdiutil attach -nomount ram://16384 | tr -d ' \t') && diskutil eraseVolume HFS+ ALPHA402 "$DEV"
dd if=/dev/zero of=/Volumes/ALPHA402/filler.bin bs=1024 count=6600      # 只剩 ~1.3 MiB
bun run ../../docs/verification/.../probes/run-arm.ts cell4-arm.ts cell4.json /Volumes/ALPHA402
diskutil eject "$DEV"
# 格 5 / 格 6 envelope(bun)
bun test ../../docs/verification/.../probes/cell5.cases.ts
bun test ../../docs/verification/.../probes/cell6-envelope.cases.ts
```

**期望值的来源(刻意不 import 生产常量)**:100 MiB 上限取平台契约文件
`vendor/alpha-platform/contracts/v1/artifact-descriptor.schema.json` 的 `size.maximum`;
两个 envelope 上限取 `vendor/alpha-platform/contracts/v1/limits.json`;32 MiB 取父需求
AC2 原文;内容摘要取 `/usr/bin/shasum`(第三方实现)。代码与常量一起改错会一起自洽,
锚点必须在被测对象之外。

### 测量口径

| 项 | 口径 |
| --- | --- |
| 判据运行时 | 传输/限额/失败类一律 `ELECTRON_RUN_AS_NODE=1 electron 42.3.3 (node 24.15.0)` 为准,`node 22.22.3` 并列作对照;命名与并发类跑 bun(纯 fs 逻辑,与 fetch 实现无关) |
| 被测入口 | 格 1/5/7 走真的 IPC handler `registerCloudIpcHandlers()`;格 2/3/4/6 走真的 `downloadArtifactToFile` + `finalizeArtifactWithQuota`。替身只有 `electron` / `logging` / `alpha-auth` 三个宿主级模块 |
| 内存 | `process.memoryUsage().rss` 的 `peak − baseline`,采样 2–4 ms;baseline 取「预热一次 1 KiB 真下载 + 强制 GC + 静置 250 ms」之后;**一臂一进程** |
| 「上游有没有被拦住」 | origin 侧 `socket` 真正写出的 body 字节数(`written`),不是「打算发多少」;每格都配一条不带闸的朴素客户端对照臂 |
| 「有没有残留」 | 目标目录 `readdirSync` 全量列举,`.part` 单独点名;检测器先用一个**真放进去的** `.part` 标定 |
| 「有没有泄漏」 | renderer 可见值整棵树遍历(invoke 返回 + 每条 `wc.send`)+ 日志行 + 盘上 manifest + 文件名,九种检出先用投毒载荷标定 |
| 重复次数 | 内存类 3 轮(离散 < 0.7 MiB);其余为确定性判据,单轮 + node/Electron 双运行时交叉 |
| 平台侧 | **全部用本机独立进程的 origin 替代**;本轮没有可用的线上凭据,任何「生产平台今天怎么发」的断言都不在本目录 |
| 进仓的原始输出 | RSS 时间线抽稀到每臂 ≤300 点(**峰值点强制保留**,原始采样数记在 `originalSamples`);envelope 夹具里 256 KiB 的填充串折叠成长度。两处都由探针本身产出,不是事后手工裁剪 —— committed 的形态与重跑的形态一致 |

## 3. 逐格

### 格 1 —— descriptor-only(AC1):部分 FAIL

真跑 `registerCloudIpcHandlers()` 注册的 `cloud-status` / `cloud-artifacts`,对着真 HTTP origin。

- **PASS**:平台按契约发 descriptor 时,renderer 面五类扫描全部零发现,且 `artifacts[0].contentRef.kind`
  是 `http-stream`(取回方式,不是内容)。
- **PASS(fail-closed)**:平台把 `base64` 挂到 descriptor 上 ⇒ 整条 status 被拒成
  `{"error":"contract-incompatible"}` —— 因为 `ArtifactDescriptorV1` 是
  `additionalProperties: false` 的闭合 schema。这不是散文承诺,是结构。
- **FAIL**:`CloudJobStatusV1.result` 在 pinned schema 里是 **`{}`**(`ArtifactListV1.result` 是
  `anyOf[{}, null]`)—— 无约束。实测把
  `result: {report: {base64: …}, preview: "data:image/png;base64,…"}` 原样透传给 renderer,
  扫描器四条命中(`content-bearing-key` / `content-base64` / `data-url`)。
  本仓声明的那道防线 `scrubInlineContent`(`shared/cloud-artifact-descriptor.ts:217`,抬头自称
  「公共视图边界防线,REQ-092 AC#1」)**零调用点** —— 两条独立检索轴交叉验证过(符号名 0 命中;
  同模块的 `PUBLIC_RESULT_MAX_BYTES` 同样零消费者)。
- **测不到**:MCP tool result 与模型 transcript。云 MCP 工具由平台的 MCP facade 提供,
  alpha-code 侧对这些结果**不施加任何契约**(同上两条轴)。这一半的真相在平台侧,
  且父需求把它挂在尚未交付的 [`alpha-platform#51`](https://github.com/jinjunnn/alpha-platform/issues/51)。

原始输出:[`results/cell1-cell7.json`](results/cell1-cell7.json) 的 `cell1_status` / `cell1_list` /
`cell1_adversarial`。

### 格 2 —— 100 MiB 正常流(AC2):摘要 PASS,峰值 FAIL

摘要:三轮 100 MiB 传输,`downloadArtifactToFile` 单遍算得的 sha256 与落盘文件的
`/usr/bin/shasum` 与夹具原始摘要**三者逐字相同**(`5e9481e3…`),落盘 104857600 字节。**PASS**。

峰值(Electron 42.3.3,`peak(RSS) − baseline(RSS)`,4ms/2ms 采样,一臂一进程):

| 臂 | 峰值增量 | 耗时 |
| --- | --- | --- |
| 100 MiB 满速 ×3 | **+84.03 / +84.36 / +84.58 MiB** | 123 / 119 / 121 ms |
| 100 MiB 限速 ~30 MB/s | +81.58 MiB | 4,039 ms |
| 100 MiB 限速 ~8 MB/s | +81.16 MiB | 15,541 ms |
| 100 MiB 采样时强制 full GC | **+18.63 MiB** | 2,088 ms |
| 25 / 50 MiB 满速 | +68.28 / +84.11 MiB | 43 / 72 ms |
| 已知的坏:整包 `arrayBuffer()` 后落盘 | +140.34 MiB | 112 ms |

读法:

1. **超顶是真的,不是 loopback 太快** —— 限速到 8 MB/s(15.5 秒跑完,比真实宽带还慢)仍 +81 MiB。
2. **超出的部分是可回收垃圾,不是被持有的字节** —— 采样时每 2ms 强制一次 full GC,峰值塌到
   **+18.6 MiB**(< 32 MiB)。也就是说「不随文件大小线性增长」这半条成立,
   「峰值 ≤ 32 MiB」这半条按字面不成立。
3. **曲线在 ~84 MiB 平台化**(25 MiB → 68.3,50 MiB → 84.1,100 MiB → 84.0),不是线性。
4. 已知的坏(+140 MiB)与生产路径(+84 MiB)只差 1.7 倍 —— 尺子分得开,但余量不大;
   **buffer 臂的摘要与落盘字节完全正确**,只有内存曲线能把它和生产路径分开。

node 22.22.3 同一批臂为 +49.5 ~ +59.2 MiB(强制 GC 后 +17.5 MiB),同向。
原始数据:[`results/cell2-cell6-verdict.json`](results/cell2-cell6-verdict.json)、
[`results/cell2-cell6-runtime.json`](results/cell2-cell6-runtime.json)、
[`results/cell2-cell6-timelines.json`](results/cell2-cell6-timelines.json)。

### 格 3 —— 限额闸(AC3):部分 FAIL

14 条,node + Electron 各跑一遍。每条都同时问 origin「你到底推出去了多少字节」,
并在盘上确认无 final 无 `.part`。原始输出:[`results/cell3.json`](results/cell3.json)。

| 用例 | 结果 |
| --- | --- |
| C3.1 `descriptor.size` = 上限 + 1 | 零网络拒绝(`invalid-artifact`,pinned schema 的 `size.maximum` 先拦下)。origin `requests: 0` |
| C3.2 / C3.5 恰好等于上限(descriptor.size / Content-Length) | 放行,完整 100 MiB 落盘,摘要正确 |
| C3.3 Content-Length 声明 200 MiB | `over-limit` `content-length 209715200 > max 104857600`;origin 只推出 **524288** 字节。对照臂朴素客户端收满 **209715200** |
| C3.4 Content-Length = 上限 + 1 | `over-limit`;origin 推出 524288 字节 |
| C3.6 chunked 实发 120 MiB | `over-limit`;origin 止于 **107,282,432**(超限后一口 socket 缓冲)。对照臂收满 125829120 |
| C3.10 上限压到 1 MiB + chunked 8 MiB | `over-limit`;origin 止于 2,293,760(≈ 上限 + 一口缓冲),不是读完 8 MiB 再判 |
| C3.9 多报 Content-Length(声明 3 MiB 实发 1 MiB) | `network` / `terminated`,零残留 |
| C3.11 平台回 413 | `over-limit`,body 零字节 |
| C3.12 少报 + descriptor 带 `size` | `size-mismatch`,零残留 ✅ |
| C3.13 少报 + descriptor 带正确 `sha256` | `sha256-mismatch`,零残留 ✅ |
| **C3.7 / C3.8 / C3.14 少报 + descriptor 既无 `size` 也无 `sha256`** | **`{ok:true}`,落盘是被截断的前缀** ❌ |

C3.14 逐字节坐实:声明 `content-length: 1048576`、实际有 3 MiB 可发,落盘 **1048576** 字节、
sha `62cee74b…`,而它**正是夹具前 1 MiB 的摘要**(独立用 python hashlib 复算);
返回给 renderer 的是 `{"ok":true,…,"verification":"unverified"}`。C3.7 同形(`964e5cee…` = big100.bin 前 1 MiB)。

原因是 undici 按 `Content-Length` 截流:客户端**从来没看见**多出来的字节 ⇒ 内存安全那一面是满足的,
但「越界即 abort」在这条支上根本不会触发,而 `bytes === declaredLength` 让写入器判成成功。
`descriptor` 无 `size` 无 `sha256` 是契约允许的形态(`verification.status: "unverified"`,
抬头写明用于 legacy/超限省略)。→ [#1111](https://github.com/jinjunnn/alpha-code/issues/1111)。

**为什么既有单测没抓到**:`src/main/alpha-artifact-download.test.ts` 的
「lying Content-Length (under-declares) → abort at cumulative overrun」用的是手搓的
`{status, ok, headers, body}` 假 Response —— 它**没有 HTTP 框定**,于是假的 body 会把超出
`content-length` 的字节继续交给写入器,越界分支被走到,用例全绿。真 HTTP 上这条路不存在。

### 格 4 —— 失败与清理(AC4):PASS

10 条,node + Electron 各跑一遍。原始输出:[`results/cell4.json`](results/cell4.json)。

| 用例 | 结果 |
| --- | --- |
| C4.0 标定 | 往目录里真放一个 `.part`,残留检测器必须报警(报了)——否则后面每条「零残留」都是假绿 |
| C4.1 断流(origin 发 1 MiB 后 `socket.destroy()`) | `{ok:false, error:"network", detail:"terminated"}`;零残留;detail 不含 token |
| C4.2 流中途 `AbortSignal` | `{ok:false, error:"cancelled", cancelled:true}`(**结构槽**在位);origin `clientAbortedEarly: 1` @ 3.9 MiB;零残留 |
| C4.3 发起前已 abort | 零网络(origin `requests: 0`),仍带结构槽 |
| C4.4 descriptor 摘要不符 | `sha256-mismatch`,3 MiB 全收后判,零残留 |
| C4.5 descriptor 摘要 vs ETag 矛盾 | `sha256-mismatch` `digest sources disagree`,读 body 前拒(origin 只推出 524288) |
| **C4.6 真 ENOSPC** | 8 MiB HFS+ RAM 卷(`hdiutil ram://` + `diskutil eraseVolume`),只留 ~1.3 MiB,拉 3 MiB ⇒ `{ok:false, error:"disk", detail:"ENOSPC: no space left on device, write"}`;**卷上零残留**;detail 不含 token |
| C4.7 失败后重试 | 成功落盘 3145728 字节、摘要正确;目录里只有 final,旧 `.part` 未幸存 |
| C4.8 僵死连接 + 5s idle 看门狗 | `network` `stream idle for 5000ms`,实测 5004 ms 返回(promise 不悬挂),零残留 |
| C4.9 finalizer 拒绝准入 | 分类错误原样上浮,`.part` 被删 |

### 格 5 —— Range / 重复 / 同名 / 并发(AC6):部分 FAIL

走**真的 IPC handler**(`cloud-artifact-download`),因为「同名不碰撞」的实现
(`reserveArtifactSavedName` + 折叠比较 + 配额准入 rename)整个住在那一跳里。
原始输出:[`results/cell5.json`](results/cell5.json)。

- **C5.1 空文件**:0 字节落成真正的空 final,摘要 = `e3b0c442…`(公开常数,独立核对);零残留。PASS
- **C5.2 Range**:桌面**从不主动发 Range** —— origin 侧记录的 `Range` 头全为 `null`。
  这不是缺陷,是分工:Range 的正向验收在平台 content endpoint 那边,本票测不到。
- **C5.3 origin 擅自截断(声明全长只发一半)**:typed 拒绝(`size-mismatch`,detail 报出声明长度)
  + 零残留。PASS
- **C5.4 重复下载同一件**:两次都成功,盘上仍只有一个文件、内容正确、零 `.part`。PASS
- **C5.6 折叠同名**(`fold.bin` vs `FOLD.BIN`):第二件被改名成
  `art_job_c5fold_7_0d151d57-FOLD.BIN`,两份内容各自正确,不静默覆盖。PASS
- **C5.7 并发 8 件同 run**:8/8 成功,8 个不同文件,逐件摘要正确,零 `.part`。PASS
- **C5.8 并发同一件**:同窗口第二次被 `already-downloading` 拒(恰好 1 成功 1 拒);
  跨窗口两次都成功且内容都正确、零 `.part`。PASS
- **C5.5 同名不同件:FAIL**。两个 id 不同、内容不同的 descriptor 都叫 `report.bin`,顺序下载:

  ```
  ra.path === rb.path                                   → true
  盘上:["report.bin"],sha = aa1c4c4c…                 (= 第二件的内容)
  manifest.artifacts.length                             → 1
  manifest[0].descriptor.id                             → art_job_c5samename_4_d2c87c22   (第一件)
  manifest[0].local.bytesOnDisk / verifiedSha256        → 3145728 / 3758d9e6…             (已与盘面不符)
  日志(warn):cloud: artifact art_job_c5samename_5_… downloaded but manifest register failed:
              savedPath already registered to artifact art_job_c5samename_4_…
  两次 IPC 返回                                          → 都是 {ok:true}
  ```

  也就是:第一件的文件被第二件的字节静默替换;manifest 仍为第一件断言着一个已经不对的
  尺寸与摘要;第二件根本没进 manifest;而 renderer 被告知两次都成功。
  账本层**发现了**冲突,但发生在字节已经覆盖之后,且被降级成一条 `warn`。
  → [#1112](https://github.com/jinjunnn/alpha-code/issues/1112)。

  `reserveArtifactSavedName` 的 `isFree` 里 `if (exactNames.has(candidate)) return true` 是刻意的
  ——它服务的是 C5.4「同一件重下应覆盖」。缺的是区分依据:同一个精确名字**归属于另一个 artifactId**
  这件事,manifest 里有,而这段判断只读目录列表。

### 格 6 —— 慢消费者与 envelope 边界:PASS

**慢消费者**(生产者满速,消费者在生产支持的 `onProgress` 注入点上每次阻塞主线程 8ms):

| 臂 | 峰值增量 |
| --- | --- |
| Electron / 100 MiB | **+19.81 MiB** |
| Electron / 25 MiB | **+18.27 MiB** |
| node / 100 MiB | +21.17 MiB |
| node / 25 MiB | +22.91 MiB |

25 MiB 与 100 MiB 差 4 倍而峰值差 < 2 MiB ⇒ **不随文件大小线性增长**,且在 32 MiB 之内。
父需求 AC2 后半句成立。

**envelope 边界**(期望值取自独立契约文件 `limits.json`,两侧各测):

| 上限 | 恰好 | 恰好 + 1 |
| --- | --- | --- |
| 下行非流式 JSON 524288(`decodeJsonContract`,走真 `cloud-status`) | 正常解码,`job_id` 回得来 | `{"error":"contract-incompatible"}` |
| 上行 dispatch envelope 262144(`guardCloudEnvelope`,以真正会发出的序列化形态计量) | `ok: true` | `ok: false`,`envelope-too-large: 262145 bytes > 262144(…)` |

外加一条三点标定:262143 / 262144 / 262145 → `true / true / false`,证明这道闸是 `>` 而不是 `≥`,
且**两侧各差一个字节都给出不同答案**(只测 +1 的话,一个写死 `max` 的实现会全绿)。
原始输出:[`results/cell6-envelope.json`](results/cell6-envelope.json)。

### 格 7 —— 凭据与字节不外泄(AC5):PASS

真跑一次 3 MiB 下载(落盘 `report.bin`,`shasum` = `3758d9e6…` = 夹具摘要),然后扫描
**五个观测面**:IPC invoke 返回值、每一条 `webContents.send`、每一行 logger 输出、盘上
`artifacts.json`(1321 字节,非空)、`artifacts/` 下的文件名。

- 五面findings 全为 `[]`。
- 进度事件真的发生过(4 条,通道恰为 `cloud-artifact-progress`),且每条载荷的键集合**恰好**是
  `["artifactId","bytes","percent","runId","total"]` —— 只有计数,没有字节。
- **扫描器先用已知的坏标定**:一个投毒载荷必须同时触发
  `token-plaintext` / `bearer-wordform` / `data-url` / `long-base64` /
  `content-base64` / `content-hex` / `binary-object` / `content-bearing-key` / `byte-array`
  九种检出(实测九种全中);再对一条投毒进度事件与一份投毒 manifest 各跑一遍,都报警。
  标定不过 ⇒ 本格全部「零发现」作废。

## 4. 顺带记录的观察(**不属于这七格,未据此判红**)

1. **`outcome.path` 把本地绝对路径交给 renderer**(实测
   `/private/var/folders/…/.alpha/runs/<run>/artifacts/report.bin`)。父需求 Non-goals 一节写着
   「不向 renderer、模型或远端暴露本地绝对路径或 bearer token」,但 AC5 正文只点名 token,
   矩阵第 7 格也只写「无 bearer、Buffer、完整字节」。要不要收口是 owner 的范围裁决。
2. **限额闸一在生产参数下不可达**:`descriptor.size > maxBytes` 这一支的前提是
   `deps.maxBytes < 104857600`,而 pinned schema 已经把 `size` 卡在 `maximum: 104857600`。
   生产默认下越界的 descriptor 一律先被判 `invalid-artifact`。效果仍是零网络 fail-closed,
   只是分类码与模块抬头自述的 `over-limit` 不同。
3. **`PUBLIC_RESULT_MAX_BYTES`(`shared/cloud-artifact-descriptor.ts:92`)零消费者。**
   真正生效的 512 KiB 上限来自 vendored `limits.json` 的 `NON_STREAMING_PAYLOAD_MAX_BYTES`
   (同值、不同来源)。不是功能缺口,是一个会漂移的重复常量。
4. **格 3 / 格 5 的两个缺陷,既有单测都覆盖不到**,原因同一类:被测对象之外的东西被手写了替身
   (假 `Response` 没有 HTTP 框定;命名判断只读目录不读账本)。若 owner 要把它们变成每 PR 闸,
   得先接受「测试里要起一个真 socket origin」这条成本。本目录的探针刻意**不**登记进
   `scripts/gate-files.tsv` —— 那是范围外的决定。

## 5. 未验证项(本目录**没有**这些的读数,不要据此推断)

| # | 未验证 | 为什么 |
| --- | --- | --- |
| 1 | **AC7 静态契约门** | 不由本票承载(见开头「覆盖边界」)。父票指给每 PR 跑的 schema/forbidden-field 门 |
| 2 | **MCP tool result 与模型 transcript 里有没有内联字节**(格 1 的另一半) | 云 MCP 工具由平台的 MCP facade 提供,alpha-code 侧对这些结果**不施加任何契约**(两条独立检索轴各自 0 命中)。本仓没有可断言的接缝 ⇒ 测不到,不是「测了没问题」 |
| 3 | **Range 的正向行为**(206 / `Content-Range` / 断点续传语义) | 桌面**从不主动发 Range**(origin 侧记录的 `Range` 头全 `null`,见格 5 C5.2)。正向验收在平台 content endpoint,本票测不到。本票只验证了「origin 擅自回 206 partial 时,摘要/尺寸不变量照旧生效」 |
| 4 | **生产平台今天实际发什么** | 本轮无可用线上凭据,且 `alpha-platform#51`(删除生产 status/MCP/result 的 inline/base64 路径)尚未交付。所有平台行为都由本机 origin 扮演 |
| 5 | **打包后的 app**(electron-builder 产物 + Chromium 起着) | 本轮用 `ELECTRON_RUN_AS_NODE` 跑 Electron 的 Node,拿到的是 main process 的运行时,但**不含渲染进程的常驻内存与真实 baseline**。格 2 的绝对值在打包态可能更高,方向不会反 |
| 6 | **崩溃恢复**(写 `.part` 途中进程被杀,重启后的清理) | 七格里没有这一格。`artifact-service` 的预约扫描注释提到这条路径,本轮未执行 |
| 7 | **非 macOS** | 全部读数取自 darwin 25.3.0 / arm64。ENOSPC 用的是 HFS+ RAM 卷,其它文件系统的 errno 与部分写行为未验证 |
| 8 | **并发规模上限** | 格 5 只跑到 8 路并发同 run。更高并发下配额准入的扫描窗口行为未验证 |
