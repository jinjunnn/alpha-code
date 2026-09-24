// vision-image — 送云端识图之前的本机压缩(`#1419`,REQ-228 基线 §2-A 第 5 条分支 (i) / §1c)。
//
// 云端 `/v1/tools/vision` 的图片上限是**解码后 262144 字节**(alpha-platform `contracts/v1/vision.ts` 的
// `VISION_IMAGE_MAX_BYTES`,与 `/mcp` 控制信封同数),而引擎自己的 `image/image.ts` 只把图压到 2000×2000 /
// base64 ≤ 5 MiB —— 差一个数量级。基线 §1c 用 3 张真实截图实测:长边 1280 + JPEG 自适应质量能全部放进
// 256 KiB,长边 1568 时信息密集的那张放不进;§1d 实测 1280 下小字仍可识别。所以这里的形状是:
//   长边 ≤ 1280 → JPEG 质量从高到低试 → 仍超限就把长边再缩 20% 重来 → 缩到 320 仍不行才放弃。
//
// 解码 / 缩放 / 编码用的是引擎自己那份 `@silvia-odwyer/photon-node@0.3.4`(同一个 patched 包,
// 见根 package.json 的 patchedDependencies),不另引第二套图像库 —— 同一张图两边看到的是同一个解码器。
// wasm 经 `with { type: "file" }` 随 bundle 落地(ui-mac electron-builder 把 `*.wasm` 与 plugin.js 一起复制到
// `<resources>/alpha-ext/`),装载路径经 photon patch 认的 `globalThis.__OPENCODE_PHOTON_WASM_PATH` 交给它。
// 引擎的 image.ts 也写同一个全局;两边指向的是同一版本、同一字节的 wasm,先后覆盖无害(2026-09-24 勘破)。

import wasmAsset from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import path from "node:path"
import { fileURLToPath } from "node:url"

/** 云端解码后字节上限(与 alpha-platform `VISION_IMAGE_MAX_BYTES` 同数;那边超过即 413 `image_too_large`)。 */
export const VISION_IMAGE_MAX_BYTES = 262_144
/** 上限对应的 base64 字符数(4/3 膨胀,向上取整到 4 的倍数;与 alpha-platform `VISION_IMAGE_MAX_BASE64_CHARS` 同式)。 */
export const VISION_IMAGE_MAX_BASE64_CHARS = Math.ceil(VISION_IMAGE_MAX_BYTES / 3) * 4
/** 基线 §2-A 第 5 条分支 (i):长边 1280。 */
export const VISION_LONG_EDGE = 1280
/** 质量从高到低;基线 §1c 实测 q85 / q70 两档都放得进,这里多给几档兜住更密的图。 */
const JPEG_QUALITIES = [85, 75, 65, 55, 45, 35] as const
/** 全部质量档都放不进时长边再缩的比例;缩到 MIN_LONG_EDGE 仍放不进就放弃(不发一张认不出字的图去花钱)。 */
const SHRINK = 0.8
const MIN_LONG_EDGE = 320

/** 云端受理的四种类型(与 alpha-platform `VISION_IMAGE_MIMES` 同集;那边按魔数判型,mime 不一致即拒)。 */
export type VisionImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif"

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))

/** 按文件头魔数判型(与 gateway `lib/vision.ts` 同一张表);不是这四种就 `undefined`。 */
export function sniffImageMime(bytes: Uint8Array): VisionImageMime | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp"
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif"
  return undefined
}

export type CompressedImage = {
  readonly base64: string
  readonly mime: "image/jpeg"
  /** 编码后的字节数(≤ VISION_IMAGE_MAX_BYTES)。 */
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly quality: number
  readonly sourceWidth: number
  readonly sourceHeight: number
}

export class VisionImageDecodeError extends Error {
  constructor(cause: unknown) {
    super(`image could not be decoded (not PNG / JPEG / WebP / GIF, or corrupt): ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "VisionImageDecodeError"
  }
}

export class VisionImageTooLargeError extends Error {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    super(`image ${width}x${height} could not be compressed under ${VISION_IMAGE_MAX_BYTES} bytes even at ${MIN_LONG_EDGE}px`)
    this.name = "VisionImageTooLargeError"
  }
}

type Photon = typeof import("@silvia-odwyer/photon-node")
let photonPromise: Promise<Photon> | undefined

/** 懒装 photon(1.9 MB wasm 编译一次,失败下次重试)。 */
function loadPhoton(): Promise<Photon> {
  if (!photonPromise) {
    photonPromise = (async () => {
      const wasmPath = path.isAbsolute(wasmAsset) ? wasmAsset : fileURLToPath(new URL(wasmAsset, import.meta.url))
      ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH = wasmPath
      return await import("@silvia-odwyer/photon-node")
    })()
    photonPromise.catch(() => {
      photonPromise = undefined
    })
  }
  return photonPromise
}

/**
 * 把任意受理类型的图片压成云端放得进的 JPEG:长边 ≤ 1280,质量自适应,编码后 ≤ 262144 字节。
 * 解不出来抛 `VisionImageDecodeError`;缩到 320px 仍放不进抛 `VisionImageTooLargeError`。
 */
export async function compressForVision(bytes: Uint8Array): Promise<CompressedImage> {
  const photon = await loadPhoton()
  let decoded: InstanceType<Photon["PhotonImage"]>
  try {
    decoded = photon.PhotonImage.new_from_byteslice(bytes)
  } catch (error) {
    throw new VisionImageDecodeError(error)
  }
  try {
    const sourceWidth = decoded.get_width()
    const sourceHeight = decoded.get_height()
    const sourceLongEdge = Math.max(sourceWidth, sourceHeight)
    let longEdge = Math.min(VISION_LONG_EDGE, sourceLongEdge)
    // 比 MIN_LONG_EDGE 还小的图(图标、小截图)不缩、只编码 —— 地板取两者较小,否则循环一次都不进。
    const floor = Math.min(MIN_LONG_EDGE, sourceLongEdge)
    for (;;) {
      const scale = longEdge / sourceLongEdge
      const width = Math.max(1, Math.round(sourceWidth * scale))
      const height = Math.max(1, Math.round(sourceHeight * scale))
      const resized = scale < 1 ? photon.resize(decoded, width, height, photon.SamplingFilter.Lanczos3) : decoded
      try {
        for (const quality of JPEG_QUALITIES) {
          const jpeg = resized.get_bytes_jpeg(quality)
          if (jpeg.length <= VISION_IMAGE_MAX_BYTES)
            return {
              base64: Buffer.from(jpeg).toString("base64"),
              mime: "image/jpeg",
              bytes: jpeg.length,
              width,
              height,
              quality,
              sourceWidth,
              sourceHeight,
            }
        }
      } finally {
        if (resized !== decoded) resized.free()
      }
      if (longEdge <= floor) break
      longEdge = Math.max(floor, Math.floor(longEdge * SHRINK))
    }
    throw new VisionImageTooLargeError(sourceWidth, sourceHeight)
  } finally {
    decoded.free()
  }
}
