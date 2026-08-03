// Generic corpus asset for the `opencode-plugin` profile (REQ-128 Phase 4, alpha-web#129).
//
// These bytes are the **vendored source** the producer reads at generate time. The published
// corpus asset `contracts/extension-package/artifact/asset.generic-plugin.js` must equal this
// file byte for byte, and `payloadRef`/`behavior.asset` must be recomputed from the published
// bytes — `tests/package-compiler.test.mjs` asserts exactly that, independently of the
// generator. A producer that emits a hard-coded blob instead of reading this file passes a
// "digest equals a literal constant" assertion and fails that one.
//
// Nothing executes these bytes anywhere in this repository. They exist so the corpus carries a
// real single-file `.js` asset set; the real package's bytes arrive with the T7 catalog entry.

export default {
  id: "generic-plugin",
  async server() {
    return {
      event: async () => {},
      "permission.ask": async () => {},
    };
  },
};
