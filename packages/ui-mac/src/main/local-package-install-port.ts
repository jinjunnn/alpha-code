// REQ-128 Phase 3 `[T3-channel]`(#782):confirm 通道通往**安装**的那一个接缝。
//
// 这一层为什么在(而不是「留给将来的抽象」):`[T2-install]`(#781)与本票**并行开工**,
// 而 confirm 通道必须**现在就是一条真通道** —— 它要进 `GATED_WRITE_CHANNELS`、要过恢复
// gate、要能被绕过实验证伪(「取出即消费 ⇒ 重点确认用例红」这条闸没有成功路径就立不起来)。
// 一条 confirm 若只会返回「还没上线」,它的一次性语义与 `#351` 语义都无法被任何测试杀死。
//
// **接线已完成**(`[T4-renderer]` `#784`,第 4/9 跳):下面这个实现转调
// `claude-plugin-install.ts` 的 `installLocalClaudePluginV1(input, deps)`。
// `pluginRoot: issued.srcDir`、`preview: issued.preview`、`payloads: issued.payloads`
// (本模块的 payload 多带 `byteCount`/`contentDigest` 两个字段,结构上兼容)。
//
// ⚠️ **一处会静默绕开闸门的地方,接线时躲开了,记在这里防止下一个人踩回去**:
// `claude-plugin-install.ts` 自带一个 `collectLocalPackagePayloadsV1`,与本票的
// `collectRetainedPayloads` **同名同义但没有预算** —— 它不做包级字节/文件帽(G19),
// 也不做「留下来的字节 == 预览判过的字节」摘要比对。confirm 若改成调它重新采集,G19 就从
// 「有闸」变成「有一段写着闸的注释」,而且会**重新引入 confirm 期重扫**(K15 明令否决的那条)。
// 所以这里**沿用 preview 期已经留下的字节**:`issued.payloads` 直接喂进去,一个字节都不重读。
// 本文件里不出现 `collectLocalPackagePayloadsV1`,也不出现任何 `fs` 读 —— 这两条由
// `local-package-install-port.test.ts` 按源码文本钉死(那是一道减速带,不是安全边界:
// 判据只看这一个文件,谁想绕过它只要把读挪进别的模块)。
//
// 本文件不该长出第二个职责;它长了就说明它变成了那种「为将来写的抽象」。

import { getAlphaEnvironment } from "./alpha-environment"
import { alphaGlobalRoot } from "./alpha-installs"
import { installLocalClaudePluginV1 } from "./claude-plugin-install"
import type { IssuedLocalPackagePreview } from "./local-package-preview"

export type LocalPackageInstallOutcome =
  | {
      ok: true
      packageId: string
      /** 真正落账的组件 `(kind, name)`。preview 的 included 集与它必须逐字相等(G15,归 T2)。 */
      installed: ReadonlyArray<{ kind: string; name: string }>
      /** owner 裁决 B:本地包装完默认是**关**的。逐条落账值上抛,renderer 据此说人话
       *  ——「装好了,但都还关着」。不上抛的话 renderer 只能猜,而猜出来的默认值
       *  正是「装完像没装」这条已知风险的放大器。 */
      desiredState: "disabled"
      /** CAS 自愈 / 事务的 loud 诊断。`#765`:renderer 的 `extIpc` 包装层见到它就推 toast,
       *  所以这里必须原样带上 —— 收集了不往上传就是静默吞掉。 */
      warning?: string
    }
  | { ok: false; reason: string; code?: string }

export type LocalPackageInstaller = (issued: IssuedLocalPackagePreview) => Promise<LocalPackageInstallOutcome>

/**
 * 装一个本地 Claude 插件包 = 把 preview 期留在 main 的那份字节交给 `[T2-install]` 的
 * 单事务安装器。**这一层不做任何决定**:不判可装性(preview 判过)、不采集载荷
 * (preview 采过)、不算摘要(preview 算过、安装器还会再比一次)。
 *
 * **降级只许写成降级**(基线 §8 纪律 3):这条路上没有 admission 的渠道保证,
 * `capabilities` 恒空 ⇒ 引擎的授权闸在这里永远不开火。这不是「我们用别的方式提供了同等保证」,
 * 是「这条路上不提供渠道保证」—— 兜底只有三件事:用户亲手选的目录、逐条告知、账本里恒为
 * user 的策展维。
 */
export const installLocalClaudePlugin: LocalPackageInstaller = async (issued) => {
  const result = await installLocalClaudePluginV1(
    {
      pluginRoot: issued.srcDir,
      preview: issued.preview,
      // ⚠️ 见文件头:**留存字节原样过桥**,不重新采集、不重扫源目录。
      payloads: issued.payloads.map((payload) => ({ name: payload.name, dir: payload.dir, files: payload.files })),
    },
    {
      globalRoot: alphaGlobalRoot,
      casBaseRoot: () => getAlphaEnvironment().casBaseRoot,
      environment: () => getAlphaEnvironment().environment,
    },
  )
  if (!result.ok) return { ok: false, reason: result.reason, code: result.code }
  return {
    ok: true,
    packageId: result.packageId,
    installed: result.installed.map((name) => ({ kind: "skill", name })),
    desiredState: result.desiredState,
    ...(result.warning ? { warning: result.warning } : {}),
  }
}
