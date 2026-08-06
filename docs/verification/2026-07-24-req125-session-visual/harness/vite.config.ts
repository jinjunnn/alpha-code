import { defineConfig } from "../../../../packages/ui-mac/node_modules/vite"
import solid from "../../../../packages/ui/node_modules/vite-plugin-solid/dist/esm/index.mjs"
import { fileURLToPath, URL } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  root: here,
  plugins: [solid()],
  resolve: {
    alias: [
      {
        find: "solid-js",
        replacement: fileURLToPath(new URL("../../../../packages/ui-mac/node_modules/solid-js", import.meta.url)),
      },
      { find: "@opencode-ai/app", replacement: fileURLToPath(new URL("./visual-app-stub.ts", import.meta.url)) },
      {
        find: "@solidjs/router",
        replacement: fileURLToPath(new URL("./visual-router-stub.ts", import.meta.url)),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
  },
  worker: { format: "es" },
})
