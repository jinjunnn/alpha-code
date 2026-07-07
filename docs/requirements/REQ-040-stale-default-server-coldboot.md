---
id: REQ-040
title: 冷启动陈旧 defaultServerUrl 无存活校验 → 连死端口卡「无法连接到 Local Server」
type: bug
priority: P1
status: archived
repo: A
created: 2026-07-06
sprint: 2026-07-06-s20-realmachine-vnext
source: S20 真机批 finding F-1
---

## 背景/证据
S20 真机批(2026-07-06)首次冷启动整屏卡「无法连接到 Local Server · 正在自动重试…」,侧栏不挂。
根因:`opencode.settings`(electron-store)持久化了 `defaultServerUrl: http://127.0.0.1:52743`(**具体端口**);内嵌 sidecar 每次 `server.listen(0)`(`main/index.ts:475`)**随机新端口**(本次 62919)→ `getDefaultServer`(`renderer/index.tsx:260`)把陈旧 URL 交给 AppInterface → 连死端口 52743。日志佐证:`getDefaultServerUrl()` 返回 52743 而 `server ready` 在 62919。

触发面:`setDefaultServer` **仅**由手动「服务器选择」弹窗「设为默认」按钮 + WSL 设置写入(`app/src/components/dialog-select-server.tsx:70`、`wsl/settings.tsx:139`),**无自动持久化路径**;alpha 侧栏隐藏该 chrome → 普通用户不触发。本机 52743 = 历次 dev/prod 实验或旧 Tauri 迁移遗留的**污染态**,非普遍冷启动 bug(与 S16 verified 正常启动一致)。**但缺存活校验 = 一旦被写入即无恢复入口**(REQ-014「陈旧 store → 冷启动破且无恢复」家族)。

## 验收标准
1. 持久化的默认服务器若是「具体端口的本地 sidecar URL」(`127.0.0.1`/`localhost`/`[::1]:PORT`),冷启动**丢弃并回退符号性 `sidecar`**(始终指向当次 live sidecar),不再连死端口;
2. 远端主机(真域名/局域网 IP)与 `wsl:` key 的默认**保留**(不误伤);
3. 纯函数可单测。

## 处置(shipped,PR S20)
- `renderer/wsl/connections.ts` 新增纯函数 `isEphemeralLocalServerUrl(url)`(正则判 `127.0.0.1|localhost|[::1]:PORT`);
- `renderer/index.tsx` 的 `getDefaultServer` 读到易失本地 URL → 返回 `null`(→ `availableStartupServer` 取 `"sidecar"`);
- 单测 `wsl/connections.test.ts`(易失判定 4 正例 + 5 反例 + `availableStartupServer` 3 组);
- 零改上游(全 alpha 自有文件)。
- **verified 待**:S20 重打包签名包冷启动——植入陈旧 `defaultServerUrl` → 现回退 `sidecar` 正常起窗。

## 关联
[[REQ-014]](同「陈旧 store 无恢复」家族)· audits/2026-07-06-s20-realmachine-vnext/verify.md §F-1。
