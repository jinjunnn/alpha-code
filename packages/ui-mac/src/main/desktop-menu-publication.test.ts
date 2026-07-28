// REQ-126 AC7(#658)桌面菜单发布面闸门的入口。
//
// 保证(删掉本文件会失去什么):原生应用菜单里**又出现一个点了没反应的项**这件事将不再有任何东西
// 能发现。菜单项由 `main/menu.ts` 逐条发布,点一下经 `sendMenuCommand` 送到渲染进程
// `command.trigger(id)`,而上游 `run()` 对未注册 id **静默返回** —— 于是 REQ-085/086/125 顶替掉
// 上游三片叶之后,一串菜单项按下去什么都不发生,也不报错。
//
// 真实判据在 packages/ui-mac/test-component/desktop-menu-publication.cases.ts:mock 掉 electron 跑
// 真 `createMenu`,拿到真原生模板,把它**整个**点一遍,断言发出的命令 id 集恰好等于发布面
// (`src/shared/desktop-menu-policy.ts`)。之所以起子进程而不是就地跑:`mock.module("electron", …)`
// 是进程级的,`bun test src` 里别的 main 用例也各自替身了 electron,同进程会互相盖掉
// (实测症状:整包跑时报 `Export named 'Menu' not found`,单跑却全绿)—— 仓内 test-component/*.cases.ts
// 同因同法。
//
// 这不是「把主判据委派给另一个已登记测试」那种形态:本文件**直接执行**判据(子进程跑不起来、
// 或 cases 文件被删,spawn 非零退出即红),所以登记簿里 delegates_to = `-`。
//
// 本文件不只看"子进程绿":还钉住**跑过的用例条数下界**,否则删掉矩阵里的某一格(比如「把真菜单
// 整个点一遍」——正是本闸门唯一抓得住「多出一条没人接的菜单项」的那一格)子进程照样 0 fail。
// 下界**等于**当前条数,不留余量;合法新增用例时同步上调。

import { expect, test } from "bun:test"
import path from "node:path"

/** (整个点一遍 + 逐条点得着 + 结构对齐 + 分隔符卫生 + 分类穷尽)× 2 平台 + 1 条具体后果 = 11。 */
const CASE_FLOOR = 11

test(
  "桌面菜单发布面:真建出来的原生菜单,整个点一遍只发得出发布面上的命令",
  () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        path.resolve(import.meta.dir, "../../test-component/desktop-menu-publication.cases.ts"),
      ],
      cwd: path.resolve(import.meta.dir, "../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // 取回真实数字再比:`toContain("0 fail")` 会被 "10 fail" 匹配上,而钉死总数会在别人合法
    // 新增一格时误红 —— 所以判据是「fail 恰为 0」+「pass 不低于矩阵下界」。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, enough: pass >= CASE_FLOOR }, output).toEqual({ fail: "0", enough: true })
  },
  120_000,
)
