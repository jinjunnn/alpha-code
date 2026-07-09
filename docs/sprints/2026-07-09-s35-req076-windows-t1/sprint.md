# S35 — REQ-076 Windows 平台线 T1+T2(出包链 + 功能对齐,mac 侧可完成面)

> 开批:2026-07-09(用户指令「推 sprint 开工」;REQ-076 ready → in-sprint)
> 权威方案:[[ADR-026]];技术底:[audits/2026-07-09-windows-portability-audit](../../audits/2026-07-09-windows-portability-audit.md);需求档:[requirements/REQ-076](../../requirements/REQ-076-windows-support.md)
> WIP 检查:S34 已收尾归档(2026-07-09),无在批 sprint。

## 目标

REQ-076 的 T1(出包链)+ T2(功能对齐)中**在 mac 开发机上可完成并可验证的全部工作**:
`package:win`/`ship:windows` 脚本接线、win32 watcher prebuild、死配置清理、platform seam 落地、
两个阻断级修复(Windows 应用菜单 / 工具探测)、适配级清单清零(代码面)、mac 交叉打出未签名
NSIS 包(产物冒烟)。**Windows 真机运行验证不在本批**(无 Windows 环境,诚实残单)。

## 抽取

| ID | 范围 | 状态 |
|---|---|---|
| REQ-076 | T1 全部 + T2 代码面(真机验证除外) | in-sprint |

## 任务表

| # | 任务 | 状态 |
|---|---|---|
| T0 | sprint 契约 + BACKLOG 翻 in-sprint | ✅ |
| T1a | `package:win` + `ship:windows` 脚本;`@parcel/watcher-win32-x64` optionalDeps;清 electron-builder 死 `native/` extraResources | ✅ |
| T2a | platform seam:`src/main/platform/{index,darwin,win32}.ts` + 13 条纯函数单测(双平台行为在 mac 锁定) | ✅ |
| T2b | 阻断①:Windows 应用菜单(数据菜单全量 + 「帮助」关于/NOTICE + frameless 弹菜单 IPC `popup-app-menu` 通道就位) | ✅ |
| T2c | 阻断②:ext-ipc `checkRuntime` 平台化(seam:posix which+补目录逐字保留 / win32 where+原样 PATH) | ✅ |
| T2d | 适配级:CSP 守卫扩 win32(WSL 非回环风险注记);open-path 编辑器映射(经 apps.resolveAppPath 落 .exe,无 shell);ext-config 白名单 head 归一(npx.cmd→npx);db-safety win32 明示禁用+loud;secret 0600 NTFS 降级 loud(server.ts fork 点);data-clear 文案 DPAPI 分支 | ✅ |
| T1b | mac 交叉打未签名 Windows NSIS 包:`dist/alpha-code-win-x64.exe`(121MB)+ blockmap;win-unpacked 含全套 alpha extraResources(NOTICE/agents/alpha-ext/factory-skills/plugins/skills) | ✅ |
| 收口 | alpha-check 绿 → PR → BACKLOG 回写 shipped(四件套) | ✅(PR 号见 BACKLOG 行) |

## Gates

1. `scripts/alpha-check.sh` 绿(北极星守卫 + typecheck + 单测,与 alpha-ci 1:1)。
2. **mac 行为零回归**:所有平台化改动在 darwin 分支下与现行为逐一等价(单测锁定);现有测试全绿。
3. 交叉出包产物 `dist/` 下存在 Windows NSIS 安装器(未签名;不承诺 mac 上可运行验证)。
4. 待拍板项不抢跑:密钥 ACL(队列②)未拍板 → win32 侧只做**诚实降级 loud 日志**,不实现 ACL;
   db-safety 完全等价方案(捆绑 sqlite3.exe vs node 内建)不在本批拍死 → win32 探测 PATH 中 sqlite3,
   缺失 = fail-open + loud(现状 mac 逻辑零变)。

## 残单(诚实边界,出批即挂真机批)

- Windows 真机/VM:安装 → 冷启动 → 登录 → 会话跑通 → 深链 second-instance → 菜单动作可达 →
  MCP 预检判定正确 → 更新器 dry-run(= REQ-076 验收 1/2/6,verified 的门)。
- **交叉包不含 win32 原生件(T1b 实测发现)**:bun 只装当前平台 optionalDeps,electron-builder
  文件遍历收集器如实报 missing(`@lydell/node-pty-win32-x64`、`@parcel/watcher-win32-x64` 等)→
  **mac 交叉包仅供结构冒烟;正式 Windows 包必须在 Windows 构建机/CI 上打**(上游 publish.yml
  即用 Windows runner,同款约束)。真机批用包须 Windows 机产出。
- win32 可见菜单入口:frameless 窗口无原生菜单栏,`popup-app-menu` IPC + preload 通道已就位,
  renderer 顶栏按钮(win32-only UI,mac 无法视觉核验)随真机批落地。
- CSP 扩 win32 的 WSL 非回环地址风险:真机批验证,坏则退守 darwin-only 或补白名单
  (逃生阀 `ALPHA_CSP_DISABLE=1` 现成)。
- Authenticode 签名(队列①已拍:T3 时再定);密钥 icacls ACL(队列②待拍)。
- C 仓下载页/feed Windows 面(T3)。

## 结果(收口回填,2026-07-09)

- **Gates 全过**:typecheck 绿;**657 单测 0 失败**(新增 platform seam 13 条;顺带修复
  alpha-secret-files 引 logging 导致 electron 桩炸测的回归——loud 警告移至 server.ts fork 点,
  模块保持 electron-free);北极星守卫零波动(全部 alpha 自有文件)。
- **`ship:windows` 从无到有**:mac 交叉出 `dist/alpha-code-win-x64.exe`(121MB NSIS,未签名)
  + 全套 alpha extraResources 就位。
- **审计清单清账**:阻断级 2/2 修复;适配级 9 项全处置(其中 db-safety/密钥权限为「明示禁用/
  loud 降级」而非完全等价 —— 按 gate 4 不抢跑待拍板项)。
- mac 行为零回归:平台化改动 darwin 分支逐字保留(seam 单测锁定 + 全量测试绿)。

## 回写清单

- [ ] BACKLOG:REQ-076 in-sprint → shipped(PR 号 + 残单注记)
- [ ] 本文件任务表勾选 + 结果回填
- [ ] docs/CHANGELOG.md [Unreleased]:Windows 支持(实验性,出包链 + 功能对齐;真机验证中)
- [ ] requirements/REQ-076 frontmatter status 同步
