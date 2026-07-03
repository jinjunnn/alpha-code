// B6(=G1):@alpha-code/ext 装载路径解析(electron-free 纯逻辑,单测覆盖;electron 参数由调用方注入)。
//
// ext 是自包含 ESM bundle(ADR-006:桌面 Electron-Node 不重写 .js→.ts,必须预 bundle;
// prebuild/predev 已构建 packages/ext/dist/plugin.js)。装载链:
//   main(spawnLocalServer)解析出 bundle 绝对路径 → 经 StartCommand 传给 sidecar(不走 env,
//   免动 A6 白名单)→ injectAlphaConfig 合并进 OPENCODE_CONFIG_CONTENT 的 V1 `plugin`(单数)数组
//   → opencode 引擎按原生 plugin 机制加载 → alpha_ping/alpha_echo 进工具表,零改上游(ADR-002/005)。
//
// 逃生:ALPHA_EXT_DISABLE=1 跳过装载。缺文件 → 返回 reason,调用方 loud warn(anti-B11:
// 否则表现为「工具静默不在」)。

import { join } from "node:path"

export type ExtPluginResolveInput = {
  /** app.isPackaged */
  packaged: boolean
  /** process.resourcesPath(打包后 extraResources 落点 <resources>/alpha-ext/plugin.js) */
  resourcesPath: string
  /** 调用方模块目录(dev 下 = packages/ui-mac/out/main,与 windows.ts 的 root 同法) */
  moduleDir: string
  /** process.env.ALPHA_EXT_DISABLE === "1" */
  disabled: boolean
  exists: (p: string) => boolean
}

export type ExtPluginResolveResult = { path?: string; reason?: string }

export function resolveExtPluginPath(input: ExtPluginResolveInput): ExtPluginResolveResult {
  if (input.disabled) return { reason: "ALPHA_EXT_DISABLE=1" }
  const path = input.packaged
    ? join(input.resourcesPath, "alpha-ext", "plugin.js")
    : // dev:out/main → ui-mac → packages → ext/dist/plugin.js(镜像 windows.ts iconsDir 的相对法)
      join(input.moduleDir, "..", "..", "..", "ext", "dist", "plugin.js")
  if (!input.exists(path)) {
    return { reason: `ext bundle missing at ${path}(预期 prebuild/predev 已构建;打包态 = extraResources alpha-ext/)` }
  }
  return { path }
}
