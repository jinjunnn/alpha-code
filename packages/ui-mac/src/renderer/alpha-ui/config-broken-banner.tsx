// 全局配置失效提示条 —— 首页与新对话页共用这一段(#1590 AC1:同一组件、同一文案、同一「打开配置」动作)。
// 启动必然落到新对话页,只挂在首页时用户看不到它。

import { Show } from "solid-js"
import { Banner } from "./Banner"
import { useConfigHealth } from "./use-config-health"
import { t } from "../i18n"

export function ConfigBrokenBanner() {
  const configHealth = useConfigHealth()
  return (
    <Show when={configHealth().broken}>
      <Banner
        kind="warning"
        title={t("alpha.home.configBroken")}
        detail={configHealth().reason}
        action={{ label: t("alpha.home.openConfig"), onClick: () => void window.api.openPath(configHealth().path ?? "") }}
      />
    </Show>
  )
}
