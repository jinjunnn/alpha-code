// #587 AC5 visual harness build config — same loopback-only pattern as the accepted
// 2026-07-24-req125-session-visual harness (production components + production CSS,
// zero Electron, zero credentials). Only the harness root differs.
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
    ],
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
  },
  worker: { format: "es" },
})
