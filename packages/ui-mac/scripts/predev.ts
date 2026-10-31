import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

// REQ-159(`#1321`):进程围栏的原生模块(dev 下 sidecar 从 native/alpha-fence/build/ 加载;没有它引擎不起)。
await $`bun ./scripts/build-fence-addon.ts`

// Bundle @alpha-code/ext to self-contained ESM so the embedded Node server can load it
// without resolving raw TS at runtime (see .claude/rules/DECISIONS.md ADR-006).
await $`cd ../ext && bun run build`

await $`cd ../opencode && bun script/build-node.ts`

// #857:与 prebuild 同一个补丁 —— 让固定的 Electron 监听与进程内交接共用 Default 的路由层与 memo map。
// 漏了它,dev 的 sidecar 是两份服务图,而出货只有一份,dev 上看到的行为与出货不一致。
await $`bun ./scripts/patch-sidecar-shared-routes.ts`

// #1229:Office 版式预览宿主页(跑在隔离 WebContentsView 里,与主渲染世界零共享)。
// 单独打包的理由见该脚本文件头;产物落 out/office-preview/,由 rail-preview-host 按固定资产表服务。
await $`bun ./scripts/build-office-preview.ts`
