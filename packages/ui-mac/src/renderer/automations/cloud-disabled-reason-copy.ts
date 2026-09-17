// [#778] 云端把一个定时任务停掉时,列表行上用户读到的那一句。
//
// 理由值的权威是 alpha-platform 调度器的**写入点**(`packages/gateway/src/routes/cloud-schedules.ts`):
//   · execution_grant_missing / execution_grant_expired —— 派发前授权校验失败;
//   · stuck_job            —— 上一个 job 迟迟不终态,连续 overlap 熔断;
//   · consecutive_failures —— 连败熔断。
// 四个值的恢复动作都是「关掉再打开开关」:云端重新启用那一跳会清停用态、并重新签发执行授权。
//
// 不认识的值走兜底:明说「云端暂停了」并原样带出理由 —— 平台新增一个值时,用户与支持侧拿到的是一个
// 可以报的标识符,而不是被悄悄归进某个已知理由(过去所有非连败的值都被说成「任务卡滞」,
// 授权过期的用户因此以为是云端故障而干等)。

import { t } from "../i18n"

export function cloudDisabledReasonCopy(reason: string): string {
  if (reason === "consecutive_failures") return t("alpha.auto.cloudDisabledFailures")
  if (reason === "stuck_job") return t("alpha.auto.cloudDisabledStuck")
  if (reason === "execution_grant_missing") return t("alpha.auto.cloudDisabledGrantMissing")
  if (reason === "execution_grant_expired") return t("alpha.auto.cloudDisabledGrantExpired")
  return t("alpha.auto.cloudDisabledUnknown", { reason })
}
