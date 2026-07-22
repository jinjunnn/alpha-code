import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { decodeContract } from "@alpha-code/contracts-consumer"
import { validateCloudToolInput, validateCloudToolOutput } from "./cloud-contract-hook"

const fixture = (name: string) =>
  Bun.file(
    resolve(
      import.meta.dir,
      `../../alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/fixtures/producer/${name}.json`,
    ),
  ).json()

test("cloud HTTP and cloud MCP use the same pinned v1 decoder", async () => {
  const request = await fixture("cloud-job-request")
  const accepted = await fixture("cloud-job-accepted")
  expect(decodeContract("CloudJobRequestV1", request.value, "cloud-http")).toEqual(request.value)
  expect(() => validateCloudToolInput("cloud_dispatch", request.value)).not.toThrow()
  expect(() => validateCloudToolOutput("cloud_dispatch", { structuredContent: accepted.value })).not.toThrow()
  expect(() =>
    validateCloudToolOutput("cloud_dispatch", { content: [{ type: "text", text: JSON.stringify(accepted.value) }] }),
  ).not.toThrow()
})

test("cloud MCP rejects incompatible results as visible tool errors", async () => {
  const status = await fixture("cloud-job-status")
  status.value.status = "waiting"
  expect(() => validateCloudToolOutput("cloud_status", { output: "", metadata: status.value })).toThrow(
    "Alpha contract incompatible",
  )
})
