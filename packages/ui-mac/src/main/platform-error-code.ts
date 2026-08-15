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
//
// [ac#962] 平台的拒绝有**两种信封形状**,分类槽的位置不同,咽喉两种都读:
//   · 扁平(cloud 面,alpha-platform `lib/cloud-core.ts` / `cloud.ts`):`{ error: 散文, code }`;
//   · 嵌套(gateway 面,alpha-platform `packages/gateway/src/worker.ts`):`{ error: { message, code } }`
//     —— 这一种在 `/v1/messages` 上是**结构性必需**(Anthropic wire,Claude Code 认得),
//     不是平台随手写的,所以消费端认两种形状而不是要求对方统一。
// 顺序写死 **顶层优先**:cloud 面(含唯一真用户出口 renderer 的 dispatchError)今天靠顶层码
// 工作;反过来先读嵌套的话,平台哪天在 cloud 面同时给出两个槽,已工作的路径会**静默换码**
// 而没有任何判据变红。fail-closed 那一半不因此变松:两个槽都没有合法码 ⇒ 仍是 `http-<status>`,
// 不猜、不回落到 `error.message`(那是散文槽)。
const CLASSIFICATION_CODE = /^[a-z][a-z0-9_]{2,63}$/

/** 合法分类码才算数;不合法(非字符串/违文法/越界)一律返回 undefined,让调用方去看下一个槽。 */
function classify(slot: unknown): string | undefined {
  return typeof slot === "string" && CLASSIFICATION_CODE.test(slot) ? slot : undefined
}

export async function httpErrorCode(res: Response): Promise<string> {
  const fallback = `http-${res.status}`
  try {
    const body: unknown = JSON.parse(await res.text())
    // 可选链而不是靠外层 catch 兜:`error` 是 null / 字符串 / 数组时都是**正常形状**,
    // 不是异常 —— 靠 catch 兜的实现今天碰巧也返回 fallback,但下一个动 try 边界的人会把它翻掉。
    const envelope = body as { code?: unknown; error?: { code?: unknown } | null } | null
    return classify(envelope?.code) ?? classify(envelope?.error?.code) ?? fallback
  } catch {
    return fallback
  }
}
