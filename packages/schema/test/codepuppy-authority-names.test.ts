// alpha-code#1568 AC3:来源证明 / 来源分类的取值是 `codepuppy-cloud` / `codepuppy-bundled`,
// schema 与两份 SDK 生成类型逐字一致。删掉或回退 schema 里的任一取值、或只改其中一份生成物,这里当场红。
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ToolClass } from "../src/alpha-tool-policy"
import { ToolAuthority } from "../src/tool-identity"

const DIGEST = `sha256:${"a".repeat(64)}`
const kindsOf = (union: typeof ToolAuthority) =>
  (union.members as ReadonlyArray<{ fields: { kind: { literal: string } } }>).map((member) => member.fields.kind.literal)

/** 生成物里 `export type ToolAuthority = …` 那一段的全部 `kind: "<x>"`。 */
async function generatedKinds(path: string) {
  const text = await Bun.file(new URL(path, import.meta.url)).text()
  const block = text.match(/export type ToolAuthority =[\s\S]*?(?=\nexport type )/)?.[0]
  if (!block) throw new Error(`${path}: ToolAuthority declaration missing`)
  return Array.from(block.matchAll(/kind: "([^"]+)"/g), (match) => match[1])
}

describe("#1568 AC3 来源证明取值", () => {
  test("schema 的 authority kind 与 tool class 只用 codepuppy 取值", () => {
    expect(kindsOf(ToolAuthority)).toEqual(["not-asserted", "codepuppy-cloud", "codepuppy-bundled"])
    expect(ToolClass.literals).toEqual(["builtin", "codepuppy-cloud", "codepuppy-bundled", "third-party-mcp", "plugin"])
  })

  test("新取值能 decode,旧取值 alpha-cloud / alpha-bundled 被拒(不新旧并认)", () => {
    const decode = Schema.decodeUnknownSync(ToolAuthority)
    for (const kind of ["codepuppy-cloud", "codepuppy-bundled"]) {
      expect(decode({ kind, bindingId: "mcp:codepuppy", evidenceDigest: DIGEST })).toMatchObject({ kind })
    }
    for (const kind of ["alpha-cloud", "alpha-bundled"]) {
      expect(() => decode({ kind, bindingId: "mcp:codepuppy", evidenceDigest: DIGEST })).toThrow()
      expect(() => Schema.decodeUnknownSync(ToolClass)(kind)).toThrow()
    }
  })

  test("两份 SDK 生成类型的 ToolAuthority 与 schema 逐项一致", async () => {
    for (const path of ["../../sdk/js/src/gen/types.gen.ts", "../../sdk/js/src/v2/gen/types.gen.ts"]) {
      expect(await generatedKinds(path)).toEqual(kindsOf(ToolAuthority))
    }
  })
})
