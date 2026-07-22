export { createComponent } from "solid-js"
export { render } from "solid-js/web"
export { createPermissionDecisionCommand, PermissionDialog } from "./PermissionDialog"
export { PermissionWatcher } from "./permission-watcher"
// The dialog renders i18n text via this same (bundled) i18n instance; the test must be
// able to pin the locale it asserts against (assertions are zh product copy). Without this
// the built runtime falls back to detectLocale() → "en" and every zh literal assertion drifts.
export { setLocale } from "../i18n"
