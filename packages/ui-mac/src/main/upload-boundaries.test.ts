import { describe, expect, test } from "bun:test"
import type { AutomationTask } from "../shared/automation-types"
import { cloudScheduleRegistrationFor } from "./cloud-schedule-config"
import { materializeCloudMcpConfig } from "./cloud-sidecar-config"
import { guardCloudEnvelope } from "./cloud-envelope-guard"

const hasUploadAuthorityReference = (value: unknown) =>
  /upload[_-]?consent|manifest_sha256|consent[_-]?token|x-alpha-upload-consent/i.test(JSON.stringify(value))

describe("upload authority is absent from non-explicit channels", () => {
  test("MCP schedule and bounded-agent surfaces have no upload consent channel", () => {
    const task: AutomationTask = {
      id: "task-1",
      name: "Daily research",
      nlText: "daily",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      target: { projectDir: "/project", agent: "alpha-automation" },
      prompt: "Research release notes",
      execution: "cloud",
      permissionProfile: "readonly",
      budget: { maxDurationMin: 15 },
      overlapPolicy: "skip",
      catchUpPolicy: "skip",
      notify: { system: true },
      enabled: true,
      createdAt: "2026-07-22T00:00:00.000Z",
    }
    const savedSchedule = cloudScheduleRegistrationFor(task, "0 9 * * *")
    const sidecar = materializeCloudMcpConfig("https://cloud.example/mcp", "{file:/safe/cloud-token}")
    const boundedAgent = guardCloudEnvelope({
      autonomy: "bounded-agent",
      objective: "Review the public release notes",
      capabilities: ["web_search"],
    })

    expect(hasUploadAuthorityReference(savedSchedule)).toBe(false)
    expect(hasUploadAuthorityReference(sidecar)).toBe(false)
    expect(boundedAgent.ok).toBe(true)
    expect(hasUploadAuthorityReference(boundedAgent)).toBe(false)
  })

  test("renderer or agent injection of upload authority hits upload-main-gate-required", () => {
    expect(
      guardCloudEnvelope({
        autonomy: "bounded-agent",
        objective: "work",
        capabilities: [],
        upload_consent: "forged",
      }),
    ).toEqual({ ok: false, error: "upload-main-gate-required" })
    expect(
      guardCloudEnvelope({
        autonomy: "pipeline",
        kind: "code-review",
        input: { manifest: { consent_required: false } },
      }),
    ).toEqual({ ok: false, error: "upload-main-gate-required" })
  })

  test("input.diff and code-review remain grandfathered", () => {
    expect(
      guardCloudEnvelope({ autonomy: "pipeline", kind: "code-review", input: { diff: "diff --git a/a b/a\n" } }).ok,
    ).toBe(true)
  })
})
