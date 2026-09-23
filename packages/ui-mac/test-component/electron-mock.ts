// `#1423` —— `bun test src` 里注册 electron mock 的唯一入口。
//
// 为什么需要它(2026-09-23 实测,不是推断):`bun test src` 把 382 个测试文件跑在**同一个进程**
// 里,而 bun 1.3.14 的 `mock.module("electron", …)` 把该模块的**导出名集合**钉死在进程里
// **第一个被实例化**的工厂上 —— 后来的工厂只更新这些名字的值,新名字静默丢掉
// (同一条机制已记在 src/main/alpha-keychain-backend.ts 的头注里)。
//
// 而 electron 是 CJS —— `node_modules/.bun/electron@*/node_modules/electron/index.js` 末行是
// `module.exports = getElectronPath()`。bun 因此把**任何形态**的 import(具名 / 默认 / 命名空间)
// 都编译成对 `default` 的访问。第一个工厂不给 `default` ⇒ 凡是 import 面走得到 electron 的模块
// 在**链接期**就抛 `Missing 'default' export in module …/electron/index.js`,**整份测试文件夭折、
// 一条用例都不执行**;bun 把它记成一条没有名字的失败(`N fail` 里有它、`(fail)` 行里没有它、
// junit 里连 testsuite 都没有),于是棘轮点不出名字。
//
// 最小复现与反证(两条都实跑过):
//   bun test src/main/alpha-surfaces.test.ts src/main/process-fence-wiring.test.ts
//     ⇒ 1 error(alpha-surfaces 的工厂先被实例化,它没有 default)
//   给 alpha-surfaces 的工厂补上 default 之后同一条命令 ⇒ 16 pass / 0 fail
//
// 为什么只罩 `src/**/*.test.ts`:`*.cases.ts` 由各自的 host 用 `Bun.spawnSync([bun,"test",<单个文件>])`
// 起**独立进程**,一个进程里只有它自己那一个工厂,名字集合天然完整 —— 跨文件污染面不在那里。
//
// 为什么传工厂而不是传对象:几处调用点的 mock 值引用 `beforeEach` 才赋值的绑定,工厂必须保持惰性。
// `default` 指向工厂返回的**同一个对象**(而不是一份拷贝),与 req053-electron-stub.ts 的
// `stub.default = stub` 同形;不用展开是因为展开会当场求值调用方对象上的 getter。
//
// 闸门:src/main/electron-mock-default.test.ts —— `src/**/*.test.ts` 里不许留裸的
// `mock.module("electron", …)`。
import { mock } from "bun:test"

export function mockElectron(factory: () => Record<string, unknown>): void {
  mock.module("electron", () => {
    const exports = factory()
    exports.default = exports
    return exports
  })
}
