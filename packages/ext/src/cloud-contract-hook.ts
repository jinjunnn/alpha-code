import { ContractIncompatibleError, decodeContract, decodeJsonContract, type ContractName } from "@alpha-code/contracts-consumer"

const CLOUD_TOOLS = new Set(["cloud_dispatch", "cloud_status", "cloud_await", "cloud_artifacts"])

export function validateCloudToolInput(tool: string, args: unknown): void {
  if (tool !== "cloud_dispatch") return
  decodeContract("CloudJobRequestV1", args, "cloud-mcp")
}

type CloudToolOutput = {
  output?: string
  metadata?: unknown
  structuredContent?: unknown
  content?: Array<{ type?: unknown; text?: unknown }>
}

export function validateCloudToolOutput(tool: string, output: CloudToolOutput): void {
  if (!CLOUD_TOOLS.has(tool)) return
  if (tool === "cloud_dispatch") {
    validateOutputContract("CloudJobAcceptedV1", output)
    return
  }
  if (tool === "cloud_artifacts") {
    validateOutputContract("ArtifactListV1", output)
    return
  }
  validateOutputContract("CloudJobStatusV1", output)
}

function validateOutputContract(contract: ContractName, output: CloudToolOutput) {
  if (output.structuredContent !== undefined && output.structuredContent !== null) {
    decodeContract(contract, output.structuredContent, "cloud-mcp")
    return
  }
  const text = output.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text
  if (typeof text === "string") {
    decodeJsonContract(contract, text, "cloud-mcp")
    return
  }
  if (typeof output.output === "string") {
    decodeJsonContract(contract, output.output, "cloud-mcp")
    return
  }
  if (output.metadata && typeof output.metadata === "object" && !Array.isArray(output.metadata)) {
    decodeContract(contract, output.metadata, "cloud-mcp")
    return
  }
  throw new ContractIncompatibleError({
    surface: "cloud-mcp",
    received_version: "missing",
    reason: "schema-validation",
  })
}
