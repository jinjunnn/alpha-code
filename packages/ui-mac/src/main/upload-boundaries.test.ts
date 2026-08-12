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
    // `#733`:签名只剩一个参数(第二个参数是删掉的静态 bearer 的密钥文件引用)。
    // 这一处**不会**因为漏改而变红 —— `packages/ui-mac/tsconfig.json` 把 `*.test.ts` 排除在
    // typecheck 外,而 bun 直接剥类型:多传一个实参在运行时是静默忽略。所以它靠手工枚举改到,
    // 不靠编译器。判据见 CLAUDE.md《本机验证陷阱》「测试文件常被排除在 typecheck 外」。
    const sidecar = materializeCloudMcpConfig("https://cloud.example/mcp")
    const boundedAgent = guardCloudEnvelope({
      autonomy: "bounded-agent",
      objective: "Review the public release notes",
      capabilities: ["web_search"],
      // [#918] bounded-agent 必须显式声明工具集合(平台把「没声明」归一成零工具)。
      constraints: { allowed_tools: ["web"] },
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
