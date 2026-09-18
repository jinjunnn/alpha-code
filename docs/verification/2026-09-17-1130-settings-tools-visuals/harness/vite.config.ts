// #1130 视觉 harness 构建配置 —— 与已批 2026-08-12-583-584-586 harness 同一 loopback-only 模式
// (生产组件 + 生产 CSS,零 Electron、零凭据)。差别:Settings 整页经 alpha-ui/providers 转口 import
// `@opencode-ai/app`(Banner → useContractHealth),所以要挂 app 自己的 vite 插件链(`@` 别名 +
// tailwind + solid),与 settings.test.ts 的运行时构建同源;solid-js 钉到 ui-mac 那一份避免双实例。
import { defineConfig } from "../../../../packages/ui-mac/node_modules/vite"
import appPlugin from "../../../../packages/app/vite.js"
import { fileURLToPath, URL } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  root: here,
  plugins: [appPlugin],
  resolve: {
    alias: [
      {
        find: "solid-js",
        replacement: fileURLToPath(new URL("../../../../packages/ui-mac/node_modules/solid-js", import.meta.url)),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
  },
  worker: { format: "es" },
})
