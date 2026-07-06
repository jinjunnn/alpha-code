// REQ-041:引擎 variant(推理档)标签规范化。上游/第三方模型的档位标签可能是英文(low/medium/high ——
// 如 deepseek,其 variants 来自上游 opencode 模型定义,不是 alpha-models.json 的中文 低/中/高)。EffortChip
// 此前只按中文精确匹配 → 英文 variant 模型:①显示回退到默认档(与引擎实际不符)②cycle 永不命中→「切换失败」。
// 规范化后,显示/选中/切换一律按同一档比较,两套标签一致(deepseek 是 cn 版默认模型,必经此路径)。
// 独立文件(不引 Solid)使纯函数可单测。

export const EFFORTS = ["低", "中", "高", "超高"] as const
export type Effort = (typeof EFFORTS)[number]

const VARIANT_ALIASES: Record<string, Effort> = {
  低: "低", 中: "中", 高: "高", 超高: "超高",
  minimal: "低", min: "低", low: "低",
  medium: "中", mid: "中",
  high: "高",
  max: "超高", xhigh: "超高", highest: "超高",
}

/** 引擎 variant 原始标签 → 规范档(低/中/高/超高);无法识别返回 undefined(调用方回退显示原文)。 */
export function normalizeVariant(label: string | undefined): Effort | undefined {
  if (!label) return undefined
  const k = label.trim()
  return VARIANT_ALIASES[k] ?? VARIANT_ALIASES[k.toLowerCase()]
}
