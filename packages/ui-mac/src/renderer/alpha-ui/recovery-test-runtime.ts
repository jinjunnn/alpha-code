export { createComponent } from "solid-js"
export { render } from "solid-js/web"
export { RecoverySurface } from "./RecoverySurface"
// Surface renders i18n text via this bundled i18n instance; the test pins the locale it
// asserts against (zh product copy). Without this the built runtime falls back to
// detectLocale() → "en" and every zh literal assertion drifts (#475 i18n regression).
export { setLocale } from "../i18n"
