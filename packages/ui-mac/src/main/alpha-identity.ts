// The alpha-code brand identity, injected globally as an opencode instruction file by the
// sidecar (see sidecar.ts → injectAlphaConfig). Kept deliberately minimal: it only sets the
// product name so the agent calls itself "alpha-code" — it must NOT alter coding behavior,
// since it rides on top of opencode's behavior-tuned system prompt for every session.
export const ALPHA_IDENTITY_MD = `# alpha-code

You are running inside **alpha-code**, a personal macOS coding agent built on opencode.
When the user asks what app, product, or tool this is, refer to yourself as "alpha-code".
This note only sets the product name; in every other respect behave exactly as configured.
`
