import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import { brandI18nPlugin } from "./scripts/brand-i18n"
import { patchUpstreamPlugin } from "./scripts/patch-upstream"
import { UPSTREAM_LOGO_ALIAS } from "./scripts/upstream-logo-alias"
import { nodePtyPackage, resolveTargetArch } from "./scripts/target-arch"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

// #1496:按**目标**架构选 node-pty 包(`ALPHA_TARGET_ARCH=arm64|x64`,缺省宿主架构)。包名会被编进
// out/main —— 用宿主 `process.arch` 会让 arm64 机器打出的 Intel 包带着 arm64 终端。打包前由
// electron-builder.config.ts 的 beforePack 再核对一遍产物(scripts/target-arch.ts)。
const nodePtyPkg = nodePtyPackage(process.platform, resolveTargetArch())

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        // #367:ext-cas-gc-worker = CAS GC worker_threads 入口(调度器按 import.meta.url 同目录解析)。
        input: {
          index: "src/main/index.ts",
          sidecar: "src/main/sidecar.ts",
          "ext-cas-gc-worker": "src/main/ext-cas-gc-worker.ts",
        },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        // (镜像上游 desktop 修复 f63a451b/#35270;2026-07-07 sync 后 ui-mac build 实锤同款损坏)
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      // `@alpha-code/contracts-consumer` is a private, source-only workspace package
      // (`exports: "./src/index.ts"`). If externalized it ships as raw .ts inside
      // app.asar/node_modules, where Node refuses to strip types at runtime
      // (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) and the main process crashes on
      // launch. Exclude it so rollup bundles+transpiles it (and its ajv deps) into the
      // main chunk. (`@alpha-code/ext` avoids this by shipping a built dist/plugin.js.)
      externalizeDeps: { include: [nodePtyPkg], exclude: ["@alpha-code/contracts-consumer"] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts", recovery: "src/preload/recovery.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    // brandI18nPlugin rewrites upstream app i18n brand strings at bundle time only —
    // the on-disk source stays untouched, so upstream sync never conflicts (ADR-005/006).
    // C14④:冻结(ADR-020)后补丁子串恒应命中,打偏=真漂移 → 默认 strict(build 即红);
    // 逃生 ALPHA_PATCH_LENIENT=1(re-freeze 体检期临时放行)。
    plugins: [
      brandI18nPlugin({ strict: process.env.ALPHA_PATCH_LENIENT !== "1" }),
      patchUpstreamPlugin({ strict: process.env.ALPHA_PATCH_LENIENT !== "1" }),
      appPlugin,
      sentry,
    ],
    resolve: { alias: [UPSTREAM_LOGO_ALIAS] },
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          recovery: "src/renderer/recovery.html",
        },
      },
    },
  },
})
