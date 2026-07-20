---
name: integrate-project
description: Import or re-import external ecosystem content (.claude/.agents skills, CLAUDE.md) into alpha-code's native .alpha layout. Use when the user asks to import external skills/instructions, bring over Claude Code content, refresh a previous import after the external directory changed, or wonders why .claude/.agents content is not visible in alpha-code.
license: MIT (alpha-code original)
---

# Integrate Project — external content import

alpha-code deliberately does **not** read other tools' directories (`.claude/`, `.agents/`,
`CLAUDE.md`) — unreviewed content must not silently enter the model context. Import converts that
content into native alpha assets (a **snapshot**, decoupled from the source; re-running this skill
is the way to refresh after the external directory changes).

## Procedure

1. **Detect** — list what exists (project scope unless the user says global):
   - `<project>/.claude/skills/*/SKILL.md` and `<project>/.agents/skills/*/SKILL.md`
   - `<project>/CLAUDE.md`
   - global: `~/.claude/skills/`, `~/.agents/skills/`, `~/.claude/CLAUDE.md`
2. **Preview** — show the user the exact list (names + source paths) and what each maps to:
   - skill → `<project>/.alpha/skills/<name>/` (or
     `$ALPHA_GLOBAL_DIR/skills/<name>/` for global; use only the absolute value supplied by alpha)
   - `CLAUDE.md` → `AGENTS.md` (the engine's native instruction file)
   Anything that does not map (e.g. `.claude/commands`, `.claude/agents`, hook scripts) must be
   listed as **not importable** — say so plainly, never silently drop it.
3. **Confirm** — proceed only after the user confirms the list.
4. **Convert** (per item; on re-import, overwrite the previous snapshot only after telling the user):
   - **Skill**: copy the whole skill directory into `.alpha/skills/<name>/` (keep `SKILL.md` at its
     root). For project scope, then call `alpha_register` with `type=skill` to register the skills
     path. For a name that already exists in `.alpha/skills`, ask before replacing.
   - **CLAUDE.md**: if `AGENTS.md` does not exist, create it from the CLAUDE.md content with a first
     line `<!-- imported from CLAUDE.md by alpha-code (snapshot; re-import to refresh) -->`. If
     `AGENTS.md` exists, do NOT overwrite or append blindly — show both and help the user merge.
5. **Activate** — call `alpha_reload`; the imported items are available from the NEXT message.
6. **Report** — list what was imported, what was skipped and why. Be honest about partial results.

## Boundaries

- Never modify the source `.claude`/`.agents` directories — import is copy-only.
- Never create a `.opencode` directory or a `.mcp.json` file.
- If the user wants the old inherit-everything behavior instead, tell them about the
  `ALPHA_ECOSYSTEM_INHERIT=1` escape hatch (machine-wide, restores upstream behavior; alpha then
  stops detecting and prompting).
