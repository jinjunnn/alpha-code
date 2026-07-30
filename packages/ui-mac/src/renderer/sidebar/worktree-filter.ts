// worktree-filter — B4「垃圾/隐藏项目」数据层过滤谓词(S17 T5;纯函数,单测在册)。
// 语义:
//  - exact 剔除:"/" 全局桶(上游约定,sidebar 从不直接渲染或对它做 project-scope 请求;
//    use-projects 只会把它保留成非 Git 会话的内部哨兵)+ macOS home 根(/Users/<name> —— 几乎
//    不可能是有意项目,却会挂整个家目录的递归 watcher/git/skills 扫描,B4 背景);
//  - hidden(用户「归档」,alpha.sidebar.hidden):exact 剔除;会话事件按前缀匹配(防 loadProjects 循环);
//  - ~/Documents / ~/Desktop 级**不**自动剔除:存在真实使用场景,用户可经既有「归档」手动隐藏
//    (隐藏后同样数据层零请求)。已知限制:unhide 暂无 UI(手清 localStorage `alpha.sidebar.hidden`),
//    B4 档记账。
// 产品 Mac-only(NON_GOALS#6),home 判定用 /Users/<name> 形态,免 IPC 取 homedir。

const MAC_HOME_RE = /^\/Users\/[^/]+\/?$/

export function shouldSkipWorktree(worktree: string, hidden: ReadonlySet<string>): boolean {
  if (worktree === "/") return true
  if (MAC_HOME_RE.test(worktree)) return true
  return hidden.has(worktree)
}

export function isUnderSkippedWorktree(directory: string | undefined, hidden: ReadonlySet<string>): boolean {
  if (!directory) return false
  if (shouldSkipWorktree(directory, hidden)) return true
  for (const w of hidden) {
    if (w === "/") continue // "/" 作前缀会吞掉一切 —— exact-only
    if (directory.startsWith(w.endsWith("/") ? w : `${w}/`)) return true
  }
  return false
}
