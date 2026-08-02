---
title: REQ-128 Phase 3 —— G1–G20 绕过实施记录总表
kind: verification
owners:
  - alpha-code extension maintainers
last_reviewed: 2026-08-02
review_after: 2026-11-02
---

方案基线 [REQ-128 Phase 3](../design/2026-08-02-req128-phase3-local-claude-plugin-import.md) §6 首句：
**写不出绕过配方的闸判为假闸，不许留在表里充数。**

本表是 `#783`(T5) 的收口件：把散在三处的绕过记录合成一份，并**点名今天还没有记录的闸**。
散处分别是 —— T1 在 PR [`#786`](https://github.com/jinjunnn/alpha-code/pull/786) 正文的 B1–B11、
T2 在 [`2026-08-02-req128-t2-gate-bypass-experiments.md`](2026-08-02-req128-t2-gate-bypass-experiments.md)
的 13 条、以及本票新做的 A/B/C 三条。

> **这份表本身不是「已验证」的证明。** 它是一张账：哪几道闸真被绕过一次并变红、
> 哪几道只有用例没有绕过、哪几道的真实语料半场是**恒真式**。第三类最危险 ——
> 它会以「真实语料全过」的样子被读成「验过了」。

## 一、总账

「谁验的」= 实施那次绕过的票。「真实语料半场」一栏只在**恒真**时才填字。

| 闸 | 谁验的 | 绕过配方（改坏的生产代码） | 实际输出 | 真实语料半场 |
| --- | --- | --- | --- | --- |
| **G1** 原子性 | T2 `#787` | `installLocalClaudePluginV1` 改回「一个技能一个事务」的 `for` 循环 | **8 fail**，含「N 条 record 携带的是同一个 transactionId」 | — |
| **G2** 分组不可绕 | T2 `#787` | 把 `packageMutation` 从 root item 上摘掉 | **6 fail**；`uninstallByKey` 对包内技能返回 `ok:true`（被静默卸掉） | — |
| **G3** 载荷完整 | T2 `#787` | `specsByKey` 只留 `SKILL.md`（= `buildSkillTxItems` 的形状） | **1 fail**：安装成功，而 generation 目录比源目录少 3 个文件 | — |
| **G3** mode 语义 | T2 `#787` | 删掉自包含判定的可执行位臂 + 给夹具 `chmod 0755` | **1 fail**：源侧 `exec:true`，装完 `exec:false` | — |
| **G4** 复用既有 fresh 闸 | T2 `#787` | 换成自制的「只查账本 record」替身 | **5 fail**：flat 目录 / 残留 generation store / catalog 同名 / 并发 / 整次零写 | — |
| **G4b** 锁内重验 | T2 `#787` | 删掉 `hooks.precondition`，只留锁外预检 | **1 fail**：并发夹具变红 | — |
| **G4** v1 那一臂 | T2 `#787` | `uncuratedSkillFreshGate` 去掉 `status === "v1"` | **1 fail**；⚠️ **修复前同一变异 = 26 pass / 0 fail**（那半边从没被执行过） | — |
| **G5** `previousDigest` 不撞 `#306` | T2 `#787`（**借 G4 的变异**） | 基线给 G5 的配方就是「删掉 G4 的预检」⇒ 与 G4 同一次实验 | G4 变异的 5 fail 里含「catalog 同名 ⇒ 具名拒绝，不走到 mutation」 | — |
| **G6** preview→confirm 绑定 | **无人** | — | — | — |
| **G7** 引擎授权闸 | T2 `#787` | 计划里预塞一份「全部确认」的 `authorization` | **1 fail**：capabilities 非空时安装照样成功，不再停在 authorize | — |
| **G8①** 铸造期 `local:` | **无人**（有用例，无绕过） | — | — | — |
| **G8②** admission 反向拒绝 | **无人** | — | — | — |
| **G9** 组件类型具名拒绝 | T1 `#786` B9 | 删掉枚举 `commands/` 的那一行 | **RED**（真实语料 22 个带 `commands/` 的插件） | — |
| **G10** 装完默认关 | T2 `#787` | 从 `shared/ext-install-policy.ts` 删掉 `localPackage` 判别维 | **3 fail**：落账变回 `enabled` | — |
| **G11** 事务规模界 64 | T1 `#786` B6/B7 | B6：超限改成 `items.slice(0,64)`；B7：把界从 64 改成发布端的 16 | B6 **RED**；B7 **RED ×2** | ⚠️ **恒真式**（下 §二 ①） |
| **G12** 载荷读取硬化 | **无人**（有敌意夹具，无绕过） | 基线配方「把某一个文件的读改成 `fs.readFileSync`」**今天没人实施过** | — | — |
| **G13** 全跳过终态 | T1 `#786` B10 + T2 `#787` | T1：0 组件改成 `{ok:true, installed:[]}`；T2：让 0 组件也去建 mutation | T1 **RED ×2**（25 个 0-skill 插件）；T2 **1 fail** | — |
| **G14** root 是真技能 | T2 `#787` | root 换成合成的 `kind:"plugin"` 节点 | **5 fail**（被 G15 在写盘前拦下） | — |
| **G15** 四集双射 | T2 `#787` | 图的 children 由 `accepted.slice(1)` 改成 `slice(2)` | **5 fail**，闸在调事务**之前**拒绝 | — |
| **G16** 自包含判定 | T1 `#786` B3/B4/B5 + T5 `#783` **B** | T1 B4：x 位判据「任一 x」→「u+g+o 全有」；B5：删 symlink 臂；B3：删被排除目录臂。T5 B：**整条删掉可执行位臂** | T1 B4 **RED ×3**、B5 **RED ×2**、B3 **RED**；T5 B **3 fail**（可装数 / 18 成员集 / 10 全灭成员集同时变红） | ⚠️ symlink 臂与 R2-a 臂**恒真式**（§二 ②⑥） |
| **G17** 调用控制字段 | T1 `#786` B1/B2 | B1：键存在性 → 要求冒号后有非空标量（R2-b 回退）；B2：解析器改回只交出 `name`/`description` | B1 **RED ×3**；B2 **RED ×11** | ⚠️ **真实语料杀不掉 B1**（§二 ⑦） |
| **G18** 布局具名 | T1 `#786` B8 + T5 `#783` **C** | T1 B8：分流改回「有 `plugin.json` 才是包」；T5 C：删掉 `.claude/skills` 那一臂 | T1 B8 **RED**（manifestless/receipts）；T5 C **1 fail** | ⚠️ 臂③⑤⑥**恒真式**（§二 ①③④⑤） |
| **G19** preview 字节预算 | **无人** | — | — | — |
| **G20** 热重载真接上 | **无人** | — | — | — |
| **AC7** `.bak` 与普通目录同待 | T5 `#783` **A** | 在 `intakeImportDir` 加 `if (basename.endsWith(".bak")) return {route:"single-skill"}` | **2 fail**（改名等价性 + marketplace 根具名码） | — |

### 三类点名（这是本表要交的信息）

**① 有绕过记录的（15 道）**：G1、G2、G3、G4（含 G4b、v1 臂、mode 臂）、G5（借 G4）、G7、G9、
G10、G11、G13、G14、G15、G16、G17、G18。

**② 今天还没有记录的（6 道）**，分两种，处置完全不同：

| 闸 | 为什么没有 | 谁该补 |
| --- | --- | --- |
| **G6** preview→confirm 绑定 | 实现属 `#782`(T3)，**尚未合并** | 随 `#782` 落地时补 |
| **G8②** admission 反向拒绝 | 同上（`package-admission.ts` 的唯一一处拒绝在 T3 范围内） | 随 `#782` |
| **G19** preview 字节预算与释放 | 同上 | 随 `#782` |
| **G20** 热重载真接上 | 实现属 `#784`(T4)，**尚未合并**。基线自陈「这条闸第一次跑起来就是红的」 | 随 `#784` |
| **G8①** 铸造期 `local:` 校验 | ⚠️ **实现与用例都已在册**（`claude-plugin-install.test.ts` 的「`local:` 命名空间是铸造期校验」），但**没有人实施过一次绕过** | 可立即补，不必等任何票 |
| **G12** 载荷读取硬化 | ⚠️ **实现与敌意夹具都已在册**（`claude-plugin-intake.test.ts` 的 G12 一节，9 条），但基线给的配方「把某一个文件的读改成 `fs.readFileSync`」**今天没人跑过**。T1 的 B11 实施的是 **AC9 零写盘**，与这条不是同一件事 | 可立即补，不必等任何票 |

**G8① 与 G12 是这份表里唯一「本可以验而没验」的两道。** 其余四道是票还没落地，不是漏做。

**③ 记录是恒真式的** —— 见下一节。这一类**不会**在总账里表现为红，它表现为「全绿」，
所以必须单独列。

## 二、真实语料半场是恒真式的七处

判据语料 = `~/.claude/plugins/marketplaces`（排除 `.bak`，基线 §3.1）。
下面每一条的**真实语料命中数都是 0**，即：拿真实语料跑这几条臂，期望值恒等于「全通过」，
**它给不出任何证据**。回归断言落在
`packages/ui-mac/test-component/claude-plugin-import-matrix.cases.ts` 的
`describe("恒真式登记:这些闸的真实语料半场**不提供任何证据**")` —— 那一节里
**每条断言的期望值都是 0**，它证明的不是闸门有效，恰恰相反。

| # | 闸/臂 | 真实语料命中 | 基线有没有点名 | 真证据在哪 |
| --- | --- | --- | --- | --- |
| ① | **G11** 65 项超限 | **0**（最大 13，界 64 ⇒ 结构上撞不上） | ✅ §12 风险 6 | 合成 65/66/200 项夹具（`claude-plugin-intake.test.ts` G11 表驱动） |
| ② | **G16** symlink 臂 | **0**（marketplaces 与 cache 全域 0 例） | ✅ §12 风险 6 | 合成 symlink 夹具 ×3（目录/SKILL.md/逃逸） |
| ③ | **G18 ⑤** 根级 `SKILL.md` | **0** | ✅ §12 风险 6 | 合成 `plugin-root-is-skill` 夹具 |
| ④ | **G18 ③** `workflow-skills/` | **0** | ❌ **基线未点名** —— §3.2 记了 4 个实例，但那 4 个**全在 `cache` 里**，而 §3.1 已把 cache 排除出判据语料 | 合成 `non-standard-skill-dir` 夹具 |
| ⑤ | **G18 ⑥** `plugin.json.skills` 字段 | **0**（基线自测 183 份 manifest 里 0 次） | ❌ 基线说了「0 例」，但没登记为恒真臂 | 合成 `manifest-declared-skills-field` 夹具 |
| ⑥ | **G16** R2-a 被排除目录臂 | **0**（基线 §14 自测 0 命中） | ❌ 同上 | 合成 `node_modules`/`.git`/`__pycache__` 夹具 ×3 |
| ⑦ | **G17** 块式控制字段 | **不是 0 命中，是「区分不了」** | ❌ **基线 §14 R2-b 的绕过配方在真实语料上不成立** | 合成「唯一控制字段是块式」的夹具 |

**⑦ 单独说，因为它是另一种形态。** 基线 §14 R2-b 写「把检测口径改回要求有标量值 ⇒ 块式那一半必须变红」。
T1 实测：真实语料里 7 份块式 `allowed-tools:` 的文件**全部同时**带一个标量控制字段
（`user-invocable:` / `disable-model-invocation:`）⇒ 技能级拒绝集在**两种口径下都是 12**。
也就是说这条闸的真实语料半场**不是 0 例，而是有例却区分不出来** —— 更容易被读成「验过了」。
真正杀掉它的只有**唯一控制字段是块式**那份合成夹具。

**基线 §12 风险 6 记的是「三处」，实测是七处。** 多出来的四处（④⑤⑥⑦）各自在基线别的段落里
都写过「本机 0 例」或等价的话，但都没有进那份风险清单 —— 于是它们会以「真实语料全过」的样子
被下一轮 review 读成已验证。

## 三、本票新做的三条绕过（A/B/C）

工作树干净 ⇒ 改坏一处生产代码 ⇒ 跑整个用例文件 ⇒ `git checkout -- <那一个文件>` 还原。
基线未变异：`13 pass / 0 fail`（`Ran 13 tests across 1 file`）。

| # | 改坏了什么 | 结果 |
| --- | --- | --- |
| **A** | `intakeImportDir` 加 `if (path.basename(real).endsWith(".bak")) return { route: "single-skill" }` | **2 fail** |
| **B** | 删掉 `not-self-contained-executable-bit` 那一臂 | **3 fail** |
| **C** | 删掉 `dot-claude-skills-dir` 的具名（`.claude/skills` 臂） | **1 fail** |

### A —— `.bak` 这条闸差点被我自己写成假闸

第一版的 `.bak` 回归用的是 `previewLocalClaudePlugin`（内层），而最像样的绕过落在**分流层**
`intakeImportDir`。于是第一次实验里那条用例**照样绿**，只有 marketplace 根那条变红：

```
Expected: "local-claude-plugin"
Received: "single-skill"
(fail) AC7 `.bak` 目录与普通目录**逐字段同待** > `.bak` 的 marketplace 根与非 `.bak` 兄弟拿到**同一个**具名布局码
```

改成走生产入口 `intakeImportDir` 之后重跑同一个变异，两条一起红。
**教训与本仓「假闸形态⑧」同源**：断言内层函数名字盲 ≠ 断言用户选到 `.bak` 时行为不变。
这条写在这里，是因为它正是「绕过实验的价值不在证明闸有效，而在暴露闸的射程」。

### B —— 计数断言杀不掉的，成员集杀得掉

删掉可执行位那一臂之后，三条同时红 —— 而其中两条是**成员集**断言：

```
(fail) 可装 132 —— 分母是 159 份**支持布局**的 SKILL.md,不是 162
(fail) 10 个插件一个技能都装不上(intake 口径,分母 37)—— 逐个点名
(fail) 18 个技能因不自包含被拒 —— 逐个点名(只断言 18 杀不掉换成员的改动)
```

### C —— 与 T1 的合成夹具重叠，价值在别处

同一个变异下 T1 的合成用例（`② .claude/skills/<n>/SKILL.md`）**也会红**
（实测 `50 pass / 1 fail`）。所以本票这条**对这个变异是冗余的**，如实记下。
它不冗余的地方只有一处：它断言的是**真实实例数 `toBe(1)` 与真实的 `at` 路径**，
于是「语料夹具被从另一台机器重新生成、真实实例没了」会变红，而合成用例看不见这件事。

## 四、本表没有覆盖的事

- **打包真机 L2**（装 `tide-plugin` → 显示未启用 → 用户拨开关 → 下一条消息里技能真被引擎注入
  → 整包卸载 → 无残留）**本轮未做**：它要等 renderer 半场 `#784`。`#783` 因此保持 OPEN。
- **G13 的「事务函数零调用」**在 T2 那边用的是「零 journal 目录」这个可观察产物，不是 spy 计数
  （T2 doc 已自陈）。本表照抄该口径，不改判。
- 本表只记**绕过是否实施过**，不重判各闸的设计是否正确。设计判据在基线 §6。
