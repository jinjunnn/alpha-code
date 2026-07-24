# Current designs (living)

One folder per product surface. Each `design.html` is the **living** design for
that page — edit it in place when the page gains or changes content. These were
seeded from each surface's latest *approved, committed* dated snapshot; the
frozen snapshots stay under `docs/design/2026-…/`.

Notable entries:

- [`session-workspace/design.html`](session-workspace/design.html) — the
  session page as a **whole** (full-page composition of shell-sidebar +
  conversation-timeline + composer + artifact-workbench, plus the merged
  single top bar and the four-panel right rail: 审查 / 文件 / 终端 / 产物).
- [`conversation-timeline/design.html`](conversation-timeline/design.html) —
  doubles as the timeline **component gallery** (one frame per message type;
  the approved artifact-link-row increment is merged in §⑥; missing component
  frames are tracked in its §⑦ 待补 index). Add future timeline component
  frames there, not in the session-workspace page draft.

- **Which surface is which, and its alpha-vs-opencode status:** see
  [`../PAGE-MAP.md`](../PAGE-MAP.md).
- **The two-layer model and workflow:** see [`../README.md`](../README.md).
- **On approval / ship:** cut a new dated snapshot from the current file so the
  approved state is frozen, then update `PAGE-MAP.md`.

Before editing any file here, read the design system under
[`../system/`](../system/) (principles, color, tokens, components) and the
current code entry listed for the surface in `PAGE-MAP.md`. Do not redesign a
page without that context.
