// alpha-code#1568 AC4 —— 桌面远端名表 ⊆ 平台公开工具清单(跨仓钉扎)。
//
// 平台那一份是云 MCP 真 `tools/list` 载荷(alpha-platform `packages/gateway/test/fixtures/mcp-legacy-tools-list.json`:
// 从生产 buildMcpServer + Client.listTools() 录下,平台 `mcp-dual-era.test.ts` T1 逐字节钉住,public-cloud-mcp.md §6
// 与它逐行一致)。本仓经契约消费包按不可变提交 vendor 进来(`alpha-platform-cloud-mcp.lock.json`,`check:vendor`
// 校验字节),这里读的就是那份字节(`fixtures/cloud-mcp-tools.ts`)—— 不是手抄名单。
// 桌面任何一张按远端名匹配的表(契约校验、识图、web search 闸、定制中心的云工具判据)出现平台没有的名字
// ⇒ 当场红:那种名字在真会话里恒不命中,闸门会静默失效(#650 就是这么来的)。
import { describe, expect, test } from "bun:test"
import { CLOUD_CONTRACT_REMOTE_TOOLS, CLOUD_UNVALIDATED_REMOTE_TOOLS } from "../../../ext/src/cloud-contract-hook"
import { CLOUD_VISION_REMOTE_TOOL } from "../../../ext/src/cloud-vision"
import { CLOUD_WEB_SEARCH_REMOTE_TOOL } from "./cloud-web-search"
import { CLOUD_MCP_TOOLS, platformCloudMcpTools } from "./fixtures/cloud-mcp-tools"
import { CLOUD_DISPATCH_TOOL } from "./hub-view"

const DESKTOP_REMOTE_NAMES = [
  ...CLOUD_CONTRACT_REMOTE_TOOLS,
  ...CLOUD_UNVALIDATED_REMOTE_TOOLS,
  CLOUD_VISION_REMOTE_TOOL,
  CLOUD_WEB_SEARCH_REMOTE_TOOL,
  CLOUD_DISPATCH_TOOL,
]
const notInPlatform = (names: readonly string[]) => names.filter((name) => !CLOUD_MCP_TOOLS.includes(name))

describe("#1568 AC4 云 MCP 远端名跨仓钉扎", () => {
  test("vendored 平台清单:十个只说动作的名字,不带服务前缀", () => {
    expect([...CLOUD_MCP_TOOLS]).toEqual([
      "dispatch",
      "status",
      "await",
      "artifacts",
      "cancel",
      "web_search",
      "web_fetch",
      "vision",
      "decide",
      "account_status",
    ])
  })

  test("桌面远端名表 ⊆ 平台公开工具清单", () => {
    expect(notInPlatform(DESKTOP_REMOTE_NAMES)).toEqual([])
  })

  // ext 运行期「确定属于云 server 却一个远端名都对不上 ⇒ 拒绝」(cloud-contract-hook.ts)依赖这两张表合起来是全集:
  // 平台新增一个工具而桌面没跟,这里先红,而不是在用户会话里把那个新工具拒掉。
  test("ext 的契约表 ∪ 无契约表 == 平台公开工具清单(双向)", () => {
    expect([...CLOUD_CONTRACT_REMOTE_TOOLS, ...CLOUD_UNVALIDATED_REMOTE_TOOLS].sort()).toEqual([...CLOUD_MCP_TOOLS].sort())
  })

  test("判据看得见漂移:改名前的 cloud_* 远端名不在平台清单里", () => {
    expect(notInPlatform(["cloud_dispatch", "cloud_web_search", "cloud_vision"])).toEqual(["cloud_dispatch", "cloud_web_search", "cloud_vision"])
  })

  test("载荷形状不对就响亮失败,不返回空清单或残缺清单", () => {
    for (const bad of ["[]", "{}", '[{"name":"dispatch"},{"description":"no name"}]'])
      expect(() => platformCloudMcpTools(bad)).toThrow("not a non-empty array of named tools")
  })
})
