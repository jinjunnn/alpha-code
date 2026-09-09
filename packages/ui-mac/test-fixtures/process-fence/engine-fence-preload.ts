// REQ-159 (`#1321`) —— 引擎级判据用的 bun preload:在引擎的任何模块装载之前,用**生产的** .node 模块把
// 本进程关进 main 渲染 + 试编译过的 profile(与出货 sidecar「import 引擎前自打 seatbelt」同一顺序、同一 SPI)。
// 只做动作;装不上就退出 3 —— 引擎根本起不来,测试据此判「本次测量作废」,不是「围栏拦住了」。
import { readFileSync } from "node:fs"

const addonPath = process.env.ALPHA1321_FENCE_ADDON
const profileFile = process.env.ALPHA1321_FENCE_PROFILE
if (!addonPath || !profileFile) {
  console.error("engine-fence-preload: ALPHA1321_FENCE_ADDON / ALPHA1321_FENCE_PROFILE missing")
  process.exit(3)
}
const m = { exports: {} as { apply?: (p: string) => { rc: number; error: string }; buildId?: string } }
process.dlopen(m, addonPath)
const r = m.exports.apply!(readFileSync(profileFile, "utf8"))
if (r.rc !== 0) {
  console.error(`engine-fence-preload: sandbox_init rc=${r.rc}: ${r.error}`)
  process.exit(3)
}
console.error(`engine-fence-preload: fence applied (addon ${m.exports.buildId})`)
