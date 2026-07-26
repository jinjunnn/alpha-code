// Route-authority ratchet — a SOURCE-TEXT gate, and the boundary of what that can mean.
//
// WHAT THIS IS FOR. Drift: an upstream release that reshuffles layout.tsx, a later contributor who
// moves the deep-link wiring without knowing why it is shaped this way, a revived parallel route or
// URL codec. Those changes are made in the open, and reading the source catches them.
//
// WHAT THIS IS NOT. A barrier against someone who is trying to get past it. Text rules on this
// surface have now been walked three times (R3 rewrote the `navigate` callback, R4 aliased the
// factory, R5 shadowed the binding with a parenthesis-free arrow parameter), and each fix bought a
// smaller class than the one before. The escapes below are known and left open on purpose, because
// closing them means writing a type-aware module resolver inside a test file, and an unmaintainable
// gate is a gate that gets deleted:
//   * a second consumer reached WITHOUT naming the factory — `mod["createDeepLink" + "Consumer"]`,
//     a dynamic `import()` with an assembled specifier, any name produced at runtime;
//   * a re-export planted outside the two roots scanned here (`packages/app/src` and this package's
//     `src`) — a third workspace package, generated code, a patched dependency;
//   * a second consumer MOUNTED somewhere other than layout.tsx's `onMount` — an object property, a
//     JSX inline handler, another component, an effect in a different file;
//   * wiring hidden inside a template literal's `${…}`: strings are skipped when parameter regions
//     are scanned.
// It also errs the other way on purpose: `if (consumeDeepLinks) {` reads as a re-binding. A false
// red is a conversation; a false green is what this file exists to avoid, and it has produced three.
//
// SO THE PRIMARY JUDGEMENT IS ELSEWHERE. `route-deep-link-consumer.test.ts` EXECUTES the real
// production consumer over a real manifest-decoded delivery and asserts the observed navigation
// target equals the href the manifest derives independently. Any change to what the app actually
// does — a rewritten target, a remapped delivery, a dropped link — moves that assertion, whatever
// the source text says. This file pins only the one stretch that test cannot reach into: layout.tsx
// handing the consumer its primitives and mounting it. Read a green here as "nothing drifted",
// never as "no second consumer can exist".
import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"

const packageRoot = join(import.meta.dir, "../..")
const sourceRoot = join(packageRoot, "src")
const workspaceRoot = join(packageRoot, "../..")
// The upstream renderer is held at arm's length, but its deep-link module is a surface Alpha owns
// end to end (the manifest decodes; that module only consumes — including the dispatch, which is
// why it lives there and not inline in layout.tsx). Being Alpha's own module, it takes the FULL
// rule set: a hand-assembled `/${…}/session` for a delivery is a violation there.
const upstreamDeepLinkModule = join(workspaceRoot, "packages/app/src/pages/layout/deep-links.ts")
// The rest of that directory is upstream's: its sidebar legitimately writes its own route
// literals, so it takes only the deep-link codec rules. That layer is contracted by path SHAPE in
// route-upstream-shape.test.ts instead.
const upstreamLayoutRoot = join(workspaceRoot, "packages/app/src/pages/layout")
// layout.tsx is upstream's too, but it is where the deep-link consumer used to live. It may call
// the module; it may not re-become the consumer, because then the hand-assembled href would be
// back in a file the full rule set cannot police.
const upstreamLayoutFile = join(workspaceRoot, "packages/app/src/pages/layout.tsx")
// The whole upstream renderer source: the search space for a module that re-exports the consumer
// factory under a second name, which is the one alias route the call-site judgement cannot see.
const upstreamAppRoot = join(workspaceRoot, "packages/app/src")
const ratchetPath = join(import.meta.dir, "route-authority-ratchet.test.ts")
const routeManifestPath = join(import.meta.dir, "route-manifest.ts")
const surfaceLedgerPath = join(import.meta.dir, "frontend-surface-manifest.ts")

interface SourceFile {
  path: string
  source: string
}

interface Violation {
  path: string
  rule: string
}

const ROUTE_LITERAL_RULES = [
  {
    rule: "navigation must use a manifest-derived href",
    pattern: /\b(?:navigate|redirect)\s*\(\s*["'`]\/[^"'`]*["'`]/g,
  },
  {
    rule: "href/to must use a manifest-derived href",
    pattern: /\b(?:href|to)\s*(?:=|:)\s*(?:\{\s*)?["'`]\/[^"'`]*["'`]/g,
  },
  {
    rule: "Route path must come from the manifest",
    pattern: /<Route\b[^>]*\bpath\s*=\s*(?:\{\s*)?["'`]\/[^"'`]*["'`]/g,
  },
  {
    rule: "pathname dispatch must use parseRoute",
    pattern:
      /\b(?:location\.)?pathname(?:\s*(?:===|!==|==|!=)\s*["'`]\/[^"'`]*["'`]|\.(?:startsWith|endsWith|includes)\(\s*["'`]\/[^"'`]*["'`]\s*\))/g,
  },
  {
    rule: "new-session path literals belong in the manifest",
    pattern: /["'`]\/new-session(?:\?[^"'`]*)?["'`]/g,
  },
  {
    rule: "parameterized session hrefs belong in the manifest",
    pattern: /`\/\$\{[^}]+\}\/session(?:\/\$\{[^}]+\})?`/g,
  },
] as const

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (comment) => comment.replace(/[^\n]/g, " "))
}

function violationsFor(file: SourceFile) {
  const source = withoutComments(file.source)
  const path = relative(packageRoot, file.path)
  const violations: Violation[] = []

  if (/\blegacy-route-abi\b|\bLegacyRouteAbiV1\b/.test(source)) {
    violations.push({ path, rule: "removed legacy route ABI reference" })
  }

  // Every route composes exactly one Alpha surface. The release-state machine that once let a
  // route fall back to an upstream leaf (env override / userData pin / crash fallback) is gone
  // and must not grow back.
  if (
    /\bSURFACE_RELEASE_STATES\b|\bALPHA_SURFACE_(?:HOME|NEW_SESSION|SESSION)\b|\balpha-surfaces-resolve\b/.test(source)
  ) {
    violations.push({ path, rule: "removed legacy surface release flag" })
  }

  // The frontend surface manifest is a descriptive ownership ledger: it does not register,
  // parse, or navigate routes. Executable route strings have only one exemption: the manifest.
  if (![routeManifestPath, surfaceLedgerPath].includes(file.path) && !/\.test\.[cm]?[jt]sx?$/.test(file.path)) {
    ROUTE_LITERAL_RULES.forEach((entry) => {
      entry.pattern.lastIndex = 0
      if (entry.pattern.test(source)) violations.push({ path, rule: entry.rule })
    })
  }

  if (/\.test\.[cm]?[jt]sx?$/.test(file.path)) return violations

  if (
    file.path !== routeManifestPath &&
    (/["'`](?:opencode|alpha-code):\/\//.test(source) ||
      /["'`](?:opencode|alpha-code):["'`]/.test(source) ||
      /\bsetAsDefaultProtocolClient\s*\(\s*["'`](?:opencode|alpha-code)["'`]/.test(source))
  ) {
    violations.push({ path, rule: "deep-link scheme literal outside the manifest" })
  }

  const parsesUrl = /\bnew URL\s*\(/.test(source)
  const dispatchesHostname = /\.(?:hostname|host)\b/.test(source)
  const dispatchesDeepLinkRoute = /["'`](?:new-session|open-project)["'`]/.test(source)
  const isDeepLinkIngress =
    file.path.includes(`${join(sourceRoot, "main")}/`) || file.path.includes(`${join(sourceRoot, "renderer")}/`)
  if (isDeepLinkIngress && parsesUrl && dispatchesHostname && dispatchesDeepLinkRoute) {
    violations.push({ path, rule: "new URL plus hostname deep-link dispatch outside the manifest" })
  }

  return violations
}

async function sourcesUnder(root: string) {
  const paths = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root, absolute: true }))
  return Promise.all(
    paths
      .filter((path) => path !== ratchetPath)
      .sort()
      .map(async (path) => ({ path, source: await Bun.file(path).text() })),
  )
}

const DEEP_LINK_CODEC_RULES = [
  { rule: "deep-link scheme literal outside the manifest", pattern: /["'`](?:opencode|alpha-code):\/\// },
  { rule: "deep-link URL codec outside the manifest", pattern: /\bnew URL\s*\(|\.hostname\b|\bsearchParams\b/ },
] as const

function deepLinkViolationsFor(file: SourceFile): Violation[] {
  if (/\.test\.[cm]?[jt]sx?$/.test(file.path)) return []
  const source = withoutComments(file.source)
  const path = relative(workspaceRoot, file.path)
  return DEEP_LINK_CODEC_RULES.filter((entry) => entry.pattern.test(source)).map((entry) => ({
    path,
    rule: entry.rule,
  }))
}

// Selecting deliveries is the first move of a consumer. Keeping that out of layout.tsx keeps the
// consumer inside the module the full rule set polices: to hand-assemble a route from a delivery
// in layout.tsx you must first pick the deliveries apart, and that is what this bites.
const DEEP_LINK_CONSUMER_RULES = [
  {
    rule: "deep-link dispatch belongs in the ratcheted deep-links module",
    pattern: /\bcollect(?:OpenProject|NewSession)DeepLinks\b|\bdeepLinkId\b/,
  },
] as const

function consumerViolationsFor(file: SourceFile): Violation[] {
  const source = withoutComments(file.source)
  const path = relative(workspaceRoot, file.path)
  return DEEP_LINK_CONSUMER_RULES.filter((entry) => entry.pattern.test(source)).map((entry) => ({
    path,
    rule: entry.rule,
  }))
}

/**
 * What layout.tsx hands the consumer, and what it then does with it. Everything BETWEEN those
 * bindings and the navigation is executed and asserted in route-deep-link-consumer.test.ts; the
 * call site itself is the only stretch a test cannot reach into, because a wrapper here
 * (`navigate: (href) => go(href + "/wrong")`), a remapped input (`buffer: () => rewritten`), a
 * later override (a spread or a repeated key) or a consumer that is built and then never wired
 * would retarget — or silently disable — the navigation without any executed code changing.
 *
 * So this reads the call as STRUCTURE rather than as text: the deps are parsed into top-level
 * entries, anything that is not a plain `key: value` (a spread, a computed key) is surfaced, and
 * the binding is followed to its `onMount` uses. Whitespace and property order are therefore free;
 * overriding and detaching are not. Deps assembled somewhere else and passed in as a variable are
 * refused outright — they would put the wiring back out of reach, which is the thing this exists
 * to prevent.
 *
 * "The binding" has to mean a LEXICAL binding, not a name, or the whole judgement is a spelling
 * check: take the factory under a second name, keep the honest call as decoration, and re-declare
 * the same identifier inside `onMount` around a rewritten consumer — every name-based assertion
 * above still passes while the mounted consumer is a different function. Hence two rules with no
 * exceptions: the factory is only ever CALLED, never aliased, and the identifier it is bound to is
 * declared exactly once in the file.
 */
const CONSUMER_DEPS = ["enabled", "buffer", "openProject", "navigate", "handoff"] as const

const CONSUMER_FACTORY = "createDeepLinkConsumer"

// One statement shape, read two ways: blanked (below) when the factory's name must be counted as
// calls only, and kept as a span (further below) when the mention inside it has to be classified.
// A fresh regex per use — a shared `g` regex carries `lastIndex` between a `replace` and an `exec`
// loop, and a judgement that depends on call order is a judgement that will silently drift.
const IMPORT_STATEMENT = String.raw`^[ \t]*import[\s{][\s\S]*?(?:from[ \t]*["'][^"']*["']|["'][^"']*["'])[ \t]*;?`

/**
 * The same offset-preserving whiteout as `withoutComments`, applied to the TEXT of string and
 * template literals: delimiters, newlines and every offset stay where they are, so a span found in
 * this view locates the very same characters in the source it came from.
 *
 * R8's false green: the statement shape above starts at any line-beginning `import {`, INCLUDING
 * one written inside a template literal, and then runs on to the next quoted string — swallowing
 * the real import that follows into the same span. A default import of any module at all then read
 * as an unrenamed named specifier, because the `{` faked inside the template was never closed:
 *
 *     const parserBait = `
 *     import {
 *     `
 *     import createDeepLinkConsumer from "./consumer-alias"
 *
 * Text inside a literal is data, never a statement, so it is blanked before the shape is looked for
 * at all. A `${…}` substitution is code again, and nests. No parser is needed for that, only the
 * lexer's own rule: a literal ends at its unescaped delimiter.
 *
 * Comments are already blanked at both call sites — an apostrophe in prose would otherwise open a
 * literal here — and every way this can still go wrong (a desynced quote) blanks MORE, which loses
 * spans and classifies mentions as `aliased`: a red, which is the direction this file errs in.
 */
function withoutLiteralText(source: string) {
  const out = source.split("")
  const blank = (at: number) => {
    if (out[at] !== undefined && out[at] !== "\n") out[at] = " "
  }
  // `'` `"` `` ` `` — inside a literal; `}` — inside a substitution; `{` — a brace nested in one.
  const open: string[] = []
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    const inside = open[open.length - 1]
    if (inside === "'" || inside === '"' || inside === "`") {
      if (char === "\\") {
        blank(index)
        blank(index + 1)
        index += 1
      } else if (char === inside) open.pop()
      else if (inside === "`" && char === "$" && source[index + 1] === "{") {
        open.push("}")
        index += 1
      } else blank(index)
      continue
    }
    if (char === "'" || char === '"' || char === "`") open.push(char)
    else if (char === "{") open.push("{")
    else if (char === "}" && (inside === "{" || inside === "}")) open.pop()
  }
  return out.join("")
}

/**
 * The statements as spans, read from the lexical view so only a real statement can open one, and
 * so a module specifier's own text cannot close one early. Offsets carry over unchanged, which is
 * what lets a mention found in the source be attributed to the span it sits in.
 */
function importStatementsIn(source: string) {
  const lexical = withoutLiteralText(source)
  const pattern = new RegExp(IMPORT_STATEMENT, "gm")
  const spans: { start: number; text: string }[] = []
  for (let hit = pattern.exec(lexical); hit !== null; hit = pattern.exec(lexical))
    spans.push({ start: hit.index, text: hit[0] })
  return spans
}

/**
 * Blank out import statements, keeping every offset. Imports are the one place the factory's name
 * legitimately appears without being called, so they are removed before that rule is applied —
 * and an import that renames it (`… as buildConsumer`) then leaves zero calls, which is refused
 * by the same count.
 */
function withoutImports(source: string) {
  return importStatementsIn(source).reduce(
    (text, span) =>
      `${text.slice(0, span.start)}${span.text.replace(/[^\n]/g, " ")}${text.slice(span.start + span.text.length)}`,
    source,
  )
}

/**
 * What an import statement does with the factory's name, read from BOTH sides of it.
 *
 * R7's false green: only the right-hand side was read, so `import { buildConsumer as
 * createDeepLinkConsumer }` classified as an ordinary `imported` mention — any function at all
 * could wear the trusted name while the tree assertion stayed bit-for-bit unchanged. `as` makes a
 * second name whichever side it sits on, and a default / namespace / import-equals binding makes
 * one too: none of them can be followed to what they actually bind without a module resolver.
 */
function importMentionKind(statement: string, at: number) {
  const before = statement.slice(0, at)
  const after = statement.slice(at + CONSUMER_FACTORY.length)
  // `buildConsumer as NAME` and `* as NAME` put the `as` to the left; `NAME as buildConsumer` to
  // the right. Either way the name here is not the name the module exports.
  if (/\bas\s+$/.test(before) || /^\s*as\b/.test(after)) return "aliased"
  // Only a named specifier — inside the import clause's braces — names the export itself. A
  // default import (`import NAME from …`) or an import-equals (`import NAME = require(…)`) binds
  // the name to whatever that module chose to hand back, which is a second name again.
  return (before.match(/\{/g) ?? []).length > (before.match(/\}/g) ?? []).length ? "imported" : "aliased"
}

/**
 * Every parenthesised group that introduces a BODY: its closing paren is followed by `=>`, by `{`,
 * or by a simple return-type annotation on the way to either. Parameter lists are the shape that
 * matters, and reading them as regions rather than as one regex is what makes the parameter's own
 * shape irrelevant — annotated, defaulted, rest, destructured, or renamed in a destructuring
 * pattern all land inside the same region. Strings are skipped, so a paren inside one cannot open
 * a region; brackets nest, so an annotation's own parens do not close the outer one early.
 *
 * Deliberately generous: `catch (e) {`, `if (x) {` and `for (…) {` are read as parameter lists too.
 * Over-counting can only make `singleBinding` false — a red the author reads and explains — while
 * under-counting is what silently lets a shadowed consumer through.
 */
function bodyIntroducingGroups(source: string) {
  const groups: string[] = []
  const open: number[] = []
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "(") open.push(index)
    else if (char === ")") {
      const from = open.pop()
      // `\w` and `[]` cover a plain annotation (`: void`, `: Ref<T>[]`); anything with its own
      // parens or arrow in the return type is left to the arrow/brace forms above it.
      if (from !== undefined && /^\s*(?::[\w\s$.<>,|&[\]]*)?(?:=>|\{)/.test(source.slice(index + 1, index + 200)))
        groups.push(source.slice(from + 1, index))
    }
  }
  return groups
}

/**
 * How many times `name` is BOUND in this source: a declaration, a parameter in any shape, or a
 * catch clause. More than one means the uses below cannot be attributed to the consumer, because
 * two different variables answer to the same identifier.
 *
 * The parameter half is a region test rather than a pattern over the parameter itself. R5 walked
 * the pattern version with `;(consumeDeepLinks => { … })(rewired)` — a single arrow parameter needs
 * no parentheses at all — and the same hole was open for `(consumeDeepLinks: () => void)`,
 * `(consumeDeepLinks = rewired)`, `(...consumeDeepLinks)` and `({ consumeDeepLinks })`. Passing the
 * consumer as an argument (`makeEventListener(window, event, consumeDeepLinks)`) is still not a
 * binding: that group introduces no body.
 */
function bindingsOf(source: string, name: string) {
  // `\.\.\.` because a rest parameter puts a dot immediately before the name, and a dot is
  // otherwise what tells a member access apart from an identifier.
  const mentioned = new RegExp(`(^|[^\\w$.]|\\.\\.\\.)${name}\\b`)
  const declared = [
    new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`, "g"),
    // The parenthesis-free arrow parameter, which no region can catch because there is no region.
    new RegExp(`(^|[^\\w$.])${name}\\s*=>`, "g"),
  ].reduce((total, pattern) => total + (source.match(pattern) ?? []).length, 0)
  return declared + bodyIntroducingGroups(source).filter((group) => mentioned.test(group)).length
}

/**
 * Where the factory's name is spelled, how often, and as WHAT.
 *
 * `withoutImports` blanks the statement that would reveal an alias, so a module re-exporting the
 * factory under a second name (`export { createDeepLinkConsumer as buildConsumer }`) is invisible
 * to `deepLinkWiringIn`: layout.tsx's honest call still reads as the only one while a second
 * consumer built from the alias registers first and drains the buffer before it. Closing that at
 * the call site needs a module resolver. Closing it at the SOURCE needs only this, because a
 * second exported name cannot come into existence without the factory's own name appearing in the
 * file that creates it.
 *
 * Which is why comparing the SET OF FILES was not enough, and R6 walked it: put that same
 * re-export in the definition file — a file that is ALLOWED to spell the name — and the set is
 * bit-for-bit unchanged. So each mention is classified instead, and no module resolver is needed
 * for that either:
 *   * `declared` — the factory itself, `const`/`function`/`class` immediately before the name;
 *   * `applied` — the name immediately followed by `(`: its one call;
 *   * `imported` — an UNRENAMED named specifier inside an import statement, the only import shape
 *     in which this name is the exported name;
 *   * `aliased` — everything else, which is every way a second name is made: `as` on either side
 *     of it, a default or namespace or import-equals binding, `const build =
 *     createDeepLinkConsumer`, a bare `export { createDeepLinkConsumer }`.
 * Imports are classified rather than blanked, so a renaming import in a file that has no business
 * naming the factory at all still shows up here — including R7's reverse alias, which renames some
 * OTHER export into this name and would otherwise have read as an ordinary import.
 *
 * Bounded to `packages/app/src` and this package's `src` — see the header for what that leaves out.
 */
function factoryMentionsIn(source: string) {
  const clean = withoutComments(source)
  const imports = importStatementsIn(clean)
  const pattern = new RegExp(`\\b${CONSUMER_FACTORY}\\b`, "g")
  const kinds: string[] = []
  for (let hit = pattern.exec(clean); hit !== null; hit = pattern.exec(clean)) {
    const at = hit.index
    const before = clean.slice(0, at)
    const after = clean.slice(at + CONSUMER_FACTORY.length)
    const statement = imports.find((span) => at >= span.start && at < span.start + span.text.length)
    if (/\b(?:const|let|var|function|class)\s+$/.test(before)) kinds.push("declared")
    else if (/^\s*\(/.test(after)) kinds.push("applied")
    else if (statement) kinds.push(importMentionKind(statement.text, at - statement.start))
    else kinds.push("aliased")
  }
  return kinds
}

function factoryNameSites(files: SourceFile[]) {
  return files
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file.path))
    .map((file) => ({ path: relative(workspaceRoot, file.path), mentions: factoryMentionsIn(file.source) }))
    .filter((site) => site.mentions.length > 0)
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * Walk `body` outside strings and outside any bracket pair, reporting each top-level position.
 * Property order and line breaks are invisible to this; nesting and quoting are not.
 */
function scanTopLevel(body: string, visit: (char: string, index: number) => void) {
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if ("([{".includes(char)) depth += 1
    else if (")]}".includes(char)) depth -= 1
    else if (depth === 0) visit(char, index)
  }
}

/** Split on commas that are not inside brackets, parentheses, braces, or a string. */
function splitTopLevel(body: string): string[] {
  const cuts: number[] = []
  scanTopLevel(body, (char, index) => {
    if (char === ",") cuts.push(index)
  })
  const parts: string[] = []
  let from = 0
  for (const cut of [...cuts, body.length]) {
    parts.push(normalize(body.slice(from, cut)))
    from = cut + 1
  }
  return parts.filter((part) => part.length > 0)
}

/** The `key: value` separator, ignoring colons inside a type annotation, ternary, or string. */
function topLevelColon(entry: string): number {
  let at = -1
  scanTopLevel(entry, (char, index) => {
    if (char === ":" && at === -1) at = index
  })
  return at
}

interface ConsumerWiring {
  /** The const the consumer is bound to — what `onMount` must actually use. */
  binding: string
  /** Top-level `key: value` deps, whitespace-normalized, in source order. */
  entries: { key: string; value: string }[]
  /** Everything that is not a plain named dep: spreads, computed keys, anything exotic. */
  foreign: string[]
  /**
   * Where the binding is used: as the wake-up listener, and as the mount-time first drain — plus
   * whether those two uses can be attributed to it at all, which they cannot if the identifier is
   * bound more than once in the file.
   */
  usage: { listener: boolean; invoked: boolean; singleBinding: boolean }
}

function deepLinkWiringIn(source: string): ConsumerWiring {
  const clean = withoutImports(withoutComments(source))
  const marker = `${CONSUMER_FACTORY}(`
  const calls = clean.split(marker).length - 1
  // Any mention of the factory that is not a call is an alias, and an alias is a second factory
  // this judgement cannot see: `const build = createDeepLinkConsumer` puts the real construction
  // beyond every rule below, including the count on this line.
  const mentions = clean.split(new RegExp(`\\b${CONSUMER_FACTORY}\\b`)).length - 1
  if (mentions !== calls) throw new Error(`${CONSUMER_FACTORY} must not be aliased, only called`)
  if (calls !== 1) throw new Error(`expected exactly one ${CONSUMER_FACTORY} call, found ${calls}`)
  const callAt = clean.indexOf(marker)

  // A const, so the wiring `onMount` uses below cannot be reassigned out from under it.
  const binding = /const\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(clean.slice(0, callAt).trimEnd())?.[1]
  if (!binding) throw new Error("the deep-link consumer must be bound to a const at its call site")

  const open = clean.indexOf("{", callAt + marker.length)
  const argumentEnd = open === -1 ? Math.min(clean.length, callAt + marker.length + 40) : open
  const argument = normalize(clean.slice(callAt + marker.length, argumentEnd))
  if (argument !== "") throw new Error(`the consumer deps must be an inline object literal, found "${argument}"`)

  let depth = 0
  let end = -1
  for (let index = open; index < clean.length; index += 1) {
    if (clean[index] === "{") depth += 1
    else if (clean[index] === "}") {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end === -1) throw new Error("unterminated createDeepLinkConsumer call")

  const entries: ConsumerWiring["entries"] = []
  const foreign: string[] = []
  for (const part of splitTopLevel(clean.slice(open + 1, end))) {
    const colon = topLevelColon(part)
    const key = colon === -1 ? part : normalize(part.slice(0, colon))
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      foreign.push(part)
      continue
    }
    entries.push({ key, value: colon === -1 ? key : normalize(part.slice(colon + 1)) })
  }

  // Line breaks and a trailing comma are free here too; what is pinned is that the very consumer
  // built above is the one subscribed to the wake-up event AND drained once at mount.
  const used = clean.slice(end)
  return {
    binding,
    entries,
    foreign,
    usage: {
      listener: new RegExp(`makeEventListener\\(\\s*window\\s*,\\s*deepLinkEvent\\s*,\\s*${binding}\\s*,?\\s*\\)`).test(
        used,
      ),
      invoked: new RegExp(`(^|[^\\w$.])${binding}\\s*\\(\\s*\\)`).test(used),
      // …and that both of those uses can only mean the const above, because nothing else in the
      // file answers to that name.
      singleBinding: bindingsOf(clean, binding) === 1,
    },
  }
}

/** The deps as a lookup, with duplicate keys kept visible rather than collapsed. */
const depsOf = (wiring: ConsumerWiring) => wiring.entries.map((entry) => entry.key)
const depValue = (wiring: ConsumerWiring, key: string) =>
  wiring.entries.filter((entry) => entry.key === key).map((entry) => entry.value)

describe("Alpha route authority ratchet", () => {
  test.each(["main", "renderer"])("the detector bites on an out-of-manifest href and scheme parser in %s", (layer) => {
    const source = `
      const href = "/new-session?draftId=parallel"
      navigate(href)
      app.setAsDefaultProtocolClient("alpha-code")
      const parsed = new URL("opencode://new-session?directory=/tmp")
      if (parsed.hostname === "new-session") dispatch(parsed)
    `

    expect(violationsFor({ path: join(sourceRoot, layer, "fixture.ts"), source }).map((entry) => entry.rule)).toEqual([
      "href/to must use a manifest-derived href",
      "new-session path literals belong in the manifest",
      "deep-link scheme literal outside the manifest",
      "new URL plus hostname deep-link dispatch outside the manifest",
    ])
  })

  test("Alpha sources do not reintroduce a parallel route or deep-link codec", async () => {
    expect((await sourcesUnder(sourceRoot)).flatMap(violationsFor)).toEqual([])
  })

  test("the upstream layout directory stays free of a second deep-link codec", async () => {
    expect((await sourcesUnder(upstreamLayoutRoot)).flatMap(deepLinkViolationsFor)).toEqual([])
  })

  test("the deep-link detector bites on a revived upstream parser", () => {
    const source = `
      const url = new URL("opencode://new-session?directory=/tmp")
      if (url.hostname === "new-session") dispatch(url.searchParams.get("directory"))
    `
    expect(
      deepLinkViolationsFor({ path: join(upstreamLayoutRoot, "fixture.ts"), source }).map((entry) => entry.rule),
    ).toEqual(["deep-link scheme literal outside the manifest", "deep-link URL codec outside the manifest"])
  })

  test("the deep-link consumer module assembles no route of its own", async () => {
    const source = await Bun.file(upstreamDeepLinkModule).text()
    expect(violationsFor({ path: upstreamDeepLinkModule, source })).toEqual([])
  })

  test("the full rule set bites on a hand-assembled session href in the consumer module", () => {
    // The exact mutation the previous ratchet let through: rebuild the destination from the
    // delivery's directory instead of navigating to the href the manifest decoded.
    const source = "navigateWithSidebarReset(`/${base64Encode(link.directory)}/session`)"
    expect(violationsFor({ path: upstreamDeepLinkModule, source }).map((entry) => entry.rule)).toEqual([
      "parameterized session hrefs belong in the manifest",
    ])
  })

  test("layout.tsx calls the consumer instead of being one", async () => {
    const source = await Bun.file(upstreamLayoutFile).text()
    expect(consumerViolationsFor({ path: upstreamLayoutFile, source })).toEqual([])
  })

  const HONEST_DEPS = `
    enabled: () => server.isLocal(),
    buffer: () => window,
    openProject: (directory, navigate) => void openProject(directory, navigate),
    navigate: navigateWithSidebarReset,
    handoff: (directory, prompt) => setSessionHandoff(directory, { prompt }),
  `

  const MOUNTED = `
    onMount(() => {
      makeEventListener(window, deepLinkEvent, consumeDeepLinks)
      consumeDeepLinks()
    })
  `

  const wiringOf = (deps: string, mount = MOUNTED) =>
    deepLinkWiringIn(`const consumeDeepLinks = createDeepLinkConsumer({${deps}})\n${mount}`)

  test("layout.tsx hands the consumer its own primitives, unwrapped and unmapped", async () => {
    // Fallback to the executable judgement, not a substitute for it: see route-deep-link-consumer.
    const wiring = deepLinkWiringIn(await Bun.file(upstreamLayoutFile).text())

    expect(wiring.foreign).toEqual([])
    expect(depsOf(wiring).sort()).toEqual([...CONSUMER_DEPS].sort())
    expect(depValue(wiring, "navigate")).toEqual(["navigateWithSidebarReset"])
    expect(depValue(wiring, "buffer")).toEqual(["() => window"])
  })

  test("the consumer layout.tsx builds is the one it mounts", async () => {
    // Otherwise the honest deps above can sit next to a consumer nothing ever calls.
    const wiring = deepLinkWiringIn(await Bun.file(upstreamLayoutFile).text())
    expect(wiring.usage).toEqual({ listener: true, invoked: true, singleBinding: true })
  })

  test("reformatting and reordering the same wiring is not a violation", () => {
    // The judgement is structural, so equivalent source must stay green — a gate that reddens on
    // a line break teaches people to route around it.
    const wiring = wiringOf(`
      navigate:
        navigateWithSidebarReset,
      handoff: (directory, prompt) =>
        setSessionHandoff(SessionStateKey.from(server.scope(), SessionRouteKey.fromLegacy(base64Encode(directory))), {
          prompt,
        }),
      buffer: () =>
        window,
      enabled: () => server.isLocal(),
      openProject: (directory, navigate) => void openProject(directory, navigate),
    `)

    expect(wiring.foreign).toEqual([])
    expect(depsOf(wiring).sort()).toEqual([...CONSUMER_DEPS].sort())
    expect(depValue(wiring, "navigate")).toEqual(["navigateWithSidebarReset"])
    expect(depValue(wiring, "buffer")).toEqual(["() => window"])
    expect(wiring.usage).toEqual({ listener: true, invoked: true, singleBinding: true })
  })

  test("the wiring pin bites on a wrapped navigate and on a remapped buffer", () => {
    const wiring = wiringOf(`
      enabled: () => server.isLocal(),
      buffer: () => rewritten(window),
      openProject: (directory, navigate) => void openProject(directory, navigate),
      navigate: (href) => navigateWithSidebarReset(href + "/wrong"),
      handoff: (directory, prompt) => setSessionHandoff(directory, { prompt }),
    `)

    expect(depValue(wiring, "navigate")).not.toEqual(["navigateWithSidebarReset"])
    expect(depValue(wiring, "buffer")).not.toEqual(["() => window"])
  })

  test("the wiring pin bites on a spread that overrides the honest deps", () => {
    // The mutation a "does the source contain these two lines" pin waves through: both lines are
    // still there, verbatim, and a later spread replaces what they bound.
    const wiring = wiringOf(`${HONEST_DEPS},
      ...{
        buffer: () => rewritten(window),
        navigate: (href) => navigateWithSidebarReset(rewrite(href)),
      },
    `)

    expect(depValue(wiring, "navigate")).toEqual(["navigateWithSidebarReset"]) // the text pin sees nothing
    expect(wiring.foreign).toEqual([
      "...{ buffer: () => rewritten(window), navigate: (href) => navigateWithSidebarReset(rewrite(href)), }",
    ])
  })

  test("the wiring pin bites on a duplicate key that overrides the honest one", () => {
    const wiring = wiringOf(`${HONEST_DEPS},
      navigate: (href) => navigateWithSidebarReset(rewrite(href)),
    `)

    expect(depValue(wiring, "navigate")).toHaveLength(2)
    expect(depsOf(wiring).sort()).not.toEqual([...CONSUMER_DEPS].sort())
  })

  test("the wiring pin bites on a correct consumer that is never mounted", () => {
    // The other R3 bypass: keep the honest call site, then hand `onMount` something else.
    const wiring = wiringOf(
      HONEST_DEPS,
      `
      const noop = () => {}
      onMount(() => {
        makeEventListener(window, deepLinkEvent, noop)
        noop()
      })
    `,
    )

    expect(wiring.foreign).toEqual([])
    expect(depValue(wiring, "navigate")).toEqual(["navigateWithSidebarReset"])
    expect(wiring.usage).toEqual({ listener: false, invoked: false, singleBinding: true })
  })

  test("deps assembled somewhere else are refused, not waved through", () => {
    // Accepted trade-off: hoisting the deps out would put the wiring back beyond reach, so it is
    // a hard error rather than a silent pass. The refusal names the reason.
    expect(() => deepLinkWiringIn("const consumeDeepLinks = createDeepLinkConsumer(deps)")).toThrow(
      /inline object literal/,
    )
  })

  test("a consumer that is not bound to a const is refused outright", () => {
    expect(() => deepLinkWiringIn("register(createDeepLinkConsumer({ a: 1 }))")).toThrow(/bound to a const/)
  })

  test("a second consumer call site is refused outright", () => {
    const doubled = "createDeepLinkConsumer({ a: 1 })\ncreateDeepLinkConsumer({ b: 2 })"
    expect(() => deepLinkWiringIn(doubled)).toThrow(/exactly one/)
  })

  test("taking the factory under a second name is refused, so the count cannot be dodged", () => {
    // Half of the R4 bypass: the alias is invisible to a count of `createDeepLinkConsumer(`, so
    // the honest call above stays the only one this judgement can see while a second consumer is
    // built from the same factory.
    const aliased = `
      const buildConsumer = createDeepLinkConsumer
      const consumeDeepLinks = createDeepLinkConsumer({${HONEST_DEPS}})
      onMount(() => {
        const rewired = buildConsumer({ buffer: () => rewritten(window) })
        makeEventListener(window, deepLinkEvent, rewired)
        rewired()
      })
    `
    expect(() => deepLinkWiringIn(aliased)).toThrow(/must not be aliased/)
  })

  test("importing the factory under a second name leaves nothing to judge, and says so", () => {
    const renamed = `
      import { createDeepLinkConsumer as buildConsumer } from "./layout/deep-links"
      const consumeDeepLinks = buildConsumer({${HONEST_DEPS}})
    `
    expect(() => deepLinkWiringIn(renamed)).toThrow(/exactly one/)
  })

  test("re-declaring the same name inside onMount is a different binding, and is seen as one", () => {
    // The other half: every name-based assertion still passes — the deps are honest, `foreign` is
    // empty, and the identifier `onMount` subscribes and calls is spelled exactly right. It is
    // simply a different variable, which is why the judgement counts bindings and not spellings.
    const shadowed = deepLinkWiringIn(`
      const consumeDeepLinks = createDeepLinkConsumer({${HONEST_DEPS}})
      onMount(() => {
        const consumeDeepLinks = () => elsewhere()
        makeEventListener(window, deepLinkEvent, consumeDeepLinks)
        consumeDeepLinks()
      })
    `)

    expect(shadowed.foreign).toEqual([])
    expect(depValue(shadowed, "navigate")).toEqual(["navigateWithSidebarReset"])
    expect(shadowed.usage).toEqual({ listener: true, invoked: true, singleBinding: false })
  })

  test("a parameter that shadows the binding is a re-binding too", () => {
    const shadowed = deepLinkWiringIn(`
      const consumeDeepLinks = createDeepLinkConsumer({${HONEST_DEPS}})
      onMount(() => {
        withRewrittenBuffer((consumeDeepLinks) => {
          makeEventListener(window, deepLinkEvent, consumeDeepLinks)
          consumeDeepLinks()
        })
      })
    `)

    expect(shadowed.usage).toEqual({ listener: true, invoked: true, singleBinding: false })
  })

  // R5's executable false green, and the family it belongs to: the previous pattern demanded the
  // identifier sit immediately next to a comma or the closing paren, so every parameter shape that
  // is not a bare name walked straight past it — starting with the one that has no parentheses at
  // all. Each of these mounts a DIFFERENT function under the same spelling.
  test.each([
    ["no parentheses at all", "consumeDeepLinks => {"],
    ["a type annotation", "(consumeDeepLinks: () => void) => {"],
    ["a default value", "(consumeDeepLinks = rewired) => {"],
    ["a rest parameter", "(...consumeDeepLinks) => {"],
    ["a destructuring pattern", "({ consumeDeepLinks }) => {"],
    ["a renamed destructuring pattern", "({ inner: consumeDeepLinks }) => {"],
  ])("a shadowing parameter written with %s is still a re-binding", (_shape, parameters) => {
    const shadowed = deepLinkWiringIn(`
      const consumeDeepLinks = createDeepLinkConsumer({${HONEST_DEPS}})
      onMount(() => {
        ;(${parameters}
          makeEventListener(window, deepLinkEvent, consumeDeepLinks)
          consumeDeepLinks()
        })(rewired)
      })
    `)

    expect(shadowed.usage).toEqual({ listener: true, invoked: true, singleBinding: false })
  })

  test("the factory's name is spelled three times in the tree: declared, imported, called", async () => {
    // Two files, and inside them exactly the mentions the honest wiring needs. A count of FILES
    // would leave room for a second exported name inside either of them.
    const sources = [...(await sourcesUnder(upstreamAppRoot)), ...(await sourcesUnder(sourceRoot))]

    expect(factoryNameSites(sources)).toEqual([
      { path: "packages/app/src/pages/layout.tsx", mentions: ["imported", "applied"] },
      { path: "packages/app/src/pages/layout/deep-links.ts", mentions: ["declared"] },
    ])
  })

  // R7's false green, and the family it belongs to. The classification read only the RIGHT of the
  // name, so an import that renames some OTHER export INTO the factory's name looked exactly like
  // the honest `import { createDeepLinkConsumer }`: every mention in the tree stayed `imported` /
  // `applied` / `declared`, and any `buildConsumer` could wear the trusted name. A default,
  // namespace or import-equals binding is the same class — the name is this file's choice, not the
  // module's export.
  test.each([
    ["a reverse alias", `import { buildConsumer as ${CONSUMER_FACTORY} } from "./layout/consumer-alias"`],
    ["a default import", `import ${CONSUMER_FACTORY} from "./layout/consumer-alias"`],
    ["a namespace import", `import * as ${CONSUMER_FACTORY} from "./layout/consumer-alias"`],
    ["an import-equals", `import ${CONSUMER_FACTORY} = require("./layout/consumer-alias")`],
  ])("%s that takes the factory's name is an alias, and the tree judgement reddens", (_shape, statement) => {
    const source = `
      ${statement}
      const consumeDeepLinks = ${CONSUMER_FACTORY}({${HONEST_DEPS}})
      ${MOUNTED}
    `

    // The wiring judgement reads this call site as perfect — `withoutImports` blanked the statement
    // that renamed something else into the name — so, as with the R6 re-export, the alias has to be
    // caught where it is CREATED.
    expect(deepLinkWiringIn(source).usage).toEqual({ listener: true, invoked: true, singleBinding: true })
    expect(factoryNameSites([{ path: upstreamLayoutFile, source }])).toEqual([
      { path: "packages/app/src/pages/layout.tsx", mentions: ["aliased", "applied"] },
    ])
  })

  test("an unrenamed named import is the one import shape that is not an alias", () => {
    // The other direction: the honest tree above must stay green, or the gate reddens on itself.
    expect(factoryMentionsIn(`import { ${CONSUMER_FACTORY}, deepLinkEvent } from "./layout/deep-links"`)).toEqual([
      "imported",
    ])
  })

  test("an import faked inside a template literal cannot swallow the real one", () => {
    // R8's false green. The statement span began at the template's line-beginning `import {` and ran
    // on to the next quoted string, taking the real default import with it — which then read as an
    // unrenamed named specifier, because the `{` faked inside the template was never closed. Any
    // module's default export could wear the trusted name with every mention in the tree unchanged.
    const source = [
      "const parserBait = `",
      "import {",
      "`",
      "void parserBait",
      `import ${CONSUMER_FACTORY} from "./layout/consumer-alias"`,
      `const consumeDeepLinks = ${CONSUMER_FACTORY}({${HONEST_DEPS}})`,
      MOUNTED,
    ].join("\n")

    // Same as the other alias shapes: the call site reads as perfect, and the alias is caught where
    // it is created.
    expect(deepLinkWiringIn(source).usage).toEqual({ listener: true, invoked: true, singleBinding: true })
    expect(factoryNameSites([{ path: upstreamLayoutFile, source }])).toEqual([
      { path: "packages/app/src/pages/layout.tsx", mentions: ["aliased", "applied"] },
    ])
  })

  test("import-shaped text inside a template — nested substitutions included — is text, not a statement", () => {
    // And the other direction again: blanking literal text must not cost the honest tree a green.
    // The inner statement sits inside a template nested in a `${…}` substitution, which is where a
    // whiteout that does not follow the nesting would either stop early or run past the end.
    const source = [
      `import { ${CONSUMER_FACTORY} } from "./layout/deep-links"`,
      "const doc = `",
      'import { anything as somethingElse } from "./elsewhere"',
      "${nested(`",
      'import { deeper } from "./deeper"',
      "`)}",
      "`",
      `const consumeDeepLinks = ${CONSUMER_FACTORY}({${HONEST_DEPS}})`,
      MOUNTED,
    ].join("\n")

    expect(deepLinkWiringIn(source).usage).toEqual({ listener: true, invoked: true, singleBinding: true })
    expect(factoryNameSites([{ path: upstreamLayoutFile, source }])).toEqual([
      { path: "packages/app/src/pages/layout.tsx", mentions: ["imported", "applied"] },
    ])
  })

  test("a convenience alias exported from the definition file itself is seen", async () => {
    // R6's bypass, and the reason the judgement counts mentions rather than files: the alias lives
    // in a file that MAY name the factory, layout.tsx imports it under the second name (which
    // `withoutImports` blanks), and the executed tests only ever run the factory itself. The file
    // set is identical to the honest tree's; the mentions inside the definition file are not.
    const source = `${await Bun.file(upstreamDeepLinkModule).text()}\nexport { createDeepLinkConsumer as buildConsumer }\n`

    expect(factoryNameSites([{ path: upstreamDeepLinkModule, source }])).toEqual([
      { path: "packages/app/src/pages/layout/deep-links.ts", mentions: ["declared", "aliased"] },
    ])
  })

  test("a module re-exporting the factory under a second name is seen, though the wiring is not", () => {
    // The wiring judgement reads this call site as perfect: honest deps, one factory call, one
    // binding, subscribed and drained. It is still defeated — the aliased consumer drains the
    // buffer first and the honest one then drains nothing. The import that would give it away was
    // blanked, so the alias has to be caught where it is CREATED instead.
    const wiring = deepLinkWiringIn(`
      import { buildConsumer } from "./layout/consumer-alias"
      const consumeDeepLinks = createDeepLinkConsumer({${HONEST_DEPS}})
      onMount(() => {
        const rewired = buildConsumer({ buffer: () => rewritten(window) })
        rewired()
        makeEventListener(window, deepLinkEvent, consumeDeepLinks)
        consumeDeepLinks()
      })
    `)
    expect(wiring.foreign).toEqual([])
    expect(wiring.usage).toEqual({ listener: true, invoked: true, singleBinding: true })

    expect(
      factoryNameSites([
        {
          path: join(upstreamLayoutRoot, "consumer-alias.ts"),
          source: `export { createDeepLinkConsumer as buildConsumer } from "./deep-links"`,
        },
      ]),
    ).toEqual([{ path: "packages/app/src/pages/layout/consumer-alias.ts", mentions: ["aliased"] }])
  })

  test("the consumer detector bites when dispatch moves back into layout.tsx", () => {
    const source = `
      for (const link of collectNewSessionDeepLinks(links)) {
        navigateWithSidebarReset(\`/\${base64Encode(link.directory)}/session\`)
      }
    `
    expect(consumerViolationsFor({ path: upstreamLayoutFile, source }).map((entry) => entry.rule)).toEqual([
      "deep-link dispatch belongs in the ratcheted deep-links module",
    ])
  })
})
