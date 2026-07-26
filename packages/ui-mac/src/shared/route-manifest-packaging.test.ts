// The installer's protocol metadata is what makes a COLD-START deep link reach the app at all:
// if it disagrees with the manifest the runtime registers against, the OS simply never hands the
// link over and every runtime test stays green. So this asserts the packaged artefact's actual
// configuration value — the production config module is executed here, not read as text.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getConfig, type Channel } from "../../electron-builder.config"
import { DEEP_LINK_SCHEMES } from "./route-manifest"

const CHANNELS: Channel[] = ["dev", "beta", "prod"]

describe("installer protocol registration comes from the route manifest", () => {
  test.each(CHANNELS)("%s ships exactly the manifest's schemes", (channel) => {
    const protocols = getConfig(channel).protocols
    expect(protocols).toBeDefined()
    expect((protocols as { schemes: string[] }).schemes).toEqual(DEEP_LINK_SCHEMES)
  })

  test("the manifest is the only place a scheme is spelled out", () => {
    // Deriving today is not enough: a future channel could paste a literal list back in and the
    // assertion above would still pass for the other two channels.
    const config = readFileSync(join(import.meta.dir, "../../electron-builder.config.ts"), "utf8")
    const schemeLists = [...config.matchAll(/schemes\s*:\s*\[([^\]]*)\]/g)].map((match) => match[1]!)
    expect(schemeLists.length).toBeGreaterThan(0)
    expect(schemeLists.filter((list) => /["'`]/.test(list))).toEqual([])
  })
})
