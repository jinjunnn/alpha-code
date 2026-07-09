// platform/darwin.ts —— POSIX 侧(darwin;linux 不发布,沿用同一组常量)的平台常量(ADR-026)。
// 行为锚:这些值 = REQ-076 之前散落在各消费方的既有 mac 行为,平台化收编时逐字保留(S35 gate 2)。

/** GUI 启动的进程 PATH 不全(无 Homebrew),工具探测前补包管理器 bin 目录(原 ext-ipc.PROBE_PATH) */
export const POSIX_PROBE_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]

/** 探测 PATH 追加的 home 相对目录(与 POSIX_PROBE_DIRS 一并拼接) */
export const POSIX_PROBE_HOME_DIRS = [".local/bin"]

/** DB 安全带 sqlite CLI:macOS 恒有(SIP 域);固定绝对路径不走 PATH(防劫持,原 db-safety.SQLITE3) */
export const POSIX_SQLITE = "/usr/bin/sqlite3"
