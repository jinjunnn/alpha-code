// REQ-235 `cloud@1`(冻结面 F3)载荷解码。三组判据:
//   · 语料那条 `cloud-v1` 原样解出、宿主支持 token 为空集(授权能力另由 main 派生,见 package-admission);
//   · **schema 与 decoder 的每一条界逐字对齐** —— 界从发布出去的 schema 里读,探针在界上必须收、
//     越界一格必须拒。decoder 是逐档案手写的,两份文法分开维护,对不上就是「过了发布端 schema 却被宿主
//     拒掉」(或反过来放进来);
//   · schema 表达不了、只由宿主判的不变量(name 不重、option 不重、default ∈ options、min ≤ max)。

import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  decodePackageProfilePayloadV1,
  derivePayloadCapabilitiesV1,
  type CloudPayloadV1,
} from "./decoder"
import { HOST_EXTENSION_PACKAGE_CORPUS } from "./generate-artifact"

type Json = Record<string, unknown>

const schema = (await Bun.file(resolve(import.meta.dir, "profiles/cloud.v1.schema.json")).json()) as {
  properties: { behavior: { required: string[]; properties: Record<string, Json> } }
  $defs: Record<string, Json & { properties?: Record<string, Json> }>
}
const corpus = (await Bun.file(resolve(import.meta.dir, HOST_EXTENSION_PACKAGE_CORPUS)).json()) as {
  cases: Array<{ name: string; components: Array<{ id: string; payload: Json | null }> }>
}
const corpusPayload = corpus.cases.find((item) => item.name === "cloud-v1")!.components[0]!.payload as CloudPayloadV1

const behaviorProps = schema.properties.behavior.properties
const defs = schema.$defs
const num = (node: Json | undefined, key: string) => {
  const value = node?.[key]
  if (typeof value !== "number") throw new Error(`schema bound ${key} missing`)
  return value
}

const text = (overrides: Json = {}) => ({ name: "prompt", control: "textarea", required: true, maxChars: 10, label: "L", ...overrides })
const select = (overrides: Json = {}) => ({
  name: "style",
  control: "select",
  required: false,
  options: [{ value: "a", label: "A" }],
  label: "L",
  ...overrides,
})
const behavior = (overrides: Json = {}) => ({
  pipelineKind: "example",
  fields: [text()],
  fixed: [],
  holdUsd: 0.3,
  upstreamData: ["Sends the prompt."],
  ...overrides,
})
const decode = (value: Json, capabilities: string[] = []) =>
  decodePackageProfilePayloadV1(
    "cloud",
    new TextEncoder().encode(JSON.stringify({ schema: "alpha.host-extension-package.payload.cloud.v1", behavior: value })),
    capabilities as never,
  )
const accepts = (value: Json) => decode(value).ok
const range = (count: number, make: (index: number) => Json) => Array.from({ length: count }, (_, index) => make(index))

describe("cloud@1 payload (REQ-235 F3)", () => {
  test("the corpus case decodes verbatim and derives no host support token", () => {
    const decoded = decodePackageProfilePayloadV1(
      "cloud",
      new TextEncoder().encode(JSON.stringify(corpusPayload)),
      [],
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.payload).toEqual(corpusPayload)
    expect(derivePayloadCapabilitiesV1(decoded.payload)).toEqual([])
    // 组件自报的 token 必须等于派生集(空)—— 载荷不能借 cloud 偷带一个宿主能力。
    expect(decode(behavior(), ["alpha.secret-prerequisite.v1"]).ok).toBe(false)
  })

  test("the behavior key set is exactly the schema's, and every one of them is required", () => {
    expect(Object.keys(behaviorProps).sort()).toEqual(["fields", "fixed", "holdUsd", "pipelineKind", "upstreamData"])
    expect([...schema.properties.behavior.required].sort()).toEqual(Object.keys(behaviorProps).sort())
    for (const key of Object.keys(behaviorProps)) {
      const missing = behavior()
      delete (missing as Json)[key]
      expect(accepts(missing), key).toBe(false)
    }
    expect(accepts(behavior({ budget: { max_wall_clock_sec: 60 } }))).toBe(false)
  })

  test("array bounds come from the published schema: on the bound accepts, one past refuses", () => {
    const fieldsMax = num(behaviorProps.fields, "maxItems")
    const fixedMax = num(behaviorProps.fixed, "maxItems")
    const upstreamMin = num(behaviorProps.upstreamData, "minItems")
    const upstreamMax = num(behaviorProps.upstreamData, "maxItems")
    const optionsMin = num(defs.selectField!.properties!.options, "minItems")
    const optionsMax = num(defs.selectField!.properties!.options, "maxItems")
    expect([fieldsMax, fixedMax, upstreamMin, upstreamMax, optionsMin, optionsMax]).toEqual([16, 16, 1, 16, 1, 32])

    const fields = (count: number) => range(count, (index) => text({ name: `f${index}` }))
    expect(accepts(behavior({ fields: [] }))).toBe(true)
    expect(accepts(behavior({ fields: fields(fieldsMax) }))).toBe(true)
    expect(accepts(behavior({ fields: fields(fieldsMax + 1) }))).toBe(false)

    const fixed = (count: number) => range(count, (index) => ({ name: `x${index}`, value: "v" }))
    expect(accepts(behavior({ fixed: fixed(fixedMax) }))).toBe(true)
    expect(accepts(behavior({ fixed: fixed(fixedMax + 1) }))).toBe(false)

    expect(accepts(behavior({ upstreamData: range(upstreamMin - 1, () => ({})) }))).toBe(false)
    expect(accepts(behavior({ upstreamData: range(upstreamMax, (index) => `line ${index}`) as never }))).toBe(true)
    expect(accepts(behavior({ upstreamData: range(upstreamMax + 1, (index) => `line ${index}`) as never }))).toBe(false)

    const options = (count: number) => range(count, (index) => ({ value: `v${index}`, label: "O" }))
    expect(accepts(behavior({ fields: [select({ options: options(optionsMin - 1) })] }))).toBe(false)
    expect(accepts(behavior({ fields: [select({ options: options(optionsMax) })] }))).toBe(true)
    expect(accepts(behavior({ fields: [select({ options: options(optionsMax + 1) })] }))).toBe(false)
  })

  test("string bounds come from the published schema: on the bound accepts, one past refuses", () => {
    const cases: Array<[string, number, number, (value: string) => Json]> = [
      ["label", num(defs.label, "minLength"), num(defs.label, "maxLength"), (value) => behavior({ fields: [text({ label: value })] })],
      ["help", num(defs.help, "minLength"), num(defs.help, "maxLength"), (value) => behavior({ fields: [text({ help: value })] })],
      [
        "option.value",
        num(defs.option!.properties!.value, "minLength"),
        num(defs.option!.properties!.value, "maxLength"),
        (value) => behavior({ fields: [select({ options: [{ value, label: "O" }] })] }),
      ],
      [
        "option.label",
        num(defs.label, "minLength"),
        num(defs.label, "maxLength"),
        (value) => behavior({ fields: [select({ options: [{ value: "a", label: value }] })] }),
      ],
      [
        "fixed.value",
        num(defs.fixedInput!.properties!.value, "minLength"),
        num(defs.fixedInput!.properties!.value, "maxLength"),
        (value) => behavior({ fixed: [{ name: "format", value }] }),
      ],
      [
        "upstreamData[]",
        num(behaviorProps.upstreamData!.items as Json, "minLength"),
        num(behaviorProps.upstreamData!.items as Json, "maxLength"),
        (value) => behavior({ upstreamData: [value] }),
      ],
    ]
    expect(cases.map(([name, min, max]) => `${name}:${min}..${max}`)).toEqual([
      "label:1..80",
      "help:1..500",
      "option.value:1..256",
      "option.label:1..80",
      "fixed.value:1..4096",
      "upstreamData[]:1..500",
    ])
    for (const [name, min, max, make] of cases) {
      expect(accepts(make("a".repeat(min))), `${name} at min`).toBe(true)
      expect(accepts(make("a".repeat(min - 1))), `${name} below min`).toBe(false)
      expect(accepts(make("a".repeat(max))), `${name} at max`).toBe(true)
      expect(accepts(make("a".repeat(max + 1))), `${name} past max`).toBe(false)
    }
  })

  test("numeric bounds come from the published schema", () => {
    const maxChars = defs.textField!.properties!.maxChars!
    const minChars = defs.textField!.properties!.minChars!
    expect([num(maxChars, "minimum"), num(maxChars, "maximum"), num(minChars, "minimum"), num(minChars, "maximum")]).toEqual([
      1, 65536, 0, 65536,
    ])
    expect(accepts(behavior({ fields: [text({ maxChars: num(maxChars, "minimum") })] }))).toBe(true)
    expect(accepts(behavior({ fields: [text({ maxChars: num(maxChars, "minimum") - 1 })] }))).toBe(false)
    expect(accepts(behavior({ fields: [text({ maxChars: num(maxChars, "maximum") })] }))).toBe(true)
    expect(accepts(behavior({ fields: [text({ maxChars: num(maxChars, "maximum") + 1 })] }))).toBe(false)
    expect(accepts(behavior({ fields: [text({ maxChars: 1.5 })] }))).toBe(false)
    expect(accepts(behavior({ fields: [text({ minChars: num(minChars, "minimum") })] }))).toBe(true)
    expect(accepts(behavior({ fields: [text({ minChars: num(minChars, "minimum") - 1 })] }))).toBe(false)

    expect(num(behaviorProps.holdUsd, "minimum")).toBe(0)
    expect(accepts(behavior({ holdUsd: 0 }))).toBe(true)
    expect(accepts(behavior({ holdUsd: 1.5 }))).toBe(true)
    expect(accepts(behavior({ holdUsd: -0.01 }))).toBe(false)
    expect(accepts(behavior({ holdUsd: "0.30" }))).toBe(false)
  })

  test("the pipelineKind and input-name grammars agree with the published patterns on fixed probes", () => {
    const kindRe = new RegExp(behaviorProps.pipelineKind!.pattern as string)
    const nameRe = new RegExp(defs.inputName!.pattern as string)
    const kinds: Array<[string, boolean]> = [
      ["html-generate", true],
      ["image-generation", true],
      ["a", true],
      [`a${"b".repeat(63)}`, true],
      [`a${"b".repeat(64)}`, false],
      ["Html", false],
      ["1a", false],
      ["a_b", false],
      ["", false],
    ]
    for (const [kind, allowed] of kinds) {
      expect(kindRe.test(kind), `schema kind ${kind}`).toBe(allowed)
      expect(accepts(behavior({ pipelineKind: kind })), `decoder kind ${kind}`).toBe(allowed)
    }
    const names: Array<[string, boolean]> = [
      ["prompt", true],
      ["max_tokens", true],
      [`a${"b".repeat(63)}`, true],
      [`a${"b".repeat(64)}`, false],
      ["a-b", false],
      ["Prompt", false],
      ["_a", false],
      ["__proto__", false],
    ]
    for (const [name, allowed] of names) {
      expect(nameRe.test(name), `schema name ${name}`).toBe(allowed)
      expect(accepts(behavior({ fields: [text({ name })] })), `decoder field name ${name}`).toBe(allowed)
      expect(accepts(behavior({ fields: [], fixed: [{ name, value: "v" }] })), `decoder fixed name ${name}`).toBe(allowed)
    }
  })

  test("the control set is closed and each arm refuses the other arm's keys", () => {
    expect((defs.textField!.properties!.control as Json).enum).toEqual(["text", "textarea"])
    expect((defs.selectField!.properties!.control as Json).const).toBe("select")
    expect(Object.keys(defs.textField!.properties!).sort()).toEqual(
      ["control", "help", "label", "maxChars", "minChars", "name", "required"],
    )
    expect(Object.keys(defs.selectField!.properties!).sort()).toEqual(
      ["control", "default", "help", "label", "name", "options", "required"],
    )
    for (const control of ["text", "textarea"]) expect(accepts(behavior({ fields: [text({ control })] }))).toBe(true)
    for (const control of ["file", "code", "checkbox", "number", "", undefined])
      expect(accepts(behavior({ fields: [text({ control })] })), String(control)).toBe(false)
    expect(accepts(behavior({ fields: [text({ options: [{ value: "a", label: "A" }] })] }))).toBe(false)
    expect(accepts(behavior({ fields: [select({ maxChars: 10 })] }))).toBe(false)
    expect(accepts(behavior({ fields: [text({ maxChars: undefined })] }))).toBe(false)
    expect(accepts(behavior({ fields: [select({ options: undefined })] }))).toBe(false)
    expect(accepts(behavior({ fields: [text({ required: "yes" })] }))).toBe(false)
  })

  test("host-only invariants the schema cannot express refuse the whole payload", () => {
    expect(accepts(behavior({ fields: [text({ name: "prompt" }), text({ name: "prompt" })] }))).toBe(false)
    expect(accepts(behavior({ fields: [text({ name: "format" })], fixed: [{ name: "format", value: "html" }] }))).toBe(false)
    expect(accepts(behavior({ fields: [], fixed: [{ name: "format", value: "a" }, { name: "format", value: "b" }] }))).toBe(false)
    expect(accepts(behavior({ fields: [select({ options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] })] }))).toBe(false)
    expect(accepts(behavior({ fields: [select({ default: "a" })] }))).toBe(true)
    expect(accepts(behavior({ fields: [select({ default: "missing" })] }))).toBe(false)
    expect(accepts(behavior({ fields: [text({ minChars: 10, maxChars: 10 })] }))).toBe(true)
    expect(accepts(behavior({ fields: [text({ minChars: 11, maxChars: 10 })] }))).toBe(false)
    // 一个坏字段 = 整包坏,不是少一行的表单。
    expect(accepts(behavior({ fields: [text({ name: "ok" }), text({ name: "bad", control: "file" })] }))).toBe(false)
  })

  test("labels and help travel as inert text: control characters and markup-shaped strings", () => {
    expect(accepts(behavior({ fields: [text({ label: "a\u0007b" })] }))).toBe(false)
    expect(accepts(behavior({ fields: [text({ help: "line\nbreak" })] }))).toBe(false)
    // 形似标记的字符串是合法文本 —— 不在解码层「净化」,渲染层只作文本节点(见 cloud-form-box 判据)。
    const decoded = decode(behavior({ fields: [text({ label: "<img src=x onerror=alert(1)>" })] }))
    expect(decoded.ok).toBe(true)
    if (decoded.ok && decoded.payload.schema === "alpha.host-extension-package.payload.cloud.v1")
      expect(decoded.payload.behavior.fields[0]!.label).toBe("<img src=x onerror=alert(1)>")
  })
})
