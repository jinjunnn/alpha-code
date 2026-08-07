import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"

import { patchPluginInternalModels } from "../../scripts/patch-plugin-internal-models"

const BEFORE = `var layer72 = exports_Layer.effectDiscard(exports_Effect.gen(function* () {
    const add8 = function(input) {
      return plugin.add(input.id, input.effect);
    };
    yield* exports_state.batch(exports_Effect.gen(function* () {
      yield* add8(exports_reference4.Plugin);
      yield* add8(exports_agent7.Plugin);
      yield* add8(exports_command7.Plugin);
      yield* add8(exports_skill4.Plugin);
      yield* add8(ModelsDevPlugin);
      yield* add8(exports_agent6.Plugin);
    })).pipe(exports_Effect.withSpan("PluginInternal.boot"), exports_Effect.forkScoped({ startImmediately: true }));
  }));`

const AFTER = `var layer72 = exports_Layer.effectDiscard(exports_Effect.gen(function* () {
    const add8 = function(input) {
      return plugin.add(input.id, input.effect);
    };
    yield* add8(ModelsDevPlugin);
    yield* exports_state.batch(exports_Effect.gen(function* () {
      yield* add8(exports_reference4.Plugin);
      yield* add8(exports_agent7.Plugin);
      yield* add8(exports_command7.Plugin);
      yield* add8(exports_skill4.Plugin);
      yield* add8(exports_agent6.Plugin);
    })).pipe(exports_Effect.withSpan("PluginInternal.boot"), exports_Effect.forkScoped({ startImmediately: true }));
  }));`

describe("PluginInternal models.dev boot order (#857)", () => {
  test("moves the one ModelsDevPlugin registration before the outer batch", () => {
    expect(patchPluginInternalModels(BEFORE)).toBe(AFTER)
  })

  test("accepts generated identifier suffix changes without weakening the shape check", () => {
    const input = BEFORE.replaceAll("exports_state", "state_bundle_91").replaceAll("exports_Effect", "effect$3").replaceAll("add8", "add$42")
    const output = patchPluginInternalModels(input)
    expect(output.indexOf("yield* add$42(ModelsDevPlugin);")).toBeLessThan(output.indexOf("yield* state_bundle_91.batch"))
    expect(output.match(/ModelsDevPlugin/g)).toHaveLength(1)
  })

  test("is idempotent only for the exact already-patched placement", () => {
    expect(patchPluginInternalModels(AFTER)).toBe(AFTER)
  })

  test("fails closed when the boot marker or model registration is missing", () => {
    expect(() => patchPluginInternalModels(BEFORE.replace('withSpan("PluginInternal.boot")', 'withSpan("other")'))).toThrow(
      "expected one PluginInternal.boot block",
    )
    expect(() => patchPluginInternalModels(BEFORE.replace("ModelsDevPlugin", "OtherPlugin"))).toThrow(
      "expected one ModelsDevPlugin registration",
    )
  })

  test("fails closed on duplicate or structurally ambiguous targets", () => {
    expect(() => patchPluginInternalModels(BEFORE.replace("yield* add8(ModelsDevPlugin);", "yield* add8(ModelsDevPlugin);\n      yield* add8(ModelsDevPlugin);"))).toThrow(
      "expected one ModelsDevPlugin registration",
    )
    expect(() => patchPluginInternalModels(BEFORE.replace("yield* add8(exports_command7.Plugin);", "if (enabled) yield* add8(exports_command7.Plugin);"))).toThrow(
      "unexpected PluginInternal.boot prefix",
    )
  })

  test("prebuild invokes the strict patch after the embedded server is rebuilt", () => {
    const prebuild = readFileSync(resolve(import.meta.dir, "../../scripts/prebuild.ts"), "utf8")
    const build = prebuild.indexOf("script/build-node.ts")
    const patch = prebuild.indexOf("patch-plugin-internal-models.ts")
    expect(build).toBeGreaterThanOrEqual(0)
    expect(patch).toBeGreaterThan(build)
  })
})
