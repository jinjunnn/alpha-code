// REQ-078 T2 — 附件通道纯核:类型/体积闸门、去重与总数帽、FilePart 形状(上游 images 通道同形)。

import { describe, expect, test } from "bun:test"
import {
  ATTACH_ACCEPT,
  ATTACH_MAX_COUNT,
  buildAttachmentParts,
  classifyAttachment,
  IMAGE_MAX_BYTES,
  mergeAttachments,
  PDF_MAX_BYTES,
  type ComposerAttachment,
} from "./composer-attachments-core"

const att = (over: Partial<ComposerAttachment>): ComposerAttachment => ({
  id: "att-1",
  name: "a.png",
  mime: "image/png",
  kind: "image",
  size: 100,
  url: "data:image/png;base64,AAAA",
  ...over,
})

describe("classifyAttachment — 类型与体积闸门", () => {
  test("图片四型与 PDF 放行,kind 正确", () => {
    expect(classifyAttachment({ name: "a.png", type: "image/png", size: 10 })).toEqual({ ok: true, kind: "image" })
    expect(classifyAttachment({ name: "a.webp", type: "image/webp", size: 10 })).toEqual({ ok: true, kind: "image" })
    expect(classifyAttachment({ name: "a.pdf", type: "application/pdf", size: 10 })).toEqual({ ok: true, kind: "pdf" })
  })
  test("文本/代码/未知类型如实拒绝并指路 @ 引用(不静默吞)", () => {
    const r = classifyAttachment({ name: "a.ts", type: "text/plain", size: 10 })
    expect(r.ok).toBe(false)
    expect(r.ok ? "" : r.reason).toContain("@ 引用")
  })
  test("超限如实拒绝:图片 5MB / PDF 10MB,边界值放行", () => {
    expect(classifyAttachment({ name: "a.png", type: "image/png", size: IMAGE_MAX_BYTES }).ok).toBe(true)
    const img = classifyAttachment({ name: "a.png", type: "image/png", size: IMAGE_MAX_BYTES + 1 })
    expect(img.ok ? "" : img.reason).toContain("5MB")
    expect(classifyAttachment({ name: "a.pdf", type: "application/pdf", size: PDF_MAX_BYTES }).ok).toBe(true)
    const pdf = classifyAttachment({ name: "a.pdf", type: "application/pdf", size: PDF_MAX_BYTES + 1 })
    expect(pdf.ok ? "" : pdf.reason).toContain("10MB")
  })
  test("accept 串覆盖图片四型 + PDF(选择器预过滤;真闸门在 classify)", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]) {
      expect(ATTACH_ACCEPT).toContain(m)
    }
  })
})

describe("mergeAttachments — 去重与总数帽", () => {
  test("name+size 相同视为重复,静默跳过不算错", () => {
    const { next, rejected } = mergeAttachments([att({})], [att({ id: "att-2" })])
    expect(next).toHaveLength(1)
    expect(rejected).toHaveLength(0)
  })
  test("同名不同体积不是重复", () => {
    const { next } = mergeAttachments([att({})], [att({ id: "att-2", size: 200 })])
    expect(next).toHaveLength(2)
  })
  test("超出总数帽如实拒绝", () => {
    const existing = Array.from({ length: ATTACH_MAX_COUNT }, (_, i) => att({ id: `att-${i}`, name: `f${i}.png` }))
    const { next, rejected } = mergeAttachments(existing, [att({ id: "att-x", name: "extra.png" })])
    expect(next).toHaveLength(ATTACH_MAX_COUNT)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toContain(`${ATTACH_MAX_COUNT}`)
  })
})

describe("buildAttachmentParts — 上游 images 通道同形状", () => {
  test("{type:file, mime, url: dataUrl, filename}", () => {
    const parts = buildAttachmentParts([att({ name: "shot.png" }), att({ id: "att-2", name: "doc.pdf", mime: "application/pdf", kind: "pdf", url: "data:application/pdf;base64,BBBB" })])
    expect(parts).toEqual([
      { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
      { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,BBBB", filename: "doc.pdf" },
    ])
  })
})
