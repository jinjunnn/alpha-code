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
