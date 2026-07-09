// composer-copy — the SINGLE source for composer placeholder copy (REQ-038 目标⑥).
//
// Before this file the same sentence lived twice: hardcoded in AlphaHome.tsx AND as the build-time
// brand-i18n replacement for upstream prompt-input.tsx's designPlaceholder() literal. Two literals
// drift silently (C28 honesty: the placeholder promises capabilities — it must match reality on BOTH
// surfaces). Imported by AlphaHome (renderer) and scripts/brand-i18n.ts (vite build plugin) — both
// are TS compiled by electron-vite, so one constant serves both worlds.

/** What both composers promise. Kept true by REQ-038: home now has / commands and @ references. */
export const COMPOSER_PLACEHOLDER = "问点什么,输入 / 调命令,@ 引用上下文…"

/** REQ-073:计划模式开启时的占位(Codex 对标;Shift+Tab 与 chip ⊗ 同为退出口)。 */
export const COMPOSER_PLACEHOLDER_PLAN = "描述任务,先生成计划再执行…(Shift+Tab 切回)"

/** The exact upstream literal in prompt-input.tsx:designPlaceholder() (frozen tree, ADR-020) that
 *  brand-i18n rewrites at build time. Includes the quotes — it is a source-substring match. */
export const COMPOSER_PLACEHOLDER_UPSTREAM_LITERAL = '"Ask anything, / for commands, @ for context..."'
