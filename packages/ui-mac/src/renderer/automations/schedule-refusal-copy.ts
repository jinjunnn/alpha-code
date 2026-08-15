// [#969] 云档定时任务被拒绝时,用户在 `.alpha-auto-err` 那一行读到的东西。
//
// 为什么映射在 renderer 而不是 main:main 侧全仓零 i18n import,把中文写进 main 等于让
// 英文界面读中文(en 之外的 14 个语种按既有设计回落 en)。所以 main 只出**结构槽** `code`,
// 这里是唯一有 `t()` 的那一层。形状照 `../extensions/cloud-dispatch-box.tsx` 的 `dispatchError`。
//
// 两条纪律:
//  ① **不认识的码原样透出**,不假装认识 —— 平台新增一个码时,用户看到的是一个可以拿去搜/报
//     的标识符,而不是一句和事实无关的万能抱歉;
//  ② **文案不复述平台的数值上限**(每租户条数 / 名字字数 / 最小间隔 / 信封字节)。那些数字住在
//     alpha-platform,在这里抄一份就是再造一处会静默漂移的跨仓常量副本(`alpha.auto.cloudBoundary`
//     今天已经犯了这个错,另开票收)。
//
// **刻意不映射**的四个平台 schedule 码 —— 桌面的注册信封结构上发不出它们,给它们写文案就是
// 写永不执行的死分支(信封形状见 `../../main/cloud-schedule-config.ts`,恒为
// `{schema_version, idempotency_key, autonomy:"pipeline", kind:"research", input:{question}}`):
//   · `schedule_autonomy_unsupported`  —— autonomy 恒 "pipeline",没有第二个取值可发;
//   · `schedule_upload_unsupported`    —— input 只有 question,没有上传槽;
//   · `schedule_budget_cap_exceeded`   —— 信封里没有 budget 键;
//   · `denied_paths_unenforceable_for_execution_form` —— 信封里没有 policy/denied_paths。
//     (该码在 **dispatch** 面可达且已有文案,见 cloud-dispatch-box.tsx —— schedule 面到不了。)
// 它们若真的出现,走下面的回落分支原样上屏 —— 那正是「我们的勘破错了」应该长的样子。

import { t } from "../i18n"

/**
 * 分类码 → 人话。认识的给文案,不认识的回落成带码的模板。
 *
 * 入参的 `code` 来自两个不相交的域:平台分类码 `/^[a-z][a-z0-9_]{2,63}$/`(snake,经
 * main 的 platform-error-code 咽喉),以及桌面自铸的 kebab 码(`authed()` 的四个传输伪码 +
 * `SCHEDULE_FORM_UNSUPPORTED_CODE`)。
 */
export function scheduleRefusalCopy(code: string): string {
  // 传输腿(桌面自铸,kebab)。文案与 dispatch 面共用既有键 —— 同一件事只说一遍。
  if (code === "not-authenticated" || code === "unauthorized") return t("alpha.ext.cloudErrAuth")
  if (code === "no-cloud-endpoint") return t("alpha.ext.cloudErrEndpoint")
  if (code === "network") return t("alpha.ext.cloudErrNetwork")
  // 桌面自己的早返(请求根本没发出去,平台侧刻意无码)。
  if (code === "cloud-schedule-form-unsupported") return t("alpha.auto.cloudErrFormUnsupported")
  // 平台分类码里**桌面到得了**的那些(alpha-platform lib/schedules.ts 的 SCHEDULE_REFUSAL_CODES
  // + 两个 429 桶 + 413)。
  if (code === "schedule_limit_reached") return t("alpha.auto.cloudErrLimitReached")
  if (code === "schedule_name_invalid") return t("alpha.auto.cloudErrNameInvalid")
  if (code === "schedule_cron_invalid") return t("alpha.auto.cloudErrCronInvalid")
  if (code === "schedule_interval_too_tight") return t("alpha.auto.cloudErrIntervalTooTight")
  if (code === "control_envelope_too_large") return t("alpha.auto.cloudErrEnvelopeTooLarge")
  if (code === "rate_limited") return t("alpha.auto.cloudErrRateLimited")
  if (code === "account_admission_rate_exceeded") return t("alpha.auto.cloudErrTenantRateLimited")
  // 回落:原样带上码。刻意**不**区分注册/删除 —— 那个区分今天只存在于 main 硬编码的中文前缀里,
  // 而这一层要对 16 个语种成立。
  return t("alpha.auto.cloudErrUnknown", { code })
}
