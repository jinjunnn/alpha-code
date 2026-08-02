// REQ-128 Phase 3 `[T3-channel]`(#782):本地 Claude 插件包的 **preview→confirm 两段式通道**
// 在 main 侧的家 —— 留字节、算预算、管生命周期。electron-free(IPC 接线在 `ext-ipc.ts`)。
//
// 为什么要有这一层(基线 §7 K15):
//   confirm 若从 renderer 收目录路径或内容,那就是一条任意写盘通道(`#255` 关掉过一次);
//   confirm 若在确认期**重扫**源目录再比摘要,那是第二个 TOCTOU 窗口 + 第二份摘要文法。
//   REQ-033 的 agent 导入已经给出正确形状:**preview 期把字节留在 main,confirm 只收 previewId**。
//   本模块把那个形状搬到「一个包 N 个技能」的规模上。
//
// 规模变了,代价也变了(G19 / R1-M1)——这是本模块存在的第二个理由:
//   单技能帽是 10MB / 500 文件(`ext-fs-installer.ts` 的 `IMPORT_MAX_TOTAL`),而事务允许
//   64 个 item ⇒ **一次预览可以在 main 里留下约 640MB**,而且反复预览后取消不释放会累积。
//   照抄 agent 那条「≤256KB × 最多 16 条」的帽是错的:那是**条数**帽,套到包字节上等于没帽。
//   所以这里立的是**包级总字节 + 包级总文件**帽,加上**每个 renderer 只允许一个 active preview**,
//   加上取消 / 窗口销毁 / 新预览替换**立即释放**。
//
// 三条不变量,全部可被绕过实验证伪(基线 §6 首句):
//   ① renderer 全程给不出写入内容:留存的 `srcDir` 与字节**永不过 wire**(见 `previewWireV1`);
//   ② previewId 一次性,且**写成功才消费**(`#351`:配置写锁 busy 后用户重点确认,不该只
//      拿到「预览已失效」——单次消费语义只对成功写入成立);
//   ③ 预算是**硬停**:边收边累计,越界即整包拒并释放,绝不先收满 640MB 再判。

import { randomUUID } from "node:crypto"
import path from "node:path"

import { collectImportSkillPayload } from "./ext-fs-installer"
import { localSkillContentDigest, type LocalPackagePreviewV1 } from "./claude-plugin-intake"

/**
 * **包级**总字节帽。
 *
 * 取值依据(实测,不是拍的):
 *   · 下界 —— 必须 **≥ 单技能帽 10MB**(`IMPORT_MAX_TOTAL`)。低于它,一个单技能插件会比
 *     直接导入同一个技能更容易被拒 —— 那是拿闸门制造回归。
 *   · 上界 —— 必须**远低于** 64 × 10MB = 640MB 的结构性最坏值,否则这道帽不减少任何风险。
 *   · 真实语料 —— 62 个插件里**最大一个包的可装载荷是 303,137 字节**(equity-research,
 *     9 技能 20 文件)。32MB 是它的 108 倍。**先跑再立**:前提为假的闸门比没有闸门更贵。
 */
export const LOCAL_PACKAGE_PREVIEW_MAX_BYTES = 32 * 1024 * 1024

/**
 * **包级**总文件帽。同样两侧夹逼:≥ 单技能帽 500(`IMPORT_MAX_ENTRIES`),
 * 远低于 64 × 500 = 32000;真实语料最大 20 个文件(equity-research),2000 是它的 100 倍。
 */
export const LOCAL_PACKAGE_PREVIEW_MAX_FILES = 2000

/** 留在 main 的一个技能载荷。`data` **永不过 wire**。 */
export type RetainedComponentPayload = {
  /** 相对插件根的 POSIX 路径(= preview 里那一条的 `dir`)。 */
  readonly dir: string
  /** frontmatter name(= preview 里那一条的 `name`)。 */
  readonly name: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly data: Buffer }>
  readonly byteCount: number
  readonly contentDigest: string
}

/** 一次已签发的预览。**整个对象只在 main 里存在。** */
export type IssuedLocalPackagePreview = {
  readonly previewId: string
  /** 签发它的 webContents id。一个 renderer 同时只允许有一个。 */
  readonly senderId: number
  /** 用户**亲手选的**源目录(main 自弹 picker,`#255`)。**永不过 wire。** */
  readonly srcDir: string
  readonly preview: LocalPackagePreviewV1
  readonly payloads: readonly RetainedComponentPayload[]
  readonly byteCount: number
  readonly fileCount: number
  readonly issuedAt: number
}

/** 过 wire 的安全投影:previewId + 逐条判决。**没有** srcDir、**没有**字节、**没有**绝对路径。 */
export type LocalPackagePreviewWireV1 = {
  readonly previewId: string
  readonly preview: LocalPackagePreviewV1
  /** 留在 main 的载荷规模 —— 说给用户听的「这次要装多少东西」,不是路径。 */
  readonly retained: { readonly byteCount: number; readonly fileCount: number }
}

export function previewWireV1(issued: IssuedLocalPackagePreview): LocalPackagePreviewWireV1 {
  return {
    previewId: issued.previewId,
    preview: issued.preview,
    retained: { byteCount: issued.byteCount, fileCount: issued.fileCount },
  }
}

export type CollectPayloadsResult =
  | { readonly ok: true; readonly payloads: RetainedComponentPayload[]; readonly byteCount: number; readonly fileCount: number }
  | { readonly ok: false; readonly reason: string; readonly reasonCode: LocalPackageBudgetCode }

export type LocalPackageBudgetCode = "preview-budget-bytes" | "preview-budget-files" | "preview-source-changed" | "preview-payload-unreadable"

/**
 * 把 preview 判为 `install` 的那些技能的**字节**收进 main,边收边累计、越界即停。
 *
 * 两条纪律:
 *   · 内容**只经** `collectImportSkillPayload` 读(realpath 圈禁 / O_NOFOLLOW / fstat 帽)——
 *     本模块不自己开任何文件句柄,`ext-fs-installer` 的硬化不许被绕开(G12)。
 *   · 收上来的字节必须与**预览判过的**字节摘要逐字相同(用 `localSkillContentDigest` 那**一份**
 *     公式,不重写)。两次读之间目录变了 ⇒ **整次拒绝**,不静默取后一次 —— 否则用户确认的是
 *     A、装进去的是 B。这**不是**「confirm 期重扫」(那条被基线 §7 K15 否决):它发生在
 *     **同一次 preview 操作内部**,confirm 期一个字节都不再读源目录。
 */
export function collectRetainedPayloads(srcDir: string, preview: LocalPackagePreviewV1): CollectPayloadsResult {
  const payloads: RetainedComponentPayload[] = []
  let byteCount = 0
  let fileCount = 0
  for (const component of preview.components) {
    if (component.disposition !== "install") continue
    const collected = collectImportSkillPayload(path.join(srcDir, component.dir))
    if (!collected.ok)
      return {
        ok: false,
        reasonCode: "preview-payload-unreadable",
        reason: `「${component.name}」的文件读不出来:${collected.reason}`,
      }
    const digest = localSkillContentDigest(collected.files)
    if (digest !== component.contentDigest)
      return {
        ok: false,
        reasonCode: "preview-source-changed",
        reason: "这个文件夹在预览过程中被改动了,为安全起见本次不装。请重新选择一次。",
      }
    const bytes = collected.files.reduce((total, file) => total + file.data.length, 0)
    byteCount += bytes
    fileCount += collected.files.length
    // 硬停:先判再收下一个 ⇒ main 里最多多留一个技能(≤10MB),而不是先攒满 640MB 再说。
    if (byteCount > LOCAL_PACKAGE_PREVIEW_MAX_BYTES)
      return {
        ok: false,
        reasonCode: "preview-budget-bytes",
        reason: `这一包的内容太大(超过 ${Math.floor(LOCAL_PACKAGE_PREVIEW_MAX_BYTES / (1024 * 1024))}MB),本版本不装`,
      }
    if (fileCount > LOCAL_PACKAGE_PREVIEW_MAX_FILES)
      return {
        ok: false,
        reasonCode: "preview-budget-files",
        reason: `这一包的文件太多(超过 ${LOCAL_PACKAGE_PREVIEW_MAX_FILES} 个),本版本不装`,
      }
    payloads.push({
      dir: component.dir,
      name: component.name,
      files: collected.files,
      byteCount: bytes,
      contentDigest: digest,
    })
  }
  return { ok: true, payloads, byteCount, fileCount }
}

/**
 * 已签发预览的登记处。**每个 renderer 至多一条** —— 这是 G19 的第二半:
 * 没有这条,用户连点五次预览就在 main 里留下五份字节,而且没有任何一份有主。
 *
 * 形状对齐 `pickedFiles`(`ipc.ts` 的 `createPickedFileAuthorizations`):模块级单例 +
 * sender 绑定 + 单次消费。**不是**为了测试才可注入 —— 测试直接读这个单例的计量。
 */
export function createLocalPackagePreviewStore() {
  /** previewId → 已签发预览。 */
  const byId = new Map<string, IssuedLocalPackagePreview>()
  /** senderId → previewId。**一对一** —— 新预览进来先把旧的释放掉。 */
  const bySender = new Map<number, string>()

  const drop = (previewId: string): boolean => {
    const issued = byId.get(previewId)
    if (!issued) return false
    byId.delete(previewId)
    if (bySender.get(issued.senderId) === previewId) bySender.delete(issued.senderId)
    return true
  }

  return {
    /** 签发。**同一个 sender 的上一条当场释放**(G19 的「新预览替换即释放」)。 */
    issue(input: {
      senderId: number
      srcDir: string
      preview: LocalPackagePreviewV1
      payloads: readonly RetainedComponentPayload[]
      byteCount: number
      fileCount: number
    }): IssuedLocalPackagePreview {
      const previous = bySender.get(input.senderId)
      if (previous) drop(previous)
      const issued: IssuedLocalPackagePreview = {
        previewId: randomUUID(),
        senderId: input.senderId,
        srcDir: input.srcDir,
        preview: input.preview,
        payloads: input.payloads,
        byteCount: input.byteCount,
        fileCount: input.fileCount,
        issuedAt: Date.now(),
      }
      byId.set(issued.previewId, issued)
      bySender.set(input.senderId, issued.previewId)
      return issued
    },

    /** confirm 侧取件:**只按 previewId**。confirm 通道拿不到 event,也就给不出任何别的输入。 */
    get(previewId: string): IssuedLocalPackagePreview | undefined {
      return byId.get(previewId)
    },

    /** 只读通道取件:按 sender **且** previewId —— 读面有 event,就该把 sender 绑上。 */
    read(senderId: number, previewId: string): IssuedLocalPackagePreview | undefined {
      const issued = byId.get(previewId)
      return issued && issued.senderId === senderId ? issued : undefined
    },

    /** **写成功才消费**(`#351`)。失败路径绝不调它。 */
    consume(previewId: string): boolean {
      return drop(previewId)
    },

    /** 显式取消。返回是否真的释放了一条(用于「取消一条不存在的预览」不撒谎)。 */
    cancel(senderId: number, previewId: string): boolean {
      const issued = byId.get(previewId)
      if (!issued || issued.senderId !== senderId) return false
      return drop(previewId)
    },

    /** 窗口销毁 / renderer 走人:那个 sender 的一切当场释放。 */
    releaseSender(senderId: number): boolean {
      const previewId = bySender.get(senderId)
      return previewId ? drop(previewId) : false
    },

    /** 计量面(G19 的断言对象):当前**还留在 main 里的字节数**。 */
    retainedBytes(): number {
      let total = 0
      for (const issued of byId.values()) total += issued.byteCount
      return total
    },

    retainedFiles(): number {
      let total = 0
      for (const issued of byId.values()) total += issued.fileCount
      return total
    },

    size(): number {
      return byId.size
    },
  }
}

export type LocalPackagePreviewStore = ReturnType<typeof createLocalPackagePreviewStore>

/** 生产单例。`ext-ipc` 的 preview / cancel / confirm 三条通道共用**同一个**。 */
export const localPackagePreviews: LocalPackagePreviewStore = createLocalPackagePreviewStore()
