import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"

import { patchSidecarSharedRoutes } from "../../scripts/patch-sidecar-shared-routes"

const BEFORE = `webHandler = lazy3(() => exports_HttpRouter.toWebHandler(routes8, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware
  }));
function listenerLayer(opts, port2) {
  return exports_HttpRouter.serve(exports_server3.createRoutes(opts), {
    middleware: disposeMiddleware
  });
}
function startListener(opts, port2) {
  const scope3 = exports_Scope.makeUnsafe();
  return exports_Layer.buildWithMemoMap(listenerLayer(opts, port2), exports_Layer.makeMemoMapUnsafe(), scope3).pipe(other);
}`

const AFTER = `webHandler = lazy3(() => exports_HttpRouter.toWebHandler(routes8, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware
  }));
function listenerLayer(opts, port2) {
  return exports_HttpRouter.serve(opts.cors?.length === 1 && opts.cors[0] === "oc://renderer" ? exports_server3.routes : exports_server3.createRoutes(opts), {
    middleware: disposeMiddleware
  });
}
function startListener(opts, port2) {
  const scope3 = exports_Scope.makeUnsafe();
  return exports_Layer.buildWithMemoMap(listenerLayer(opts, port2), memoMap, scope3).pipe(other);
}`

describe("sidecar shared location map generated patch (#857)", () => {
  test("shares Default routes and memo map only for the fixed Electron CORS shape", () => {
    expect(patchSidecarSharedRoutes(BEFORE)).toBe(AFTER)
  })

  test("accepts generated identifier suffix changes without weakening the shape check", () => {
    const input = BEFORE.replaceAll("exports_HttpRouter", "httpRouter$91")
      .replaceAll("exports_server3", "server_bundle_42")
      .replaceAll("exports_Layer", "layer$7")
      .replaceAll("memoMap", "memoMap27")
      .replaceAll("port2", "port19")
      .replaceAll("scope3", "scope11")
    const output = patchSidecarSharedRoutes(input)
    expect(output).toContain("? server_bundle_42.routes : server_bundle_42.createRoutes(opts)")
    expect(output).toContain("buildWithMemoMap(listenerLayer(opts, port19), memoMap27, scope11)")
  })

  test("is idempotent only for the exact complete patch", () => {
    expect(patchSidecarSharedRoutes(AFTER)).toBe(AFTER)
  })

  test("fails closed when either production block is missing", () => {
    expect(() => patchSidecarSharedRoutes(BEFORE.replace("listenerLayer", "otherLayer"))).toThrow(
      "expected one listenerLayer block",
    )
    expect(() => patchSidecarSharedRoutes(BEFORE.replace("startListener", "otherStart"))).toThrow(
      "expected one startListener block",
    )
  })

  test("fails closed when the listener route is missing or duplicated", () => {
    expect(() => patchSidecarSharedRoutes(BEFORE.replace("createRoutes(opts)", "otherRoutes(opts)"))).toThrow(
      "expected one unpatched listener route",
    )
    expect(() => patchSidecarSharedRoutes(`${BEFORE}\n${BEFORE}`)).toThrow("expected one listenerLayer block")
  })

  test("fails closed when the listener memo construction is missing or duplicated", () => {
    expect(() => patchSidecarSharedRoutes(BEFORE.replace("makeMemoMapUnsafe()", "otherMemoMap()"))).toThrow(
      "expected one unpatched listener memo map",
    )
    const duplicateStart = `function startListener(opts, port7) {
  return exports_Layer.buildWithMemoMap(listenerLayer(opts, port7), exports_Layer.makeMemoMapUnsafe(), scope7).pipe(other);
}`
    expect(() => patchSidecarSharedRoutes(`${BEFORE}\n${duplicateStart}`)).toThrow("expected one startListener block")
  })

  test("rejects a partially applied patch or a different Default memo map", () => {
    const routeOnly = BEFORE.replace(
      "exports_server3.createRoutes(opts)",
      'opts.cors?.length === 1 && opts.cors[0] === "oc://renderer" ? exports_server3.routes : exports_server3.createRoutes(opts)',
    )
    expect(() => patchSidecarSharedRoutes(routeOnly)).toThrow("only partially applied")
    expect(() => patchSidecarSharedRoutes(AFTER.replace("memoMap, scope3", "otherMemo, scope3"))).toThrow(
      "different memo map than Default",
    )
  })

  test("prebuild invokes the strict patch after build-node and before the models boot-order patch", () => {
    const prebuild = readFileSync(resolve(import.meta.dir, "../../scripts/prebuild.ts"), "utf8")
    const build = prebuild.indexOf("script/build-node.ts")
    const shared = prebuild.indexOf("patch-sidecar-shared-routes.ts")
    const models = prebuild.indexOf("patch-plugin-internal-models.ts")
    expect(build).toBeGreaterThanOrEqual(0)
    expect(shared).toBeGreaterThan(build)
    expect(models).toBeGreaterThan(shared)
  })
})
