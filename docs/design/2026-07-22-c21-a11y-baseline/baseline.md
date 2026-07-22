---
title: C21 Alpha UI a11y readiness baseline
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-22
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

---

## §1 只读勘破 — live-code audit (per primitive CLASS)

Cited from the running tree (rolling pin `849c2598`). Each row: current state →
file:line → verdict. `#183`-delivered surfaces are recorded once here and are
**out of re-audit scope** (boundary line, see §3).

| Primitive CLASS | Current live state | Evidence (file:line) | Verdict |
| --- | --- | --- | --- |
| **Dialog (modal)** | initial focus (autofocus→panel), Tab focus-trap via start/end guards, return-focus to trigger on close, Escape (IME-guarded) closes if dismissable, `role=dialog`+`aria-modal`+`aria-labelledby`+`aria-describedby`, sibling `inert`+`aria-hidden` | `dialog-core.ts:40` (focusInitial), `:55-74` (focusGuard/containFocus trap), `:139-154` (Tab/Escape keydown), `:199-213` (inert+aria-modal layers), `:231-239` (return-focus); `Dialog.tsx:84-96,118-123` | **SATISFIED (#183)** |
| **picker (model)** | `role=dialog`+`aria-label` on container, search `<input>` `aria-label` + initial focus, rows are native `<button>` (Tab-operable) with per-row `aria-label`+`aria-current`, Escape+return-focus+initial-focus inherited from `ChipPopover` wrapper | `alpha-composer-model.tsx:291,296,201,500-505`; wrapper `alpha-composer.tsx:127-160` (initial focus, Escape+`a.focus()`, cleanup return-focus) | **SATISFIED** (name/state/keyboard correct; no L1 assertion yet → §4 VERIFY) |
| **menu (chip/sidebar)** | ChipPopover `role=menu` + `role=menuitemradio`+`aria-checked`, Escape closes + returns focus to anchor; sidebar menus: `focusFirstMenuItem`, `dismissMenu`, `dismissMenuOnEscape` helpers | `alpha-composer.tsx:277,282-306,150-156`; `sidebar/menu-a11y.ts:1-17` (+ `menu-a11y.test.ts`) | **SATISFIED** |
| **autocomplete (slash / combobox)** | `role=combobox` on textarea, `aria-expanded`, `aria-controls`→`role=listbox`, `role=option`+`aria-selected`, `aria-activedescendant` tracks Arrow keys, Escape collapses | `composer-a11y.test.ts:130-169` (passing); runtime `composer-a11y-test-runtime.tsx` | **SATISFIED (tested)** |
| **composer controls (PermChip)** | trigger `aria-expanded`, focus moves into popover, Escape closes + return-focus, `role=menu`/`menuitemradio`/`aria-checked` | `composer-a11y.test.ts:88-109` (passing) | **SATISFIED (tested)** |
| **Toast** | `role=status`+`aria-live=polite`, decorative icon `aria-hidden`, close button `aria-label` | `Toast.tsx:35-43` | **SATISFIED** |
| **focus-ring token** | `--a-ring-focus` = `0 0 0 3px var(--a-accent-ring)`, applied only on `.a-ui :focus-visible` (never mouse) | `tokens.css:56,123`; `base.css:42-48` | **GAP — contrast (see §3)** |
| **tertiary-text token** | `--a-text-tertiary` #7c7d85 light / #71727a dark; used for informational meta across 60+ CSS sites (composer, timeline, settings), not placeholder-only | `tokens.css:29,172,224`; usages in `alpha-composer.css`, `timeline-reskin.css`, `settings.css` | **GAP — contrast (see §3)** |
| **reduced-motion** | `@media (prefers-reduced-motion: reduce)` collapses `--a-dur-*` to `0ms`; guarded by ratchet test | `tokens.css:247-254`; `reduced-motion-ratchet.test.ts` | **SATISFIED (tested)** |

**Net:** 7 of 9 classes already satisfied and mostly test-guarded. Only the two
**contrast tokens fail**. Three AC checkboxes are satisfied-by-audit (Dialog,
picker/menu, composer names) and close **verify-only**; the two verification-
evidence checkboxes (L1 harness / L2 SR walkthrough) are the remaining work.

**This baseline does not mint new children — the C21 child split already exists:**

- **`#441`/`#446`** — satisfied **AC1** (overlap counted once).
- **`#477` (CLOSED)** — `[C21][CODE]` composer/autocomplete/sidebar a11y +
  reduced-motion 封漏, landed **AC2/AC3/AC5** (its own read-only recon is the
  source this audit confirms; L1 behavior tests shipped with it).
- **`#478` (OPEN, this iteration 暂缓)** — `[C21][CODE]` AA 对比 token 修正,
  owns **AC4**. It already carries the same measured ratios, the two ring
  candidates, the 164-consumer/tri-block edit-site warning, and — critically —
  the **owner design gate** (see §3.D / §4). This baseline consolidates the audit
  and points AC4 at `#478`; it does **not** create a parallel contrast ticket.

---

## §2 方案 — approach

**Single mechanism, gaps only.** The five a11y invariant classes are already
carried by two landed runtimes — `dialog-core.ts` (focus authority) and the
`composer-a11y-test-runtime` + `bun:test` harness (behavior authority). We
remediate the **contrast GAP** by editing token values in `tokens.css` (the one
canonical styling primitive) and **extend the existing harness** to assert the
already-correct picker/menu ARIA plus a token-contrast ratchet. Nothing new is
built; no primitive is redrawn.

- **Authority question (the anti-无底洞 test):** can THIS system be the
  authority? Yes — `dialog-core` owns focus/trap/return, `tokens.css` owns every
  color, and the bun harness owns behavioral truth. There is **no external
  system to stay point-by-point in sync with**. Good.

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

## §3 不变量枚举 — the 5 invariant CLASSES (boundary front-loaded)

Boundary line: `#183`-delivered Dialog surfaces + already-tested composer/menu
behaviors are counted **once** (§1) and are not re-audited here. Each class
lists the failure it forbids / who SATISFIES vs GAP / numeric acceptance.

### A. focus-management
- **Forbids:** focus escaping a modal; focus lost on close; focus stranded on an
  inert layer.
- **Satisfies:** `dialog-core` trap+return+containFocus (`:55-74,:231-239`);
  ChipPopover initial+return focus (`alpha-composer.tsx:127-140`).
- **GAP:** none. **Acceptance:** modal open → focus inside; Tab cycles within;
  close → focus returns to trigger. Already asserted for composer primitives.

### B. keyboard-operability
- **Forbids:** any control reachable only by pointer; Escape not dismissing an
  overlay.
- **Satisfies:** Dialog Tab/Escape; combobox Arrow/Escape; menu Escape;
  picker rows Tab; sidebar menu helpers.
- **GAP:** none functional; **coverage gap** — model-picker/menu keyboard+ARIA
  has no L1 assertion. **Acceptance:** every overlay control Tab-reachable and
  Escape-dismissable; asserted in extended harness (§4 VERIFY-L1).

### C. accessible-name + state
- **Forbids:** unnamed control; state (expanded/checked/current/selected) not
  exposed to AT.
- **Satisfies:** `aria-label`/`aria-current` on picker rows; `aria-expanded`+
  `menuitemradio`+`aria-checked`; combobox `aria-selected`/`aria-activedescendant`;
  Toast `role=status`; decorative icons `aria-hidden`.
- **GAP:** none functional; coverage folded into §4 VERIFY-L1.

### D. contrast-AA  ← **the only remediation-bearing class**
Real token values from `tokens.css`, WCAG ratios computed against **actual
adjacent backgrounds** (worst-case surface in each theme). Text needs ≥4.5:1;
non-text focus indicator needs ≥3:1.

| Token | Theme | Value | Adjacent bg | Ratio | Need | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `--a-text-tertiary` | light | #7c7d85 | #ffffff canvas | **4.09** | 4.5 | FAIL |
| `--a-text-tertiary` | light | #7c7d85 | #eceef1 muted (worst) | **3.52** | 4.5 | FAIL |
| `--a-text-tertiary` | dark | #71727a | #0a0b0d canvas | **4.12** | 4.5 | FAIL |
| `--a-text-tertiary` | dark | #71727a | #16171a muted (worst) | **3.75** | 4.5 | FAIL |
| `--a-ring-focus` (accent-ring @0.45) | light | rgba(79,70,229,.45) over #ffffff | #ffffff | **2.10** | 3.0 | FAIL |
| `--a-ring-focus` (accent-ring @0.45) | dark | rgba(129,140,248,.45) over #0a0b0d | #0a0b0d | **2.19** | 3.0 | FAIL |

- **Forbids:** informational text or focus indicator below AA.
- **GAP:** **both tokens fail in both themes.** (Tertiary is not placeholder-only
  — it colors informational meta across 60+ sites, so the WCAG placeholder
  exemption does **not** apply.)
- **Acceptance (numeric, computed candidates):**
  - `--a-text-tertiary` light → ~**#6a6b73** (4.56:1 on worst #eceef1, 5.3:1 on
    white); dark → ~**#86878f** (5.0:1 on worst #16171a, 5.5:1 on canvas). Both
    ≥4.5:1 on their worst adjacent background. Edit **all three theme blocks** in
    `tokens.css` (`:root` light, `[data-color-scheme=dark]`, and the OS-fallback
    `@media (prefers-color-scheme: dark)` block — do **not** miss the fallback, or
    OS-dark users keep the failing value).
  - **focus-ring — design-sensitive, two candidates (owner picks):**
    - **① heavier ring:** `--a-accent-ring` alpha **0.45 → ≥0.80** (same indigo
      hue): light →4.19:1, dark →4.56:1, ≥3:1 with margin, stays translucent
      indigo. **Risk:** a 2026-07-07 owner ruling rejected the "肥紫圈" and moved
      chips to a 1.5px thin solid outline (`alpha-composer.css:165`) — a heavier
      ring reopens that.
    - **② chips-style thin solid outline (recommended):** switch the focus
      indicator to a 1.5px **solid** `--a-accent` outline (≈6.3:1) — consistent
      with the chips decision, lighter, and clears AA with the most margin. Best
      fit for the "restrained" register (principle 1/9).
  - The choice between ① and ② is **not** the implementer's — it is the owner
    design gate `#478` records (`前端先设计后实现`: a one-page before/after token
    sheet in both themes, owner-approved, **before** any edit lands). This
    baseline recommends **②**; the sheet renders both for the call.

### E. reduced-motion
- **Forbids:** any non-zero `--a-dur-*` under `prefers-reduced-motion: reduce`;
  regression of the collapse.
- **Satisfies:** `tokens.css:247-254`; `reduced-motion-ratchet.test.ts`.
- **GAP:** none. **Acceptance:** all four durations = 0ms under reduce; ratchet
  test green.

---

## §4 子票切分 — child split (reuse existing tickets; do not duplicate)

Class **D** (contrast) is the only remediation-bearing class and is **already
owned by OPEN `#478`** — this baseline does not re-mint it. Classes A/B/C/E are
SATISFIED (A2/A3/A5 landed by CLOSED `#477`, A1 by `#441`/`#446`) and close
**verify-only**. The residual work is: unblock `#478`'s design gate, and add the
coverage the two verification-evidence AC checkboxes require.

### AC4 — reuse OPEN `#478`, gated on the owner design sheet
`#478` `[C21][CODE] AA 对比 token 修正 (AC4)` already scopes the fix (tokens-only,
all three theme blocks, `--a-text-tertiary` + focus ring) and is correctly held
`本迭代暂缓 —— 动笔前置门未过`. **The gate is the owner design decision in §3.D**
(candidate ① heavier ring vs ② chips-style thin outline). Deliverable to clear
it = the one-page before/after token sheet, both themes, owner-approved — then
`#478` implements and closes with the contrast-ratchet evidence below.

### VERIFY (new coverage only — not re-testing `#477`/`#183`)
`[C21][VERIFY] 扩展 L1 harness 覆盖 model-picker + 增加 contrast ratchet`
- **AC:** "Automated a11y and keyboard tests" — for the surfaces `#477` did not
  already assert. Extend `composer-a11y.test.ts` to cover model-picker
  (`role=dialog` + row `aria-label`/`aria-current` + Escape/return-focus); add a
  token-contrast ratchet (mirrors `reduced-motion-ratchet.test.ts`) asserting
  tertiary ≥4.5:1 and the focus indicator ≥3:1 in both themes — this is the
  evidence `#478`'s 退出条件 leans on.
- **边界:** L1 only, reuses the existing bun/happy-dom runtime.
- **out-of-scope:** composer/autocomplete/sidebar behavior (landed + tested in
  `#477`); `#183` Dialog internals.
- **退出条件:** new assertions green in the fixed tree ×2; ratchet red on any
  contrast-token regression.

`[C21][VERIFY] L2 打包版 screen-reader / 焦点走查`
- **AC:** "Packaged screen-reader/focus walkthrough" — packaged-app VoiceOver
  pass over Dialog, model-picker, chip menus, autocomplete, Toast: names/roles/
  states announced, focus order sane, focus visibly rings, Escape returns focus.
- **边界:** L2 packaged evidence only; no code.
- **out-of-scope:** L1-covered assertions; unit behavior.
- **退出条件:** walkthrough notes + evidence under `docs/verification/`, ring
  visible against real backgrounds, no unnamed control.

**Owner gate (not "no gate"):** the AC4 ring change is **design-sensitive** — the
one-page token sheet must be owner-approved before `#478` lands (per `#478`'s own
`动笔前置门`). The contrast *values* are numeric/fail-closed, but the ring
*mechanism* (① vs ②) is an owner call, so this is not a silent correctness edit.

---

## 与现状的关系 — relationship to incumbent

- **This does NOT re-implement `#183`.** Modal Dialog a11y (focus trap, return-
  focus, Escape, aria-modal/labelledby/describedby, inert siblings) shipped there
  and is recorded once in §1; it is out of re-audit scope.
- **This does NOT re-mint the C21 child split.** `#441`/`#446` (AC1), CLOSED
  `#477` (AC2/AC3/AC5), and OPEN `#478` (AC4) already exist; this baseline is the
  consolidated audit that confirms them and points AC4 at `#478` — it adds only
  the new VERIFY coverage (model-picker L1 + contrast ratchet + L2 SR walkthrough).
- **The "补全/greenfield" framing in the C21 AC is partly stale.** 7 of 9
  primitive classes are already live and mostly test-guarded (composer, menu,
  autocomplete, Toast, reduced-motion). Treating C21 as new build would
  duplicate landed work.
- **Only genuine delta = the AC4 contrast tokens** (`--a-text-tertiary`,
  focus indicator), which measurably fail AA in both themes (§3) and whose
  ring-weight mechanism is an **owner design decision** (`#478` gate), plus the
  two verification layers the AC still lists as unchecked.
- **Live-path honesty:** all "SATISFIED" verdicts are read from source at
  `849c2598`; the "tested" ones cite passing bun tests. What must be confirmed at
  implement-time: the exact final token hex/alpha (compute against the shipped
  backgrounds again before landing, in case the rolling pin moves a neutral), and
  the L2 packaged VoiceOver announcements (not verifiable from code).
