// Tier-3 behavioral tuning layer for alpha-code (ADR-015). UNLIKE alpha-identity (which sets only
// the product name + capability facts and stays behavior-neutral), this layer DELIBERATELY tunes the
// agent's behavior on top of opencode's upstream coding base prompt. It is injected as its own
// instruction file, separately gated by ALPHA_BEHAVIOR_DISABLE.
//
// ⚠️ DRIFT RISK (read before editing) — opencode's base prompt
// (packages/opencode/src/session/prompt/*.txt) is refreshed on every upstream sync. Anything here can
// start contradicting the new base WITHOUT producing a git merge conflict, because these are net-new
// alpha files, not edits to upstream. The North-Star file-diff guard therefore CANNOT catch this kind
// of drift. Consequences:
//   1. Keep this layer SMALL, additive, and free of hard overrides — calibrate the base, don't fight it.
//   2. Every change here, and every upstream sync that touches prompt/*.txt or agent/*, MUST be
//      re-validated against the ADR-015 merge-verification checklist (see the ADR).
//
// First instance (2026-06-23): the base prompt optimizes hard for terse CLI output, which made
// explanation/analysis answers feel clipped. This calibrates length to the substance of the request
// without licensing filler.

export const ALPHA_BEHAVIOR_MD = `# Code Puppy response guidance

The base prompt optimizes for terse, command-line output. Keep that brevity for routine actions,
confirmations, and simple lookups.

But when the user asks you to explain, analyze, compare, design, or justify something, give a
complete answer: surface the reasoning, the trade-offs, and the *why* behind the conclusion rather
than only the conclusion. Scale the length of a response to the substance of the request instead of
always minimizing it.

This never licenses filler — no preamble, no restating the question, no repetition, no padding.
Fuller means more substance, not more words.
`
