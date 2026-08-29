// REQ-108(#1173)—— 强模态在场信号:计数器语义 + 生产者/消费者接线 ratchet。
//
// 端到端的用户可观察判据在 test-component/file-viewer.cases.ts(真 Dialog 驱动,断言落在
// 朝 main 去的 setVisible 那条边)。这里只钉两件那份用例照不到的事:
//   ①计数器本身(嵌套模态、重复 release);
//   ②settings 这个**不走 dialog-core 模态栈**的生产者确实上报了 —— 它的组件用例跑在
//     独立 Vite bundle 里(自带一份 modal-presence 实例),模块级断言够不着,故为源级 ratchet。

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { enterModal, modalPresent, subscribeModalPresence } from "./modal-presence"

const dialogCore = readFileSync(join(import.meta.dir, "dialog-core.ts"), "utf8")
const settings = readFileSync(join(import.meta.dir, "settings.tsx"), "utf8")
const overlayView = readFileSync(
  join(import.meta.dir, "session-rail/files/file-viewer-view.tsx"),
  "utf8",
)
const overlayIo = readFileSync(join(import.meta.dir, "session-rail/files/file-viewer-io.ts"), "utf8")

describe("#1173 modal presence counter", () => {
  test("nested modals only flip the signal on the 0↔n edges", () => {
    const seen: boolean[] = []
    const off = subscribeModalPresence((present) => seen.push(present))
    expect(modalPresent()).toBe(false)

    const outer = enterModal()
    const inner = enterModal()
    expect(modalPresent()).toBe(true)
    inner()
    // 内层关掉、外层还在 ⇒ 仍在场:让位不能提前结束。
    expect(modalPresent()).toBe(true)
    outer()
    expect(modalPresent()).toBe(false)
    off()
    expect(seen).toEqual([true, false])
  })

  test("release is idempotent — a double cleanup cannot drive the counter negative", () => {
    const release = enterModal()
    release()
    release()
    expect(modalPresent()).toBe(false)
    const second = enterModal()
    // 若第一次的重复 release 记了账,这里会读成 false(从此永远藏不住叠放层)。
    expect(modalPresent()).toBe(true)
    second()
    expect(modalPresent()).toBe(false)
  })

  test("unsubscribing stops delivery without disturbing the count", () => {
    const seen: boolean[] = []
    const off = subscribeModalPresence((present) => seen.push(present))
    off()
    const release = enterModal()
    release()
    expect(seen).toEqual([])
    expect(modalPresent()).toBe(false)
  })
})

describe("#1173 producers and the single consumer are wired", () => {
  test("the dialog stack reports presence and releases before any early return", () => {
    expect(dialogCore).toContain(`import { enterModal } from "./modal-presence"`)
    expect(dialogCore).toContain("const releaseModal = enterModal()")
    // 释放必须排在 `indexOf < 0` 的提前 return 之前,否则一次异常 unregister 就永久卡住计数器。
    const release = dialogCore.indexOf("releaseModal()")
    const earlyReturn = dialogCore.indexOf("const index = stack.entries.indexOf(entry)")
    expect({ found: release > 0, beforeEarlyReturn: release < earlyReturn }).toEqual({
      found: true,
      beforeEarlyReturn: true,
    })
  })

  test("the settings surface reports presence (it declares aria-modal but is not on the dialog stack)", () => {
    expect(settings).toContain(`import { enterModal } from "./modal-presence"`)
    expect(settings).toContain("onCleanup(enterModal())")
    expect(settings).toContain(`aria-modal="true"`)
  })

  test("the rail overlay is the consumer and forwards to the guarded main-side channel", () => {
    expect(overlayView).toContain("subscribeModalPresence")
    expect(overlayView).toContain("props.overlayIO.setVisible(previewId, !present)")
    expect(overlayIo).toContain("window.api.railPreview.setVisible(previewId, visible)")
  })
})
