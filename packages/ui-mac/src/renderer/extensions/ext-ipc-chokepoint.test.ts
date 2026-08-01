// `#765` 的咽喉闸:整棵 renderer 生产树里,**只有** `extensions/ext-ipc.ts` 允许直接够到
// 扩展 IPC 面(`window.api.ext`)。别的文件一律走 `extIpc`,于是「这次调用带回了一条具名
// warning」必然被呈现 —— 不靠调用点作者记得写那一行。
//
// 为什么需要这道闸,而不是「已经改完六处了」:
// 呈现机制本身(ext-ipc-warning.ts)对新方法默认覆盖,但它只覆盖**经过它**的调用。
// 一个新写的 `window.api.ext.somethingNew(...)` 会绕开整套机制,而绕开是静默的 ——
// 用户面少一条提示,没有任何东西变红。REQ-128 Phase 2 三次栽在这个形态上。
// 所以判据不是「呈现写对了没有」,而是「有没有人能不经过咽喉」。
//
// ⚠️ 这道闸判的是**源码文本**,有一处已知且刻意保留的洞:先把桥存进变量再换个名字取
// (`const bridge = window.api; bridge.ext.foo()`)绕得过去。正则只盯 `api.ext` 这条链。
// 它拦的是「顺手写了个新调用点」,不是「有人存心躲」——后者不在本票的威胁模型里。
// 注释里出现同样的字面同样算违规(不做注释剥离):判据越简单,越不会自己长出漏洞;
// 要在注释里谈这个 API,写 `extIpc` 就行,那本来也是改完之后更准确的说法。
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const RENDERER_ROOT = resolve(import.meta.dir, "..")

/** 唯一允许直接够到扩展 IPC 面的文件(相对 renderer 根)。 */
const CHOKEPOINT = "extensions/ext-ipc.ts"

/** `window.api.ext` / `api.ext` / `someBridge.api.ext` —— 一律算直连。 */
const DIRECT_EXT_BRIDGE = /\bapi\s*\.\s*ext\b/

function productionSources(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      // 测试与组件测试运行时是 IPC 桩的所在地,它们**应该**直接搭桥。
      if (/\.(test|cases)\.tsx?$/.test(entry.name)) continue
      if (/-test-runtime\.tsx?$/.test(entry.name)) continue
      found.push(relative(RENDERER_ROOT, abs))
    }
  }
  walk(RENDERER_ROOT)
  return found.sort()
}

describe("`#765` 扩展 IPC 咽喉", () => {
  // 前提自检:走查真的看到了东西。文件树读空时上面的断言会「无违规 = 全绿」。
  test("前提:renderer 生产树被真的走查到了", () => {
    const files = productionSources()
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(CHOKEPOINT)
    expect(files).toContain("extensions/extension-hub.tsx")
    expect(files).toContain("extensions/use-extensions.ts")
    expect(statSync(join(RENDERER_ROOT, CHOKEPOINT)).size).toBeGreaterThan(0)
  })

  test("只有咽喉文件直接够得到扩展 IPC 面", () => {
    const direct = productionSources().filter((path) =>
      DIRECT_EXT_BRIDGE.test(readFileSync(join(RENDERER_ROOT, path), "utf8")),
    )
    expect(
      direct,
      "新增的调用点必须走 extIpc —— 直连会绕过 warning 呈现,而绕过是静默的",
    ).toEqual([CHOKEPOINT])
  })

  test("咽喉文件自己确实接上了呈现(不是个空壳转发)", () => {
    const source = readFileSync(join(RENDERER_ROOT, CHOKEPOINT), "utf8")
    // `toContain("pushToast")` 不够:把呈现函数换成 `() => {}` 之后 import 行还在,这条照样绿
    // (实测过)。判据得是「真的**调**了它」,所以要求出现在调用位。
    expect(source).toMatch(/pushToast\s*\(/)
    expect(source).toMatch(/warningPresentingExt\s*</)
  })

  // 反向自检:闸门自己得能开火。用真实文本喂一遍正则,而不是相信它「看起来对」。
  test("正则真的会对各种直连写法开火,且不误伤 extIpc", () => {
    const verdicts = [
      "const r = await extIpc.installCatalog(intent)",
      "const r = await window.api.ext.installCatalog(intent)",
      "const r = await api.ext.uninstallV2(intent)",
      "const r = await someBridge.api . ext .setInstallState(x)",
      "// 数据流:extIpc.builtinRead/builtinApply",
      "window.api.updater.check()",
    ].map((line) => DIRECT_EXT_BRIDGE.test(line))
    expect(verdicts).toEqual([false, true, true, true, false, false])
  })
})
