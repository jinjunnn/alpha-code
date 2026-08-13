// #940 —— 平台错误分类码提取的**咽喉**(#918 的 httpErrorCode 从 alpha-cloud-jobs 单点升级为类机制)。
//
// 类:src/main 里每个「读 alpha-platform(gateway / account-server)非 2xx Response 并产出
// error 字符串」的点。第一实例 #918(authed 派发面),第二实例 #940(显式上传派发)——
// 同一类第二次出现,按仓规从逐实例修切到「枚举整类 + 单点机制」:提取逻辑只此一份,
// 全部出口从这里进;新增出口由 platform-error-chokepoint.test.ts 默认拒
// (源码文本扫描 —— 减速带级绊线,不是安全边界,见该文件抬头的诚实声明)。
//
// 平台拒绝的两种真实信封形状(实读 alpha-platform@0883b28,#918 只认了第一种):
//   · cloud 路由(lib/cloud-core.ts / routes/cloud-jobs.ts / cloud-schedules.ts):
//       { error: <散文>, code?: <稳定分类码> }
//     例:{ error: "upload rejected", code: "upload_reserved_input" }
//   · models / account(server.ts / account-server.ts):
//       { error: { message: <散文>, code?: <码> } }
//     例:{ error: { message: "forbidden: …", code: "scope_forbidden" } }
//
// 只取 code 槽:`error` 散文可能携带路径/租户且随时会变,默认不进 UI(prose 槽唯一的
// 消费点是 alpha-cloud-schedules,理由钉在那边的调用点)。无 code、code 不合文法、
// 非 JSON、形状不认识 ⇒ `http-<status>`,不猜 —— 这是 fail-closed 的那一半,不能省。

export const CLASSIFICATION_CODE = /^[a-z][a-z0-9_]{2,63}$/

export type PlatformErrorParts = {
  /** 稳定分类码(过 CLASSIFICATION_CODE 文法才算)。renderer 可安全原样呈现或映射文案。 */
  code?: string
  /** 平台散文(cloud 形状的 `error` / 嵌套形状的 `error.message`)。默认不进 UI。 */
  prose?: string
  /** `http-<status>`。没有可信分类码时的诚实回退。 */
  fallback: string
}

const asCode = (value: unknown): string | undefined =>
  typeof value === "string" && CLASSIFICATION_CODE.test(value) ? value : undefined

/** 非 2xx 平台响应 → 三个槽。消费 body(调用方不得再读同一个 Response 的 body)。 */
export async function platformErrorParts(res: Response): Promise<PlatformErrorParts> {
  const fallback = httpStatusFallback(res.status)
  try {
    const body = JSON.parse(await res.text()) as { code?: unknown; error?: unknown } | null
    const nested =
      body?.error && typeof body.error === "object"
        ? (body.error as { message?: unknown; code?: unknown })
        : undefined
    const code = asCode(body?.code) ?? asCode(nested?.code)
    const prose =
      typeof body?.error === "string" ? body.error : typeof nested?.message === "string" ? nested.message : undefined
    return { ...(code !== undefined ? { code } : {}), ...(prose !== undefined ? { prose } : {}), fallback }
  } catch {
    return { fallback }
  }
}

/** 非 2xx 平台响应 → 用户可见 error 字符串:分类码,或 `http-<status>` 回退。 */
export async function httpErrorCode(res: Response): Promise<string> {
  const parts = await platformErrorParts(res)
  return parts.code ?? parts.fallback
}

/** `http-<status>` 的唯一构造点。给**有意不做分类码提取**的出口用(目前只有
 *  alpha-account-request:renderer 的 accountResultState 按 `/^http-(408|425|429|5\d\d)$/`
 *  判 transient-vs-terminal,把 status 数字换成分类码会让恢复分类失真;例外理由钉在
 *  那边的调用点)。新出口默认不该用它 —— 先走 httpErrorCode。 */
export function httpStatusFallback(status: number): string {
  return `http-${status}`
}
