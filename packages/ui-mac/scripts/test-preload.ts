// bun test preload: pin the UI locale for the whole test process before any test file
// evaluates. Consumed by src/renderer/i18n/index.ts detectLocale(), which prefers an
// explicit ALPHA_UI_LOCALE over navigator sniffing. `||=` respects an override the caller
// already exported (e.g. to run the suite in another locale). Child processes spawned by
// tests (alpha-composer-model.component.test.ts) inherit this via process.env.
process.env.ALPHA_UI_LOCALE ||= "zh"
