---
type: design
slug: req131-settings-tool-policy
date: 2026-08-25
status: approved
relates:
  - jinjunnn/alpha-code#723(REQ-131)
  - jinjunnn/alpha-code#724(CLOSE_DECIDE 基线 §8/§9.3)
  - jinjunnn/alpha-code#1130(本增量的实现票)
  - jinjunnn/alpha-code#1128(已落地的三态 resolver / selector / 持久化)
  - jinjunnn/alpha-code#1129(目录与执行咽喉 + inventory API,已合)
---

# 设置「工具」节 —— 按来源服务编辑工具三态

> 帧见同目录 [`frame.html`](frame.html)(六个状态 + 浅/深色切换)。本文记数据
> 映射、交互规范与刻意不画的部分。批准后,帧并入
> [`current/settings/design.html`](../current/settings/design.html) 的 `#set-tools`
> 锚,台账见 [`current/settings/components.md`](../current/settings/components.md)。

## 1. 与上一稿的关系

**继承**:

- Settings 整页结构照旧 —— 全屏 overlay、左侧类别导航、右侧 pane,来自
  [`2026-07-20-req090-alpha-surfaces/`](../2026-07-20-req090-alpha-surfaces/design.html)
  的 Settings 帧与现役实现(`packages/ui-mac/src/renderer/alpha-ui/settings.tsx`,
  nav 今天是 通用 / 快捷键 / 扩展存储 三项)。本稿只在导航**追加第四项「工具」**,
  不动既有三个 pane。
- 行 / 分组 / 卡片、Banner 告警、加载 / 失败 / 重试的语汇沿用 req090 Settings 帧与
  现役 `settings.css`(`--a-*` token,浅深两色)。
- 「开发者详情默认折叠、正文只用展示名」沿用
  [`2026-08-08-req125-tool-card-provenance/`](../2026-08-08-req125-tool-card-provenance/design.md)
  的裁决(owner 2026-08-09 批准的 Q3)。

**新增**:「工具」pane 本体 —— 四来源分组、服务展开到工具、三态控件、继承与
生效原因的行内呈现、绑定变更 / 损坏恢复 / 逐条写入失败四个异常态。

**为什么**:#724 CLOSE_DECIDE §8 定下 Settings 终局形态(同一 live inventory 分四组、
行内呈现默认 / 继承 / override / effective / 原因、broad scope 提示、新发现与 rebind
醒目、a11y 与保存失败自验)。数据层(#1128)已落地,本稿是它的第一张用户界面。

**已知漂移,本稿不顺手修**:`current/settings/design.html` 的设置节仍是
hub-settings 时代的「仅 通用 + 快捷键」两项;现役实现已有第三项「扩展存储」
(req090),活稿未回填。本稿不重画整页,只出「工具」增量;该漂移记在台账里。

## 2. 勘破实录(动笔前)

- **今天长什么样**:`settings.tsx`(717 行)—— 全屏 `role="dialog"` overlay,
  68px 头部(返回 + 标题 + 未保存徽标),220px 左导航,右侧 pane =
  section-head(h2 + 说明 + 主按钮)+ 若干 group 卡片 + ToggleRow。通用 / 快捷键
  走「草稿 + revision 保存」模型,失败 Banner + 焦点接管;扩展存储走「检查 → 回收」
  即时操作模型。
- **数据真形状**(已落地,#1128 / PR #1131):
  - `packages/schema/src/alpha-tool-policy.ts` —— 三态 `enabled|ask|disabled`;
    四类 `builtin|alpha-cloud|third-party-mcp|plugin`(`host`/`builtin-v2` 归
    builtin);结构化 selector `class|service|tool`;`ToolPolicyRecord`
    (service/tool 层 enabled 必须携带 bindingDigest,class 层必须不带);
    `ToolPolicyDocumentV1` 按 `(account, workspace)` 分区。
  - `packages/opencode/src/permission/alpha-tool-policy.ts` ——
    `EffectiveToolPolicy { state, action, reason }`,reason 是 9 型 union(见 §3 表);
    API:`resolve / inspect / setRecord / removeRecord / reset`(reset 产备份)。
- **该组件有没有帧和锚**:没有。settings 页此前无 `components.md` 台账,活稿内
  无工具相关帧。本稿新起锚 `#set-tools`,台账随本稿新建。

## 3. 数据映射 —— 帧里每个元素从哪来

| 帧元素 | 来源 | 状态 |
| --- | --- | --- |
| 四个分组 | `classifyTool()` → `ToolClass` | 已落地 |
| 服务行(名称 / 展开) | `ToolIdentity.origin`(MCP 配置键 / plugin 来源),仅展示 | 已落地 |
| 工具行名称 | `ToolIdentity.name`(被动转义展示;专名映射归 REQ-125 展示规则) | 已落地 |
| 三态控件写入 | `setRecord({selector, state, bindingDigest?})` | 已落地 |
| 「恢复继承」↺ | `removeRecord(selector)` | 已落地 |
| 「生效:…」行 + 徽标 | `EffectiveToolPolicy.state` + `reason` 9 型逐型映射文案(下表) | 已落地 |
| 「继承:默认 / 你的设置(层级)」 | `reason.kind = "default"(class)` / `"user"(level)` | 已落地 |
| 锁定行(不可更改) | `reason.kind = cap-managed / cap-entitlement / cap-hard-deny` | 已落地 |
| 「服务已变更」徽标 + 重新启用 | `reason.kind = "binding-changed"`;重新启用 = 以当前 digest 重写 enabled 记录 | 已落地 |
| 损坏恢复横幅 + 重置 | user layer `quarantined` + `reset()`(返回备份路径) | 已落地 |
| 逐条保存失败 | `ToolPolicyWriteError`(含 quarantine 拒写) | 已落地 |
| 「仅当前账户与当前项目」 | `inspect().partition` | 已落地 |
| 每类 / 每服务条数、工具清单本身 | live inventory(§5:identity + 可信 authority + 继承 + effective + binding change) | 已落地(#1129 已合,PR #1135) |
| 「新发现」徽标 | 同上(§3:无 broad override 的新动态工具标「新发现」) | 已落地(#1129 已合,PR #1135) |
| 「计费:按用量 / 未知」 | `ToolBillingFact { class, evidenceId }`(宿主 / 服务端可信事实;缺失显示「未知」) | schema 已落地;供给随 inventory |
| 「1 项注册身份无法核验」 | resolver `invalid-identity`;条目枚举依赖 inventory 是否暴露此类注册 | 已落地;Q1 已裁 = 暴露计数(见 §8) |
| 「已核验」徽标(Alpha Cloud 组) | `ToolAuthority.kind = "alpha-cloud"`(verified) | 已落地 |

reason → 文案(全部 9 型,一型不落):

| `EffectiveToolPolicyReason` | 行内文案 | 可编辑 |
| --- | --- | --- |
| `default` + class=builtin | 默认,本地工具无需单独批准 | 是 |
| `default` + 其余类 | 默认,首次使用前询问 | 是 |
| `user` level=class/service/tool | 你的设置,整类 / 此服务 / 仅此工具 | 是 |
| `binding-changed` | 服务配置已变更,你之前的「启用」不再沿用 | 是(重新启用) |
| `cap-managed` | 由设备管理策略停用,本机不可更改 | 否(锁) |
| `cap-managed-unreadable` | 管理策略暂时读不到,已全部停用(整节横幅,同损坏态形制) | 否 |
| `cap-entitlement` deny/missing | 当前套餐不含此服务 | 否(锁) |
| `cap-hard-deny` | 已被全局安全开关关闭 | 否(锁) |
| `quarantine` | 设置文件待恢复(整节横幅 + 重置) | 否 |
| `invalid-identity` | 身份无法核验,已自动停用 | 否 |

## 4. 交互规范

- **逐条即写,无草稿 / 无整页保存键**。策略记录彼此独立,API 是逐条
  `setRecord/removeRecord`;与「通用」pane 的草稿 + revision 模型刻意不同。写失败
  ⇒ 该行回退到权威值 + `role=alert` 行内告警 + 重试(帧「保存失败」态)。
- **收紧畅通,放宽有闸**:选 询问 / 停用 一点即存;在 class / service 层选 启用
  弹行内确认(「现有与以后新增的全部工具都将不再询问」),这是 §3「broad intent
  必须明示未来成员」的落点 —— 静态小字易被略过,确认条不会。tool 层启用不弹条,
  但 service/tool 层的启用写入**必须**携带 inventory 给出的当前 bindingDigest
  (schema 强制;class 层启用必须不带)。
- **控件表达三件不同的事**:三态 radiogroup 是「用户 override」(无记录 = 无选中);
  「生效」徽标是 resolver 终值;「生效:…」小字是原因。三者可以不一致
  (record=enabled 而 binding 变了 ⇒ 徽标是每次询问),这正是要让用户看见的。
- **cap 永远压住用户层**:锁定行显示原因但不可点;quarantine / managed-unreadable
  是整节横幅 + 全部行只读,「重置为安全默认」走 `reset()`(原文件保留备份,文案
  明说,不静默覆盖)。
- **两个窄例外不出现**:`host::StructuredOutput`(强制 enabled 的内部协议工具)与
  `_noop`(历史回放占位)不进本节 —— 帧外说明一;实现以窄测试锁死。
- **本节不承担调用判决展示**:工具卡(时间线)只呈现实际调用结果;本节只管
  长期策略。会话内 once/always 属 Permission 引擎,pane 脚注一句话说清边界。

## 5. 状态覆盖(六帧)

默认(四组 + 展开 + 继承/override/锁定混排) · 服务变更回询问 · 策略文件损坏
(全停 + 重置) · 逐条保存失败(回退 + 重试) · 加载中(骨架,aria-busy) ·
读取失败(fail-closed 文案:读不到清单不会放宽任何工具)。浅 / 深色由页顶开关
覆盖全部六态。

## 6. 刻意不画的部分

- **搜索 / 过滤、批量操作** —— 基线 §8 未要求;首版清单量级(几十项)分组折叠足够。
- **「重新导入」损坏文件** —— `reset()` 只支持重置 + 备份;备份的人工恢复是文件
  操作,不在 UI 造假入口。
- **managed 策略的查看器 / 编辑器** —— cap 只读,行内原因已尽 UI 之责。
- **会话内 once/always 的列表** —— 属 Permission 引擎会话态,不是持久策略;混排
  会让「这里改了 = 永久」的心智失真。
- **V2 引擎、工具卡样式、providers/models 面** —— 各归其票(§10 边界)。
- **主动没做**:未在真 App 里截「工具」节的运行图 —— 本节今天在产品里不存在;
  现状勘破以 `settings.tsx`/`settings.css` 全文与 req090 已批帧为据。

## 7. 待 owner 的两个小裁决(建议,不入 AC)

- **Q1 无法核验的注册要不要枚举**:帧内画了服务展开区末尾的一条只读提示
  (「N 项注册身份无法核验,已自动停用」)。它依赖 inventory 暴露 invalid 注册的
  计数;若 #1129 最终不暴露,该条自然缺席,其余不受影响。**推荐:暴露计数 +
  开发者详情内给原因**,让「工具消失了」可解释。
- **Q2 导航命名**:「工具」(推荐,与「扩展存储」同级简洁)vs「工具权限」。
  「权限」一词已被通知区的现有开关占用,复用易混。

## 8. 批准记录(2026-08-26)

**状态:approved。** 本稿即 `#1130` 的 UI 类 AC 验收基线,也是升 Ready 的门。

批准时的地面真相变化(与 §3 表同步):`#1128` 与 `#1129` **均已合并关闭**,
于是 §3 表里原标「契约,#1129 在途」的三行(live inventory、「新发现」徽标、
无法核验注册的枚举)**都已落地**,本稿不再有悬空依赖。

### §7 两个小裁决

- **Q1 无法核验的注册要不要枚举 —— 裁:按推荐做,暴露计数 + 开发者详情内给原因。**
  理由:两种失败里,「工具静默消失、用户无从解释」比「多一行只读提示」贵得多;
  本仓已经在别处付过「静默」的学费。计数放服务展开区末尾的只读提示,原因归开发者详情
  (沿用 REQ-125 「开发者详情默认折叠」的既有裁决),正文不因此变吵。
- **Q2 导航命名 —— 裁:用「工具」。** 理由如稿:「权限」已被通知区现有开关占用,
  复用会让「这里改了 = 永久」与「会话内 once/always」两种心智混在一起,
  而 §4 刚刚花力气把它们分开。

两条都属稿内既定范围,**不新增 AC**。

### 批准同时确认的边界(不是新要求,是复述本稿已写明的)

- 逐条即写、无整页保存键;写失败回退到权威值 + `role=alert` + 重试;
- class / service 层选「启用」必须弹行内确认(broad intent 明示未来成员);
  service/tool 层启用写入必须携带当前 `bindingDigest`,class 层必须不带;
- cap 永远压住用户层;quarantine / managed-unreadable 为整节横幅 + 全部行只读;
- `host::StructuredOutput` 与 `_noop` 不进本节,以窄测试锁死;
- 本节不承担调用判决展示。

### 落地要求(来自本稿 §引言,不是新增)

实现落地时把帧并入 [`current/settings/design.html`](../current/settings/design.html)
的 `#set-tools` 锚,并新建 [`current/settings/components.md`](../current/settings/components.md) 台账;
§1 记的那条已知漂移(活稿设置节仍是「仅 通用 + 快捷键」)**照旧不在本票修**,记进台账即可。
