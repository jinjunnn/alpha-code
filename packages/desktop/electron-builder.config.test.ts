import { expect, test } from "bun:test"
import { join } from "node:path"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"
const sourceRoot = join(import.meta.dir, "src")

const channels = [
  { channel: "dev", appId: "ai.opencode.desktop.dev" },
  { channel: "beta", appId: "ai.opencode.desktop.beta" },
  { channel: "prod", appId: "ai.opencode.desktop" },
] as const

/**
 * The keys electron-builder turns into an OS-level URL-scheme registration. All of them nest, so
 * this is matched by SHAPE at any depth rather than at a known path: `protocols` blocks sit at the
 * root or per platform (`mac`, `win`, …); `CFBundleURLTypes` / `CFBundleURLSchemes` reach the same
 * macOS Info.plist through `mac.extendInfo`, which is the documented way to register a scheme
 * without ever writing the word `protocols` (https://www.electron.build/mac).
 */
const SCHEME_REGISTRATION_KEYS = ["protocols", "schemes", "CFBundleURLTypes", "CFBundleURLSchemes"]

/**
 * Every place electron-builder can turn into an OS-level URL-scheme registration, found by shape
 * rather than by name: the keys above, plus a Linux desktop entry registering a scheme through a
 * `MimeType=x-scheme-handler/…` line, which no `opencode://` grep would ever see. The runtime
 * handling is gone (baseline §5.2), so ANY surviving registration is the "OS wakes the app, app
 * drops the URL" break — installer metadata is exactly where such a leftover hides from the
 * runtime tests.
 *
 * Deliberately NOT covered, because closing them means parsing files this config only names
 * (baseline §5.3): the CONTENT of an `nsis.include` / `nsis.script` script, which can write the
 * Windows registration keys itself, and the content of any FURTHER `.desktop` file shipped through
 * `deb.fpm` / `rpm.fpm` beyond the one asserted below. Both are cheap to add the day either
 * appears; claiming them now would be the false green this function exists to remove.
 */
function schemeRegistrationsIn(value: unknown, path = "config"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => schemeRegistrationsIn(entry, `${path}[${index}]`))
  if (typeof value === "string") return value.includes("x-scheme-handler") ? [path] : []
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, entry]) =>
    SCHEME_REGISTRATION_KEYS.includes(key) ? [`${path}.${key}`] : schemeRegistrationsIn(entry, `${path}.${key}`),
  )
}

for (const channel of channels) {
  test(`registers no URL scheme for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?protocols=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.protocols).toBeUndefined()
    expect(schemeRegistrationsIn(config)).toEqual([])
  })

  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.deb?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode.desktop %U")
  expect(desktop).toContain("Icon=ai.opencode.desktop")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
  // The other bare-scheme registration Linux offers, and the one a `opencode://` grep misses.
  expect(schemeRegistrationsIn(desktop.split("\n"))).toEqual([])
})

test("the shape scan sees a registration written through mac.extendInfo", async () => {
  // The mutation the key-name pin waved through: no `protocols`, no `schemes`, no `opencode://`
  // string, and the packaged app still declares the URL scheme in its Info.plist.
  const smuggled = { mac: { extendInfo: { CFBundleURLTypes: [{ CFBundleURLSchemes: ["opencode"] }] } } }
  expect(schemeRegistrationsIn(smuggled)).toEqual(["config.mac.extendInfo.CFBundleURLTypes"])

  // …and the shipping config is clean under that same scan, not merely under the old one.
  const module = await import("./electron-builder.config.ts?extendinfo=prod")
  expect(schemeRegistrationsIn((module.default as Configuration).mac)).toEqual([])
})

test("no runtime registers a scheme behind the installer metadata's back", async () => {
  // `app.setAsDefaultProtocolClient()` registers a URI handler without touching any config the
  // scan above can read, so it is the one registration surface that has to be asserted in source.
  const sources = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: sourceRoot, absolute: true }))
  const offenders: string[] = []
  for (const path of sources.sort()) {
    if (/\bsetAsDefaultProtocolClient\b/.test(await Bun.file(path).text())) offenders.push(path)
  }
  expect(offenders).toEqual([])
  expect(sources.length).toBeGreaterThan(0) // a glob that matches nothing is not a pass
})
