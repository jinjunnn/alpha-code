---
title: C21 Alpha UI a11y readiness baseline
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-25
review_after: 2027-01-16
---

# C21 — Alpha UI 无障碍就绪基线 (behavior + contrast audit)

This is an **audit-and-remediate-gaps** baseline, not a new visual mock. The
C21 AC was written as "补全" (fill the gap); the incumbent has since shipped
most of the surface via closed `#183` (REQ-090). This doc records what is
already live so we do **not** re-implement it, computes the two contrast tokens
against real backgrounds, and scopes only the genuine remaining gaps.

Design authority: [`docs/design/system/principles.md`](../system/principles.md)
(cool graphite/porcelain, single indigo accent, tokens-only `--a-*`, light+dark
both first-class, "accessible by construction", body text ≥4.5:1, non-text ≥3:1).

## 与上一稿的关系 — rev2 (2026-07-25)

rev1 (2026-07-22) 成稿于 REQ-125 之前,两处前提已经变了,不修订就会指挥错方向:

1. **AC4 已交付,不再是 GAP。** `#478`/PR#518 落地了 §3.D 的候选 ②(1.5px 细实色
   accent 描边)与两个 tertiary 值;rev1 的 §1/§3.D 还写着 FAIL。rev2 把它改成
   landed,并把「一次性取证脚本」升成常驻闸门(见 §3.D)。
2. **session / timeline / composer 已经是 alpha 自持的,不再是「上游只记录不修」。**
   REQ-125 把这三族收进 `renderer/alpha-ui/`,rev1 的 primitive 清单里没有它们,
   于是 C21 曾以为自己只剩两个 token 要改 —— 实际上新收编的面板里带着三处
   「声明了复合 role 却没兑现键盘契约」的实缺(§1 新增三行,§3 新增不变量 F)。

其余结论(Dialog/picker/menu/autocomplete/Toast/reduced-motion 已满足、不引外部
a11y 库、不给 model picker 加 arrow-roving)rev1 判对了,原样保留;行锚点按当前树
重新校准。

**rev2 第一轮实现被跨模型对抗审计判回,四处结论因此改写**(改的是本稿的技术判断,
不是它的方向):

1. **键位表按 role 分,不是一张通吃表。** 第一轮把 ←→↑↓ + Home/End 合成一张表发给
   所有复合控件。W3C 的 Tabs 与 Radio Group 不是同一张表:横向 tablist 不监听 ↑↓
   (那属于 `aria-orientation="vertical"`,吞掉就是抢页面滚动),Radio Group 里没有
   Home/End(「移动即选中」下,一个未定义的键会改掉用户已给的答案)。本仓四条页签条
   都是横排 flex,所以 rev2 的 §3.F 写的是「统一键表」而不是「统一到四个方向键」。
   同一处还漏了两类必须放行的输入:带修饰键的组合(macOS 的 VoiceOver 光标就是
   Ctrl+Option+方向键)和 IME 组字中的按键。
2. **文件面板的降级形态改了,裁决没改。** owner 裁决仍是「降级为 list 语义、不写键盘
   代码」。但 `role="listitem"` 不能盖在 `<button>` 上 —— ARIA in HTML 允许 button
   覆盖的 role 里没有 listitem,而且 listitem 不支持 `aria-expanded`,盖上去会同时
   丢掉「这是个按钮」和「目录是否展开」两条播报。rev2 的形态是外包一层
   `<div role="listitem">`,目录的子 `role="list"` 落在该 listitem 内。
3. **AC4 的闸门在第一轮是 fail-open,而且漏了一个真实存在的背景。** 详见 §3.D。
4. **类边界闸门按文件认领是不够的。** 详见 §3.F。

---

## §1 只读勘破 — live-code audit (per primitive CLASS)

Cited from the running tree (alpha `bbef61e6e`). Each row: current state →
file:line → verdict. `#183`-delivered surfaces are recorded once here and are
**out of re-audit scope** (boundary line, see §3).

| Primitive CLASS | Current live state | Evidence (file:line) | Verdict |
| --- | --- | --- | --- |
| **Dialog (modal)** | initial focus (autofocus→panel), Tab focus-trap via start/end guards, return-focus to trigger on close, Escape (IME-guarded) closes if dismissable, `role=dialog`+`aria-modal`+`aria-labelledby`+`aria-describedby`, sibling `inert`+`aria-hidden` | `dialog-core.ts:31` (createDialogFocusManager), `:79` (registerDialog), `:146` (Escape), `:189-220` (inert layers); `Dialog.tsx:84-88` | **SATISFIED (#183)** |
| **picker (model)** | `role=dialog`+`aria-label` on container, search `<input>` `aria-label` + initial focus, rows are native `<button>` (Tab-operable) with per-row `aria-label`+`aria-current`, Escape+return-focus+initial-focus inherited from `ChipPopover` wrapper | `alpha-composer-model.tsx:413` (role+label), `:418` (search label), `:293` (initial focus), `:634-638` (row `aria-current`/`aria-label`); wrapper `alpha-composer.tsx:127-160` | **SATISFIED** (name/state/keyboard correct; no L1 assertion yet → §4 VERIFY) |
| **menu (chip/sidebar)** | ChipPopover `role=menu` + `role=menuitemradio`+`aria-checked`, Escape closes + returns focus to anchor; sidebar menus: `focusFirstMenuItem`, `dismissMenu`, `dismissMenuOnEscape` helpers | `alpha-composer.tsx:274`(`aria-expanded`)、`:289`(`role=menu`)、`:294,303,312`(`menuitemradio`)、`:140-151`(initial focus + return focus);`sidebar/menu-a11y.ts:1-17`(+ `menu-a11y.test.ts`) | **SATISFIED** |
| **autocomplete (slash / combobox)** | `role=combobox` on textarea, `aria-expanded`, `aria-controls`→`role=listbox`, `role=option`+`aria-selected`, `aria-activedescendant` tracks Arrow keys, Escape collapses | `composer-a11y.test.ts:130-169` (passing); runtime `composer-a11y-test-runtime.tsx` | **SATISFIED (tested)** |
| **composer controls (PermChip)** | trigger `aria-expanded`, focus moves into popover, Escape closes + return-focus, `role=menu`/`menuitemradio`/`aria-checked` | `composer-a11y.test.ts:88-109` (passing) | **SATISFIED (tested)** |
| **Toast** | `role=status`+`aria-live=polite`, decorative icon `aria-hidden`, close button `aria-label` | `Toast.tsx:35-43` | **SATISFIED** |
| **session-workspace (REQ-125)** | 右栏页签条 `role=tablist`/`tab`/`tabpanel` + 宽度把手 `role=separator`(带 `aria-valuemin/max/now` 与 ←→ 调宽);提问卡选项组 `role=radiogroup`/`radio`(多选时 `group`/`checkbox`);审批卡 `role=group`,失败态 `role=alert` | `session-workspace-shell.tsx:343`(separator)、`:353`(tablist)、`:358`(tab);`session-question-card.tsx:108`(radiogroup)、`:117`(radio;`#221` 从 dock 抽出为纯呈现层,以便真挂载测试驱动) | 名称/状态 **SATISFIED**;radiogroup 曾缺键盘契约 → **GAP,`#221` 已兑现**(§3.F) |
| **session-rail (REQ-125)** | 终端面板 `role=tablist`/`tab`/`tabpanel`;产物面板模式条 `role=tablist` + 卡片列表 `role=list`;文件面板行层曾声明 `role=tree`/`treeitem`(已按 owner 裁决降级为 `list`/`listitem`);评审面板 `role=group` | `terminal-rail-panel.tsx:131`(tablist)、`:143`(tab);`artifacts-panel-view.tsx:187`(tablist);`files-view.tsx:207`(容器 list)、`:88`(listitem 外包层) | 名称/状态 **SATISFIED**;终端 tablist 缺键盘契约、文件面板 role 过度声明 → **GAP,`#221` 已兑现**(§3.F) |
| **session-timeline (REQ-125)** | 消息流 `role=log`(流式追加走 live region)、状态条 `role=status`、工具卡片折叠用原生 `<button>`+`aria-expanded`、结果清单 `role=list`/`listitem`、失败态 `role=alert`;不声明任何复合漫游 role | `session-timeline-view.tsx`(log/status/aria-expanded);`cards/tool-cards.tsx`(list/listitem/alert) | **SATISFIED**(靠原生控件 + live region 自洽,无未兑现的 role 承诺) |
| **focus-ring token** | `--a-ring-focus` = `0 0 0 1.5px var(--a-accent)`(#478 选定的细实色描边),仅在 `.a-ui :focus-visible` 生效(不对鼠标点亮) | `tokens.css:141`; `base.css:45-47` | **SATISFIED (#478;ratchet 见 §3.D)** |
| **tertiary-text token** | `--a-text-tertiary` #64656d light(`#221` 为 `--a-bg-inset` 再压深一档)/ #86878f dark(含 OS-fallback 块);用于全仓 60+ 处信息性 meta,不是 placeholder-only | `tokens.css:29`(light)、`:190`(dark)、`:247`(OS-fallback) | **SATISFIED (#478 + #221;ratchet 见 §3.D)** |
| **reduced-motion** | `@media (prefers-reduced-motion: reduce)` collapses `--a-dur-*` to `0ms`; guarded by ratchet test | `tokens.css:275-281`; `reduced-motion-ratchet.test.ts` | **SATISFIED (tested)** |

**Net:** rev1 的两个 contrast GAP 已由 `#478` 关闭;rev2 把 REQ-125 收编的三族补进
清单后,真实剩余缺口从「两个 token」变成「三处未兑现的复合 role 键盘契约」(§3.F)。
Dialog / picker / menu / composer 名称与状态仍是 satisfied-by-audit,verify-only 关闭;
L2 打包版读屏走查仍未做。

**This baseline does not mint new children — the C21 child split already exists:**

- **`#441`/`#446`** — satisfied **AC1** (overlap counted once).
- **`#477` (CLOSED)** — `[C21][CODE]` composer/autocomplete/sidebar a11y +
  reduced-motion 封漏, landed **AC2/AC3/AC5** (its own read-only recon is the
  source this audit confirms; L1 behavior tests shipped with it).
- **`#478` (CLOSED, PR#518)** — `[C21][CODE]` AA 对比 token 修正,owns **AC4**。
  owner 设计门已过并选定 §3.D 候选 **②**(1.5px 细实色 accent 描边);tertiary 与
  ring 三个主题块一并落地。rev2 起 AC4 不再是 GAP,只剩「改回去会红」的闸门(§3.D)。
- **`#221` (this ticket)** — `[C21][CODE]` 兑现 §3.F 的键盘契约:抽出
  `roving-focus.ts` 收编重复实现、补终端 tablist 与提问卡 radiogroup、按 owner 裁决
  把文件面板降级为 `list`/`listitem`,并补 AC4 的对比度闸门与类边界闸门。

---

## §2 方案 — approach

**Single mechanism, gaps only.** The a11y invariant classes are each carried by
**one** landed authority — `dialog-core.ts` (focus/trap/return), `tokens.css`
(every color), `roving-focus.ts` (composite-role key table), and the
`composer-a11y-test-runtime` + `bun:test` harness (behavioral truth). Remediation
is always "route the offending surface to the existing authority", never "patch
this widget". Nothing new is built; no primitive is redrawn.

- **Authority question (the anti-无底洞 test):** can THIS system be the
  authority? Yes — the four authorities above are all in-repo. There is **no
  external system to stay point-by-point in sync with**. Good.
- **Why `roving-focus.ts` is an authority and not an abstraction:** the same
  ArrowLeft/ArrowRight/Home/End branch had already been hand-copied three times
  (rail tablist, rail artifacts mode strip, artifact workbench mode strip) — and
  the surfaces that skipped the copy are exactly the three §3.F defects. 收编成
  一处后,类边界闸门才有东西可指(§3.F 的 ratchet)。

**Rejected alternatives:**

1. **Per-widget a11y patching** (add trap/ARIA per component). Rejected —
   instance-vs-class anti-pattern (memory: `instance-vs-class-in-review`). The
   trap already exists once in `dialog-core`; contrast is one token edit, not N
   component edits.
2. **External focus-trap / aria-library** (focus-trap, @react-aria, etc.).
   Rejected — `dialog-core` already **is** the authority; importing a library
   would create exactly the "my design must stay in sync with an external
   system" 无底洞, plus it violates tokens-only + no-webfont/no-bundle register.
3. **Redraw the model-picker as `role=listbox` with roving tabindex.** Rejected
   — over-engineering. Native `<button>` rows are fully Tab-operable with correct
   names/state; the AC says "完整键盘操作", which Tab satisfies. Arrow-roving is a
   speculative enhancement, not an AC gap.

---

## §3 不变量枚举 — the 6 invariant CLASSES (boundary front-loaded)

Boundary line: `#183`-delivered Dialog surfaces + already-tested composer/menu
behaviors are counted **once** (§1) and are not re-audited here. Each class
lists the failure it forbids / who SATISFIES vs GAP / numeric acceptance.

### A. focus-management
- **Forbids:** focus escaping a modal; focus lost on close; focus stranded on an
  inert layer.
- **Satisfies:** `dialog-core` trap+return+containFocus (`:31` focus manager, `:79`
  registerDialog); ChipPopover initial+return focus (`alpha-composer.tsx:140-151`).
- **GAP:** none. **Acceptance:** modal open → focus inside; Tab cycles within;
  close → focus returns to trigger. Already asserted for composer primitives.

### B. keyboard-operability
- **Forbids:** any control reachable only by pointer; Escape not dismissing an
  overlay.
- **Satisfies:** Dialog Tab/Escape; combobox Arrow/Escape; menu Escape;
  picker rows Tab; sidebar menu helpers.
- **GAP:** 可达性本身无缺(所有控件都是原生 `<button>`,Tab 可达);**coverage gap** ——
  model-picker/menu keyboard+ARIA 仍无 L1 断言。**组内**的方向键语义不归本类,归
  新增的 class F —— B 管「能不能到」,F 管「声明了 role 就得按 role 的方式到」。
  **Acceptance:** every overlay control Tab-reachable and Escape-dismissable;
  asserted in extended harness (§4 VERIFY-L1).

### C. accessible-name + state
- **Forbids:** unnamed control; state (expanded/checked/current/selected) not
  exposed to AT.
- **Satisfies:** `aria-label`/`aria-current` on picker rows; `aria-expanded`+
  `menuitemradio`+`aria-checked`; combobox `aria-selected`/`aria-activedescendant`;
  Toast `role=status`; decorative icons `aria-hidden`.
- **GAP:** none functional; coverage folded into §4 VERIFY-L1.

### D. contrast-AA  ← **LANDED (`#478` / PR#518)**
Real token values from `tokens.css`, WCAG ratios computed against **actual
adjacent backgrounds** (worst-case surface in each theme). Text needs ≥4.5:1;
non-text focus indicator needs ≥3:1.

owner 设计门已过,选定 **候选 ②**(chips 一致的 1.5px 细实色 accent 描边);三个主题块
(`:root`、`[data-color-scheme=dark]`、OS-fallback `@media (prefers-color-scheme: dark)`)
一并改到位 —— rev1 特别告警过的 OS-fallback 块没有漏。

rev1 与第一轮实现都只把**五个**背景当作「相邻背景」,漏了 `--a-bg-inset`。它不是理论项:
`alpha-composer.css:266-267` 的发送按钮就是 `background: var(--a-bg-inset); color:
var(--a-text-tertiary)`,即「浅色 tertiary 落在 inset 上」这一对**当前就在产品里跑**。
把它纳入配对集后浅色 tertiary 只有 **4.23:1**,于是 rev2 把浅色值再压深一档
(`#6a6b73` → `#64656d`,每通道 −6/255,色相不变),最差对回到 **4.63:1**。深色两块
(`#86878f` on `#1e2024` = 4.56:1)本来就过,不动。这是本轮唯一的视觉改动。

| Token | Theme | rev1 值 → rev2 现值 | Adjacent bg (worst) | rev1 → 现比值 | Need | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `--a-text-tertiary` | light | #7c7d85 → #6a6b73 → **#64656d** | **#e3e6ea inset** | 3.52 → 4.23 → **4.63** | 4.5 | PASS |
| `--a-text-tertiary` | dark | #71727a → **#86878f** | **#1e2024 inset** | 3.75 → **4.56** | 4.5 | PASS |
| `--a-ring-focus` | light | `0 0 0 3px rgba(79,70,229,.45)` → **`0 0 0 1.5px var(--a-accent)`**(实色 #4f46e5) | #e3e6ea inset | 2.10 → **5.02** | 3.0 | PASS |
| `--a-ring-focus` | dark | 同上 → 实色 #818cf8 | #1e2024 inset | 2.19 → **5.47** | 3.0 | PASS |

- **Forbids:** informational text or focus indicator below AA。
- **GAP:** none —— 值已落地。剩下的唯一缺口是**回归闸门**:rev1 的取证是一次性脚本
  `ac4-contrast-check.mjs`,它把 token 值抄了一份副本,副本一旦与 `tokens.css` 漂移
  就失效,而且没人会在每个 PR 上跑它。
- **Acceptance(rev2 的退出条件,由 `#221` 兑现):**
  `contrast-ratchet.test.ts` 与 `reduced-motion-ratchet.test.ts` 同形制:算法照搬取证
  脚本(WCAG 相对亮度),但值**一律用正则从 `tokens.css` 现读**,三个主题块全读、
  **六个**相邻背景(canvas / subtle / muted / **inset** / surface / surface-raised)全配对;
  `--a-ring-focus` 引用哪个 token 也是现读并解析成实色 —— 一旦改回半透明圈(rev1 的
  `rgba(...)` 形态,或候选 ①)直接判红。任一主题块漏定义 tertiary 或背景 token 同样红。
- **fail-closed 必须是字面意义上的(第一轮的实缺)。** 第一轮把 token 值直接喂给
  `parseInt`:非 hex 值(`rgba()`、`oklch()`、`currentColor`、带 alpha 的 4/8 位 hex)
  得到 `NaN`,而 `NaN < 4.5` 为 **false** —— 号称「半透明焦点圈直接判红」,实测是把
  透明前景一路放绿。rev2 的判据是:凡是算不出确定比值的输入,亮度函数返回 `undefined`
  而**不是** `NaN`,调用方据此显式判红;只接受不透明 `#rgb` / `#rrggbb`。

### E. reduced-motion
- **Forbids:** any non-zero `--a-dur-*` under `prefers-reduced-motion: reduce`;
  regression of the collapse.
- **Satisfies:** `tokens.css:275-281`; `reduced-motion-ratchet.test.ts`.
- **GAP:** none. **Acceptance:** all four durations = 0ms under reduce; ratchet
  test green.

### F. composite-role ⇒ 键盘契约  ← **rev2 新增,唯一 remediation-bearing class**
声明一个复合 role,就是向 AT 许诺它欠下的键盘语义。**只写 role 不写键盘,比不写 role
更糟**:AT 会照着 role 宣布用法,用户按方向键却什么都不发生。

- **Forbids:** 任何声明 `role=tablist` / `tree` / `radiogroup` / `listbox` 的容器,
  **该 role 规定的**方向键在组内不移动,或组内留下多于一个 Tab 落点;以及声明一个
  当前形态根本不打算兑现的 role(过度声明 —— 降级比装作满足诚实)。反过来同样禁止:
  吞掉该 role 键表**之外**的输入 —— 横排 tablist 上的 ↑↓、radio 上的 Home/End、
  任何带修饰键的组合、IME 组字中的按键。这些不是「顺手多支持一点」,是抢别人的键。
- **认可的实现只有两条**(APG):① roving tabIndex —— 焦点真的落在项上移动;
  ② `aria-activedescendant` —— 焦点留在输入框,活动项由 id 指认(combobox 拥有的
  listbox 走这条,`composer-autocomplete` 即是,已由 `composer-a11y.test.ts` 断言)。
- **Satisfies(rev2 前已有,但是三份手抄):** rail 页签条、rail 产物模式条、
  artifact workbench 模式条 —— 同一段 ArrowLeft/ArrowRight/Home/End 分支复制三次。
- **GAP(rev2 勘破,`#221` 已兑现):**
  1. 终端面板 `role=tablist`/`tab`:无 `onKeyDown`、无 roving tabIndex;`tablist` 里还
     混着关闭/新建按钮(N 个实例 = N+2 个 Tab 落点),键盘关闭后焦点掉回 `<body>`。
  2. 提问卡 `role=radiogroup`/`radio`:无方向键、无 roving tabIndex;组本身没有名称;
     单选项走 `toggle`,已选项上再按一次 Space 会把整组清空(APG 明令不得)。
  3. 文件面板 `role=tree`/`treeitem`:零键盘处理。**owner 裁决降级**为
     `role=list`/`listitem` —— 面板今天的真实操作只有「Tab 到行 + 回车打开/展开」,
     靠原生 `<button>` 自洽,不写键盘代码;真需要树操作时按 `#622` 恢复 tree 语义。
     listitem 落在外包 `<div>` 上,不盖在 `<button>` 上(见「与上一稿的关系」第 2 条)。
- **Acceptance:**
  - 键位表只有一处实现:`roving-focus.ts`(`rovingKey` + `rovingTabIndex`,纯函数、
    零外部依赖),三处手抄一并收编。**键表按 role 分,调用方必须声明自己是哪一类**:
    `horizontal-tabs` = ←→ + Home/End(本仓四条页签条都是横排 flex);
    `radio` = ←↑ 上一项 / →↓ 下一项,**没有** Home/End。非本表的键、带修饰键的组合、
    `isComposing` 期间的按键一律原样放行,不 `preventDefault`。
  - 单选组的**每一个激活入口**(click / Space / Enter / 方向键)都走「选中」而不是
    「切换」;`toggle` 只属于多选的 checkbox 组。radiogroup 自身由可见问题文本
    `aria-labelledby` 命名。
  - `role="tablist"` 只拥有 tab:新建按钮移出页签条;关闭按钮退出 Tab 序列,键盘关闭
    改由页签上的 Delete/Backspace 承担,并把焦点交给相邻的存活页签(全关光则交给空态
    的新建按钮)。
  - **类边界闸门**(`roving-focus.test.ts`):扫 `alpha-ui/**/*.tsx`,**逐条 `role=` 声明
    计数**,不按文件认领 —— 已经接好一个 tablist 的文件,不足以让同文件第二个裸控件
    蒙混过关(第一轮就是这么漏的)。一套接线 = 一个 `rovingKey(` + 一个 `rovingTabIndex(`
    (取两者较小值:只 import 不用、或只给 tabIndex 不给键位都是半套),或一个真的
    `aria-activedescendant` 属性,或 combobox 跨文件形态(活动项访问器 + 带稳定 id 的
    `role="option"`)。光出现 `activeDescendant` 这个标识符不算。

---

## §4 子票切分 — child split (reuse existing tickets; do not duplicate)

rev2 起,唯一 remediation-bearing 的是新增的 class **F**(复合 role 键盘契约),由
`#221` 兑现;class **D** 已由 CLOSED `#478`/PR#518 落地,只补回归闸门。Classes
A/B/C/E 仍 SATISFIED(AC2/AC3/AC5 landed by CLOSED `#477`,AC1 by `#441`/`#446`),
verify-only 关闭。剩余工作只有 L2 打包版读屏走查。

### AC2(class F)— `#221`,同 PR 兑现
`roving-focus.ts` 收编键位表 + 三处手抄;补终端 tablist 与提问卡 radiogroup 的键盘契约;
文件面板按 owner 裁决降级为 `list`/`listitem`(`#622` 记录将来恢复 tree 语义的条件)。
- **边界:** 只动 `packages/ui-mac`(+ 本稿);不引 axe-core / testing-library /
  focus-trap;不碰 `Dialog.tsx` / `dialog-core.ts` / `alpha-composer-model.tsx` /
  `PermissionDialog.tsx`(属 `#183` 边界,本票只验收引用)。
- **本轮的两处结构改动(第一轮没有,审计后才必须):** ①文件面板每行外包一层
  `role="listitem"` 的 `<div>`(`.a-srf-item`,纵向 flex + 1px 间距,视觉零变化);
  ②终端页签条外包 `.a-term-tabbar`,把新建按钮挪出 `role="tablist"`(视觉零变化;唯一
  差别是页签横向溢出滚动时新建按钮不再跟着滚出视野)。另有一处纯搬运:提问卡从
  `session-composer-dock.tsx` 抽成 `session-question-card.tsx` —— dock 依赖
  ServerSDK/Router 上下文,在组件测试环境里根本 import 不进来,不抽就只能用「读源码
  字符串」冒充测试;抽出后它与 `files-view` 同形制,可被真 Solid 挂载驱动。
- **退出条件:** 三处键盘契约各有真 Solid 挂载或真 DOM 用例;类边界闸门在缺契约时红;
  每条闸门声明都经过真实变异验证(改一个字面量必须让它红)。

### AC4(class D)— `#478` 已交付,`#221` 补闸门 + 一处 token 修正
`contrast-ratchet.test.ts`:从 `tokens.css` 现读三个主题块的实值,tertiary 对**六个**
相邻背景 ≥4.5:1、焦点指示器 ≥3:1;算不出确定比值的值(半透明 / 非 hex / 缺失)一律判红。
纳入 `--a-bg-inset` 后浅色 tertiary 不达标,同 PR 修 token(`#6a6b73` → `#64656d`),
详见 §3.D。一次性脚本 `ac4-contrast-check.mjs` 保留为取证留痕(值已同步),不再是唯一证据。

### VERIFY(new coverage only — not re-testing `#477`/`#183`)
`[C21][VERIFY] 扩展 L1 harness 覆盖 model-picker`
- **AC:** "Automated a11y and keyboard tests" — for the surfaces `#477` did not
  already assert. Extend `composer-a11y.test.ts` to cover model-picker
  (`role=dialog` + row `aria-label`/`aria-current` + Escape/return-focus).
- **边界:** L1 only, reuses the existing bun/happy-dom runtime.
- **out-of-scope:** composer/autocomplete/sidebar behavior (landed + tested in
  `#477`); `#183` Dialog internals; contrast ratchet(已随 `#221` 落地)。
- **退出条件:** new assertions green in the fixed tree ×2.

`[C21][VERIFY] L2 打包版 screen-reader / 焦点走查`
- **AC:** "Packaged screen-reader/focus walkthrough" — packaged-app VoiceOver
  pass over Dialog, model-picker, chip menus, autocomplete, Toast: names/roles/
  states announced, focus order sane, focus visibly rings, Escape returns focus.
- **边界:** L2 packaged evidence only; no code.
- **out-of-scope:** L1-covered assertions; unit behavior.
- **退出条件:** walkthrough notes + evidence under `docs/verification/`, ring
  visible against real backgrounds, no unnamed control.

### 派生出去的窄票(不在 `#221` 范围内)
- **`#622`** — 将来真要做树操作时恢复文件面板的 tree 语义与完整键盘操作。
- **`#629`** — 提问卡 `custom` 分支与空 `options` 的契约缺口(`custom` 契约默认启用但
  UI 按 undefined = false 处理;自定义输入被已选项静默压过;`options: []` 渲染出空
  radiogroup)。由 `#221` R1 审计发现,经复核为 `#221` 之前既有的**功能**缺口,不是
  无障碍缺口,故另开票而不是扩本票范围。

**Owner gates already exercised:** AC4 的环形机制(① vs ②)是 owner 决策,已过门并
选 ②;class F 的文件面板降级(tree → list)同样是 owner 裁决,不是实现者自选。两处都
不是静悄悄的正确性编辑。浅色 tertiary 从 `#6a6b73` 再压到 `#64656d` 是**数值型的
fail-closed 修正**(纳入 inset 后 4.23 < 4.5),不是新的设计选择,机制仍是已批的候选 ②。

---

## 与现状的关系 — relationship to incumbent

- **This does NOT re-implement `#183`.** Modal Dialog a11y (focus trap, return-
  focus, Escape, aria-modal/labelledby/describedby, inert siblings) shipped there
  and is recorded once in §1; it is out of re-audit scope.
- **This does NOT re-mint the C21 child split.** `#441`/`#446` (AC1), CLOSED
  `#477` (AC2/AC3/AC5), CLOSED `#478` (AC4) 与 `#221`(class F 的兑现)已经存在;
  本稿是确认它们的合并审计,只新增 VERIFY 覆盖(model-picker L1 + L2 SR 走查)。
- **The "补全/greenfield" framing in the C21 AC is partly stale.** 绝大多数
  primitive class 已经在跑且多数有测试守着(composer、menu、autocomplete、Toast、
  reduced-motion、timeline)。把 C21 当新建会重做已落地的工作。
- **rev2 的真实 delta = class F**:REQ-125 收编进来的三族面板里,三处声明了复合 role
  却没兑现键盘契约。AC4 的 token 值已由 `#478` 落地,rev2 把它从「一次性脚本取证」
  升级成「每个 PR 都跑的闸门」—— 升级过程中才发现闸门覆盖面漏了 `--a-bg-inset`,
  而那一对组合当前就在产品里跑(`alpha-composer.css:266-267`),所以 rev2 顺带修了
  浅色 tertiary。**「补一条闸门」暴露出「值本来就不合格」,这是闸门该有的样子。**
- **Live-path honesty:** 所有 "SATISFIED" 判定读自 alpha `bbef61e6e` 的源码,标注
  "tested" 的引用的是通过中的 bun 测试。仍不能从代码验证、必须在实机确认的只剩一件:
  L2 打包版 VoiceOver 的真实播报(归下次 RC 批)。
