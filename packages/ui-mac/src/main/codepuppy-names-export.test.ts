// alpha-code#1568 AC6 —— 第一方命名导出器(`scripts/export-codepuppy-names.ts`)的断言。
//
// 正例跑的是**真树**:导出器直接 import 每一层的权威(注入面常量、Office 登记表、扩展工具表、agent 文字表、schema、
// 随包模型目录、vendored 平台清单、随包 Office 工具清单),所以任何一层回退成旧名,这里当场红。
// 反例是改名前那棵树会导出的清单(名字逐字取自 7573fd5bf:cloud-web-search.ts:2、office-advisories.ts:80-98、
// context-injection.ts TOOL_TEXT 键、alpha-agents.ts 键、tool-identity.ts / alpha-tool-policy.ts、alpha-models.json:8;
// 当时远端名带 `cloud_` 前缀,扩展工具表还没有可读标识),证明判据看得见每一层的旧名。
import { describe, expect, test } from "bun:test"
import { codepuppyNameViolations, exportCodepuppyNames, type CodepuppyNames } from "../../scripts/export-codepuppy-names"

const PRE_RENAME: CodepuppyNames = {
  serverKeys: ["cloud", "alpha-word", "alpha-excel", "alpha-powerpoint", "alpha-pdf"],
  pluginTools: ["alpha_cloud_access", "alpha_reload", "alpha_register", "alpha_echo", "alpha_ping", "hub_search", "hub_install", "hub_status"].map(
    (id) => ({ id, readable: id }),
  ),
  agents: ["alpha-automation", "alpha-readonly", "alpha-automation-standard", "alpha-ask"],
  sourceClasses: ["builtin", "alpha-cloud", "alpha-bundled", "third-party-mcp", "plugin"],
  authorityKinds: ["not-asserted", "alpha-cloud", "alpha-bundled"],
  providerIds: ["alpha"],
  platformTools: ["cloud_dispatch", "cloud_web_search"],
  modelFunctionNames: ["alpha_cloud_access", "cloud_cloud_dispatch", "cloud_cloud_web_search", "alpha-word_read_docx"],
}

describe("#1568 AC6 第一方命名导出器", () => {
  test("真树:零违例;服务器键 / 插件工具 / 模式 / 来源分类 / 供应商 id 都是 codepuppy 形式", () => {
    const names = exportCodepuppyNames()
    expect(codepuppyNameViolations(names)).toEqual([])
    expect(names.serverKeys).toEqual(["codepuppy", "codepuppy-word", "codepuppy-excel", "codepuppy-powerpoint", "codepuppy-pdf"])
    expect(names.providerIds).toEqual(["codepuppy"])
    expect(names.modelFunctionNames).toContain("codepuppy_dispatch")
    expect(names.modelFunctionNames).toContain("codepuppy-word_read_docx")
    // 判据不是空跑:清单里真有东西可判。
    expect(names.modelFunctionNames.length).toBeGreaterThan(20)
  })

  test("改名前的树:每一层都被点名", () => {
    const violations = codepuppyNameViolations(PRE_RENAME)
    for (const layer of ["serverKeys", "pluginTools", "agents", "sourceClasses", "authorityKinds", "providerIds"])
      expect([layer, violations.some((line) => line.startsWith(`${layer}: old name`))]).toEqual([layer, true])
  })

  test("插件动作与平台工具撞名 ⇒ 点名(否则两边拼出同一个模型函数名)", () => {
    const names = exportCodepuppyNames()
    const clash = { ...names, pluginTools: [...names.pluginTools, { id: "codepuppy_dispatch", readable: "codepuppy:dispatch" }] }
    clash.modelFunctionNames = [...clash.modelFunctionNames, "codepuppy_dispatch"]
    const violations = codepuppyNameViolations(clash)
    expect(violations).toContain('pluginTools: action "dispatch" (codepuppy_dispatch) is also a platform tool')
    expect(violations).toContain('modelFunctionNames: "codepuppy_dispatch" is produced twice')
  })

  test("模型函数名:大写、超过 64 字符、非法字符都被点名;品牌重复出现也被点名", () => {
    const names = exportCodepuppyNames()
    const bad = {
      ...names,
      agents: [...names.agents, "codepuppy-codepuppy-ask"],
      modelFunctionNames: ["Codepuppy_dispatch", `codepuppy_${"x".repeat(60)}`, "codepuppy.word_read"],
    }
    const violations = codepuppyNameViolations(bad)
    expect(violations.filter((line) => line.startsWith("modelFunctionNames:"))).toHaveLength(3)
    expect(violations).toContain('agents: "codepuppy-codepuppy-ask" must start with codepuppy and carry the brand exactly once')
  })
})
