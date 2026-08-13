// [#918→#940] 平台 HTTP 拒绝 → 用户可读错误字符串的**唯一咽喉**。
//
// 平台的拒绝带**稳定分类码**(alpha-platform `lib/cloud-core.ts` 的 `{ error, code }` 信封:
// `denied_paths_unenforceable_for_execution_form`、`upload_reserved_input`、`billing_unready`、
// `rate_limited` …)。把它压成 `http-400` 等于把「你要的那条限制,这个执行形态根本强制不了」
// 这句诚实说明丢掉,只留一个用户无从下手的数字 —— 而 renderer 会把它原样贴在错误行里。
//
// 纪律(#918 定,#940 收编整类):
//   · 只取 `code` 这一个分类槽:`error` 是散文,可能携带路径/租户且随时会变,不进 UI。
//   · 无 `code`(或形状不认识)⇒ 保持 `http-<status>`,不猜。
//   · **`http-<status>` 只允许在本模块铸造。** src/main 里任何读平台 Response 产出 error
//     字符串的出口都必须经这里;新增出口不经咽喉 = platform-error-code-gate.test.ts 红。
//     (#918 修了 authed() 一处后,dispatchExplicitCloudUpload 又原样长出第二个实例 ——
//     同一类第二次出现,按类收口,不再逐实例修。)
const CLASSIFICATION_CODE = /^[a-z][a-z0-9_]{2,63}$/

export async function httpErrorCode(res: Response): Promise<string> {
  const fallback = `http-${res.status}`
  try {
    const body: unknown = JSON.parse(await res.text())
    const code = (body as { code?: unknown } | null)?.code
    return typeof code === "string" && CLASSIFICATION_CODE.test(code) ? code : fallback
  } catch {
    return fallback
  }
}
