# 整份测试文件在链接期夭折 —— bun 的 electron mock 与「没有名字的失败」(`#1423`)

> 勘破记录。全部数字是 2026-09-23 在 `alpha@20c78a4ed` 上实跑出来的(macOS / bun 1.3.14 /
> electron 42.3.3),不是推断。配套的门 × 环境状态表在
> [`quality-gate-environments.md`](quality-gate-environments.md)。

## 1. 现象

`cd packages/ui-mac && bun test src` 在修复前是:

```
 5275 pass
 3 fail
 3 errors
Ran 5278 tests across 382 files.
```

三条 `# Unhandled error between tests`,分别挂在
`src/main/{process-fence-wiring,sidecar-stop,server}.test.ts` 下,报同一句

```
SyntaxError: Missing 'default' export in module '…/electron@42.3.3…/electron/index.js'.
```

这三个文件**各自单跑都是绿的**(23 / 5 / 12 条),只在全量里整份夭折 —— 里面几十条断言一条没执行。

## 2. 机制(两步,都实测过)

**第一步:electron 是 CJS,任何 import 形态都要 `default`。**
`node_modules/.bun/electron@*/node_modules/electron/index.js` 的最后一行是
`module.exports = getElectronPath()`(返回 Electron 可执行文件的路径字符串)。bun 因此把
**具名 / 默认 / 命名空间**三种 import 全部编译成对 `default` 的访问 —— 这三种形态没有一种能绕开它。

**第二步:`mock.module("electron", …)` 的导出名集合由进程里第一个被实例化的工厂钉死。**
`bun test src` 把 382 个文件跑在同一个进程里。先跑的那个工厂决定名字集合,后来的工厂只更新
这些名字的**值**,新名字静默丢掉(同一条机制此前已记在
`packages/ui-mac/src/main/alpha-keychain-backend.ts` 的头注里)。于是:第一个工厂不给 `default`
⇒ 后面任何 import 面走得到 electron 的模块在**链接期**就抛 ⇒ 整份文件夭折。

**最小复现与反证**(两条都实跑):

```
bun test src/main/alpha-surfaces.test.ts src/main/process-fence-wiring.test.ts
  → 12 pass / 1 error        # alpha-surfaces 的工厂先被实例化,它没有 default
（给 alpha-surfaces 的工厂补上 default 之后,同一条命令）
  → 16 pass / 0 fail
```

`alpha-surfaces.test.ts` 与这三个文件**毫无关系** —— 这是这个缺陷最难归因的地方:成败取决于
哪个无关测试文件的 electron mock 先跑。

**两条平台变体是同一个根因的两面。** macOS 缺的是 `default`;ubuntu CI(run `35806141587`)报的是
`Export named 'utilityProcess' not found` —— 那一侧第一个工厂的名字集合缺的是具名成员。
把 `server.ts` 从 `import { app, utilityProcess } from "electron"` 改成命名空间导入,只消掉了
**具名成员**那一半;`default` 那一半必须在 mock 侧解决(本仓实测:只改 `server.ts` 之后
`bun test src/main` 仍是 `3 fail / 3 errors`,逐字不变)。

## 3. 为什么棘轮对它是瞎的

夭折在报表上的形状(bun 1.3.14,合成夹具实测):

| 观测轴 | 夭折的文件 |
| --- | --- |
| console `N fail` | **+1**(和真红混在一起) |
| console `N errors` | **+1** |
| console `(fail) …` 行 | **没有** |
| junit `<testsuite>` | **完全不出现**(该文件一个元素都没有) |
| `Ran N tests across M files` | 计 1 个 test、1 个 file |

`scripts/known-fails-compare.py` 靠 `(file, display)` 点名来分新旧红。夭折给不出 display,于是
交叉轴①(`junit 失败数 == console N fail`)两侧不平 ⇒ 判「测量作废」:**拦住了,但说不出是哪个
文件**。后果不是「少跑了三个文件」,是这三个文件里**任何**回归都没有判据 —— 它们的红与它们的
绿在报表上长得一样。

零测试文件不会制造这个形状,但**也不出现在 junit 里**(实测:空文件与只有 `console.log` 的文件
都计进 `across N files`、都没有 testsuite)。所以「`across N files` 减去 junit 的 testsuite 数」
**不能**用来数夭折 —— 这条看起来最顺手的轴是错的。

## 4. 修法

1. **`packages/ui-mac/test-component/electron-mock.ts`** —— `src/**/*.test.ts` 里注册 electron mock
   的唯一入口 `mockElectron(factory)`,由它保证 `default` 指向工厂返回的同一个对象。
   只罩 `src/**/*.test.ts`:`*.cases.ts` 由各自 host 用 `Bun.spawnSync([bun,"test",<单个文件>])`
   起独立进程,一个进程一个工厂,跨文件污染面不在那里。
2. **`server.ts` 改用命名空间导入** —— 它是仓内唯一一处 `import { app, utilityProcess } from "electron"`,
   也正是 ubuntu 那一侧点名的具名成员来源。
3. **`scripts/known-fails-compare.py` 把夭折变成一条可点名的拦截路径**:console 里的夭折块按
   紧邻其上的文件头行归因;归因不到 ⇒ 仍然作废(fail-closed)。交叉轴①改成
   `junit 失败数 + 夭折文件数 == console N fail`,剩下的不平照旧作废。
   **夭折不许登记进 `scripts/known-fails.tsv`**(判官在清单形状那一层就拒):一个加载不起来的
   文件里没有可归因的用例,登记它等于让棘轮对整份文件永久失明 —— 比点不出名字更坏。

判据在 `packages/ui-mac/src/main/known-fails-ratchet.test.ts`:合成的夭折夹具必须被点名、
对照臂(把加载错误修好)必须放行、登记进清单必须仍被拒。

## 5. 诚实边界

- 本次只把 `default` 收进了唯一入口。**名字集合**那一半(某个工厂没给的具名成员,被后来的消费方
  需要)仍然可能咬人 —— ubuntu 那条 `Export named 'utilityProcess' not found` 就是它,
  `src/main/desktop-menu-publication.test.ts` 的头注也记着同族的 `Export named 'Menu' not found`。
  本机跑不出 linux 那一侧,所以不在本次修法里;它现在的兜底是第 4 条第 3 点 —— **会被点名**,
  不再是一条没有名字的失败。
- 归因靠的是 console 的文件头行。bun 换版本改掉这个输出形状时,判官会把夭折块判成「归因不到文件」
  并作废,而不是安静地报出错误的文件名。
