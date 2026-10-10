// REQ-229 / REQ-230 视觉证据 harness(L2):挂载**生产组件** + 真实 CSS,只桩数据与 IPC。
// 不进 `bun test src`(本目录不在 src 下);运行:`bun test-visual/capture.ts`(见 README)。
import { fileURLToPath } from "node:url"
import solidPlugin from "vite-plugin-solid"
import { defineConfig } from "vite"
import { UPSTREAM_LOGO_ALIAS } from "../scripts/upstream-logo-alias.ts"

const providersStub = fileURLToPath(new URL("./providers-stub.ts", import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      // composer 的 `./providers` 借上游 command 上下文 —— 与 alpha-composer-model.cases.ts 同一处桩。
      name: "alpha-visual:providers-stub",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "./providers" && importer?.includes("/alpha-ui/alpha-composer")) return providersStub
      },
    },
    solidPlugin(),
  ],
  resolve: { alias: [UPSTREAM_LOGO_ALIAS] },
  server: { port: 5199, strictPort: true, fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
})
