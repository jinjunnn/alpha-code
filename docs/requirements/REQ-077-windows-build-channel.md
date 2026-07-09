---
id: REQ-077
title: Windows 正式构建通道 — CI(GitHub 托管 windows runner)出含 win32 原生件的安装包(REQ-076 真机批用包前置)
type: feature
priority: P1
repo: A
created: 2026-07-09
status: shipped
source: S35 T1b 实测发现(2026-07-09):bun 只装当前平台 optionalDeps → mac 交叉包缺 win32 原生件;用户拍板补位处理;同日 S36 落地
---

## 背景(S35 实测钉死,证据 = [sprints/s35](../sprints/2026-07-09-s35-req076-windows-t1/sprint.md) 残单)

`ship:windows`(REQ-076 T1,PR #166)在 mac 上交叉出包**结构正确但不完整**:bun 只安装当前平台的
optionalDependencies,electron-builder 的 bun 文件遍历收集器如实报 missing —— 交叉包缺
`@lydell/node-pty-win32-x64`(WSL 终端 PTY)与 `@parcel/watcher-win32-x64`(文件监视)等 win32
原生件。**mac 交叉包仅供内测/结构冒烟;正式 Windows 包必须在 Windows 环境构建**(上游 publish.yml
即用 Windows runner,同款约束)。

连带阻塞:REQ-076 真机批(verified 的门)需要一个**完整**的 Windows 包 —— 本 REQ 是其用包前置。

## 方案要点

- **CI workflow(alpha 自有新增文件,零改上游)**:`.github/workflows/alpha-windows-build.yml`,
  跑 **GitHub 托管 `windows-latest` runner**(标准托管池,不依赖 Blacksmith —— 继承的上游 workflow
  之所以永久 queued 正是因为要 Blacksmith,见 docs/CI.md §5;本 workflow 不踩此坑)。
- **触发 = `workflow_dispatch` 手动先行**(真机批按需出包);发版 runbook 接线(tag 触发/Release
  资产上传)归 REQ-076 T3,不在本 REQ 抢跑。
- **步骤骨架**:checkout → bun install(Windows 上原生装 win32 optionalDeps)→
  `bun run --cwd packages/ui-mac ship:windows`(未签名;签名待 T3 证书)→ actions artifact 上传
  `alpha-code-win-x64.exe` + blockmap。
- 备选(不推荐,记录备查):mac 侧强灌异平台原生件(bun 无官方支持,npm --force 换包管理器 = 破
  monorepo 约定)——放弃,与上游做法对齐用 Windows runner。

## 验收标准

1. workflow_dispatch 一键出包,artifact 可下载。
2. 产物包内**含 win32 原生件**(node-pty-win32-x64 / watcher-win32-x64 在 asar.unpacked 或
   node_modules 内可查),electron-builder 日志无相关 missing。
3. 产物在 Windows 真机可安装启动(与 REQ-076 真机批同场验证即可,不单独开批)。
4. 零改上游文件(北极星守卫不波动);runner 为 GitHub 托管标准池(不引入 Blacksmith 依赖)。

## 非目标

- Authenticode 签名接线(REQ-076 T3,证书已拍「T3 时再定」)。
- 发版自动化(tag 触发/Release 上传/latest.yml feed)—— 归 T3 发版 runbook。
- Windows CI 上跑测试矩阵(typecheck/单测已由 alpha-ci 平台无关覆盖;Windows 运行时验证走真机批)。

## 关联

- [[REQ-076]](T1b 残单的处理载体;本 REQ 产物 = 其真机批用包)· [[ADR-026]] §6(打包/发布分工)
- docs/CI.md §5(Blacksmith 教训 —— 本 workflow 明确用 GitHub 托管池)
