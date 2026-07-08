---
name: customize-alpha
description: Configure and customize alpha-code — global/project engine config (alpha.jsonc), connectors (MCP), skills, agents, commands, plugins, governance of built-ins, and hot reload. Use when the user asks how to customize alpha-code, add/remove a connector or skill, change agent behavior, tweak commands, or where alpha-code's config files live.
license: MIT (alpha-code original)
---

# Customize alpha-code

You help the user customize **alpha-code**. Everything alpha-code owns lives under `.alpha`
directories — never create or edit a `.opencode` directory or a `.mcp.json` file (those are other
tools' conventions; alpha-code does not read them).

## Where things live

| Scope | Truth | What goes there |
|---|---|---|
| Global (all projects) | `~/.alpha/alpha.jsonc` | connectors (`mcp`), `plugin`, `agent`, `command`, `provider` overrides |
| Global installs | `~/.alpha/{skills,agents,plugins}/` + ledger `~/.alpha/installs.json` | things the user installed/created/imported |
| Per project | `<project>/.alpha/alpha.jsonc` | project-scoped connectors / agents / commands / skills path |
| Per project content | `<project>/.alpha/skills/<name>/SKILL.md`, `<project>/.alpha/plugins/*.js` | project skills and plugins |

Rule of thumb: `.alpha` only ever contains what the user chose to add. Factory content ships inside
the app and never appears in `.alpha`.

## How to make changes

1. **Project-scoped extensions (preferred in a session)** — use the `alpha_register` tool:
   - `type=agent|command` with the entry JSON (`{"description":"...","prompt":"..."}` / `{"template":"..."}`)
   - `type=mcp` with the connector config — executable connectors additionally need the user's
     per-project consent dialog before they load
   - `type=skill` (no entry) after writing `<project>/.alpha/skills/<name>/SKILL.md`
   Changes are validated, written atomically, and hot-reloaded after the current reply — available
   from the NEXT message. No app restart.
2. **Global changes** — edit `~/.alpha/alpha.jsonc` directly (same keys as project), then call
   `alpha_reload`. For connectors/skills/agents/plugins prefer the **Extension Hub** (定制中心) in
   the sidebar: browse, one-click install, update, uninstall — it keeps the install ledger accurate.
3. **Creating new skills/agents** — delegate to the factory skills `skill-creator` / `agent-creator`
   (they interview, generate, write to the right place, and hot-reload).

## Governing built-ins

The Extension Hub's governance panel (已安装 → 内置) can hide or disable upstream built-in agents
and skills, and override agent fields (prompt/model/permission). User governance always wins over
alpha factory defaults. Some agents are protected (compaction/title/summary and alpha's automation
agents) because disabling them breaks the engine or alpha features — the panel refuses loudly.

## Honest boundaries

- Plugins must be self-contained ESM `.js` (raw TypeScript is rejected by the desktop runtime).
- Executable content (connectors, plugins) inside a project only loads after the user grants the
  project trust dialog.
- If a change does not take effect, call `alpha_reload` once; if it still doesn't, say so honestly
  and suggest an app restart rather than pretending it worked.
