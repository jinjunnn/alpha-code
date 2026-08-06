# Claude plugin agent frontmatter distribution (#848)

This is point-in-time evidence for the corpus frozen in
`packages/ui-mac/test-fixtures/claude-plugin-corpus.json`. It is not an active
status tracker and does not redefine the production parser.

## Scope and provenance

- Corpus fixture SHA-256:
  `bfd176c60aedf55ef5b3de5edf0a4104bce25e3edfe2300c7dfad3095c7105b3`.
- Scope: plugin-level `agents/**/*.md`, where a plugin root is a directory
  containing `.claude-plugin/plugin.json`.
- Measured population: **43 files / 169,124 bytes** across 62 plugin roots.
- Marketplace split: `claude-for-financial-services` 10,
  `claude-plugins-official` 31, `openai-codex` 1, `tide-plugin` 1.
- The corpus generator preserves these 43 files as UTF-8 round-trip-checked
  verbatim text. A missing `text` field is a loud error, not a zero-result
  measurement.
- All pass/reject decisions below come from the production
  `agentMdToEntry`; the reporting script does not implement another agent
  grammar.

The deterministic report is generated with:

```sh
bun packages/ui-mac/scripts/report-agent-frontmatter-distribution.ts
```

Its in-memory coverage can be rerun with `--selftest`.

## Whole-file result

The production parser accepts **9 / 43** files and rejects **34 / 43**.

| Production result | Files |
| --- | ---: |
| accepted | 9 |
| `unsupported frontmatter key: tools` | 23 |
| `unsupported frontmatter key: effort` | 7 |
| unexpected indentation in block-style frontmatter | 4 |

The 34 rejection classes are an exact partition. This is a compatibility
measurement, not permission to broaden the parser: any schema decision remains
owned by the agent profile contract.

## Top-level key distribution

Each key is probed through a minimal document using the production parser.
`ignored` means the file can parse but the key is intentionally not copied into
the entry; `rejected` is the production result.

| Key | Occurrences / files | Observed value shapes | Production disposition |
| --- | ---: | --- | --- |
| `description` | 43 / 43 | comma list, plain scalar, quoted scalar, block-style continuation | accepted when structurally valid; 4 block-style values reject on indentation |
| `name` | 43 / 43 | plain scalar | ignored (the file name supplies identity) |
| `tools` | 33 / 33 | comma list, inline list, plain scalar | rejected |
| `model` | 24 / 24 | plain scalar | accepted |
| `color` | 19 / 19 | plain scalar | accepted |
| `effort` | 7 / 7 | plain scalar | rejected |
| `initialPrompt` | 1 / 1 | quoted scalar | rejected |
| `skills` | 1 / 1 | indented block | rejected |

The production whole-file result takes precedence over any per-key observation.
For example, a file containing `tools` remains rejected even if its other keys
are individually accepted.

## Deliberately excluded paths

These three files are under a skill's internal `agents/` directory, not at a
plugin root. They remain placeholder entries and are named here so the scope
cannot silently widen:

- `claude-plugins-official/plugins/skill-creator/skills/skill-creator/agents/analyzer.md`
- `claude-plugins-official/plugins/skill-creator/skills/skill-creator/agents/comparator.md`
- `claude-plugins-official/plugins/skill-creator/skills/skill-creator/agents/grader.md`

## Machine locks

`claude-plugin-corpus-census.test.ts` independently locks:

- 43 files, 169,124 verbatim bytes, and zero placeholders;
- the path plus per-file SHA-256 aggregate
  `fa30d60c7e60a8c1789d457da6f50627b67d6b3725e4e0d31369ba7b84d433f6`;
- the exact 9 accepted / 34 rejected partition; and
- the G6 fixture split of 292 verbatim / 596 placeholder entries.

The report script owns the readable per-file table and exact production error
strings; this document records the stable aggregate and interpretation.
