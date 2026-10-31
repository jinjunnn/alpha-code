/**
 * #1578 AC5 (REQ-236 §2.6-7, owner「路一」): the first-party extension plugin shipped with the app proves its own tools.
 *
 * The ext build writes `bundled-tools.json` next to `dist/plugin.js` (`packages/ext/scripts/build.ts`): the bundle's
 * sha256 and the names of the tools the bundle itself defines. Main points the engine at the packaged copy through
 * `ALPHA_EXT_BUNDLED_MANIFEST` (sidecar env, the same trust channel as the Office manifest); nothing next to a loaded
 * plugin is ever consulted, so a plugin cannot vouch for itself.
 *
 * A loaded plugin's tools get `codepuppy-bundled` only when the loader resolved it as a file plugin (the structured
 * `source`, never the origin string or install path) and the module file it imported hashes to the manifest's digest;
 * then only the tool names the manifest lists qualify. Project plugins merged into the extension's hooks
 * (`packages/ext/src/plugin-fanout.ts`) add names the manifest does not list, and cannot replace a listed one
 * (the extension's own keys win the merge). Anything else — npm source, another module, no manifest, an unreadable or
 * malformed one — proves nothing.
 */

import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { canonicalJsonDigest } from "@/permission/alpha-tool-policy-store"
import type { ToolAuthority } from "@opencode-ai/schema/tool-identity"

export const EXT_BUNDLED_MANIFEST_ENV = "ALPHA_EXT_BUNDLED_MANIFEST"

export type BundledPluginTools = {
  readonly authority: Extract<ToolAuthority, { kind: "codepuppy-bundled" }>
  readonly tools: ReadonlySet<string>
  /** #1568 AC5: listed tool → its display identifier (`codepuppy:<action>`) as declared in the extension's tool table. */
  readonly readable: ReadonlyMap<string, string>
}

export function bundledPluginTools(
  load: { source: "file" | "npm"; entry: string },
  env: Record<string, string | undefined>,
  readFile: (file: string) => Uint8Array,
): BundledPluginTools | undefined {
  const manifestPath = env[EXT_BUNDLED_MANIFEST_ENV]
  if (load.source !== "file" || !manifestPath) return undefined
  try {
    const manifest = JSON.parse(new TextDecoder().decode(readFile(manifestPath))) as {
      moduleSha256?: unknown
      tools?: unknown
      readable?: unknown
    }
    const tools = manifest.tools
    if (typeof manifest.moduleSha256 !== "string" || !Array.isArray(tools)) return undefined
    if (!tools.every((name): name is string => typeof name === "string" && name.length > 0)) return undefined
    // #1568 AC5: every listed tool declares exactly one display identifier; anything else is a malformed manifest.
    const readable = manifest.readable
    if (typeof readable !== "object" || readable === null || Array.isArray(readable)) return undefined
    const readableOf = new Map(Object.entries(readable))
    if (readableOf.size !== tools.length) return undefined
    if (!tools.every((name) => /^codepuppy:[a-z0-9_]+$/.test(String(readableOf.get(name))))) return undefined
    const entry = load.entry.startsWith("file:") ? fileURLToPath(load.entry) : load.entry
    const digest = createHash("sha256").update(readFile(entry)).digest("hex")
    if (digest !== manifest.moduleSha256) return undefined
    return {
      authority: {
        kind: "codepuppy-bundled",
        bindingId: "plugin:alpha-ext",
        evidenceDigest: canonicalJsonDigest({
          kind: "codepuppy-bundled-plugin",
          moduleSha256: digest,
          tools: [...tools].sort(),
        }),
      },
      tools: new Set(tools),
      readable: readableOf as Map<string, string>,
    }
  } catch {
    // Missing or unreadable manifest / module: nothing is proven; the tools stay third-party.
    return undefined
  }
}
