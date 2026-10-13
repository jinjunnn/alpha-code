import { afterAll, beforeAll, expect, test } from "bun:test"
import { loadConfigFromFile } from "electron-vite"
import { mkdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Browser } from "playwright-core"
import { build, createServer, type ViteDevServer } from "vite"

// Reuse the production composer/IPC fixture from test-visual/main.tsx. Replace its
// styles with the complete release renderer CSS: isolated tooltip.css misses #1501.
const evidence = resolve("node_modules/.cache/1501-tooltip")
let browser: Browser
let server: ViteDevServer
let css: string

beforeAll(async () => {
  rmSync(evidence, { recursive: true, force: true })
  mkdirSync(evidence, { recursive: true })
  const config = await loadConfigFromFile({ command: "build", mode: "production" })
  await build({
    ...config.config.renderer,
    configFile: false,
    envFile: false,
    logLevel: "error",
    build: { ...config.config.renderer!.build, outDir: resolve(evidence, "renderer"), sourcemap: false },
  })
  const html = await Bun.file(resolve(evidence, "renderer/index.html")).text()
  css = (
    await Promise.all(
      [...html.matchAll(/<link rel="stylesheet"[^>]+href="([^"]+)"/g)].map((match) =>
        Bun.file(resolve(evidence, "renderer", match[1]!.replace(/^\//, ""))).text(),
      ),
    )
  ).join("\n")
  expect(css).toContain(".a-tip{")
  expect(css).toContain(".a-ui{")
  server = await createServer({
    configFile: resolve("test-visual/vite.config.ts"),
    envFile: false,
    logLevel: "error",
    server: { port: 0, strictPort: false },
  })
  await server.listen()
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ??
      (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined),
  })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

for (const theme of ["dark", "light"] as const) {
  for (const input of ["hover", "keyboard"] as const) {
    test(`#1501 ${input === "hover" ? "AC1" : "AC2"} ${theme}: readable model tooltip${input === "keyboard" ? ", Escape/blur dismissal and picker click" : ""}`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 860 },
        locale: "zh-CN",
        colorScheme: theme,
      })
      try {
        await page.goto(`${server.resolvedUrls!.local[0]}?scene=menu-model&theme=${theme}`, {
          waitUntil: "networkidle",
        })
        const chip = page.locator(".a-chip-model")
        const model = await Bun.file(resolve("src/main/alpha-models.json")).json()
        const name = model.platformModels[0].name
        await chip.locator(".a-chip-label").filter({ hasText: name }).waitFor()
        await page.evaluate(() =>
          document.querySelectorAll("style, link[rel='stylesheet']").forEach((node) => node.remove()),
        )
        await page.addStyleTag({ content: css })
        if (input === "hover") await chip.hover()
        if (input === "keyboard") {
          // Tab from the preceding native button into the actual model chip.
          await chip.evaluate((node) => {
            const buttons = [...document.querySelectorAll("button")]
            buttons[buttons.indexOf(node as HTMLButtonElement) - 1]!.focus()
          })
          await page.keyboard.press("Tab")
          expect(await chip.evaluate((node) => node === document.activeElement)).toBe(true)
        }
        const tip = page.getByRole("tooltip")
        await tip.waitFor({ state: "visible" })
        const colors = await tip.evaluate((node) => ({
          textContent: node.textContent,
          color: getComputedStyle(node).color,
          backgroundColor: getComputedStyle(node).backgroundColor,
          fontSize: getComputedStyle(node).fontSize,
        }))
        await page.screenshot({ path: resolve(evidence, `${theme}-${input}.png`) })
        await Bun.write(resolve(evidence, `${theme}-${input}.json`), JSON.stringify(colors, null, 2))
        expect(colors.textContent).toBe(`选择模型 · ${name}`)
        expect(colors.backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
        expect(colors.color).not.toBe(colors.backgroundColor)
        if (input === "keyboard") {
          await page.keyboard.press("Escape")
          await tip.waitFor({ state: "hidden" })
          await page.keyboard.press("Shift+Tab")
          await page.keyboard.press("Tab")
          await tip.waitFor({ state: "visible" })
          await page.keyboard.press("Tab")
          await tip.waitFor({ state: "hidden" })
          await chip.click()
          expect(await chip.getAttribute("aria-expanded")).toBe("true")
          await page.locator(".a-pop-fixed").waitFor({ state: "visible" })
          await page.keyboard.press("Escape")
          await page.locator(".a-pop-fixed").waitFor({ state: "hidden" })
          await page.mouse.move(0, 0)
          await page.keyboard.press("Tab")
          await tip.waitFor({ state: "hidden" })
          await Bun.write(
            resolve(evidence, `${theme}-keyboard-actions.json`),
            JSON.stringify(
              {
                focusShowsTooltip: true,
                escapeHidesTooltip: true,
                blurHidesTooltip: true,
                clickOpensPicker: true,
              },
              null,
              2,
            ),
          )
        }
      } finally {
        await page.close()
      }
    }, 30_000)
  }
}
