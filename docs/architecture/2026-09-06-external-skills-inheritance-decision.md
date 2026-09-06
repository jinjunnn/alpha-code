---
title: 外部技能目录(~/.claude/skills 等)维持关闭 —— 勘破与裁决
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-06
review_after: 2026-12-06
---

# 外部技能目录维持关闭:那行 flag 是 ADR-024 的安全裁决,同意门已经上线并在本机弹过四次

*2026-09-06 · 票 `#1243`(REQ-154 `#1234` 的 DECIDE 子票)· 被测树 `origin/alpha@0830951d3`*

## 先说结论

**维持关闭(票面选项 1)。** 这不是新裁决,是
[ADR-024](../../.claude/rules/adrs/ADR-024-ecosystem-inheritance-default-deny.md)
(2026-07-08 owner 拍板)的重申 —— 那条 ADR 就是安全裁决(「静默继承的三宗罪」第一条:提示注入面),
票面写明「若是安全裁决,本票直接采信并结」。判据顺序按票面:安全 > 可回滚 > 收益,三格逐一在 §4。

但票面与 REQ-153 基线 §1.8 的两个前提**不成立**,这才是本文值得存在的原因:

| 票面前提 | 地面真相 |
| --- | --- |
| 「一行**无条件**的开关,不是配置项」 | `ecosystem-import.ts:28-32` 是 `??=` **set-if-unset**,shell 显式 `OPENCODE_DISABLE_EXTERNAL_SKILLS=0` 优先;`ALPHA_ECOSYSTEM_INHERIT=1` 整机逃生。更重要的是 ADR-024 §2/§3 设计的**同意门已经上线**(§2 列三条入口),「不装载」从来不是终态,「未经确认不装载」才是 |
| 「owner 现成的技能对这里一点用都没有」 | 这台机器上迁移门已弹过 **4 次**(§1.4):2026-07-19 prod 环境 owner 选「导入」,14 个技能 + CLAUDE.md 进了原生根;当前 dev(2026-07-23)与当前 prod(2026-08-07)owner 选了「**不导入**」。「不可用」是 owner 在门上按的那个键,不是产品结构上关死的;要用,走重导入,**零代码** |
| 「打开就能立刻用上质量类技能」 | 本机 `~/.claude/skills` 只有 **7** 个,全是流程/治理技能(`dev-loop`、`requirement-management`、`owner-decision`…),**没有一个是产出物质量/中文排版技能**;真正的 17 个用户技能住在 `~/.config/opencode/skills`(引擎原生生态位,**本来就开着**,`config/paths.ts` 经 `skill/index.ts:205-208` 扫描)。打开外部目录对 REQ-154 的收益 ≈ 0 |

对 REQ-154 的含义:质量指导由出厂技能 + `alpha-behavior` 承担(`#1240` / `#1242`),票面本来的默认路线成立。

## 1. 那行 flag 的出处(票面证据 1)

### 1.1 单一提交,单一 ADR

```
$ git log origin/alpha --format='%h %ad %s' --date=short -S'OPENCODE_DISABLE_EXTERNAL_SKILLS' \
    -- packages/ui-mac/src/main/ecosystem-import.ts
26803ddda 2026-07-08 feat(main): REQ-063 外部生态继承 default-deny + consent 导入门(ADR-024)

$ git log origin/alpha --format='%h %ad %s' --date=short \
    -- .claude/rules/adrs/ADR-024-ecosystem-inheritance-default-deny.md
9744d03c8 2026-07-08 docs(g6): 去 opencode 化目标线立项 + verified 批量归档 + REQ-059 状态回写
```

ADR-024 从落笔起没有修订过。它的裁决五条,与本票直接相关的三条:

1. **默认拒绝继承**:sidecar env 注入 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` + `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1`,
   set-if-unset;`ALPHA_ECOSYSTEM_INHERIT=1` 不注入。
2. **consent = 安装期转换导入,不是重开继承**(与 ADR-023「不做运行时模拟层」一脉):产物是原生资产,快照语义,重导入是唯一更新通道。
3. **全局一次性迁移门是发布闸**:首启检测 `~/.claude/skills`、`~/.agents/skills`、`~/.claude/CLAUDE.md` 非空就弹,不导入则 loud 明示从此不可见。

三宗罪原文的第一条就是安全面:「克隆一个第三方仓库,其自带的 `CLAUDE.md` / `.claude/skills` 未经任何确认直接进入模型上下文」。

### 1.2 写方与读方(这个值被谁写、被谁读)

| 角色 | 坐标 | 形态 |
| --- | --- | --- |
| 写 | `packages/ui-mac/src/main/ecosystem-import.ts:28-32` `applyEcosystemDefaultDeny` | `env.OPENCODE_DISABLE_EXTERNAL_SKILLS ??= "1"`;`ALPHA_ECOSYSTEM_INHERIT === "1"` 直接 return |
| 调用点 | `packages/ui-mac/src/main/server.ts:224`(sidecar env 装配) | 注释逐字引用 ADR-024 §5 |
| 读 | 上游 `packages/opencode/src/effect/runtime-flags.ts:21` | `disableExternalSkills: bool("OPENCODE_DISABLE_EXTERNAL_SKILLS")` |
| 消费 | 上游 `packages/opencode/src/skill/index.ts:185-203` | 为真时跳过 `.claude` / `.agents` 两个外部根与向上走查;`config.directories()` 与 `skills.paths` 不受影响 |
| 绊线 | `packages/ui-mac/src/main/ecosystem-import.test.ts:48-67` | 三条用例:默认注入 / 显式值优先 / 逃生不注入 —— 谁把注入删掉,第一条当场红 |

### 1.3 同意门三条入口,全部已接线(不是设计稿)

| 入口 | 坐标 | 触发 | 落点 |
| --- | --- | --- | --- |
| 全局一次性迁移门 | `ecosystem-gate.ts:27-89`,由 `index.ts:1351-1355` 在窗口就绪后 fire-and-forget | 无 marker 且 `~/.claude/skills`、`~/.agents/skills`、`~/.claude/CLAUDE.md` 任一非空 | 「导入」→ `importExternalSkills(…, {scope:"global"}, installGlobal)` 走 `#390` 的 CAS 事务安装器(`ext-ipc.ts:778-779`);CLAUDE.md → `<root>/instructions/imported-claude-code.md` |
| 项目打开门 | `ext-ipc.ts:593-632` | 打开的项目里有 `.claude/skills`、`.agents/skills` 或 `CLAUDE.md`,且 `prefs.json` 无版本化决策 | 技能 → `<project>/.code-puppy/skills/`,`alpha.jsonc` 注册 `skills.paths`;CLAUDE.md → `AGENTS.md`(已存在则不动,C28) |
| 会话内重导入 | 出厂技能 `resources/factory-skills/integrate-project/SKILL.md`(`FACTORY_SKILL_IDS`,`factory-skills.ts:33`) | 用户说「导入外部技能」 | 同一条转换管线;这是快照更新的唯一交互通道 |

2026-07-08 真机批(`docs/audits/2026-07-08-g6-realmachine-batch/verify.md:35-40`)已验:`ps eww` 看到两 flag 到达引擎进程;
`/grap` 为空(graphify 只在 `~/.claude/skills`);迁移门首启弹出,选「不导入」后 marker 落盘、二次启动不再弹。

### 1.4 本机四个 marker:门真的被用过,两个方向都用过

只读实查(`find ~ -maxdepth 6 -name ecosystem-import.json`),四个环境根各一份:

| 环境根 | decision | at | 内容 |
| --- | --- | --- | --- |
| `~/.alpha/`(退休根) | declined | 2026-07-08 | 首批真机验证那次 |
| `~/.alpha/env/prod/` | **imported** | 2026-07-19 | 14 个技能(`agents-sdk`、`cloudflare`、`codex-review-watchdog`、`cross-repo-delivery`、`dev-loop`、`maintain-repository-docs`、`requirement-management`、`wrangler`…)+ `CLAUDE.md → ~/.alpha/instructions`,`skipped: []` |
| `…/alpha-code-state/env/dev/`(**当前运行的环境**,基线 §1.8:2026-09-04 起 dev 渠道) | declined | 2026-07-23 | `skills/` 目录不存在,`installs.json` 空 |
| `…/alpha-code-state/env/prod/` | declined | 2026-08-07 | |

所以「技能对这里没用」的直接原因是当前 dev 根上 2026-07-23 那次「不导入」+ marker 防重弹;
产品给的补救通道就是 §1.3 第三行,不需要任何代码改动。

## 2. 技能内容进入模型上下文的确切形态(票面证据 2)

两段,外加一格常被漏掉的授信。

### 2.1 system 段:只有 name / description / location,正文不进

`packages/opencode/src/session/system.ts:98-110` → `Skill.fmt(list, { verbose: true })`(`skill/index.ts:321-338`):

```
<available_skills>
  <skill>
    <name>${skill.name}</name>
    <description>${skill.description}</description>     ← 未转义
    <location>${escapeHtml(skill.location)}</location>  ← 转义
  </skill>
</available_skills>
```

每一轮都在;`description` **不经 `escapeHtml`**,而 `location` 经。上游 `isSkillFrontmatter`(`skill/index.ts:53-59`)
只要求 `name` 是字符串,`description` 可无(无则不进 system 段)。

### 2.2 `skill` 工具:正文全文 + 最多 10 个文件**路径**,只列不执行

`packages/opencode/src/tool/skill.ts:27-61`:先 `ctx.ask({ permission: "skill", patterns: [name] })`,再输出

```
<skill_content name="…">
# Skill: …
<SKILL.md 正文全文>
Base directory for this skill: <dir>
Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.
Note: file list is sampled.
<skill_files>
<file>/abs/path/…</file>   ← ripgrep.find({ pattern: "!**/SKILL.md", hidden: true, follow: false, limit: 10 })
</skill_files>
</skill_content>
```

`<skill_files>` 只是绝对路径清单:**不读内容、不执行**。「可执行引用」的真实语义是模型随后自己调 `read` / `bash` 去碰这些路径,
走常规工具审批与沙箱(REQ-138 围栏)。

### 2.3 漏掉的那一格:技能目录自动进入免审读取白名单

`packages/opencode/src/agent/agent.ts:101-116`:

```ts
const skillDirs = yield* skill.dirs()
const whitelistedDirs = [ …, ...skillDirs.map((dir) => path.join(dir, "*")), … ]
const readonlyExternalDirectory = { "*": "ask", ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])) }
```

**每一个被发现的技能目录,其下所有文件对 agent 的 `external_directory` 权限都是 `allow`。**
一个技能目录一旦被引擎发现,读它里面的任何文件都不再问。§3 的符号链接那一行因此不是「读到几行 Markdown」的问题。

### 2.4 发现语义(打开时会扫什么)

`skill/index.ts:185-203`:`~/.claude/skills/**/SKILL.md` + `~/.agents/skills/**/SKILL.md` + 从 cwd **向上走查到 worktree**
的每一层 `.claude` / `.agents`(`fsys.up`);`Glob.scan(…, { symlink: true, dot: true })` —— **跟随符号链接**。
`loadSkills`(`:235-246`)以 `concurrency: "unbounded"` 解析,重名者只 `logWarning` 后**覆盖**(`:125-139`),
胜者取决于解析完成顺序而不是声明顺序。

## 3. 若打开,整类攻击面(票面证据 3)

按「类」列,不按实例;每一类同时对照上游继承路径与 alpha 导入门的处置。
「导入门」= `importSkillFolder`(`ext-fs-installer.ts:678-737`,project scope)与
`installUncuratedSkillImport`(`ext-install-planner.ts:1938-1985`,global scope,CAS 事务)。

| # | 类 | 上游继承路径(选项 3) | alpha 导入门(现状) |
| --- | --- | --- | --- |
| 1 | **来源不可信**:打开陌生仓库,其 `.claude/skills` 与 `CLAUDE.md` 静默进上下文(向上走查,`:196-202`) | 无任何确认 | 项目打开门先问,决策按项目版本化记账;产物是快照,与源目录脱钩 |
| 2 | **符号链接 / 目录穿越**:`symlink: true` 跟随;技能目录可以是指向任意路径的链;叠加 §2.3 ⇒ **一个链就把任意目录变成免审读取范围** | 无 | `collectImportFiles:488` 拒 symlink dirent;`readImportFileBounded:511-524` realpath 圈禁 + `O_NOFOLLOW` + `O_NONBLOCK`(FIFO);`safeResolveUnder` 防逃逸(`:704-705`);根 `SKILL.md` 必须是非链常规文件(`:597-604`) |
| 3 | **正文指令注入**:`description` 未转义、每轮进 system 段(§2.1);正文经 `skill` 工具进入(§2.2) | 只有 `ctx.ask("skill")`;是否弹审批取决于 agent 的 permission 规则集(本票未实跑这一格,不写结论) | 同意门解决的是「**谁能进**」,不是「进来的能说什么」—— 导入后的正文一样进上下文。差别在:来源经 owner 逐项确认、账本 `origin: imported-claude/agents` 可溯源、可卸载、外部目录之后的改动不跟随 |
| 4 | **引用文件的执行语义**:`<skill_files>` 只列路径;执行走 `bash` 工具 + 沙箱;但 **读免问**(§2.3) | 读免问 + 内容随外部目录实时变(TOCTOU:owner 看到的与模型读到的可以不是同一份) | 读同样免问,但内容是 owner 点头那一刻的字节(CAS 按内容寻址,`sha256` 清单),偷换需要重新过门 |
| 5 | **重名遮蔽**:同名后来者覆盖,胜者不确定(§2.4) | 外部技能可与出厂 / 用户技能重名 | `importSkillFolder:706` 同名即拒;`installRemoteSkill` 有 name-spoofing guard(frontmatter name ≠ 条目名即拒);`uncuratedSkillFreshGate` 账本冲突预检 |
| 6 | **资源上限**:`ConfigMarkdown.parse` 无大小帽 | 无 | `SKILL.md` ≤ 256KB、目录 ≤ 10MB、≤ 500 文件(`:468-470`),以实际读入字节计而非 stat 快照 |
| 7 | **生命周期**:ADR-024 ③ —— 外部目录内容变化 alpha 无感、无账本 | 无 | receipts + generation + 卸载 + 重导入 |

选项 2「有限打开(白名单目录 + 只取正文 + UI 标注来源)」描述的每一件事,**都是导入门已经做了的**:
白名单 = owner 逐项确认;「只取正文不取可执行引用」= 拒 symlink 的快照拷贝;来源标注 = receipts `origin`。
再造一条「运行时有限继承」= 第二份真源 + 把上表七行每一行重写一遍,而 ADR-023 明令不做运行时模拟层。

## 4. 三个选项按票面判据(安全 > 可回滚 > 收益)

| 选项 | 安全 | 可回滚 | 收益 | 裁决 |
| --- | --- | --- | --- | --- |
| 1 维持关闭 | ADR-024 原样,§3 七类面全部由导入门承接 | 什么都没改;逃生口(`ALPHA_ECOSYSTEM_INHERIT=1`、`OPENCODE_DISABLE_EXTERNAL_SKILLS=0`)与三条同意入口本来就在 | owner 要用外部技能:会话里说「导入外部技能」(global scope),或删当前环境根的 `ecosystem-import.json` 重启再弹;两者都不改代码、不动 `~/.claude` | **选** |
| 2 有限打开 | 等价于重做导入门,且是运行时形态(ADR-023 §2 否决的那种) | 新增第二份真源,回滚要清两处 | 与选项 1 相同(内容一样进上下文) | 否 |
| 3 完全打开 | §3 七类面裸露;§2.3 让符号链接直接变成免审读取范围 | 一行 env 可回滚,但期间进入过上下文的内容回不了 | 本机 `~/.claude/skills` 7 个流程技能,零质量类技能;收益 ≈ 0 | 否 |

「有可回滚的保守默认就选保守的」—— 这里保守默认还恰好是**已经上线并被 owner 亲手用过**的那条。

## 5. 本票主动没做的事

- 没改 `ecosystem-import.ts`、没碰任何 `UPSTREAM_PATHS`;本票只有文档。
- **没改 ADR-024 本体**(`.claude/rules/` 是受保护的规则资产)。若要在 ADR-024 末尾追加一行「2026-09-06 `#1243` 重申,证据见本文」,需要 owner 明确授权该资产的改动;本文已从 `docs/` 侧单向引用它。
- 没实跑 `skill` 工具的 `ctx.ask("skill")` 在打包壳里到底弹不弹(REQ-131 `#725` 取证的是 identity 轴,与这条 v1 permission 轴不是同一格)。裁决不依赖它:三个选项里它对每个选项的影响相同。
- 没替 owner 做重导入:那会写他的环境根,票面禁止碰 `~/.claude`,且导入是 owner 在门上按的键。
- REQ-153 基线 §1.8「无条件注入」两行在同一 PR 内改正(同一变更、同一事实),其余基线内容未动。

## 6. 复现命令(全部在 `origin/alpha@0830951d3` 上实跑)

```
# 写方 / 调用点 / 读方
git show origin/alpha:packages/ui-mac/src/main/ecosystem-import.ts | sed -n 27,36p
git show origin/alpha:packages/ui-mac/src/main/server.ts | sed -n 219,224p
git show origin/alpha:packages/opencode/src/effect/runtime-flags.ts | grep -n EXTERNAL_SKILLS
git show origin/alpha:packages/opencode/src/skill/index.ts | sed -n 185,203p

# 同意门三条入口的接线(先用已知符号 importSkillFolder 证明 grep 能命中:29 行)
git grep -n "runGlobalEcosystemGate\|detectExternal\|importExternalSkills" origin/alpha -- packages/ui-mac/src

# 注入形态与免审白名单
git show origin/alpha:packages/opencode/src/skill/index.ts | sed -n 321,338p
git show origin/alpha:packages/opencode/src/tool/skill.ts | sed -n 27,61p
git show origin/alpha:packages/opencode/src/agent/agent.ts | sed -n 101,116p

# 本机 marker(只读)
find ~ -maxdepth 6 -name ecosystem-import.json -not -path '*/node_modules/*'
cat "$HOME/Library/Application Support/alpha-code-state/env/dev/ecosystem-import.json"

# 本机外部技能存量(只读):7 个,全部 name+description 齐全,0 个 symlink
ls ~/.claude/skills; ls ~/.config/opencode/skills | wc -l   # 7 / 17
```
