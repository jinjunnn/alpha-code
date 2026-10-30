// REQ-236 §2.1-4(`#1562`):平台模型请求的凭据在**请求边界现读**,不在引擎装配置时定死。
//
// 为什么在这里:续期每十分钟换一次令牌。以前令牌经平台 provider 的 `options.apiKey = {file:…}` 在引擎装配置时
// 被替换成字面量,再被 provider.ts 的 SDK 缓存按 options 哈希留住 —— 文件改了引擎也不读,只能重启引擎换血
// (owner 机器上四小时 25 次)。现在注入面只给平台 provider 一个固定的非凭据占位 apiKey
// (ui-mac `alpha-models.ts` PLATFORM_API_KEY_PLACEHOLDER),真凭据由本钩子每次请求从
// `ALPHA_PLATFORM_AUTH_REF`(main 在 fork 时置成 `{file:<userData>/alpha-secrets/ALPHA_API_KEY}`)指向的文件读出,
// 写成请求级 `authorization`。按装着的版本实读:请求级头最后合并(`opencode/src/session/llm/request.ts`),
// `@ai-sdk/provider-utils` 小写归一且后写者赢 ⇒ 盖过 SDK 由占位 apiKey 生成的配置头;同一请求的 SDK 重试复用这份头。
//
// 读不到(引用缺席 / 不是 `{file:}` 形状 / 文件缺席或为空)⇒ 抛 `@ai-sdk/provider` 的 `LoadAPIKeyError`:
// 引擎把它归为 `ProviderAuthError`(`session/message-v2.ts`),请求在发出前被拒,界面按现有认证错误给出重试 /
// 重新登录。**绝不**回落:SDK 缓存与 provider options 里只有占位值,结构上无旧值可用(I5)。
// 只作用于平台代理节点(与输出上限同一个判据 `isPlatformProvider`);第三方与 BYOK 节点不碰。
// 错误消息不含路径与任何文件内容。

import { readFileSync } from "node:fs"
import { LoadAPIKeyError } from "@ai-sdk/provider"
import { resolveFileRefs } from "./cloud-websearch-kill"
import { isPlatformProvider } from "./platform-output-cap"

export const PLATFORM_AUTH_REF_ENV = "ALPHA_PLATFORM_AUTH_REF"

/** 平台代理节点 ⇒ `Bearer <现读的凭据>`;其它节点 ⇒ undefined(不动请求头)。读不到即抛 `LoadAPIKeyError`。 */
export function platformCredentialHeader(input: {
  providerBaseURL: unknown
  env: Record<string, string | undefined>
  readFile?: (path: string) => string
}): string | undefined {
  if (!isPlatformProvider({ providerBaseURL: input.providerBaseURL, alphaBaseURL: input.env.ALPHA_BASE_URL })) return undefined
  const token = readCredential(input.env[PLATFORM_AUTH_REF_ENV], input.readFile ?? ((path) => readFileSync(path, "utf8")))
  if (!token)
    throw new LoadAPIKeyError({
      // 措辞刻意避开引擎重试表的关键词(`opencode/src/session/retry.ts`:非 APIError 的消息含 unavailable / exhausted 等
      // 即判「可重试」,会把这个确定性的认证失败按退避重试约 60 秒才显示给用户)。
      message: "Code Puppy platform credential could not be read — the request was not sent. Retry, or sign in again.",
    })
  return `Bearer ${token}`
}

function readCredential(ref: string | undefined, readFile: (path: string) => string): string | undefined {
  if (!ref || !/^\{file:[^}]+\}$/.test(ref)) return undefined
  try {
    return String(resolveFileRefs(ref, readFile))
  } catch {
    return undefined
  }
}
