#!/usr/bin/env bun
// build-fence-addon — REQ-159 (`#1321`):把 native/alpha-fence/alpha_fence.c 编成一个 **fat** 的
// N-API 模块(arm64 + x86_64 在同一个 .node 里),落到 native/alpha-fence/build/alpha_fence.node。
//
// 为什么是 fat 而不是「一架构一份」:U1(`#1316`)只出了 arm64,并明写这是路一将来最容易漏的一格 ——
// 出 Intel / universal 时若漏了第二份,x64 包里围栏**静默不装**(用户以为有沙箱而实际没有)。
// 一个 fat 文件把「第二份」这件事从人的记忆里拿掉:同一份字节同时装着两片,dyld 自己挑;
// 而且本脚本在编完之后**逐片判**:`lipo -archs` 缺任一片、或某一片缺 `_napi_register_module_v1`
// 导出 ⇒ 删产物、非零退出。prebuild / predev 都调本脚本,所以漏片会让构建当场红,不会流到包里。
//
// 只在 darwin 上构建。别的平台没有 seatbelt,本脚本打印一行并 no-op(如实声明,不是静默);
// electron-builder.config.ts 的 extraResources 对应条目同样只在 darwin 声明。
//
// 头文件来自 node-api-headers(ui-mac devDependency,钉版 1.9.0),不依赖本机装了哪个 node
// (U1 §5 明写的一格:那一轮用的是 Homebrew node 的头,实现票要把头钉进仓)。
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** 出货必须同时装着的两片 —— 缺任一片即构建失败。 */
export const FENCE_ADDON_ARCHS = ["arm64", "x86_64"] as const
export const FENCE_ADDON_BASENAME = "alpha_fence.node"
export const FENCE_ADDON_SOURCE = join(packageDir, "native", "alpha-fence", "alpha_fence.c")
export const FENCE_ADDON_BUILD_DIR = join(packageDir, "native", "alpha-fence", "build")
export const FENCE_ADDON_OUT = join(FENCE_ADDON_BUILD_DIR, FENCE_ADDON_BASENAME)

export type BuildFenceAddonOptions = {
  /** 产物路径(默认 native/alpha-fence/build/alpha_fence.node)。 */
  out?: string
  /** 烤进模块的 buildId(默认 = 时间戳),回读用于证明「装的是这次编的」。 */
  buildId?: string
  /** 源文件(默认 native/alpha-fence/alpha_fence.c)。 */
  source?: string
  /** 只构建这些架构(测试用;生产恒为 FENCE_ADDON_ARCHS)。 */
  archs?: readonly string[]
}

export type BuildFenceAddonResult = { out: string; archs: string[]; buildId: string }

function headersIncludeDir(): string {
  const pkg = require.resolve("node-api-headers/package.json")
  const include = join(dirname(pkg), "include")
  if (!existsSync(join(include, "node_api.h"))) throw new Error(`node-api-headers include dir missing node_api.h: ${include}`)
  return include
}

function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" })
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

/** 编译 + 逐片判据。任何一步失败都删产物再抛 —— 半成品比没有更坏(会被当成「装好了」)。 */
export function buildFenceAddon(options: BuildFenceAddonOptions = {}): BuildFenceAddonResult {
  if (process.platform !== "darwin") throw new Error("alpha_fence addon builds on darwin only (seatbelt is a macOS facility)")
  const out = options.out ?? FENCE_ADDON_OUT
  const source = options.source ?? FENCE_ADDON_SOURCE
  const archs = [...(options.archs ?? FENCE_ADDON_ARCHS)]
  const buildId = options.buildId ?? `fence-${new Date().toISOString().replace(/[-:.]/g, "")}`
  if (!existsSync(source)) throw new Error(`alpha_fence source missing: ${source}`)
  mkdirSync(dirname(out), { recursive: true })
  rmSync(out, { force: true })

  const clang = run("clang", [
    "-O2",
    "-fPIC",
    "-shared",
    ...archs.flatMap((arch) => ["-arch", arch]),
    "-mmacosx-version-min=11.0",
    "-undefined",
    "dynamic_lookup",
    "-DNAPI_VERSION=8",
    `-DALPHA_FENCE_BUILD_ID="${buildId}"`,
    `-I${headersIncludeDir()}`,
    "-o",
    out,
    source,
  ])
  if (clang.status !== 0 || !existsSync(out)) {
    rmSync(out, { force: true })
    throw new Error(`clang failed (exit ${clang.status}):\n${clang.stderr}`)
  }

  let present: string[]
  try {
    present = assertFenceAddonSlices(out, archs)
  } catch (error) {
    rmSync(out, { force: true })
    throw error
  }
  return { out, archs: present, buildId }
}

/**
 * x64 那条判据(票面硬要求四):文件里必须同时有 `archs` 的每一片,且每一片都真的导出 N-API 入口。
 * 返回 lipo 看到的片集合;缺片 / 空壳片一律抛。单独导出是为了让测试能拿一个**已知缺片**的 thin 文件
 * 证明它会红 —— 先证明判据测得出已知的坏,再信它对生产产物说的「好」。
 */
export function assertFenceAddonSlices(file: string, archs: readonly string[] = FENCE_ADDON_ARCHS): string[] {
  if (!existsSync(file)) throw new Error(`alpha_fence.node missing at ${file}`)
  // 判据①:两片都在。`lipo -archs` 对 thin 文件也答一个名字,所以这里比的是集合,不是「非空」。
  const lipo = run("lipo", ["-archs", file])
  const present = lipo.stdout.trim().split(/\s+/).filter(Boolean)
  const missing = archs.filter((arch) => !present.includes(arch))
  if (lipo.status !== 0 || missing.length)
    throw new Error(`alpha_fence.node is missing arch slice(s) ${missing.join(", ")} (lipo -archs → "${present.join(" ")}") at ${file}`)
  // 判据②:每一片都真的是一个 N-API 模块(导出 napi_register_module_v1)。一片是空壳也会过 lipo。
  for (const arch of archs) {
    const nm = run("nm", ["-g", "-arch", arch, file])
    if (nm.status !== 0 || !/\b_napi_register_module_v1\b/.test(nm.stdout))
      throw new Error(`alpha_fence.node ${arch} slice does not export _napi_register_module_v1 (nm exit ${nm.status}) at ${file}`)
  }
  return present
}

if (import.meta.main) {
  if (process.platform !== "darwin") {
    console.log(`[alpha:fence-addon] skipped on ${process.platform} — seatbelt process fence is darwin-only (no addon shipped)`)
  } else {
    const result = buildFenceAddon()
    console.log(`[alpha:fence-addon] built ${result.out} archs=${result.archs.join("+")} buildId=${result.buildId}`)
  }
}
