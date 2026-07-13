// REQ-087 spike 实验闸(Issue #180/#202)。永不默认启用:
//
//   容器侧探针(SessionSpikeHost):localStorage["ALPHA_SESSION_SPIKE"]="1" + reload
//   正式外框(session-workspace/alpha-session-workspace.tsx,REQ-088 T2 由 spike 转正):
//     上面的 localStorage 闸 **且** 主进程 ALPHA_SURFACE_SESSION=alpha
//     (main/alpha-surfaces.ts env 覆盖)—— 双闸全开才生效;发布态升级归 T5,闸的去留归 T7。
//
// 为什么用 localStorage 而不是 env:renderer 没有 process.env,现有 env→renderer 通道只有
// main 的 surface resolver IPC(不属于本 spike 的可改面)。localStorage 满足「显式 opt-in、
// reload 才生效、默认关」三条纪律,且与 surface 解析「加载时一次、不热切换」语义一致。
// 清理点:REQ-088 落地或 NO-GO 后整目录删除(见 docs/spikes/2026-07-12 报告 §清理方案)。

export const SESSION_SPIKE_STORAGE_KEY = "ALPHA_SESSION_SPIKE"

/** 纯解析,可测:只认 "1" / "true"(其余一律 off,包括空串/null/乱值)。 */
export function parseSpikeFlag(value: string | null | undefined): boolean {
  return value === "1" || value === "true"
}

/** 读取一次实验闸。localStorage 不可用(隐私模式/测试环境)按关闭处理,绝不 throw。 */
export function isSessionSpikeEnabled(): boolean {
  try {
    return parseSpikeFlag(globalThis.localStorage?.getItem(SESSION_SPIKE_STORAGE_KEY))
  } catch {
    return false
  }
}
