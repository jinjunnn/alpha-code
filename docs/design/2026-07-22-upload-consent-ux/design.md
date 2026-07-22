---
type: design
slug: upload-consent-ux
date: 2026-07-22
status: draft(等 owner 评审;实现票见 alpha-code#225 / 父需求 alpha-work#10)
relates:
  - jinjunnn/alpha-code#225([Privacy] main-owned cloud upload manifest and consent token,UI 部分)
  - jinjunnn/alpha-work#10(父需求:上云隐私边界)
  - jinjunnn/alpha-platform#32(UploadManifestV1 + upload_consent 契约,已合并)
  - 2026-07-15-capability-authorize-dialog(视觉与「同意时刻」基线)
  - ADR-021(代码上云数据边界:diff-only + secrets 过滤 + 体积上限 + consent 挂钩)
---

# 上云发送同意框(upload consent)设计稿

> **与上一稿的关系** — 视觉基线 = `2026-07-15-capability-authorize-dialog`
> (status: accepted):同一 house `alpha-ui/Dialog`(`dialog.css`)+ `Button`
> (`button.css`)+ `--a-*` token 家族(`tokens.css`),**零改动**。宿主入口 =
> 现产品 `cloud-dispatch-box.tsx`「选择项目并派发」。**行为增量** = 把 ADR-021 §4
> 现落地的「每个项目**首次**云 dispatch 一律弹一次原生框」换成 **按内容条件触发**
> 的结构化同意框:**只有这次发送真的含受隐私保护信息(清单 `consent_required=true`)
> 才弹**;不含则静默直发、绝不打扰。本稿唯一新增 CSS 家族 = `.alpha-upl-*`
> (发送清单 / 隐私发现 / 用途·保留 / 撤回)。字段名与内部术语只在本文件,不进画面
> (设计宪法 §7,`docs/design/system/principles.md`)。

## 1. 背景与触发

`cloud-dispatch-box.tsx` 是 code-review pipeline 的 app-driven 派发入口:用户
「选择项目并派发」→ main 侧取 `git diff`(工作树优先,回退最近一次 commit)→
`window.api.cloud.dispatch(envelope, directory)` 出境
(`cloud-dispatch-box.tsx:55-74`)。ADR-021 §2 已在 main 单点做**技术边界**校验
(体积上限 / secrets 扫描 / `denied_paths` 默认注入,`cloud-envelope-guard.ts`),
§4 已落一个**每项目首次一律弹**的原生 consent(`alpha-cloud-consent.ts` +
`.alpha/prefs.json`)。但那道 consent 是 **blunt**:与这次上传**是否真含隐私信息
无关**,只认「这个项目第一次发没发过」——既会对纯代码的首发无谓打扰,又无法针对
「这次恰好带了 PII」提高告知。

alpha-platform#32 合入的 **`UploadManifestV1`** 补上了缺的那一维:main 在发送前为
本次上传生成一份清单,绑定 `tenant / path scope / size / sha256 / purpose /
retention_class / consent_required`,并由 `upload_consent`(iss=alpha-web)令牌绑定
`manifest_sha256`。**`consent_required` 就是本框的开关**:它由 main 侧对清单内容做
隐私分类得出,renderer/agent 既读不到也改不动。本稿定义 `consent_required=true`
时那一刻的**同意 UI**;main 侧清单生成、分类、令牌绑定按票面独立推进。

## 2. 事实基线(file:line 证据)

| # | 事实 | 锚点 |
|---|------|------|
| F1 | 派发入口:用户选目录 → main 取 `git diff` → `cloud.dispatch(envelope, directory)` 出境 | `cloud-dispatch-box.tsx:51-93` |
| F2 | 已有 `consent-declined` 出口(用户拒绝 → 中止派发,人话行内) | `cloud-dispatch-box.tsx:20`、`i18n/zh.ts:533`(`alpha.ext.cloudErrConsentDeclined`) |
| F3 | 失败一律**行内**(B11),不弹框;成功=inline done | `cloud-dispatch-box.tsx:127-140`(`.alpha-ext-card-err` / `data-ok`) |
| F4 | ADR-021 §4 现状:consent 挂在「首次 dispatch(per 项目)」,与内容无关 | `.claude/rules/adrs/ADR-021-cloud-data-boundary.md:23-26` |
| F5 | ADR-021 §2:main 单点前置硬校验(1MB 上限 / secrets 扫描 / `denied_paths` 默认注入) | 同上 :18-21;`cloud-envelope-guard.ts` |
| F6 | main 是授权/同意语义唯一真源;renderer 只发可序列化 DTO,运行时校验恒在 main | `ext-capability-authorization.ts:1-5,48-53` |
| F7 | `decidedAt` 等审计事实由 main 收到确认后打戳,renderer 无通道提供 | `ext-capability-authorization.ts:50-53` |
| F8 | house 同意框先例:`Dialog`(default 560 / `sm` 420)+ ghost 取消 + primary 确认;能力行/风险行 token 化 | `alpha-ui/dialog.css:1-46`、`ext-authz.tsx`、`2026-07-15-capability-authorize-dialog/` |
| F9 | 反馈层级:成功=toast、失败=inline、取消=静默 | v3-universal §5.6;本稿沿用 |
| F10 | 契约:`UploadManifestV1` 绑定 tenant/path scope/size/sha256/purpose/`retention_class`/`consent_required`;`upload_consent`(iss=alpha-web)绑 `manifest_sha256` | alpha-platform#32(merged) |

## 3. 核心产品规则(owner 决策,驱动一切)

**同意框仅在这次上传真正含受法律保护的隐私信息(清单 `consent_required=true`)时
出现。** 不含隐私信息的上传**永不弹框**——不打扰用户。这条规则把「合规义务」与
「界面摩擦」对齐:有法律告知义务 → 问一次;没有 → 静默直发。

### 3.1 决策表 —— 何时弹框 / 何时静默

| 这次上传的情况 | 清单 `consent_required` | 界面行为 | 状态 | 为什么 |
|---|---|---|---|---|
| 含受法律保护的隐私信息(PII / 凭据样式 / 受监管数据) | `true` | **弹同意框**:清单 + 用途 + 保留 + 撤回,等显式同意后才发送 | 情形A · sensitive-upload | 只在有法律告知义务时打断 |
| 仅普通代码/文本,未发现受保护信息 | `false` | **不弹框**,静默直发 + 一行**非阻断**透明告知 | 情形B · non-sensitive-silent | 无隐私风险不制造确认摩擦 |
| 分类不确定 / 分类器异常 / 清单不可读 | **fail-closed ⇒ 视为 `true`** | 按含隐私处理:弹框(宁可多问一次,绝不静默出境) | 情形A(fail-closed 分支) | 分类失败不得成为静默放行 |
| 无法确定发送范围(缺目录 / 读不到 / 范围空) | 清单建不出 | **不发送**,内联失败;**绝不**回退成整库上传 | 情形D · error(scope) | 缺范围 = 取消,不是「发全部」 |
| `consent_required=true` 但用户在框内取消 | `true`,未同意 | **零副作用**静默关闭,不发送、不签令牌、无云端记录 | 情形C · cancelled | 同意是发送前置;未同意 = 不发 |
| 用户已同意,但 main 绑定清单/令牌签发失败 | `true`,已同意 | 内联失败关闭,**不发送**;可重试 | 情形D · error(token) | 同意 ≠ 发送;须 main 绑定指纹 + 取令牌成功 |

**读法**:开关是 `consent_required`,不是「项目是否首发」(淘汰 F4 的 blunt 触发)。
两个「失败」行是同一 fail-closed 家族——**任何不确定都收敛到「不发送」而非「发更多」**。

### 3.2 敏感度分类 → 画面呈现(人话,画面内不出现字段名)

| 清单内部(仅本文件出现) | 画面文案(情形A 的隐私发现横幅) |
|---|---|
| PII: email / phone | 「N 个文件含疑似邮箱与电话号码」 |
| PII: identity(身份证/护照样式) | 「N 个文件含疑似个人身份信息」 |
| secret-like credential | 「N 个文件含疑似凭据样式字符串」 |
| regulated(健康/金融等,若分类支持) | 「N 个文件含受监管的敏感信息」 |
| `retention_class` / `purpose` / `consent_required` | 分别渲染为「保留」「用途」两行人话,及是否弹框的开关——**枚举码本身永不上屏** |

未知/新增分类(前向兼容):归入「含受保护信息」通用措辞,**从不静默降级为不弹**。

## 4. 主进程权威 · 信任模型(trust model)

- **main 是唯一权威(F6/F7/F10)**。清单在 main 生成、隐私分类在 main 判定、
  `consent_required` 在 main 决定、`upload_consent` 令牌由 **alpha-web** 签发并绑定
  `manifest_sha256`。renderer/agent 只能表达一件事:「我对**画面上这份清单**点了同意」。
- **展示什么同意什么(反 TOCTOU / 反越权)**。同意绑定的是清单指纹;renderer
  **不能预先替用户勾同意**,也**不能在同意后把范围偷偷放大**——放大后指纹变化,
  令牌不再匹配,main 侧拒发。画面用一句人话承载这条契约:「**同意仅对上面列出的
  内容有效**」(对应 authz 稿「确认即授权上述完整能力集」的同源克制)。
- **agent 输入不能伪造或拓宽同意**(AC)。agent 只能请求「发送范围 X」;是否含隐私、
  是否需同意、令牌是否签发,全在 main/alpha-web,agent 无通道注入 `consent_required=false`
  或跳过弹框。
- **缺目录绝不隐式扩为整库同意**(AC,§3.1 的 scope 失败行)。范围无法确定时 main
  不构造清单、不发送;绝不回退成「那就发整个项目」。这是安全红线,归到情形D 的
  内联失败,而非静默继续。

## 5. 状态与交互(四态 + preview)

```
[情形A sensitive]  派发 → main 建清单 → 分类=需同意 → 弹同意框(清单/发现/用途/保留/撤回)
                    → 「同意并发送」→ 按钮 loading(main 绑定清单 + 取 upload_consent 令牌 + 发送)
                    → 关框 + 成功 toast
[情形B silent]     派发 → main 建清单 → 分类=无需同意 → 不弹框,直接发送
                    → 派发区一行非阻断「隐私检查已通过 · 未发现受保护信息」+ 进度
[情形C cancelled]  情形A 里 取消/Esc/点背景/关闭 → 静默关框,零副作用(不发/不签/无记录)
                    → 派发区回原状,可再次派发
[情形D error]      范围建不出 或 同意后令牌/绑定失败 → 内联失败(B11),不发送,fail-closed
                    → 「重试」重走 清单→分类→(如仍含隐私)同意框
[preview]          情形A 默认给摘要(N 文件 / 总大小 / 有界范围);「查看清单」就地展开
                    逐文件路径+大小,含隐私文件带「含隐私信息」chip——同意前看清每个将出境的文件
```

- **preview / cancellation** 是本框对「知情同意」的两根支柱:preview 让「同意什么」
  可核实到单文件;cancellation 保证「不同意」零成本、零痕迹。二者都在 main 发送**之前**。
- 计时:清单+分类在本地评估、发送前返回,派发到弹框应 <1s;同意后 loading 期 =
  真正的 main 绑定+取令牌+首包。
- `prefers-reduced-motion` → 所有入场动画归 0(设计宪法 §8,mock 已含 media query)。

## 6. 设计决策

- **D1 宿主复用,不造新框**。同意视图是 house `Dialog` 的一个 body 组件
  (`.alpha-upl`),尺寸取 default(560px)以容纳清单+用途+保留(比 authz 的 `sm`
  内容更长)。**刻意不用原生对话框**(现 ADR-021 §4 用的是原生框):同意是发送
  事务里一个可重驱阶段,需渲染结构化清单+可展开 preview,原生框做不到。
- **D2 条件触发是唯一存在理由(§3)**。`consent_required` 决定弹不弹;分类不确定
  fail-closed 到弹。淘汰「每项目首发一律弹」的 blunt 触发。
- **D3 隐私发现横幅置顶**。含隐私才有此框,所以「为什么打扰你」必须是最先读到的
  东西:warning-subtle(house 克制色阶)+ 人话类别 + 计数,**不显字段名/正则/枚举码**。
- **D4 范围有界、可核实**。范围行明确「只发这些、其余不发」+ 文件/大小计数;
  preview 展开到单文件。缺范围 → 情形D,绝不扩权。
- **D5 用途 + 保留 = 同意实质**。两行人话讲清「发去做什么、留多久、谁能删」;
  `purpose`/`retention_class` 枚举翻译成句子,不上屏。
- **D6 撤回常驻**。底部一句「设置 › 隐私 › 云端数据」入口,事后可撤回同意并请求
  删除已发送内容——同意不是一锤子买卖。
- **D7 反馈层级沿用 house(F9)**:成功=toast、失败=inline(B11,不因失败弹框)、
  取消=静默中性态(不是红色错误)。
- **D8 令牌绑定失败 = fail-closed**。同意本身不发送任何东西;必须 main 绑定清单
  指纹并取得 `upload_consent` 才有字节出境。签发不通即在此关闭,不带未验证同意继续。

## 7. 视觉规范(全 token 复用)

- Dialog:`.a-dialog-*` 原样(default 560px、`--a-surface-raised` +
  `--a-shadow-overlay` + `--a-edge-light`);header 加一个 accent-subtle 圆角图标位
  (`.a-dialog-hicon`,仍纯 token,与既有 header 结构兼容)。
- 新增 CSS 类(均只消费 `--a-*`):
  `.alpha-upl`(body 容器)、`.alpha-upl-flag`(隐私发现横幅,warning-subtle)、
  `.alpha-upl-scope`(有界范围条,bg-subtle + 计数 chip)、
  `.alpha-upl-box` / `.alpha-upl-file`(发送清单,含隐私文件 `data-flag` + chip)、
  `.alpha-upl-more`(preview 展开/收起)、`.alpha-upl-meta` / `.alpha-upl-mrow`
  (用途·保留)、`.alpha-upl-withdraw`(撤回)、`.alpha-upl-note`(同意契约句)、
  `.alpha-upl-fail`(同意后 fail-closed 内联)。
- 图标:16 viewbox / 1.5 stroke 线性 SVG(与 alpha-ui 同规格)。
- 光暗双主(设计宪法 §3):mock 用 `data-theme` 切换验证;产品运行时键控
  `document.documentElement.dataset.colorScheme`(见 `tokens.md` Theming)。

## 8. 文案与 i18n(建议 keys,`alpha.cloud.consent.*` —— 仅本文件出现)

| key | zh(画面文案) |
|---|---|
| `title` | 发送到 Alpha 云前,请确认 |
| `subReview` | {pipeline} · 本次发送 |
| `introSensitive` | 「{name}」需要把你所选项目的本次改动发送到 Alpha 云执行。系统在其中发现了受隐私保护的信息,发送前需要你确认。 |
| `flagTitle` | 这次发送包含受隐私保护的信息 |
| `findEmailPhone` | {n} 个文件含疑似邮箱与电话号码 |
| `findIdentity` | {n} 个文件含疑似个人身份信息 |
| `findCredential` | {n} 个文件含疑似凭据样式字符串 |
| `scopeDiff` | 仅本次改动(未提交的工作树 diff) |
| `scopeHint` | 整个项目的其余文件不会被发送 |
| `scopeCount` | {n} 个文件 · {size} |
| `preview` / `previewCollapse` | 查看清单 / 收起清单 |
| `fileFlag` | 含隐私信息 |
| `purposeLabel` / `retentionLabel` | 用途 / 保留 |
| `purposeReview` | 代码审查 —— 分析这次改动并给出结构化意见。仅用于本次任务,不用于训练。 |
| `retention` | 任务完成后自动删除,最长保留 {days} 天。你可随时提前删除。 |
| `withdraw` | 随时可撤回:设置 › 隐私 › 云端数据 撤回同意并请求删除已发送内容。 |
| `coversNote` | 同意仅对上面列出的内容有效。取消不会发送任何内容,也不会留下云端记录。 |
| `cta` / `cancel` | 同意并发送 / 取消 |
| `silentPass` | 隐私检查已通过 · 未发现受保护信息,已直接发送 |
| `errScope` | 无法安全发送 —— 无法确定要发送的范围(所选目录读不到),已取消本次发送。 |
| `errToken` | 无法完成安全发送 —— 为这次发送准备安全凭据时失败。没有任何字节离开本机;修复后可重试。 |
| `toastSent` | 已发送 · 云端审查进行中 |

取消/失败复用既有 `alpha.ext.cloudErrConsentDeclined` 的语义(F2),但呈现为
中性「已取消」而非红色错误。

## 9. 范围外与开放问题

- 范围外:清单生成 / 隐私分类器 / `upload_consent` 令牌签发(main + alpha-web,#225
  后端);隐式通道(platform-pays 每 prompt 出境)仍按 ADR-021 §3 定位为「告知不过滤」,
  不在本框;逐文件勾选剔除(违背「整份清单一次同意」,且部分剔除会改指纹——若需要
  另开窄票议)。
- Q1 「记住本项目的选择」?**默认不记**——`consent_required` 是 per-upload 内容判定,
  记忆会把 blunt 触发从后门放回来。若 owner 要「同一清单指纹 N 分钟内免再问」,需
  main 侧对指纹做短时缓存,建议另议。
- Q2 静默态(情形B)那行「隐私检查已通过」是否要**可关**?稿采用**常显但非阻断**
  (透明优先);若嫌噪,可降级为仅首次显示。
- Q3 保留期与用途来自清单 `retention_class` / `purpose` 枚举 → 句子的映射表由谁拥有
  (main 还是 i18n)?建议同 authz 的能力词汇表:枚举在 shared,句子在 i18n。
- Q4 PAGE-MAP.md 新行(「Upload consent / 上云同意」surface)在本稿获批后补,
  避免未批先入索引(遵 `docs/design/README.md` workflow)。
