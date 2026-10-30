// REQ-236 `#1553` AC7 / AC6 / AC4 —— 附件卡的真组件用例(对照批准稿 docs/design/2026-10-30-req236-attachments/frame.html)。
//
// 真挂载生产 ComposerAttachmentStrip / TimelineAttachments,对真 DOM 断言用户看得见的字:
//   · 输入框:文本卡「直接进对话」、PDF / Office 卡「本机读取」;图片的读取方式随引擎能力与登录状态
//     (imageRouteOf 的四种结局)在附件条下写一句,缩略图角上有标记;缩略图可点开看大图,Esc 关闭;
//   · 发送前就没能附上的:卡内说明 + 移除;读盘 / 暂存失败才有「重试」;
//   · 用户消息里:读取结果一行;读取失败给「重新读取」、本回合没读给「请助手读取」,点了把同一个暂存记录交给宿主。
//
// 反向验证:把 ComposerAttachmentStrip 里图片读取方式那一行删掉 ⇒ 第一条转红;把失败卡的 `file` 判断去掉 ⇒ 第二条转红;
// 把 TimelineAttachments 的 onReadAgain 按钮去掉 ⇒ 第三条转红。
//
// 独立进程运行(`mock.module("solid-js", …)` 会污染同进程其它测试文件)。宿主:
// src/renderer/alpha-ui/attachment-cards.component.test.ts。
import { afterEach, describe, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import { dict as zh } from "../src/renderer/i18n/zh"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const { createComponent, createSignal } = solid
const { render } = solidWeb

Bun.plugin({
  name: "attachment-cards-component-tests",
  setup(builder) {
    builder.onLoad({ filter: /packages\/ui-mac\/src\/.*\.tsx$/ }, async (args) => {
      const transformed = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTypescript, { allExtensions: true, isTSX: true, onlyRemoveTypeImports: true }],
        ],
        sourceMaps: "inline",
      })
      return { contents: transformed?.code ?? "", loader: "js" }
    })
  },
})

const { setLocale } = await import("../src/renderer/i18n")
const { ComposerAttachmentStrip, TimelineAttachments } = await import("../src/renderer/alpha-ui/attachment-cards")
const { imageRouteOf } = await import("../src/renderer/alpha-ui/composer-attachments-core")
type ComposerAttachment = import("../src/renderer/alpha-ui/composer-attachments-core").ComposerAttachment
type TimelineAttachment = import("../src/renderer/alpha-ui/session-timeline/timeline-attachments").TimelineAttachment
setLocale("zh")

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  document.body.innerHTML = ""
})
const mount = (view: () => unknown) => {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(render(view as () => never, host))
  return host
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const UUID = "0b8c7f9e-1d2a-4c3b-9e8f-7a6b5c4d3e2f"
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const image = (id: string, name: string): ComposerAttachment => ({ id, name, mime: "image/png", kind: "image", size: 880_640, url: PNG })
const docx: ComposerAttachment = { id: "d", name: "复盘.docx", mime: "x", kind: "document", size: 1_887_437, reader: "word", directory: "/p", path: `attachments/${UUID}/复盘.docx` }
const md: ComposerAttachment = { id: "m", name: "纪要.md", mime: "text/plain", kind: "text", size: 12_288, url: "data:text/plain;base64,aGk=" }

describe("输入框附件条", () => {
  test("AC7 文件卡标读取路径;图片的读取方式随引擎能力与登录状态在条下写一句,缩略图角上有标记", async () => {
    const [route, setRoute] = createSignal(imageRouteOf({ image: true, loggedIn: true }))
    const host = mount(() =>
      createComponent(ComposerAttachmentStrip, {
        attachments: [image("i1", "首页截图.png"), image("i2", "旧版.png"), docx, md],
        reading: false,
        get imageRoute() {
          return route()
        },
        onRemove: () => {},
        onRetry: () => {},
      }),
    )
    await flush()
    const card = (name: string) => [...host.querySelectorAll(".a-comp-att")].find((el) => el.textContent?.includes(name))!
    expect(card("复盘.docx").textContent).toContain(zh["alpha.attach.routeLocal"])
    expect(card("复盘.docx").textContent).toContain("1.8 MB")
    expect(card("纪要.md").textContent).toContain(zh["alpha.attach.routeInline"])
    expect(host.querySelectorAll(".a-att-thumb .a-att-thumb-route")).toHaveLength(2)
    const line = () => host.querySelector(".a-att-image-route")!
    const expectLine = (key: keyof typeof zh) => expect(line().textContent).toBe(zh[key].replace("{{count}}", "2"))
    expectLine("alpha.attach.imageNative")
    setRoute(imageRouteOf({ image: false, loggedIn: true }))
    expectLine("alpha.attach.imageCloud")
    setRoute(imageRouteOf({ image: false, loggedIn: false }))
    expectLine("alpha.attach.imageNone")
    setRoute(imageRouteOf({ image: undefined, loggedIn: true }))
    expectLine("alpha.attach.imageUnknown")
    expect(line().getAttribute("data-route")).toBe("unknown")
  })

  test("AC6 发送前拒绝在卡内说明且可移除;读盘 / 暂存失败才有「重试」;缩略图点开看大图,Esc 关闭", async () => {
    const removed: string[] = []
    const retried: string[] = []
    const file = new File(["x"], "年度审计报告.pdf")
    const host = mount(() =>
      createComponent(ComposerAttachmentStrip, {
        attachments: [
          { id: "z", name: "素材包.zip", size: 10, kind: "failed", reason: "type" },
          { id: "big", name: "扫描件合集.pdf", size: 30_000_000, kind: "failed", reason: "document-size" },
          { id: "s", name: "年度审计报告.pdf", size: 1, kind: "failed", reason: "write-failed", file },
          image("i1", "首页截图.png"),
        ],
        reading: true,
        imageRoute: "native",
        onRemove: (id: string) => removed.push(id),
        onRetry: (id: string) => retried.push(id),
      }),
    )
    await flush()
    const card = (name: string) => [...host.querySelectorAll(".a-comp-att")].find((el) => el.textContent?.includes(name))!
    expect(card("素材包.zip").textContent).toContain(zh["alpha.attach.failType"])
    expect(card("扫描件合集.pdf").textContent).toContain(zh["alpha.attach.failDocumentSize"].replace("{{size}}", "20 MB"))
    expect(card("素材包.zip").querySelector(".a-att-link")).toBeNull()
    expect(card("年度审计报告.pdf").textContent).toContain(zh["alpha.attach.failStage"])
    card("年度审计报告.pdf").querySelector<HTMLButtonElement>(".a-att-link")!.click()
    card("素材包.zip").querySelector<HTMLButtonElement>(".a-comp-att-x")!.click()
    expect([retried, removed]).toEqual([["s"], ["z"]])
    expect(host.textContent).toContain(zh["alpha.attach.reading"])
    expect(host.querySelector("[role=list]")!.getAttribute("aria-label")).toBe(zh["alpha.attach.list"].replace("{{count}}", "4"))

    const thumb = host.querySelector<HTMLButtonElement>(".a-att-thumb")!
    expect(thumb.getAttribute("aria-label")).toBe(zh["alpha.attach.open"].replace("{{name}}", "首页截图.png"))
    thumb.click()
    await flush()
    expect(host.querySelector(".a-att-lightbox")?.textContent).toContain("首页截图.png")
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await flush()
    expect(host.querySelector(".a-att-lightbox")).toBeNull()
  })
})

describe("用户消息里的附件", () => {
  test("AC4 读取结果按事实一行;失败给「重新读取」、没读给「请助手读取」,点了把同一个暂存记录交给宿主;已读取 / 文本不给按钮", async () => {
    const meta = (name: string) => ({ v: 1 as const, name, mime: "x", size: 1, path: `attachments/${UUID}/${name}`, reader: "word" as const })
    const asked: string[] = []
    const items: TimelineAttachment[] = [
      { partID: "1", name: "复盘.docx", media: "file", label: "DOCX", size: 1_887_437, staged: meta("复盘.docx"), read: { kind: "read" } },
      { partID: "2", name: "扫描版合同.pdf", media: "file", label: "PDF", staged: meta("扫描版合同.pdf"), read: { kind: "empty" } },
      { partID: "3", name: "渠道.xlsx", media: "file", label: "XLSX", staged: meta("渠道.xlsx"), read: { kind: "failed", reason: "not-running" } },
      { partID: "4", name: "需求.docx", media: "file", label: "DOCX", staged: meta("需求.docx"), read: { kind: "not-read" } },
      { partID: "5", name: "纪要.md", media: "file", label: "MD", size: 12_288, read: { kind: "sent" } },
      { partID: "6", name: "截图.png", media: "image", label: "PNG", url: PNG, size: 10 },
    ]
    const host = mount(() => createComponent(TimelineAttachments, { attachments: items, onReadAgain: (a: TimelineAttachment) => asked.push(a.staged!.name) }))
    await flush()
    const card = (name: string) => [...host.querySelectorAll(".a-tl-attach")].find((el) => el.textContent?.includes(name))!
    expect(card("复盘.docx").textContent).toContain(`${zh["alpha.attach.readDone"]} · 1.8 MB`)
    expect(card("扫描版合同.pdf").textContent).toContain(zh["alpha.attach.readEmpty"])
    expect(card("渠道.xlsx").textContent).toContain(zh["alpha.attach.readFailedNotRunning"])
    expect(card("纪要.md").textContent).toContain(zh["alpha.attach.readSent"])
    expect(card("复盘.docx").querySelector(".a-att-link")).toBeNull()
    expect(card("纪要.md").querySelector(".a-att-link")).toBeNull()
    expect(card("渠道.xlsx").querySelector(".a-att-link")!.textContent).toBe(zh["alpha.attach.readAgain"])
    expect(card("需求.docx").querySelector(".a-att-link")!.textContent).toBe(zh["alpha.attach.askToRead"])
    card("渠道.xlsx").querySelector<HTMLButtonElement>(".a-att-link")!.click()
    card("需求.docx").querySelector<HTMLButtonElement>(".a-att-link")!.click()
    expect(asked).toEqual(["渠道.xlsx", "需求.docx"])
    const single = host.querySelector(".a-tl-attach[data-media=image] .a-att-thumb")!
    expect(single.hasAttribute("data-large")).toBe(true)
  })
})
