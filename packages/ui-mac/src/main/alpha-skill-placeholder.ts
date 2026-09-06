// alpha-skill-placeholder — 「空壳技能」的判据(REQ-154 / `#1242`)。
//
// 缺陷形态:一个 `SKILL.md` 只有 frontmatter + 一句「正文待补」。它对**系统提示词**几乎不花钱
// —— `skill/index.ts:321` 只把 name + description + location 注进 system 段,正文不进(三个已知
// 空壳合计 199 token = 技能块的 5.3%)。真代价发生在**之后**:模型按 description 判断这个技能
// 对得上任务、调用它,拿回一份空的 `<skill_files>`,于是它要么空手继续、要么现编。
//
// 判据必须**与名字无关**。按名字拉黑会在用户自建同名技能时误伤(本仓 2026-07-06 真机演练已经
// 撞过一次:名字匹配启发式把用户自建的 `mcp-builder` 列成迁移候选)。所以这里只看内容,两条
// 相互独立的轴,命中任一条即判空壳:
//
//   ① **残留指纹** —— 正文含 `请补充上游内容`。这是 alpha 自己 2026-06-23 那版安装实现写出的
//      占位文本(该实现已随 REQ-044 撤掉,仓内 grep 零命中,今天的 `installBuiltinSkill` 在资产
//      未打包时**诚实失败**而不是写占位)。留着这条轴是为了认出**存量**残留。
//   ② **实质地板** —— frontmatter 之后的正文没有实质内容。阈值不是拍脑袋的,是量出来的
//      (2026-09-06,本机全部 26 份 SKILL.md,含 alpha 出厂 9 份与用户目录 17 份):
//
//        三个已知空壳:正文 106–110 B,**2** 条非空行,**0** 个标题,**0** 个列表项,0 个代码块
//        最小的真技能  :`alpha-workspace` 906 B,**19** 条非空行,3 个标题,9 个列表项
//
//      2 与 19 之间没有任何东西。地板取 6 条非空行(离真技能最小值 3.2 倍余量),再加一条
//      「零结构」轴(既无标题、又无列表项、又无代码块)。两条都不是判断质量好坏 —— 它们判的是
//      「这份文件有没有正文」。
//
// 反向自检在 `alpha-factory-skill-hygiene.test.ts` 里:先在三个已知空壳上验证 3/3 命中
// (恒绿的判据不算判据),再对 alpha 出厂的全部技能跑,并单独证明两条轴各自都能独立命中。

/** 2026-06-23 那版安装实现写出的占位句。存量残留的指纹,不是今天代码还会产生的东西。 */
export const PLACEHOLDER_RESIDUE_MARKER = "请补充上游内容"

/** 实质地板:正文非空行少于这个数 = 没有正文。实测真技能最小 19 条(见抬头)。 */
export const MIN_BODY_LINES = 6

export type SkillVerdict = { placeholder: false } | { placeholder: true; reason: string }

/** 拆掉 YAML frontmatter,返回正文(没有 frontmatter 时原样返回)。 */
export function skillBody(source: string): string {
  if (!source.startsWith("---\n")) return source
  const end = source.indexOf("\n---\n", 3)
  return end === -1 ? source : source.slice(end + 5)
}

/**
 * 一份 `SKILL.md` 是不是空壳。**只看内容,不看名字**(理由见抬头)。
 * 返回 reason 而不是布尔:门红的时候要读得出红在哪一条轴上。
 */
export function classifySkill(source: string): SkillVerdict {
  const body = skillBody(source)
  if (body.includes(PLACEHOLDER_RESIDUE_MARKER)) {
    return { placeholder: true, reason: `正文含存量占位指纹「${PLACEHOLDER_RESIDUE_MARKER}」` }
  }
  const lines = body.split("\n").filter((l) => l.trim().length > 0)
  if (lines.length < MIN_BODY_LINES) {
    return { placeholder: true, reason: `正文只有 ${lines.length} 条非空行(实质地板 ${MIN_BODY_LINES})` }
  }
  const hasHeading = lines.some((l) => /^\s*#{1,6}\s/.test(l))
  const hasBullet = lines.some((l) => /^\s*([-*+]|\d+\.)\s/.test(l))
  const hasFence = body.includes("```")
  if (!hasHeading && !hasBullet && !hasFence) {
    return { placeholder: true, reason: "正文零结构(无标题、无列表项、无代码块)" }
  }
  return { placeholder: false }
}
