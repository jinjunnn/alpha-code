// @opencode-ai/sdk 在单一审批面运行时闸门 bundle 里的**录音**替身(#619 R2 Blocker)。
//
// 为什么必须有:single-surface-app-stub 的录音 proxy 只覆盖「被注入进来的 client」
// (useServerSDK().client、ensureDirSdkContext().client、projects.sdk())。dock/composer
// 若**自己新建**一个真实 client —— `createOpencodeClient({ baseUrl })` —— 决定就完全绕过
// 录音面直达引擎。Codex R2 实测该等义改写:不新增任何 DOM、方括号取值提交,
// `POST /api/session/<id>/permission/<id>/reply` 真的发出,而闸①②③全绿。
// (旧的 `createOpencodeClient` 源码禁令只检查 permission-watcher.tsx,
//  见 permission-mount-ratchet.test.ts —— dock/composer 不在其射程内。)
//
// 闭合方式:把 `@opencode-ai/sdk` **整个前缀**(/v2/client、/v2、/client、/v2/gen/client…
// 全部子路径,rollup alias 的字符串匹配含 `find + "/"` 前缀)alias 到本文件。于是 bundle
// 里任何新建的 client 也是同一个录音 proxy,方括号等义改写的调用同样进 dockClientCalls,
// 闸③覆盖「另建 client」这条路。
//
// 刻意只导出「能造出 client 的那两个成员」:其余成员(如 gen client 的 createClient)
// 一旦被 value-import,Rollup 直接以「X is not exported by …」把构建打红 —— 显性失败,
// 不是静默绕过。类型导入(本仓现有全部 SDK 导入都是 `import type`)在 transform 阶段擦除,
// 不受本替身影响。

import { recordingClient } from "./single-surface-app-stub"

/** 新建 client = 同一个录音 proxy(与注入 client 同源)。 */
export function createOpencodeClient(_config?: unknown): unknown {
  return recordingClient
}

/** `new OpencodeClient({ client })` 这条等价构造同样落进录音面。 */
export class OpencodeClient {
  constructor(_config?: unknown) {
    return recordingClient as OpencodeClient
  }
}
