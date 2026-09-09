// REQ-159 (`#1321`) —— sidecar 侧:加载原生模块、把 profile 交给内核、再**自证围栏活着**。
//
// 本模块是 sidecar.ts 在 `import("virtual:opencode-server")` 之前调的那一步。sidecar.ts 顶层的
// registerHooks / getParentPort() 让它无法被测试 import(与 #607 同因),所以这一层单独成模块:
// 判据在 process-fence-apply.test.ts 里用**真 node 子进程 + 真 .node + 真 seatbelt** 跑(不是 mock)。
//
// ── fail-closed,而且响亮(票面 AC4)──────────────────────────────────────────────
// 任何一步失败都抛 ProcessFenceError,消息里带原因原文;sidecar.ts 的 start() catch 会把它经 IPC
// 报给 main(`{type:"error"}`)并 exit(1),main 的 spawnLocalServer 据此拒绝这一代 —— 用户看到的是
// 引擎启动失败与可读原因,**不是**「引擎起来了但没有围栏」。四种失败:
//   ① 模块文件不在(打包漏了 extraResources / 架构片缺失)—— dlopen 抛,原文是 dyld 的;
//   ② `sandbox_init` rc ≠ 0 —— libsandbox 的编译/应用错误原文;
//   ③ apply 说成功,但**集合外仍写得进**(profile 被渲染成了 allow-all 一类)—— 探针落盘即拒;
//   ④ apply 说成功,但**集合内写不进**(profile 太紧,引擎起来也干不了活)—— 同样拒。
// ③④ 是「rc=0 但什么也没发生」那一类假绿的解药:判据是探针文件到底落没落盘,不是返回码。
//
// 探针路径:集合外用 `/private/var/tmp`(macOS 恒有、world-writable、不在 §8.2 任何一行下 ——
// 刻意不用 HOME:测试与隔离环境常把 HOME 放进 /private/tmp 或 $TMPDIR,那正是 §7.4 括注里
// 「escape landed 其实是布局问题」的坑);集合内用 sidecar 自己的 cwd(engine-scratch-cwd,W3 之下)。

import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export class ProcessFenceError extends Error {
  constructor(message: string) {
    super(`process fence: ${message}`)
    this.name = "ProcessFenceError"
  }
}

export type FenceAddon = {
  apply: (profile: string) => { rc: number; error: string }
  buildId: string
  libsandbox: string
}

export type ProcessFenceStartInput = {
  /** 原生模块的绝对路径(main 解析,经 StartCommand 传入)。 */
  addonPath: string
  /** 已试编译通过的 profile 全文(main 渲染,经 StartCommand 传入;这里原样 apply,不改一个字节)。 */
  profile: string
}

export type ApplyProcessFenceDeps = {
  /** 默认 process.dlopen;测试可注入。 */
  dlopen?: (module: { exports: unknown }, filename: string) => void
  /** 集合内探针目录(默认 process.cwd() = engine-scratch-cwd)。 */
  insideDir?: string
  /** 集合外探针目录(默认 /private/var/tmp)。 */
  outsideDir?: string
  writeFile?: (p: string, data: string) => void
  remove?: (p: string) => void
}

export const OUTSIDE_PROBE_DIR = "/private/var/tmp"

export function loadFenceAddon(addonPath: string, dlopen: ApplyProcessFenceDeps["dlopen"] = (m, f) => process.dlopen(m, f)): FenceAddon {
  if (!existsSync(addonPath)) throw new ProcessFenceError(`native module missing at ${addonPath}(预期 prebuild/predev 已构建;打包态 = extraResources alpha-fence/)`)
  const module: { exports: unknown } = { exports: {} }
  try {
    dlopen(module, addonPath)
  } catch (error) {
    throw new ProcessFenceError(`native module failed to load from ${addonPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const exports = module.exports as Partial<FenceAddon> | undefined
  if (!exports || typeof exports.apply !== "function" || typeof exports.buildId !== "string")
    throw new ProcessFenceError(`native module at ${addonPath} does not export apply()/buildId`)
  return exports as FenceAddon
}

export type ApplyProcessFenceResult = { buildId: string; libsandbox: string; profileBytes: number }

/** 装围栏 + 双向自证。成功返回模块身份(供日志);失败一律抛 ProcessFenceError。 */
export function applyProcessFence(input: ProcessFenceStartInput, deps: ApplyProcessFenceDeps = {}): ApplyProcessFenceResult {
  if (process.platform !== "darwin") throw new ProcessFenceError("seatbelt is darwin-only; applyProcessFence must not be called elsewhere")
  if (typeof input.profile !== "string" || !input.profile.includes("(deny file-write*)"))
    throw new ProcessFenceError("refusing to apply a profile that does not carry (deny file-write*)")
  const addon = loadFenceAddon(input.addonPath, deps.dlopen)
  const result = addon.apply(input.profile)
  if (result.rc !== 0) throw new ProcessFenceError(`sandbox_init failed (rc=${result.rc}): ${result.error.trim() || "no error text"}`)

  const writeFile = deps.writeFile ?? ((p, data) => writeFileSync(p, data))
  const remove = deps.remove ?? ((p) => rmSync(p, { force: true }))
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // ③ 集合外必须写不进。写进了 = 围栏是空的 —— 删掉探针,拒绝启动。
  const outside = join(deps.outsideDir ?? OUTSIDE_PROBE_DIR, `alpha-fence-probe-${stamp}`)
  let landedOutside = false
  try {
    writeFile(outside, "probe")
    landedOutside = true
  } catch {
    landedOutside = false
  }
  if (landedOutside) {
    try {
      remove(outside)
    } catch {}
    throw new ProcessFenceError(`sandbox_init returned 0 but a write outside the writable set landed (${outside}) — the fence is void, refusing to start the engine`)
  }
  // ④ 集合内必须写得进(否则引擎起来也干不了活,而且 health 会 200)。
  const inside = join(deps.insideDir ?? process.cwd(), `alpha-fence-probe-${stamp}`)
  try {
    writeFile(inside, "probe")
    remove(inside)
  } catch (error) {
    throw new ProcessFenceError(`fence applied but the engine cwd is not writable (${inside}): ${error instanceof Error ? error.message : String(error)}`)
  }
  return { buildId: addon.buildId, libsandbox: addon.libsandbox, profileBytes: Buffer.byteLength(input.profile) }
}

// ── main 侧:原生模块路径解析(与 alpha-ext-plugin.ts 同法)────────────────────────
export type FenceAddonResolveInput = {
  packaged: boolean
  /** process.resourcesPath(打包后 extraResources 落点 <resources>/alpha-fence/alpha_fence.node) */
  resourcesPath: string
  /** 调用方模块目录(dev 下 = packages/ui-mac/out/main) */
  moduleDir: string
  exists: (p: string) => boolean
}

export const FENCE_ADDON_RESOURCE_DIR = "alpha-fence"
export const FENCE_ADDON_FILENAME = "alpha_fence.node"

/** 解析不到即抛(fail-closed):没有模块就没有围栏,而没有围栏的引擎不许起。 */
export function resolveFenceAddonPath(input: FenceAddonResolveInput): string {
  const path = input.packaged
    ? join(input.resourcesPath, FENCE_ADDON_RESOURCE_DIR, FENCE_ADDON_FILENAME)
    : // dev:out/main → ui-mac → native/alpha-fence/build/alpha_fence.node(scripts/build-fence-addon.ts 的产物)
      join(input.moduleDir, "..", "..", "native", "alpha-fence", "build", FENCE_ADDON_FILENAME)
  if (!input.exists(path))
    throw new ProcessFenceError(`native module missing at ${path}(预期 prebuild/predev 已跑 scripts/build-fence-addon.ts;打包态 = extraResources alpha-fence/)`)
  return path
}
