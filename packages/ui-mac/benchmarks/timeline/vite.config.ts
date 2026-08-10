import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

const root = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  root,
  plugins: [solid()],
  resolve: {
    alias: [
      {
        find: "solid-js",
        replacement: fileURLToPath(new URL("../../node_modules/solid-js", import.meta.url)),
      },
    ],
  },
  build: {
    emptyOutDir: true,
    outDir: "dist",
    sourcemap: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4175,
    strictPort: true,
  },
  worker: { format: "es" },
})
