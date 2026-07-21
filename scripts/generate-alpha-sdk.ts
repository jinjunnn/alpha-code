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

if (import.meta.main) {
  await $`./packages/sdk/js/script/build.ts`.cwd(root)
  await Bun.write(generatedTypesPath, patchPermissionDecisionTypes(await Bun.file(generatedTypesPath).text()))
}
