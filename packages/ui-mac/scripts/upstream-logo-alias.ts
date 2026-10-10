import { fileURLToPath } from "node:url"

// `ac#1479`:上游 app 仍会在健康检查 / 连接失败的加载画面与错误页渲染 opencode 标志
// (`@opencode-ai/ui/logo` 的 Splash / Logo / Mark)。打包期把这个模块整体换成 alpha 的同签名
// 实现(`src/renderer/logo-alpha.tsx`),上游源码一行不改(only-add, never edit upstream)。
// 精确匹配整条模块说明符,不吃 `@opencode-ai/ui/logo-*` 之类的兄弟模块。
export const UPSTREAM_LOGO_ALIAS = {
  find: /^@opencode-ai\/ui\/logo$/,
  replacement: fileURLToPath(new URL("../src/renderer/logo-alpha.tsx", import.meta.url)),
}
