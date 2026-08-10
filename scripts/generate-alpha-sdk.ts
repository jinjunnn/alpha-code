#!/usr/bin/env bun

import { $ } from "bun"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const generatedTypesPath = `${root}/packages/sdk/js/src/v2/gen/types.gen.ts`

export function patchPermissionDecisionTypes(generatedTypes: string) {
  const permissionType = generatedTypes.match(
    /export type PermissionV2DecisionCommand =[\s\S]*?(?=\nexport type |$)/,
  )?.[0]
  if (!permissionType) throw new Error("Permission decision command type declaration was not generated")
  const permissionTypePatched = permissionType.replace(
    /(decision: ["']once["'] \| ["']reject["'][;,]?[\s\S]*?grantScope\?: )unknown([;,]?\s*grantExpiresAt\?: )unknown/,
    "$1never$2never",
  )
  if (permissionTypePatched === permissionType) {
    throw new Error("Permission decision forbidden grant field patch did not apply")
  }
  return generatedTypes.replace(permissionType, permissionTypePatched)
}

export function removeDuplicateToolDisplayTypes(generatedTypes: string) {
  const duplicate = generatedTypes.match(
    /\nexport type ToolDisplaySnapshotV11 = \{[\s\S]*?(?=\nexport type SessionStatus2 =)/,
  )?.[0]
  if (!duplicate) throw new Error("Duplicate generated tool display declarations were not found")
  if (!duplicate.includes("export type ToolPart1 =") || !duplicate.includes("display?: ToolDisplaySnapshotV11")) {
    throw new Error("Duplicate generated tool display declarations changed shape")
  }
  const declarations = Array.from(duplicate.matchAll(/\nexport type ([A-Za-z0-9_]+) =/g), (match) => match[1])
  const exportCount = duplicate.match(/\nexport /g)?.length ?? 0
  if (exportCount !== 2 || declarations.join(",") !== "ToolDisplaySnapshotV11,ToolPart1") {
    throw new Error("Duplicate generated tool display declarations contain an unexpected declaration")
  }
  const patched = generatedTypes.replace(duplicate, "")
  if (patched.includes("ToolDisplaySnapshotV11") || patched.includes("export type ToolPart1 =")) {
    throw new Error("Duplicate generated tool display declarations were not removed completely")
  }
  return patched
}

if (import.meta.main) {
  await $`./packages/sdk/js/script/build.ts`.cwd(root)
  const generatedTypes = await Bun.file(generatedTypesPath).text()
  await Bun.write(generatedTypesPath, patchPermissionDecisionTypes(removeDuplicateToolDisplayTypes(generatedTypes)))
}
