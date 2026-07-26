import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"

const channels = [
  { channel: "dev", appId: "ai.opencode.desktop.dev" },
  { channel: "beta", appId: "ai.opencode.desktop.beta" },
  { channel: "prod", appId: "ai.opencode.desktop" },
] as const

/**
 * Every place electron-builder can turn into an OS-level URL-scheme registration, found by shape
 * rather than by name: `protocols` blocks nest per platform (`mac`, `win`, …) and a Linux desktop
 * entry registers a scheme through a `MimeType=x-scheme-handler/…` line, which no `opencode://`
 * grep would ever see. The runtime handling is gone (baseline §5.2), so ANY surviving registration
 * is the "OS wakes the app, app drops the URL" break — installer metadata is exactly where such a
 * leftover hides from the runtime tests.
 */
function schemeRegistrationsIn(value: unknown, path = "config"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => schemeRegistrationsIn(entry, `${path}[${index}]`))
  if (typeof value === "string") return value.includes("x-scheme-handler") ? [path] : []
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "protocols" || key === "schemes"
      ? [`${path}.${key}`]
      : schemeRegistrationsIn(entry, `${path}.${key}`),
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
