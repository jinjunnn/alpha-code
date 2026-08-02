// REQ-128 Phase 3 `[T3-channel]`(#782):confirm 通道通往**安装**的那一个接缝。
//
// 这一层为什么在(而不是「留给将来的抽象」):`[T2-install]`(#781)与本票**并行开工**,
// 而 confirm 通道必须**现在就是一条真通道** —— 它要进 `GATED_WRITE_CHANNELS`、要过恢复
// gate、要能被绕过实验证伪(「取出即消费 ⇒ 重点确认用例红」这条闸没有成功路径就立不起来)。
// 一条 confirm 若只会返回「还没上线」,它的一次性语义与 `#351` 语义都无法被任何测试杀死。
//
// **T2 落地时的动作**:把下面这个实现换成 `claude-plugin-install.ts` 的真安装器(四集同源
// 派生 + 锁内 `uncuratedSkillFreshGate` + N 条多文件 generation item + 一次 `runExtensionTransaction`)。
// 本文件不该长出第二个职责;它长了就说明它变成了那种「为将来写的抽象」。
//
// 在那之前它是 **fail-closed** 的:不写盘、不动账本,并且**不消费 previewId** ——
// 用户重点确认时仍然拿得到同一份预览(`#351`:单次消费语义只对成功写入成立)。

import type { IssuedLocalPackagePreview } from "./local-package-preview"

export type LocalPackageInstallOutcome =
  | {
      ok: true
      packageId: string
      /** 真正落账的组件 `(kind, name)`。preview 的 included 集与它必须逐字相等(G15,归 T2)。 */
      installed: ReadonlyArray<{ kind: string; name: string }>
    }
  | { ok: false; reason: string }

export type LocalPackageInstaller = (issued: IssuedLocalPackagePreview) => Promise<LocalPackageInstallOutcome>

/**
 * 装一个本地 Claude 插件包。**当前实现是 fail-closed 的占位**(见文件头)。
 *
 * **降级只许写成降级**(基线 §8 纪律 3):这里没有「我们用别的方式装上了」这种说法 ——
 * 它现在装不了任何东西,返回的就是这句话本身。
 */
export const installLocalClaudePlugin: LocalPackageInstaller = async (issued) => {
  return {
    ok: false,
    reason: `扩展包「${issued.preview.name}」的安装还没上线,本次没有做任何改动。`,
  }
}
