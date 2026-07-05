---
id: REQ-037
title: 上游能力治理层:原生 agent/skill/command 的隐藏/禁用/重写(governance 真源 + home jsonc 物化 + dispose 热生效 + hub「内置」管理分组)
type: feature
priority: P1
status: ready
repo: A
created: 2026-07-05
---

## 背景(为什么)

用户诉求(2026-07-05):不改上游 opencode 的 agent/skill 源码,但要能**禁用**其中不好的、或以**白名单**只显示认可的,不好的经 alpha **重写**;并确认 slash command 一并纳入——让 alpha-code 既能自由复用上游 agent/skill/command,也能屏蔽/替换其中任意一个。

机制核实(2026-07-05,代码确证,file:line 均上游引擎):

| 类型 | 禁用 | 隐藏 | 重写 | 已知限制 |
|---|---|---|---|---|
| **agent** | ✅ config `agent.<名>.disable:true` 从列表删除(`agent/agent.ts:267-271`) | ✅ `hidden:true` 引擎保留、冻结前端两处选择器均过滤 `!hidden`(`local.tsx:67`、`prompt-input.tsx:663`) | ✅ 同名 config agent 字段级覆盖 prompt/model/permission(`agent.ts:281-293`) | **禁 `compaction` 必崩**(自动压缩解引用无守卫,`compaction.ts:328-329`);禁 build 兜底 plan/全禁抛错(`:328-340`);禁 general/explore = task 委派优雅报错(`task.ts:116-118`);summary 消费者未定位(禁用安全性未确证) |
| **skill** | ✅ 全局 `permission.skill: {"*":"allow","<名>":"deny"}` 按名 deny(`permission/index.ts:28-38,186-198`,merge 进每个 agent `agent.ts:138`):system prompt 剔除(`system.ts:96-107`)+ 执行抛 DeniedError(`tool/skill.ts:27-32`) | —(同 deny) | ⚠️ 磁盘同名**只对引擎内置 skill 可靠**(`skill/index.ts:278-284` 上游有意支持);磁盘互相同名 = 并发加载胜负不确定(`:240-243`)→ 重写一律「deny 原名 + alpha 新名」 | **观感泄漏**:`GET /skill` 与 skill 自动生成的斜杠 command 用 `skill.all()` 不过滤(`command/index.ts:134`)——deny 后菜单仍见(功能已拦) |
| **command** | ❌ schema 无 disable(`v1/config/command.ts:5-12`),列表无过滤手段 | ❌ | ✅ 同名 config command 覆盖内置 `/init` `/review`(`command/index.ts:70-103`;覆盖序:内置→config→MCP prompt→skill 仅补空) | 内置不可移除只可重写;MCP prompt 同名会顶掉 config 覆盖 |

**通道拍板依据**:`~/.opencode/opencode.jsonc` 是唯一 dispose 后重读的持久通道(InstanceState 作用域,`config.ts:423-433`)→ 治理物化走它,改完 dispose 即生效;`OPENCODE_CONFIG_CONTENT` env 进程内冻结(只适合静态注入,现有 alpha-automation 等不动);`~/.config/opencode` dispose 不重读(勿用)。与 ADR-014 v3「MCP/plugin 持久化走 home jsonc 文件通道」同构,writer 基建(persistMcp 一族白名单写)现成。

## 目标(做什么)

1. **治理真源** `~/.alpha/governance.json`:`{mode: "denylist"|"allowlist", agents: {hide[], disable[], override{}}, skills: {deny[]}, commands: {override{}}}`;默认 `denylist`(见决策记录)。
2. **物化 writer**(main 进程):governance → `~/.opencode/opencode.jsonc` 受控键(`agent.*` / `permission.skill` / `command.*`)+ dispose;复用既有 jsonc 写基建与路径白名单;**保护名单硬校验**:`compaction/title/summary` 拒绝 disable(loud error);`build` disable 需确认并提示兜底行为;`permission.skill` 写入保证 deny 键在 `"*"` 之后(findLast + key 保序依赖)。
3. **hub「内置(上游)」管理分组**(落「已安装」tab,即 [[REQ-019]] 递延的 V2 内置管理):列原生可见 agent(build/plan/general/explore)、内置 skill(customize-opencode)、内置 command(/init /review),每项给 隐藏/禁用/重写 操作;保护项灰显并说明原因(C28 诚实控件)。
4. **重写路径逐类型**:agent = 同名 config override(编辑 prompt/权限/模型);skill = deny 原名 + 引导创建 alpha 替代(可衔接 [[REQ-036]] 创建技能);command = 同名 config 覆盖(内置品牌化/行为校准的现成接缝)。
5. **泄漏缓解(诚实优先)**:skill 被 deny 时 writer 顺手写同名 `command.<名>` 占位模板(「该技能已在 alpha 中禁用」)——把斜杠泄漏从「误导可点」降为「可见但诚实」;文档如实记录 `GET /skill` 仍返回的上游行为,不谎称彻底移除。

## 验收标准(可验证,逐条)

1. 禁用 explore:选择器/@ 菜单消失,task 委派得到优雅报错;恢复后回归——全程 dispose 热生效,无重启;
2. 隐藏 build:UI 消失、引擎不破(默认 agent 兜底核验,新会话可正常对话);
3. 保护名单:对 compaction 写 disable 被 writer 拒绝(loud,含原因);
4. deny customize-opencode:system prompt 无该 skill(调试端点/日志核验)+ 会话内调用被拒;斜杠占位模板如实呈现;
5. 重写 `/init`:触发后走 alpha 模板而非上游模板;
6. 治理键写入不破坏用户自有 jsonc 内容(mergeDeep 保留);「重置治理」净除全部受控键(卸载净除纪律,同 REQ-023);
7. allowlist 模式切换可用:切换后未列名的可见 agent 被 hidden(保护名单豁免),切回 denylist 恢复;
8. 零改上游(north-star guard 绿);机制回归:upstream sync 触碰 `agent/agent.ts`/`permission/`/`command/index.ts` 时在 retro 复核治理机制仍成立(挂 ADR-015 合并验证同类纪律)。

## 非目标

- 不移除内置 `/init` `/review`(上游无此能力,只重写——如实告知);
- 不治理用户自建内容(`.opencode`/`~/.opencode` 用户自有物不接管,ADR-019 §4);
- 不做 per-agent 粒度的 skill 治理(全局 permission 先行,真实需求出现再扩);
- 不承诺 hidden agent 从 `GET /agent` 消失(上游行为;仅 UI 层不可见);
- 不做上游新增 agent/skill 的自动审查/评级(allowlist 模式即为「新增默认不显」的机械替代)。

## 决策记录

- **默认 denylist + allowlist 可切(本档建议,2026-07-05)**:上游可见面小(4 agent + 1 skill + 2 command),逐禁成本低;allowlist 默认拒绝会让每日 sync 新增的引擎 agent 静默隐藏,保护名单外的新隐藏 agent 是否 load-bearing 不可预知。两种模式同一治理文件均可表达,先 denylist 上线。用户如倾向 allowlist 打底,开工前改本条即可(不影响 schema)。
- 治理动作默认档 = **hidden(软)优先于 disable(硬)**:UI 目标(「不显示」)hidden 即达成且零崩溃风险;disable 供「连模型也不许用」的强诉求。

## 方案 / 关联

- [[REQ-036]](创建技能化,孪生档:治理屏蔽后的「重写」靠它产出替代物)、[[REQ-019]](V2 内置/command 管理位,本档即其实现载体)、[[REQ-033]]/[[ADR-023]](开放生态进 = 入口,本档 = 出口/策展,互补);
- ADR-014 v3(home jsonc 文件通道 + dispose)、ADR-019(`.alpha` 真源 + 引擎侧物化)、ADR-002/005(零改上游、只走 config 接缝)、C28(诚实控件:泄漏如实呈现)。
