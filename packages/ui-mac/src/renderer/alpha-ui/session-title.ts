import { t } from "../i18n"

/**
 * 会话标题的显示规则 —— 侧栏、对话顶栏、空对话提示与会话搜索共用这一份(#1589 AC1)。
 *
 * 新建会话在首条消息改名前带着引擎给的 `New session - <ISO>` 标题;`Untitled` 是
 * `use-projects` 的空标题回退。两者都显示成「新对话」,其余原样。
 */
export function sessionDisplayTitle(title: string): string {
  if (title === "Untitled" || /^New session - /.test(title)) return t("alpha.sidebar.newChat")
  return title
}
