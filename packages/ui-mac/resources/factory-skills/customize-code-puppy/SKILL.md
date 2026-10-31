---
name: customize-code-puppy
description: Customize Code Puppy — find capabilities in the Customization Center, request installation with the user's confirmation, check availability, create project skills/agents/commands/connectors, and explain project plugin trust. Use when the user asks how to customize Code Puppy, add/remove a connector or skill, change agent behavior, tweak commands, or where Code Puppy's config files live.
license: MIT (Code Puppy original)
---

# Customize Code Puppy

You help the user customize **Code Puppy**. Everything Code Puppy owns lives under `.code-puppy`
directories — never create or edit a `.opencode` directory or a `.mcp.json` file (those are other
tools' conventions; Code Puppy does not read them).

## Where things live

| Scope | Truth | What goes there |
|---|---|---|
| Global (all projects) | `$ALPHA_GLOBAL_DIR/alpha.jsonc` | connectors (`mcp`), `plugin`, `agent`, `command`, `provider` overrides |
| Global installs | `$ALPHA_GLOBAL_DIR/{skills,agents,plugins}/` + ledger `$ALPHA_GLOBAL_DIR/installs.json` | things the user installed/created/imported |
| Per project | `<project>/.code-puppy/alpha.jsonc` | project-scoped connectors / agents / commands / skills path |
| Per project content | `<project>/.code-puppy/skills/<name>/SKILL.md`, `<project>/.code-puppy/plugins/*.js` | project skills and plugins |

Rule of thumb: `.code-puppy` only ever contains what the user chose to add. Factory content ships inside
the app and never appears in `.code-puppy`.

## How to make changes

1. **Missing a capability? Search first with `codepuppy_hub_search`.** The Customization Center (定制中心)
   offers skills, agents, commands, connectors (MCP), bundles, and cloud capabilities. Read its
   installed/enabled state, required authorization, and any price explanation before proposing an install.
2. **Explain what to install and why, then call `codepuppy_hub_install`.** Ask the user to approve in the
   app's confirmation box (软件弹出的确认框). If a key is needed, the user enters it in that box.
   Never ask for or accept keys in chat; never invent or guess keys for the user.
   This is the primary managed installation path; do not edit global config to install capabilities.
3. **Check `codepuppy_hub_status` before use.** For `submitted; result pending` or `reload-pending`, check
   `codepuppy_hub_status` instead of repeating the installation. Tools return immediately; do not wait inside
   the current reply for reload. Report installed, reload-pending, and available as distinct states.
   Tell the user: 显示可用以后,下一条消息就能用;不用重启。
   Only promise use from the next message after the state is `available`.
4. **Creating project-scoped extensions** — use the `codepuppy_register` tool only for project scope:
   - `type=agent|command` with the entry JSON (`{"description":"...","prompt":"..."}` / `{"template":"..."}`)
   - `type=mcp` with the connector config — executable connectors additionally need the user's
     per-project consent dialog before they load
   - `type=skill` (no entry) after writing `<project>/.code-puppy/skills/<name>/SKILL.md`
   Changes are validated, written atomically, and scheduled for reload after sessions become idle.
   Executable connectors stay gated until the user trusts the project; do not promise immediate use.
5. **Global installs** — use the Customization Center tools above. The desktop process supplies
   `ALPHA_GLOBAL_DIR` as an absolute, canonical current-environment root; never synthesize, replace,
   or redirect it, and never fall back to the retired `$HOME/.alpha` root.
6. **Creating new skills/agents** — delegate to the factory skills `skill-creator` / `agent-creator`
   (they interview, generate, write to the right place, and hot-reload).

## Connectors (MCP) and bundles

- **Primary path = Extension Hub (定制中心)**: browse the curated catalog, one-click install with
  dependency preflight (`uv` / `node` checked before install), API keys collected as masked input
  and stored as `{file:}` references — **never write a connector API key in plaintext into
  `alpha.jsonc` yourself**; if a connector needs a key, send the user to the Hub install flow.
- **Project-scoped secondary path** = `codepuppy_register type=mcp` (config goes to
  `<project>/.code-puppy/alpha.jsonc`): executable connectors only load after the user grants the
  per-project trust dialog — expect that, don't call it a failure.
- **Runtime note**: catalog connectors run via `uvx`/`npx` pinned versions; first launch downloads
  from PyPI/npm and can be slow or blocked on restricted networks. A just-installed connector may
  show "connecting" for a while — that is honest state, not an error.
- **Bundles (套件)** are alpha's install manifests: one click fans out into several atomic installs
  (skills + agents + commands + connectors), each with its own receipt and uninstall. A bundle is not an engine
  plugin (插件 = JS module with hooks; it cannot contain skills/agents).
- The Hub's install ledger (receipts) is what makes 「已安装」 accurate — installs done by editing
  config by hand won't show there; prefer the Hub or `codepuppy_register` so state stays visible.

## Governing built-ins

The Extension Hub's governance panel (已安装 → 内置) can hide or disable upstream built-in agents
and skills, and override agent fields (prompt/model/permission). User governance always wins over
alpha factory defaults. Some agents are protected (compaction/title/summary and alpha's automation
agents) because disabling them breaks the engine or alpha features — the panel refuses loudly.

## Honest boundaries

- Plugins must be self-contained ESM `.js` (raw TypeScript is rejected by the desktop runtime).
- Project `.code-puppy/plugins/*.js` files are loaded and executed with the same permissions as
  the engine after the user trusts the project. Trust is granted once for the whole project,
  not per file or per execution. Explain this boundary before asking the user to trust a project.
- Executable plugins from the catalog are refused (ADR-040).
- If an install is not available yet, use `codepuppy_hub_status` and report its reason honestly. Use
  `codepuppy_reload` for an explicit reload request; it waits for sessions to become idle.
