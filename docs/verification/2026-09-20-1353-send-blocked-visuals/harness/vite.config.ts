// `#1353` 视觉 harness 构建配置 —— 与已批 2026-09-17-1130-settings-tools-visuals harness
// 同一 loopback-only 模式(生产组件 + 生产 CSS,零 Electron、零凭据)。
// 直接用 `@opencode-ai/app` 的插件链(solid + tailwind + `@` 别名)而不是裸挂
// vite-plugin-solid:后者是 CJS,vite 7 的配置预打包会在 `require("@babel/core")` 上直接失败
// (实测 `Dynamic require of … @babel/core … is not supported`)。solid-js 钉到 ui-mac 那一份
// 避免双实例。
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
  server: { host: "127.0.0.1", strictPort: true },
  worker: { format: "es" },
})
