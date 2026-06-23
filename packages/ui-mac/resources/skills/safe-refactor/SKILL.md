---
name: safe-refactor
description: Refactor existing code without changing behavior — characterize first, change in small reversible steps, keep the observers green throughout. Use when restructuring, renaming, extracting, deduplicating, or simplifying code that already works.
---

# Safe refactoring

A refactor changes structure, not behavior. The whole risk is silently changing behavior while
believing you didn't. This skill keeps that from happening.

## Before touching anything
- Name the behavior to preserve and how it's observed: a test, a script, a UI path. If nothing
  observes it, add that first — a characterization test that pins the *current* behavior, even if the
  current behavior is odd. You are locking in what is, not what should be.
- Confirm the code is green now. Never start from a red baseline; you won't be able to tell your
  breakage from the pre-existing red.

## While refactoring
- Make ONE structural change at a time — extract a function, rename, inline, move — and run the
  observers after each. A refactor is a sequence of small reversible steps, not one big rewrite.
- Keep every step behavior-preserving on its own. If a step only makes sense *with* a behavior
  change, that's a separate change: do it before or after, labeled as such, never smuggled inside the
  refactor.
- Don't expand scope. Note "while I'm here" fixes elsewhere instead of doing them now.

## After
- Read your own diff as a reviewer would: is every line either structure-only, or an explicitly
  flagged behavior change? Anything in between is a bug waiting to be found.
- Run the full observer set once more. If anything is red, shrink the last step until it's green
  again, then continue.

## Done when
Behavior is provably unchanged (the same observers still pass), the diff is structure-only, and the
scope didn't creep.
