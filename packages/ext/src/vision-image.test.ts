// vision-image.test.ts —— `#1419` 本机压缩:真 photon(引擎同一份 patched 包 + 同一份 wasm),不桩解码器。
// 期望值是独立字面量(262144 / 349528 / 1280 抄自 alpha-platform contracts/v1/vision.ts 与基线 §2-A 第 5 条,不从被测常量派生)。

import { describe, expect, test } from "bun:test"
import { compressForVision, sniffImageMime, VisionImageDecodeError, VISION_IMAGE_MAX_BASE64_CHARS, VISION_IMAGE_MAX_BYTES, VISION_LONG_EDGE } from "./vision-image"

type Photon = typeof import("@silvia-odwyer/photon-node")
let photonPromise: Promise<Photon> | undefined
const photon = () => (photonPromise ??= import("@silvia-odwyer/photon-node"))

/** 伪随机噪声 RGBA → PNG:JPEG 最难压的形状,逼出「质量档全试完还要缩边」那条路。 */
async function noisePng(width: number, height: number): Promise<Uint8Array> {
  const p = await photon()
  const rgba = new Uint8Array(width * height * 4)
  let seed = 0x9e3779b9
  for (let i = 0; i < rgba.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    rgba[i] = (i & 3) === 3 ? 255 : seed >>> 24
  }
  const img = new p.PhotonImage(rgba, width, height)
  try {
    return img.get_bytes()
  } finally {
    img.free()
  }
}

async function decodeSize(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const p = await photon()
  const img = p.PhotonImage.new_from_byteslice(bytes)
  try {
    return { width: img.get_width(), height: img.get_height() }
  } finally {
    img.free()
  }
}

describe("compressForVision —— 长边 ≤ 1280、JPEG、编码后 ≤ 256 KiB", () => {
  test("常量与云端契约 / 基线同数(独立字面量)", () => {
    expect(VISION_IMAGE_MAX_BYTES).toBe(262144)
    expect(VISION_IMAGE_MAX_BASE64_CHARS).toBe(349528)
    expect(VISION_LONG_EDGE).toBe(1280)
  })

  test("3000×2000 噪声 PNG ⇒ JPEG(FF D8)、长边 ≤ 1280、字节 ≤ 262144、base64 ≤ 349528,且 photon 能解回同尺寸", async () => {
    const png = await noisePng(3000, 2000)
    expect(sniffImageMime(png)).toBe("image/png")
    const out = await compressForVision(png)
    expect(out.mime).toBe("image/jpeg")
    expect(out.sourceWidth).toBe(3000)
    expect(out.sourceHeight).toBe(2000)
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(1280)
    expect(out.bytes).toBeLessThanOrEqual(262144)
    expect(out.base64.length).toBeLessThanOrEqual(349528)
    const jpeg = Buffer.from(out.base64, "base64")
    expect(jpeg.length).toBe(out.bytes)
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8])
    expect(await decodeSize(jpeg)).toEqual({ width: out.width, height: out.height })
    // 2026-09-24 实测:纯噪声在长边 1280 下靠低质量档就能进 256 KiB(此前写的「必然要缩边」是没跑过的推论,已删)。
    // 质量档确实往下走了:q85 装不下噪声,最终档位必然低于 85。
    expect(out.quality).toBeLessThan(85)
  }, 60_000)

  test("小图不放大:64×48 ⇒ 64×48 的 JPEG", async () => {
    const png = await noisePng(64, 48)
    const out = await compressForVision(png)
    expect({ width: out.width, height: out.height, mime: out.mime }).toEqual({ width: 64, height: 48, mime: "image/jpeg" })
    expect(out.bytes).toBeLessThanOrEqual(262144)
  })

  test("竖图按长边缩:800×2600 ⇒ 高 1280", async () => {
    const png = await noisePng(800, 2600)
    const out = await compressForVision(png)
    expect(out.height).toBeLessThanOrEqual(1280)
    expect(out.width).toBeLessThan(out.height)
  }, 60_000)

  test("垃圾字节 ⇒ VisionImageDecodeError(不是静默给一张空图)", async () => {
    await expect(compressForVision(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).rejects.toBeInstanceOf(VisionImageDecodeError)
  })
})

describe("sniffImageMime —— 与 gateway 同一张魔数表", () => {
  test("png / jpeg / webp / gif 各认一个;别的一律 undefined", () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png")
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("image/jpeg")
    expect(sniffImageMime(new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")]))).toBe("image/webp")
    expect(sniffImageMime(new Uint8Array(Buffer.from("GIF89a\0\0")))).toBe("image/gif")
    expect(sniffImageMime(new Uint8Array(Buffer.from("GIF87a\0\0")))).toBe("image/gif")
    expect(sniffImageMime(new Uint8Array(Buffer.from("%PDF-1.7")))).toBeUndefined()
    expect(sniffImageMime(new Uint8Array(Buffer.from("<svg xmlns")))).toBeUndefined()
    expect(sniffImageMime(new Uint8Array([]))).toBeUndefined()
  })
})
