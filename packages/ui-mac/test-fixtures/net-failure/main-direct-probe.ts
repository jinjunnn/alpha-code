// `#1572` AC4 真栈的 main 臂:Electron 内嵌 node 里**不设代理**直连(= 从 Finder 启动的 main 进程,没有代理变量),
// 对一个只收不回的本机监听发 https fetch;undici 的连接计时器同时覆盖 TCP 与 TLS,生产分类模块按 main 的路径
// `{ via: "other" }` 必须说「连接建立超时」而不是「握手无回应」。由测试用 Bun.build 打成 node 脚本再交给 Electron 跑。
import { classifyNetFailure } from "@opencode-ai/schema/alpha-net-failure"

const error = await fetch(process.argv[2]).then(
  () => undefined,
  (failure: unknown) => failure,
)
const cause = (error as { cause?: { name?: string; code?: string; message?: string } } | undefined)?.cause
console.log(
  JSON.stringify({
    classified: classifyNetFailure(error, { via: "other" }),
    shape: { name: (error as Error | undefined)?.name, causeName: cause?.name, causeCode: cause?.code, causeMessage: cause?.message },
  }),
)
