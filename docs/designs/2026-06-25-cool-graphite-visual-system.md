# alpha-code 视觉统一方案 v2 — 冷石墨 / 冷瓷白 (Cool Graphite / Porcelain)

> 2026-06-25 · 经 `ui-ux-pro-max` design 技能 + 用户选型(冷石墨方向 + 全面视觉升级)
> 取代 tokens.css v1 的中性色("zinc 暖中性")。indigo accent 保留不变。
> 落点:`packages/ui-mac/src/renderer/alpha-ui/tokens.css`(`--a-*`)+ 侧栏迁移 + `theme-alpha.ts` 引擎中性色对齐。

## 1. 设计意图
- **调性**:Linear / Vercel / Raycast register —— 安静、克制、低饱和的**冷中性**(蓝灰微调),配单一 indigo 强调色。
- **根因修复**:侧栏(`sidebar/sidebar.css`)是全前端唯一还挂 opencode 旧 `--v2-*` token 的文件 → 看着"不是 alpha 的"。本方案把它迁到 `--a-*`,并把整套中性色从暖 zinc 调成**冷石墨/冷瓷白**。
- **字体**:保留原生 **SF Pro / -apple-system** 系统栈(Mac 上比 Inter 更"原生高级");不引入 Inter。
- **黑白双模**:light/dark 都是一等公民,各自独立核验对比度(WCAG:正文 ≥4.5:1,次级 ≥3:1)。

## 2. 中性色阶 (neutral ramp)

### Light — 冷瓷白
| token | v1 (旧暖) | **v2 (冷瓷白)** | 用途 |
|---|---|---|---|
| `--a-bg-canvas` | #ffffff | **#ffffff** | 主内容/对话区(最亮,读码对比度最高) |
| `--a-bg-subtle` | #f7f7f8 | **#f6f7f9** | 侧栏 / 凹陷区(冷瓷白,比画布略沉) |
| `--a-bg-muted` | #efeff1 | **#eceef1** | hover 填充 / inset 字段 |
| `--a-bg-inset` | #e9e9ec | **#e3e6ea** | pressed / 轨道 |
| `--a-surface` | #ffffff | **#ffffff** | 卡片/面板/popover(配阴影分层) |
| `--a-surface-raised` | #ffffff | **#ffffff** | 模态 |
| `--a-scrim` | rgba(16,16,20,.42) | **rgba(15,17,21,.45)** | 模态遮罩(稍加强,保前景可读) |

### Dark — 冷石墨
| token | v1 (旧) | **v2 (冷石墨)** | 用途 |
|---|---|---|---|
| `--a-bg-canvas` | #0a0a0b | **#0a0b0d** | 主内容(最暗,冷调) |
| `--a-bg-subtle` | #121214 | **#0e0f11** | 侧栏 / 凹陷区 |
| `--a-bg-muted` | #1a1a1d | **#16171a** | hover 填充 |
| `--a-bg-inset` | #242428 | **#1e2024** | pressed / 轨道 |
| `--a-surface` | #151517 | **#121316** | 卡片/面板(比画布"抬起"一档) |
| `--a-surface-raised` | #1b1b1e | **#17181b** | 模态/popover |
| `--a-scrim` | rgba(0,0,0,.58) | **rgba(0,0,0,.60)** | 模态遮罩 |

## 3. 边框 / 文本

### 边框(冷石板调)
| token | Light | Dark |
|---|---|---|
| `--a-border-faint` | #eef0f3 | #1b1c20 |
| `--a-border` | **#e4e6ea** | **#232428** |
| `--a-border-strong` | #ced2d9 | #34363c |

### 文本
| token | Light | Dark | 对比度(在 subtle 上) |
|---|---|---|---|
| `--a-text` | **#18181b** | **#fafafa** | ~16:1 / ~17:1 ✓ |
| `--a-text-secondary` | **#52525b** | **#a1a1aa** | ~7:1 / ~8:1 ✓ |
| `--a-text-tertiary` | #7c7d85 | #71727a | ~4.5:1 / ~4.2:1(meta,可接受) |
| `--a-text-disabled` | #b3b6bd | #4f5158 | — |
| `--a-text-on-accent` | #ffffff | #ffffff | — |

## 4. 叠加层 (overlay) — 新增 token
分层 chrome(侧栏/列表项)的 hover/active/selected 用**半透明叠加**而非实色,这样叠在任意背景上都干净一致。

| token | Light | Dark |
|---|---|---|
| `--a-overlay-hover` | rgba(15,17,21,.05) | rgba(255,255,255,.055) |
| `--a-overlay-active` | rgba(15,17,21,.08) | rgba(255,255,255,.09) |
| `--a-overlay-selected` | `var(--a-accent-subtle)` | `var(--a-accent-subtle)` |

## 5. 强调色 (accent) — 不变
indigo 单色保留:light `--a-accent:#4f46e5`,dark `#818cf8`,及其 hover/active/subtle/border/ring。冷中性 + indigo 是经典高级搭配。
- ⚠️ 已知:dark 主按钮若用 `#818cf8` 实底 + 白字,对比 ~2.6:1 偏低(v1 既有问题)。consistency pass 复核 `button.css` 时一并处理(深一档底色或深色字)。

## 6. 阴影 / 动效 / 间距 / 字号 — 沿用 v1(微调阴影冷调)
- **阴影**:light 由 `rgba(16,16,20,…)` → `rgba(15,17,21,…)`(冷调);dark 维持深黑。低扩散、柔和。
- **动效**:`--a-dur-fast 130ms / base 190ms`,`--a-ease-out cubic-bezier(.22,1,.36,1)`(进场),已合 design 技能 150–300ms 规范;`prefers-reduced-motion` 已置 0ms。
- **间距**:4px 基(`--a-space-*`)不变。**字号**:不变。**字体**:系统栈不变。

## 7. 落地步骤
1. ✅ 本 spec。
2. `tokens.css`:改 :root / `[data-color-scheme="dark"]` / `@media prefers-color-scheme` 三处中性色 + 加 overlay token + 冷调阴影。
3. `sidebar/sidebar.css`:43 处 `--v2-*` → `--a-*`(bg→subtle、文本→text/secondary、边框→border、hover→overlay-hover、选中→overlay-selected);**保留**上游 chrome override 选择器(那是合法 targeting opencode V2 DOM,不动)。
4. `theme-alpha.ts`:light `neutral` 维持白、dark `neutral` #0a0b0d 对齐;reused 引擎(终端/diff/markdown)中性背景跟上。
5. consistency pass:Home/Settings/Dialog/Button/Input/ext-hub/account-popover hover/selected/elevation/type 复核。
6. 核验:light+dark CDP 截图(侧栏/首页/会话/设置),对照本 spec 迭代。

## 8. 耦合 / 风险
- 纯 `--a-*` CSS 变量改动,零改 upstream(守 ADR-005/016 北极星;前端接管已放行 alpha 自有文件)。
- 侧栏迁移后**断开**对 opencode `--v2-*` 主题的依赖 → 上游主题改名不再影响侧栏配色(更稳)。
- vibrancy(半透明材质)**本期不做**(用户选纯 CSS 冷石墨);如后续要,再单开(需动 main 进程 windows.ts)。
