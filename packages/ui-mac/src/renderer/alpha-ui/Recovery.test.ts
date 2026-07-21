import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { createComponent } from "solid-js"
import type { render } from "solid-js/web"
import type { RecoverySurface } from "./RecoverySurface"
import {
  RECOVERY_ACTIONS,
  RECOVERY_ACTION_RESULT_CODES,
  RECOVERY_CODES,
  type RecoveryAction,
  type RecoveryIncidentWire,
} from "../../shared/recovery"

type Runtime = {
  createComponent: typeof createComponent
  render: typeof render
  RecoverySurface: typeof RecoverySurface
}

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-recovery-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "recovery-test-runtime.ts"),
      formats: ["es"],
      fileName: () => "recovery-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(pathToFileURL(join(runtimeDirectory, "recovery-test-runtime.js")).href)) as Runtime

beforeEach(() => document.body.replaceChildren())
afterEach(() =>
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)
afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

const cases: RecoveryIncidentWire[] = [
  {
    incident: "db-corrupt",
    plan: {
      code: RECOVERY_CODES.databaseCorrupt,
      category: "database-corrupt",
      actions: [RECOVERY_ACTIONS.restoreLatestBackup, RECOVERY_ACTIONS.exitApp, RECOVERY_ACTIONS.continueStartup],
      retryable: false,
    },
  },
  {
    incident: "db-new",
    plan: {
      code: RECOVERY_CODES.databaseTooNew,
      category: "database-too-new",
      actions: [RECOVERY_ACTIONS.exitApp, RECOVERY_ACTIONS.backupAndContinue, RECOVERY_ACTIONS.continueStartup],
      retryable: false,
    },
  },
  {
    incident: "engine",
    plan: {
      code: RECOVERY_CODES.engineStopped,
      category: "engine-stopped",
      actions: [RECOVERY_ACTIONS.retryEngine],
      retryable: true,
    },
  },
  {
    incident: "surface",
    plan: {
      code: RECOVERY_CODES.surfaceCrashed,
      category: "surface-crashed",
      actions: [RECOVERY_ACTIONS.retryFailureSave],
      retryable: true,
    },
  },
  {
    incident: "surface-saved",
    plan: {
      code: RECOVERY_CODES.surfaceCrashed,
      category: "surface-crashed",
      actions: [],
      retryable: false,
    },
  },
]

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

function mount(incident: RecoveryIncidentWire) {
  const host = document.createElement("div")
  document.body.append(host)
  const submit = mock(async (action: RecoveryAction) => ({
    ok: true as const,
    code: RECOVERY_ACTION_RESULT_CODES.applied,
    action,
    applied: true as const,
  }))
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.RecoverySurface, {
          incident,
          submit: (_incident: string, action: RecoveryAction) => submit(action),
        }),
      host,
    ),
  )
  return submit
}

describe("Recovery real Solid render — four partitions plus the surface save-failure substate", () => {
  for (const incident of cases) {
    test(`${incident.plan.code} renders its truthful actions and submits the stable enum`, async () => {
      const submit = mount(incident)
      await flush()
      const surface = document.querySelector<HTMLElement>("[data-recovery-code]")!
      expect(surface.dataset.recoveryCode).toBe(incident.plan.code)
      expect(surface.getAttribute("aria-labelledby")).toBe("alpha-recovery-title")
      const buttons = [...surface.querySelectorAll<HTMLButtonElement>("button")]
      expect(buttons).toHaveLength(incident.plan.actions.length)
      if (buttons.length === 0) {
        expect(surface.textContent).toContain("页面暂时不可用")
        expect(submit).not.toHaveBeenCalled()
        return
      }
      buttons[0]!.click()
      await flush()
      expect(submit).toHaveBeenCalledTimes(1)
      expect(submit).toHaveBeenCalledWith(incident.plan.actions[0])
      expect(surface.querySelector("[role='status']")?.textContent).toContain("已完成")
    })
  }

  test("poison fields and raw identifiers never reach rendered text in either theme", async () => {
    const poison = "sk-secret /Users/alice/private/config.json C:\\Users\\alice\\key.txt"
    const incident = { ...cases[3], error: poison, path: poison, secret: poison } as RecoveryIncidentWire
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.dataset.colorScheme = theme
      mount(incident)
      await flush()
      expect(document.body.textContent).not.toContain("sk-secret")
      expect(document.body.textContent).not.toContain("/Users/")
      expect(document.body.textContent).not.toContain(":\\Users\\")
      expect(document.querySelector("[data-recovery-code='RECOVERY_SURFACE_CRASHED']")).not.toBeNull()
      disposers.pop()?.()
      document.body.replaceChildren()
    }
  })
})
