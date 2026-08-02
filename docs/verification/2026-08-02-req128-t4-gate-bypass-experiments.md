---
title: REQ-128 Phase 3 T4 —— renderer 半场每道闸的绕过实施记录
kind: verification
owners:
  - alpha-code extension maintainers
last_reviewed: 2026-08-02
review_after: 2026-11-02
---

本地 Claude 插件包的 **renderer 半场**(`#784`：分流 + 预览屏 + 已装扩展包区块 + 移除 +
热重载接线)立的每一道闸，都在本机**实际实施了一次绕过**并记录了结果。方案基线
[REQ-128 Phase 3](../design/2026-08-02-req128-phase3-local-claude-plugin-import.md) §6 首句：
**写不出绕过配方的闸判为假闸，不许留在表里充数。**

## 实施纪律

- 实验前 `git status` **干净**（实现已 commit）。判据是「干净」而不是「先 commit 了吧」。
- 还原**不用** `git checkout -- <file>`，而是**精确字符串回替**：本仓栽过两次「`git checkout --`
  把同一文件里尚未提交的真实改动一起抹掉」。脚本在 `finally` 里回替，跑完 `git status` 复核干净。
- 每次只改**一处**生产代码，跑 `bun test ./test-component/local-package-renderer.cases.ts`
  （或详情页那条线的 `ext-package-detail-wiring.cases.ts`）。
- **绿基线：15 pass / 0 fail（renderer 竖线）与 13 pass / 0 fail（详情页线）。**

## 结果

| # | 闸 | 改坏了什么（生产代码） | 结果 |
| --- | --- | --- | --- |
| 1 | **G20-a** confirm 成功后引擎重载 | 从 `use-extensions.localPluginConfirm` 删掉 `refreshEngine()` | **2 fail**（第 4→6 跳的 dispose 断言 + 「待重载」如实呈现） |
| 2 | **G20-b** 整包卸载后引擎重载 | 从 `use-extensions.uninstallPackage` 删掉 `refreshEngine()` | **1 fail**：包卸掉了、账本清零了，而**引擎仍被要求重扫的次数是 0** |
| 3 | **G20-c** 详情页不得绕过数据层 | `extension-detail.removePackage` 改回 `extIpc.uninstallPackage` 直连 | **1 fail**：包照样被删、既有断言全绿，只有「经过数据层」的计数器停在 0 |
| 4 | 第 1 跳分流 | `use-extensions.importSkillFolder` 把插件目录判别臂**折叠**成 `{ok:false, reason}` | **13 fail**：预览屏结构上再也打不开 |
| 5 | 裁决 B 装完默认关 | 包内开关的 `on()` 恒 `true` | **4 fail**：「全部未启用」引导条与逐条徽标全塌 |
| 6 | 移除失败必须显示失败 | `runRemovePackage` 把任何返回都当成功 | **5 fail**：卡片被拿掉、错误不呈现 |
| 7 | 取消 = 真释放留存字节 | `closeLocalPlugin` 不再调 `localPluginCancel`，直接当成功 | **2 fail**：`retainedBytes()` 不归零 |
| 8 | 安装中取消不许读成「已取消」 | 把 main 的 `install-in-flight` 拒绝当成功 | **1 fail**：弹窗被关掉、拒绝文案消失 |
| 9 | 「读不出」不许折叠成「没装」 | 已装扩展包区块的「读不出」分支恒不渲染 | **1 fail** |
| 10 | 第 8 跳单技能移除必须被拒 | `onUninstall` 的拒绝分支恒不进 | **1 fail**：行上没有拒绝、也没有「移除整个扩展包」的出路 |
| 11 | preload 通道名 | 把 `ext-import-claude-plugin-confirm` 打成 `…-confrim` | **1 fail**：typecheck 全绿而功能整条死掉 |
| 12 | 非插件目录逐字不变 | `isLocalPluginRoute` 恒 `true`（把普通技能目录也送进预览屏） | **1 fail** |

## 两条第一轮**没有**变红的配方，以及为什么它们不算闸失效

诚实记下来，因为「我实施了绕过、它红了」这句话的价值全在于它是真的。

1. **删掉 `importSkillFolder` 里那一行显式的 route 判别臂** ⇒ 15 pass，**仍然绿**。
   真因：紧接着的 `if (!r.ok) return r` **把同一个对象原样返回**，`route` 字段还在 ⇒
   运行时行为不变。那一行是**类型与意图**的声明，不是运行时闸。
   真实的回归形状是**重建对象**（`return { ok:false, reason: r.reason }`）——
   换成它之后 **13 fail**（上表第 4 行）。留在这里防止下一轮把「删一行没红」误读成假闸。
2. **`isLocalPluginRoute` 改成 `return !result.ok`** ⇒ 仍然绿。
   真因：那条回归用例里普通技能目录导入是**成功**的（`r.ok === true`），两种实现都返回 `false`，
   夹具根本没走到判别上。改成恒 `true` 才真正撑开这个判别（上表第 12 行）。

**这两条的共同教训**：绕过配方本身也会是假的。判据不是「我改了一行」，是「用户可观察的行为
真的变了吗」——没变就说明改的不是承重的那一行，要重新找承重点，而不是据此宣布闸是假的。

## G20 的基线记录：**今天那一段就是红的**

票面 AC2 要求「必须含一条基线记录，证明今天那一段就是红的」。第 2、3 行**就是那条记录**：
它们把生产代码改回**本票之前的原样**（整包移除只 `refetchInstalled()`、详情页直连 IPC），
两条闸当场变红。也就是说 G20 钉的不是一段已经成立的行为，而是一条**这一票才接上的线**——
在此之前，用户移除一个扩展包之后，那些技能仍然被引擎实例注入着，一直到下次重启 App。

## 第二轮:包显示名(owner 裁决)+ Codex R1 五条

**绿基线:20 pass / 0 fail(renderer 竖线)、30 pass / 0 fail(V3 账本类型层)。**

| # | 闸 | 改坏了什么(生产代码) | 结果 |
| --- | --- | --- | --- |
| D1 | 列表显示 `plugin.json` 的 `name` | `packLabel` 改回只读 `rootComponentName` | **4 fail** |
| D1b | 存的是 manifest 的 name,不是目录名 | 安装时改存插件目录的 basename | **2 fail**(夹具目录名刻意 ≠ 插件名) |
| D2 | 存量图缺字段不炸、回退旧行为 | 把 `displayName` 改成必填 | **4 fail** |
| D3 | 没有任何判定读它 | 让「来自本地文件夹 / 官方目录」这个标改读显示名 | **1 fail** |
| D4b | 摘要兼容口径没变 | 给缺席的显示名**填占位**(`?? ""`) | **1 fail** |
| B | 第 9 跳穿过引擎注入链 | 删掉 `plugin.ts` 里 `injectSkillGenerationPaths` 那一行 | **4 fail** |
| B-b | 同上,换一条腿 | 让 live generation 指针读不出来(root 指错) | **4 fail** |
| M2 | SDK 的 `{error}` 判失败 | `refreshEngine` 改回「只拒超时」 | **1 fail** |
| M3 | 非插件目录失败不进预览 | `isLocalPluginRoute` 改成 `!result.ok` | **1 fail** |
| M4 | 账本坏时不许再喊「尚未安装」 | 取消通用空态的抑制条件 | **1 fail** |
| M5 | retained 解释不随包卡消失 | 把它改回「只在卡还在时渲染」 | **1 fail** |

### 又一条第一轮没变红的配方(第三次,记下来)

**D4 原配方**「把条件展开改成无条件 `displayName: graph.displayName`」⇒ **30 pass,仍然绿**。

真因:`canonicalJson`(`ext-manifest-v2.ts`)**本来就会过滤掉值为 `undefined` 的键**。
所以那个条件展开是**冗余的防御**,兼容性真正靠的是另一个模块里的那一行 `filter`。

处置**不是**删掉断言,而是把闸挪到承重点上:
①直接钉住前提本身(`canonicalJson({a,b:undefined})` 必须等于 `canonicalJson({a})`,
且填占位必须不等);②绕过配方换成 `?? ""` —— 那才是会让全部存量图集体拒载的改法,它当场变红。

**三次同一形态**(route 判别臂、`!result.ok`、这一条):
绕过配方本身也会是假的。**判据不是「我改了一行」,是「用户可观察的行为真的变了吗」。**

### 开发中真实红过的一次(不是绕过实验,是缺陷)

`decodePackageGraphV1` 校验了 `displayName` 却**没有把它带进解码结果** ⇒ 重算摘要时少了这一项
⇒ 一张**合法的、带显示名的图**被篡改闸判成「被改过」而拒载。测试当场变红。
这是「前提为假的闸门比没有闸门更贵」的最小实例:它拒的不是坏输入,是我们自己刚写的配置。

### 顺带修掉的一条夹具假绿

`waitFor` 没有 `await` 断言 ⇒ 传一个 **async** 断言进去时,它的拒绝变成 unhandled rejection,
而 `waitFor` **立刻返回成功**。第 9 跳换成异步的引擎 hook 之后正好踩上:那一条一度是永远绿的。

## 第三轮:R2 Major —— 显示名反向破坏了安装路径

**缺陷本身先复现过**(不是推断):插件名 129 个 `a` ⇒ `readManifest` 只要求非空、
`mintPackageId` 把它**截成合法的 128 字符 ID** ⇒ 照样进 `installable` 预览;
安装器把**原始 129 字符**写进 `displayName` ⇒ decoder 在 **receipt commit 那一刻**拒绝:

```
[ext-transaction] tx-rolled-back {"stage":"receipt-commit",
  "reason":"receipt commit failed: package ledger mutation rejected (fail closed):
            packageGraph.displayName: must be 1..128 characters"}
```

含控制字符的名字同理(`must not contain control characters`)。
**一个只管显示、而且明确可选的字段,反向破坏了安装路径** —— 起因是同一条文法写了两遍,
intake 一份(只要求非空)、decoder 一份(长度 + 控制字符),两份不一致。

**绿基线:22 pass / 0 fail(renderer 竖线)、52 pass / 0 fail(真实语料 intake)。**

| # | 闸 | 改坏了什么(生产代码) | 结果 |
| --- | --- | --- | --- |
| M1 | 超长名字:预览期定案 | 去掉 intake 的判定(= 修复前的行为) | **3 fail** |
| M2 | 控制字符那一臂单独也被覆盖 | 只放宽控制字符那一臂,长度臂保留 | **2 fail** |
| M3b | 真实语料零误伤 | 判据收到 26 字(< 实测最长 27) | **1 fail** |
| M3c | 长度帽的取值依据 | 帽收到 20(< 27) | **1 fail** |
| M4 | 安装器不许自己派生 | 改回 `displayName: preview.name` | **3 fail** |
| M5 | 预览期告知不许省 | 去掉 `displayNameNotice` | **3 fail** |

### 第四条没变红的配方,以及它揭出的一个真问题

**M3 原配方**「把判据收到 30 字」⇒ **52 pass,仍然绿**。

我以为 30 会误伤,依据是我在代码注释里写的「本机语料最长 31」。**实测:最长是 27**
(`claude-for-msft-365-install`)。那句「31」是我**没跑就写下的散文断言** ——
而它当时还被我用来论证「128 够长」。

处置:①注释改成实测值并写明是实测;②把这个数**钉进测试**
(`Math.max(...names.length) === 27` 且 `PACKAGE_DISPLAY_NAME_MAX > 27`),
于是语料换了、或有人把帽收到真实值以下,先在这里红;③绕过配方换成 26 与 20,两条都当场变红。

**四次同一形态。** 前三次是配方改错了地方;这一次不同 ——
**配方是照着一句假事实设计的**。判据仍然是那一条:能执行就别推断。

### 修法(两条约束逐条对照)

1. **唯一真源**:`isValidPackageDisplayName` 出在 `ext-package-ledger-v3.ts`,
   decoder 与 intake **都消费它**。
2. **判定发生在预览期**:`LocalPackagePreviewV1` 新增 `displayName` / `displayNameNotice`;
   intake 定案,安装器**只透传**。名字存不下 ⇒ 预览期具名告知、**安装照常成功**,
   账本里那张图**根本没有** displayName 字段(缺席合法)。
   **不偷偷截断** —— 截断会把作者写的名字改写成我们编的名字。
   安装器另留一条**事务前**的具名拒绝兜底:绕过 intake 直接构造 preview 时,
   失败也发生在动任何东西之前,而不是 commit 期回滚。
