---
title: "cap:a11y 矩阵 — #327 Home/Workbench/session WCAG 2.2 AA + 键盘/屏读/reduced-motion"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-19
review_after: 2026-10-19
---

# cap:a11y 证据 — #327(2026-07-19)

归并 REQ-085/088/094/095 的 a11y 回归矩阵(capability = accessibility)。真机 Electron dev(CDP 9222,
`OPENCODE_TEST_ONBOARDING=1` 隔离根),基点 HEAD = `a5613686`,只读驱动。reduced-motion 经
`Emulation.setEmulatedMedia` 强制 `prefers-reduced-motion: reduce` 实测 + CSS 静态核对。

## 矩阵结果

### Workbench(产物工作台)

| # | 项 | 判定 | 证据 |
|---|---|---|---|
| 1 | tablist 语义(role=tablist + aria-label,tab role + aria-selected + aria-controls→panel) | PASS | `327-a11y.json` wbTablist:tablistPresent、label「产物工作台」、tabsHaveAriaSelected、tabsControlPanel 全 true |
| 2 | tabpanel 语义(role=tabpanel + aria-labelledby 指向当前 tab) | PASS | panelRole=tabpanel、panelLabelledby=a-wb-tab-preview |
| 3 | tablist 键盘导航(←/→ 移动、Home/End 跳首尾) | PASS | wbKeyboard:preview →(ArrowRight)→ source →(End)→ metadata →(Home)→ preview |
| 4 | 可见焦点环(focus-visible) | PASS | wbFocusVisible:box-shadow `rgba(79,70,229,.45) 0 0 0 3px`(3px 焦点环) |
| 5 | 下载状态 aria-live polite 区 | PASS | wbTablist.liveRegion=true(`.alpha-wb-live[aria-live]`) |
| 6 | 关闭按钮无障碍名 | PASS | closeBtnLabel「关闭」 |
| 7 | Esc 关闭 Workbench | PASS | wbEsc.pageStillOpen=false |
| 8 | 关闭后焦点恢复到触发器 | **FAIL** | 关闭后 activeElement 落到根 body,restoredToTrigger=false(`327-a11y.json` wbAfterEsc)。已由**开放** CODE 票 #290(REQ-094)承载 |

### Home / AlphaComposer(新会话草稿叶,composer 组件同源)

| # | 项 | 判定 | 证据 |
|---|---|---|---|
| 9 | composer textarea 有无障碍名 | PARTIAL | 仅 placeholder「问点什么,输入 / 调命令,@ 引用上下文…」充当名(弱,非 `aria-label`/`aria-labelledby`)(`327-a11y.json` homeProbe) |
| 10 | autocomplete combobox 语义(textarea role=combobox + aria-expanded + aria-controls + aria-activedescendant) | **FAIL** | textareaRole/AriaControls/AriaExpanded 全 null;`composer-autocomplete.tsx` 零 `role`/`aria-*`(静态确认)。已由**开放** CODE 票 #262(REQ-085)承载 |
| 11 | 工作区 chip 触发器展开语义(aria-expanded/aria-haspopup/aria-controls) | **FAIL** | `AlphaHome.tsx:109` 的 `.a-ws-chip` 按钮无任何 aria 展开语义(静态确认);#262 同承载 |

### 全局

| # | 项 | 判定 | 证据 |
|---|---|---|---|
| 12 | reduced-motion 系统性抹平动效 | PASS | `tokens.css:247` 在 reduce 下把 `--a-dur-{instant,fast,base,slow}` 全归 0ms(token 级全局抑制);另 `base.css:124`/`home.css:92`/`toast.css`/`tooltip.css`/`artifact-workbench.css:568` 各自 `animation:none`。实测 Workbench 卡片/tab transition 恒 0s(`327-reduced.json`) |

7 PASS / 2 FAIL / 2 PARTIAL。

## FAIL/PARTIAL 处置(不修码)

均已在 2026-07-14 审计 disposition 及 a11y 基线专项中开出**开放**票,不重复新开:
- #290 `[REQ-094][CODE] Restore trigger focus after Workbench close`(Workbench 关闭焦点恢复)
- #262 `[REQ-085][CODE] Add complete screen-reader semantics to Home workspace and autocomplete controls`(composer combobox + ws-chip 展开语义 + textarea 无障碍名)
- 伞票 #221 `[C21] Alpha UI 无障碍基线补全`(跨面 a11y 收口)

## 判定

Workbench 的 tablist/tabpanel/键盘/焦点环/live region/Esc 六项 PASS,reduced-motion 系统性 PASS;Workbench
关闭焦点恢复 FAIL、Home composer combobox + ws-chip 展开语义 FAIL、textarea 无障碍名 PARTIAL,均挂开放父需求
CODE 票。矩阵执行完毕,本票关闭(completed)。
