// REQ-088 T3/T4 web host 的 vite 配置:插件面 = @opencode-ai/app/vite(与冻结 app 的
// vite.config.ts 同一插件数组:@ 别名/channel define/theme-preload 内联/tailwind/solid)。
// 刻意**不含** ui-mac electron 构建的 brandI18nPlugin/patchUpstreamPlugin —— 两半边(adapter/
// legacy)同为未打补丁上游,与 C2 legacy 基线运行态一致;补丁在生产对两模式一视同仁
// (mode 无关),不在 adapter-vs-legacy 差异面上(证据档 §方法论 披露)。
import { defineConfig } from "vite"
import appPlugin from "@opencode-ai/app/vite"

export default defineConfig({
  plugins: [appPlugin] as never[],
  // 冻结 app 的静态资源(favicon / oc-theme-preload.js / spritesheet 等)
  publicDir: "../../../../app/public",
  server: {
    allowedHosts: true,
  },
  build: {
    target: "esnext",
  },
})
