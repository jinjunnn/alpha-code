// #1557(方案 req236 §2.5「模型目录刷新失败提示的位置与语义」· 批准稿 2026-10-30-req236-model-status §二):
// 目录刷新失败是**降级不是阻断**,只在「选模型、发消息」时与用户有关。提示因此跟着使用点走(输入框提示槽、
// 选择器分组头 / 弹层底部),不再是 index.tsx 里那条全局 fixed 横幅 —— 后者在窄窗口下压住导航与设置入口。
//
// 数据是 `#1556` 的按文档结局(main 的 alpha-catalog-health:`{ platform, byok }`,`null` = 那一份最近一次刷新成功),
// 本票只改呈现:平台那份 → 输入框提示槽 + 平台分组头(从未获取)或弹层底部一行(有已应用旧版本);
// 自带 Key 那份 → 只在自带 Key 分组头(随包清单本身可用,不进输入框)。
import { createSignal, onCleanup, onMount } from "solid-js"
import type { CatalogRefreshHealth } from "../../shared/alpha-model-types"
import { t } from "../i18n"

/** 刷新结局:invoke 取当前值(启动那次刷新早于 renderer 挂载)+ 订阅后续变化。两条都要,少一条就有一类失败到不了用户。 */
export function createCatalogRefreshHealth() {
  const [health, setHealth] = createSignal<CatalogRefreshHealth>({ platform: null, byok: null })
  onMount(() => {
    void window.api.models.refreshHealth().then(setHealth)
    onCleanup(window.api.models.subscribeRefreshHealth(setHealth))
  })
  return health
}

/** 分类码 → 批准稿的三类原因。`contract-incompatible` 走同一位置,原因写「需要更新 Code Puppy」。 */
export function catalogFailureReason(code: string) {
  if (code === "network" || code === "timeout" || code === "no-platform-endpoint")
    return t("alpha.model.catalogReasonNetwork")
  if (code === "contract-incompatible") return t("alpha.model.catalogReasonUpdate")
  return t("alpha.model.catalogReasonServer")
}

/** 最近成功时间:当天写「今天 22:17」,否则「10月29日 22:17」(批准稿 §五)。 */
export function catalogSyncedAt(iso: string, now = new Date()) {
  const at = new Date(iso)
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  if (at.toDateString() === now.toDateString()) return t("alpha.model.catalogTimeToday", { time })
  return t("alpha.model.catalogTimeDate", { month: at.getMonth() + 1, day: at.getDate(), time })
}

/** 「重试」= main 的 requestCatalogRefresh("manual")(两份目录各自单飞,结局经上面的订阅回来)。 */
export function retryCatalogRefresh() {
  void window.api.models.refresh()
}
