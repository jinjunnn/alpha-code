import { describe, expect, test } from "bun:test"
import { sessionDisplayTitle } from "./session-title"
import { t } from "../i18n"

// #1589 AC1:侧栏、对话顶栏、空对话提示、会话搜索共用的标题显示规则。
describe("sessionDisplayTitle", () => {
  test("引擎默认标题 `New session - <ISO>` → 新对话", () => {
    // 比对当前语言的文案(整包跑时别的用例可能切过语言);规则失效时这里拿到的是原始英文时间戳。
    expect(sessionDisplayTitle("New session - 2026-09-21T06:29:08.485Z")).toBe(t("alpha.sidebar.newChat"))
  })

  test("`Untitled`(use-projects 的空标题回退)→ 新对话", () => {
    expect(sessionDisplayTitle("Untitled")).toBe(t("alpha.sidebar.newChat"))
  })

  test("普通标题原样,含以 New session 开头但不是默认形状的", () => {
    expect(sessionDisplayTitle("Greeting")).toBe("Greeting")
    expect(sessionDisplayTitle("New sessions plan")).toBe("New sessions plan")
  })
})
