// REQ-078 T2 / REQ-236 `#1553` — 附件通道纯核:逐类分类与体积闸门、文本 UTF-8 与 mime 归一、去重与总数帽、
// 提交 parts 的形状(图片 / 文本 = file part;PDF / Office = synthetic 空文本 + metadata,二进制不成 file part)、
// 发送前的读取路径标签(图片随引擎能力与登录状态变化)。

import { describe, expect, test } from "bun:test"
import { ATTACHMENT_METADATA_KEY, MAX_ATTACHMENT_BYTES, stagedAttachmentOf } from "../../shared/attachment-path"
import {
  ATTACH_ACCEPT,
  ATTACH_MAX_COUNT,
  buildAttachmentParts,
  classifyAttachment,
  fileRouteOf,
  IMAGE_MAX_BYTES,
  imageRouteOf,
  mergeAttachments,
  revalidateStagedDirectory,
  stagedComposerAttachment,
  TEXT_MAX_BYTES,
  textAttachmentUrl,
  type ComposerAttachment,
} from "./composer-attachments-core"

const img = (over: Partial<Extract<ComposerAttachment, { kind: "image" }>> = {}): ComposerAttachment => ({
  id: "att-1",
  name: "a.png",
  mime: "image/png",
  kind: "image",
  size: 100,
  url: "data:image/png;base64,AAAA",
  ...over,
})
const STAGED_PATH = "attachments/0b8c7f9e-1d2a-4c3b-9e8f-7a6b5c4d3e2f/report.docx"
const doc: ComposerAttachment = {
  id: "att-3",
  name: "report.docx",
  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  kind: "document",
  size: 2048,
  reader: "word",
  directory: "/ws/a",
  path: STAGED_PATH,
}

describe("classifyAttachment — 逐类路径与体积闸门", () => {
  test("AC1 文本类按扩展名认(MD / TXT / CSV / JSON / 代码),浏览器给的 type 空或错也一样;≤256 KiB 放行、超一字节拒", () => {
    for (const [name, type] of [
      ["notes.md", ""],
      ["a.txt", "text/plain"],
      ["data.csv", "text/csv"],
      ["cfg.json", "application/json"],
      ["main.ts", "video/mp2t"],
      ["app.py", ""],
    ] as const)
      expect(classifyAttachment({ name, type, size: 10 }), name).toEqual({ ok: true, kind: "text" })
    expect(classifyAttachment({ name: "a.md", type: "", size: TEXT_MAX_BYTES }).ok).toBe(true)
    expect(classifyAttachment({ name: "a.md", type: "", size: TEXT_MAX_BYTES + 1 })).toEqual({ ok: false, reason: "text-size" })
  })
  test("AC2 PDF / DOCX / XLSX / PPTX 认作文档并带上读取工具;≤20 MiB 放行、超一字节拒", () => {
    expect(classifyAttachment({ name: "a.pdf", type: "application/pdf", size: 10 })).toMatchObject({ ok: true, kind: "document", reader: "pdf" })
    expect(classifyAttachment({ name: "A.DOCX", type: "", size: 10 })).toMatchObject({ ok: true, kind: "document", reader: "word" })
    expect(classifyAttachment({ name: "b.xlsx", type: "", size: 10 })).toMatchObject({ ok: true, kind: "document", reader: "excel" })
    expect(classifyAttachment({ name: "c.pptx", type: "", size: 10 })).toMatchObject({ ok: true, kind: "document", reader: "powerpoint" })
    expect(classifyAttachment({ name: "a.pdf", type: "application/pdf", size: MAX_ATTACHMENT_BYTES }).ok).toBe(true)
    expect(classifyAttachment({ name: "a.pdf", type: "application/pdf", size: MAX_ATTACHMENT_BYTES + 1 })).toEqual({ ok: false, reason: "document-size" })
  })
  test("AC6 不支持的类型与超限图片如实拒绝(码交给卡片说明,不静默吞)", () => {
    expect(classifyAttachment({ name: "a.zip", type: "application/zip", size: 10 })).toEqual({ ok: false, reason: "type" })
    expect(classifyAttachment({ name: "a.doc", type: "application/msword", size: 10 })).toEqual({ ok: false, reason: "type" })
    expect(classifyAttachment({ name: "a.png", type: "image/png", size: IMAGE_MAX_BYTES }).ok).toBe(true)
    expect(classifyAttachment({ name: "a.png", type: "image/png", size: IMAGE_MAX_BYTES + 1 })).toEqual({ ok: false, reason: "image-size" })
  })
  test("accept 串覆盖图片四型、四类文档与文本扩展名(选择器预过滤;真闸门在 classify)", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp", ".pdf", ".docx", ".xlsx", ".pptx", ".md", ".csv", ".json"])
      expect(ATTACH_ACCEPT.split(",")).toContain(m)
  })
})

describe("AC1 textAttachmentUrl — UTF-8 校验与 mime 归一", () => {
  test("合法 UTF-8(含中文)⇒ data:text/plain;base64,解回来逐字相同", () => {
    const text = "# 会议纪要\n第一条:上线\n"
    const url = textAttachmentUrl(new TextEncoder().encode(text))!
    expect(url.startsWith("data:text/plain;base64,")).toBe(true)
    expect(Buffer.from(url.slice(url.indexOf(",") + 1), "base64").toString("utf8")).toBe(text)
  })
  test("不是合法 UTF-8 ⇒ undefined(调用方当作「这种文件还不能附上」)", () => {
    expect(textAttachmentUrl(new Uint8Array([0xff, 0xfe, 0x00, 0xc3]))).toBeUndefined()
  })
})

describe("buildAttachmentParts — 提交形状", () => {
  test("图片原样 dataUrl file part;文本以 text/plain file part 发出(引擎把 data: 文本解码进这条消息)", () => {
    const text: ComposerAttachment = { id: "att-2", name: "notes.md", mime: "text/plain", kind: "text", size: 4, url: "data:text/plain;base64,aGkK" }
    expect(buildAttachmentParts([img({ name: "shot.png" }), text])).toEqual([
      { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
      { type: "file", mime: "text/plain", url: "data:text/plain;base64,aGkK", filename: "notes.md" },
    ])
  })
  test("AC2 Office 不成 file part:只发一个 synthetic 空文本 + 冻结形状的 metadata,任何 part 都不带它的二进制", () => {
    const parts = buildAttachmentParts([doc]) as Array<Record<string, unknown>>
    expect(parts).toEqual([
      {
        type: "text",
        text: "",
        synthetic: true,
        metadata: { [ATTACHMENT_METADATA_KEY]: { v: 1, name: "report.docx", mime: doc.mime, size: 2048, path: STAGED_PATH, reader: "word" } },
      },
    ])
    expect(parts.some((p) => p.type === "file")).toBe(false)
    expect(JSON.stringify(parts)).not.toContain("data:")
    expect(stagedAttachmentOf(parts[0]!.metadata)).toMatchObject({ path: STAGED_PATH, reader: "word" })
  })
  test("AC6 失败卡不进请求", () => {
    expect(buildAttachmentParts([{ id: "f", name: "x.zip", size: 1, kind: "failed", reason: "type" }])).toEqual([])
  })
})

describe("mergeAttachments — 去重与总数帽", () => {
  test("name+size 相同视为重复,静默跳过不算错;同名不同体积不是重复", () => {
    expect(mergeAttachments([img()], [img({ id: "att-2" })])).toEqual({ next: [img()], rejected: [] })
    expect(mergeAttachments([img()], [img({ id: "att-2", size: 200 })]).next).toHaveLength(2)
  })
  test("超出总数帽如实拒绝", () => {
    const existing = Array.from({ length: ATTACH_MAX_COUNT }, (_, i) => img({ id: `att-${i}`, name: `f${i}.png` }))
    const { next, rejected } = mergeAttachments(existing, [img({ id: "att-x", name: "extra.png" })])
    expect(next).toHaveLength(ATTACH_MAX_COUNT)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toContain(`${ATTACH_MAX_COUNT}`)
  })
})

describe("暂存附件跟着实例目录", () => {
  test("目录没变原样;换了目录 ⇒ 可重试的失败卡(不带着读取工具够不着的路径发出去)", () => {
    expect(revalidateStagedDirectory([doc], "/ws/a")).toEqual([doc])
    expect(revalidateStagedDirectory([doc], "/ws/b")).toEqual([{ id: "att-3", name: "report.docx", size: 2048, kind: "failed", reason: "not-project", file: undefined }])
  })
  test("「重新读取」放回输入框的是同一个暂存记录,发出去的 metadata 与原消息逐字相同", () => {
    const original = (buildAttachmentParts([doc])[0] as { metadata: unknown }).metadata
    const meta = stagedAttachmentOf(original)!
    expect((buildAttachmentParts([stagedComposerAttachment(meta, "/ws/a")])[0] as { metadata: unknown }).metadata).toEqual(original)
  })
})

describe("AC7 发送前的读取路径标签", () => {
  test("文件卡:文本「直接进对话」、PDF / Office「本机读取」", () => {
    expect(fileRouteOf("text")).toBe("inline")
    expect(fileRouteOf("document")).toBe("local")
  })
  test("图片:随引擎对当前模型的图片能力与登录状态变化(直接看 / 云端识图 / 看不了 / 不确定)", () => {
    expect(imageRouteOf({ image: true, loggedIn: false })).toBe("native")
    expect(imageRouteOf({ image: true, loggedIn: true })).toBe("native")
    expect(imageRouteOf({ image: false, loggedIn: true })).toBe("cloud")
    expect(imageRouteOf({ image: false, loggedIn: false })).toBe("none")
    expect(imageRouteOf({ image: undefined, loggedIn: true })).toBe("unknown")
  })
})
