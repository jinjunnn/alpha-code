import { describe, expect, test } from "bun:test"
import {
  GENERIC_SETTINGS_ACCESS_ERROR,
  GENERIC_STORE_NAME_ERROR,
  RENDERER_SETTINGS_KEY,
  RENDERER_SETTINGS_STORE,
  assertGenericStoreAccess,
} from "./store-keys"

describe("generic renderer store Settings ratchet", () => {
  test("rejects get/set/delete access to the typed Settings authority target", () => {
    expect(() => assertGenericStoreAccess(RENDERER_SETTINGS_STORE, RENDERER_SETTINGS_KEY)).toThrow(
      GENERIC_SETTINGS_ACCESS_ERROR,
    )
  })

  test("rejects clearing the Settings authority store", () => {
    expect(() => assertGenericStoreAccess(RENDERER_SETTINGS_STORE)).toThrow(GENERIC_SETTINGS_ACCESS_ERROR)
  })

  test("rejects case-folded and Windows trailing aliases across get, set, delete and clear", () => {
    for (const name of ["DEFAULT.DAT", "default.dat.", "default.dat ", "DeFaUlT.DaT. "]) {
      expect(() => assertGenericStoreAccess(name, RENDERER_SETTINGS_KEY)).toThrow(GENERIC_SETTINGS_ACCESS_ERROR)
      expect(() => assertGenericStoreAccess(name)).toThrow(GENERIC_SETTINGS_ACCESS_ERROR)
    }
  })

  test("rejects path separator store aliases before a store can be opened", () => {
    for (const name of ["default.dat/settings.v3", "default.dat\\settings.v3"]) {
      expect(() => assertGenericStoreAccess(name, RENDERER_SETTINGS_KEY)).toThrow(GENERIC_STORE_NAME_ERROR)
      expect(() => assertGenericStoreAccess(name)).toThrow(GENERIC_STORE_NAME_ERROR)
    }
  })

  test("keeps unrelated stores and keys available", () => {
    expect(assertGenericStoreAccess(RENDERER_SETTINGS_STORE, "tabs.v1")).toBeUndefined()
    expect(assertGenericStoreAccess("opencode.global.dat", RENDERER_SETTINGS_KEY)).toBeUndefined()
    expect(assertGenericStoreAccess("opencode.global.dat. ", RENDERER_SETTINGS_KEY)).toBeUndefined()
  })
})
