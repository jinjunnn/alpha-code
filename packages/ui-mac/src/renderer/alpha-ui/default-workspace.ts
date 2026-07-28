// 默认对话目录(`~/Alpha`,ADR-025)的**唯一**解析点。
//
// 为什么单独成模块:首页 chip、新对话页 chip/标题、以及侧栏的新对话入口都要回答同一个问题
// 「用户没显式选目录时,这次对话落哪」。散在各处各写一份 try/catch 的后果,正是 REQ-126 §1.4
// 记录的「新对话页显示 alpha-code 而不是 ~/Alpha」。
//
// 边界:这里只**查询路径**(主进程 `alpha-workspace-default` 不建目录),不做供给。真正的供给
// (`workspaceEnsureDefault`)与它 `{ok:false}` 的 loud 处置归 use-projects(REQ-126 不变量 5),
// 本模块不吞不装:查询失败 = `undefined`,由调用方决定怎么降级。

import { createResource, type Resource } from "solid-js"

async function readDefaultWorkspaceDir(): Promise<string | undefined> {
  try {
    const dir = await window.api.workspaceDefaultDir()
    return dir || undefined
  } catch {
    return undefined
  }
}

/** Solid 侧的读取:返回 resource 访问器本身,调用方据 `.loading` 区分「**还没解析出来**」与
 *  「解析完了但没有」。这个区分是 AC5 的要害 —— 未解析时**不得**拿别的目录顶上去当提交目标,
 *  否则用户在默认目录返回之前回车,会话就真的开在了他从没选过的项目里。 */
export function createDefaultWorkspaceDir(): Resource<string | undefined> {
  const [dir] = createResource(readDefaultWorkspaceDir)
  return dir
}
