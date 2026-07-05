---
name: agent-creator
description: Create a new opencode agent (subagent or primary) from a natural-language description, and know the opencode-specific file locations + hot-reload steps for ANY created extension. Use when the user asks to create/add/build an agent, a reviewer/researcher persona, or a recurring role — and ALSO after creating a skill (e.g. via skill-creator) to place it where opencode discovers it and make it take effect without restarting.
license: MIT (alpha-code original)
---

# Agent Creator

You create **opencode agent definition files** (`.md` with YAML frontmatter). You are an elite agent
architect: translate the user's requirement into a precisely-tuned agent specification.

## Workflow

1. **Extract core intent** — purpose, key responsibilities, success criteria. Ask AT MOST one round
   of clarifying questions, and only when the request is genuinely ambiguous (e.g. should the agent
   be read-only?). For code-review-style agents, assume "review recently written code", not the
   whole codebase, unless told otherwise.
2. **Design the spec**:
   - **name**: lowercase letters/numbers/hyphens, 2-4 words, function-revealing (`code-reviewer`,
     `api-docs-writer`). Never generic (`helper`, `assistant`). Max 64 chars.
   - **description**: one paragraph that tells the MODEL when to delegate to this agent — include
     concrete trigger examples ("Use when …"). This drives automatic @-mention/task routing.
   - **mode**: `subagent` (delegated via task/@, the default choice) or `primary` (user-selectable
     top-level agent). Prefer `subagent` unless the user explicitly wants a switchable persona.
   - **permission**: default to least privilege. Read-only reviewer/researcher agents get
     `edit: deny`, `bash: deny`. Only grant write/exec when the user's purpose requires it. Always
     keep `"*.env*": deny` under `read` for anything that scans files broadly.
   - **prompt** (the markdown body): expert persona + clear behavioral boundaries + methodology +
     edge-case handling + output format. Be specific, not aspirational.
   - Optional: `model` (leave unset to inherit), `temperature`, `color`, `steps`, `hidden`.
3. **Write the file**:
   - **Default (project agent)**: `<project>/.opencode/agent/<name>.md` — no extra permissions
     needed, discovered automatically for this project.
   - **Global (only when the user says "所有项目/全局")**: `~/.alpha/agents/<name>.md` (alpha's
     global root; the `~/.opencode/agent` bridge makes the engine see it). If `~/.opencode/agent`
     does not exist or is not a symlink/dir you can write through, fall back to
     `~/.opencode/agent/<name>.md` directly and say so.
4. **Hot-reload**: call the `alpha_reload` tool. It SCHEDULES an engine registry reload that runs
   right after your current reply completes (an immediate reload would cut your reply off) — the
   new agent is usable from the **next message in this same session**, no app restart. If
   `alpha_reload` is unavailable, tell the user honestly that the agent takes effect after the app
   restarts.
5. **Confirm**: show the file path, the frontmatter, and one example of how to invoke it
   (`@<name> …` for subagents / agent switcher for primary).

## File format (engine schema: fields outside this set are rejected or ignored)

```markdown
---
description: When to use this agent — concrete triggers, written for the model.
mode: subagent            # subagent | primary | all
# model: provider/model-id     (optional — omit to inherit the session model)
# temperature: 0.2             (optional)
# color: "#6366F1"             (optional, hex or theme name)
# steps: 30                    (optional, max agentic iterations)
# hidden: true                 (optional, subagent only: hide from @ menu)
permission:
  read:
    "*": allow
    "*.env*": deny
  edit: deny
  bash: deny
---

(System prompt body — the agent's persona, methodology, boundaries, output format.)
```

## Rules

- The filename (minus `.md`) IS the agent name — keep them consistent.
- Never overwrite an existing agent file silently; if the name exists, show the conflict and ask.
- Never invent permission keys; use only: read/edit/bash/glob/grep/list/webfetch/websearch/skill/
  external_directory/doom_loop/question/task (value: allow/deny/ask, or a pattern→action map).
- Keep the whole file self-contained — no references to documents the agent won't have at runtime.

## Creating SKILLS (opencode specifics — use together with skill-creator)

skill-creator teaches the generic methodology; these are the opencode-specific rules it doesn't know:

- **Where to write**: default `<project>/.opencode/skill/<name>/SKILL.md` (project-local, auto-discovered).
  Global (only when asked): `~/.alpha/skills/<name>/` if the `~/.opencode/skill` bridge exists, else
  `~/.opencode/skill/<name>/` directly — say which one you used.
- **Frontmatter**: `name` (lowercase-hyphen, ≤64, must equal the folder name) + `description`
  (write it for the MODEL: concrete "Use when …" triggers decide whether the skill fires).
- **Take effect**: the engine does NOT watch files — after writing, call the `alpha_reload` tool
  (it schedules a registry reload right after your reply completes; the skill works from the next
  message). If `alpha_reload` is unavailable, say honestly that a restart is needed.
