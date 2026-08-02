// REQ-128 Phase 3 `[T3-channel]`(#782):confirm 通道通往**安装**的那一个接缝。
//
// 这一层为什么在(而不是「留给将来的抽象」):`[T2-install]`(#781)与本票**并行开工**,
// 而 confirm 通道必须**现在就是一条真通道** —— 它要进 `GATED_WRITE_CHANNELS`、要过恢复
// gate、要能被绕过实验证伪(「取出即消费 ⇒ 重点确认用例红」这条闸没有成功路径就立不起来)。
// 一条 confirm 若只会返回「还没上线」,它的一次性语义与 `#351` 语义都无法被任何测试杀死。
//
// **接线时的动作**(`#787` 已合并,`installLocalClaudePluginV1(input, deps)` 在
// `claude-plugin-install.ts` 里已就绪):把下面这个实现换成对它的转调。形状基本对得上 ——
// `pluginRoot: issued.srcDir`、`preview: issued.preview`、`payloads: issued.payloads`
// (本模块的 payload 多带 `byteCount`/`contentDigest` 两个字段,结构上兼容)。
// **本票不做这一步**:它属于第 4/9 跳,归 `[T4-renderer]` 与编排者。
//
// ⚠️ **接线的人必须注意一处会静默绕开闸门的地方**:`claude-plugin-install.ts` 自带一个
// `collectLocalPackagePayloadsV1`,与本票的 `collectRetainedPayloads` **同名同义但没有预算**
// —— 它不做包级字节/文件帽(G19),也不做「留下来的字节 == 预览判过的字节」摘要比对。
// confirm 若改成调它重新采集,G19 就从「有闸」变成「有一段写着闸的注释」,而且会**重新引入
// confirm 期重扫**(K15 明令否决的那条)。正确接法:**沿用 preview 期已经留下的字节**,
// 也就是把 `issued.payloads` 直接喂进去,一个字节都不重读。
//
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
