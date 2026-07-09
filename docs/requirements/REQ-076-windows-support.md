---
id: REQ-076
title: Windows 平台支持 — ship:windows 出包 + 平台差异收敛(platform seam)+ 安全/发布链双平台化(ADR-026)
type: feature
priority: P1
repo: X
created: 2026-07-09
status: shipped
source: 用户拍板(2026-07-09:「修改宪法,需要支持 win 版本」;同日全量可移植性审计钉死技术底;同日 S35 开工 T1+T2)
---

## 背景/诉求(用户拍板,2026-07-09)

用户问「项目当前在 mac 上构建,转 Windows 应该如何做,是否需要全部改写,还是直接 ship:windows」→ 全量审计后拍板:**修宪支持 Windows**(POSITIONING/NON_GOALS#6/GLOSSARY/ARCHITECTURE 已同日修订),并要求钉死 mac/windows 差异(如 `.alpha`、`~/Alpha` 落点)的最优雅实现与共享/差异内容在项目中的定义 —— 权威方案 = [[ADR-026]]。

## 机制现状(登记时已核,证据 = [audits/2026-07-09-windows-portability-audit.md](../audits/2026-07-09-windows-portability-audit.md))

- **不需要改写**:上游官方本就发 Windows 版(CLI 三 arch + desktop);`ui-mac` 继承了 win/nsis 打包段、`icon.ico`、Windows `latest.yml` feed、深链 second-instance、WSL 子系统;冻结前端平台无关;`packages/ext` 全包零平台假设;symlink 桥已退役(REQ-059/065)→ Windows symlink 提权风险不成立。
- **`ship:windows` 今天不存在**:无 `package:win`/`ship:windows` 脚本(config 支持、脚本没接);无 Windows 本地装机脚本;无 Authenticode 证书。
- **阻断级 2 处**:`menu.ts:24`(非 darwin 无任何应用菜单 → DB 备份/清除数据/卸载说明不可达)、`ext-ipc.ts:37`(`which` + unix PATH 探测恒误报 → MCP 安装预检全线失灵)。
- **适配级 ~9 处**:db-safety sqlite 硬编码 `/usr/bin/sqlite3`(Windows 上安全带整体 fail-open 失效)、密钥文件 0600 在 NTFS 无效(5 个 secret 文件)、CSP 注入守卫漏 win32、open-path 编辑器映射、ext-config 命令白名单、`@parcel/watcher` 缺 win32 prebuild、About/NOTICE 呈现、data-clear 文案、electron-builder 死 `native/` 配置。
- 总量级:~14–16 个自有文件,核心 2–4 人日 + 完全等价 2–3 人日。

## 方案要点(详见 ADR-026,此处摘要)

1. **路径全平台同构零特例**:`~/.alpha` / `~/Alpha` / 项目 `.alpha/` 在 Windows 一律 `os.homedir()` 同构(`C:\Users\<u>\…`),不引入 `%APPDATA%` 特例(与 `.claude`/`.codex` 生态同构、单口径);userData 走 Electron 平台原生,不动。
2. **平台差异收敛 = platform seam**:`ui-mac/src/main/platform/{index,darwin,win32}.ts` 单点分发;新代码禁散落 `process.platform`,存量渐进收编。
3. **共享/差异四层定义**:运行时差异 → platform seam;打包差异 → electron-builder mac/win 段;脚本差异 → scripts per-platform 文件;资产差异 → icons/NSIS。其余默认共享,不做目录级平行结构。
4. **安全诚实降级**:0600→icacls ACL 或明示降级(待拍板,禁 placebo);CSP 守卫扩 win32;SmartScreen/无公证差异如实标注。**Parked D7 重开条件触发,关切并入 T3。**
5. **零改上游**:全部落 alpha 自有文件,北极星不波动。

## 分期与任务

### T1 — 出包冒烟(先证明「装得上、开得起、能跑会话」)
- [x] `package:win` + `ship:windows` 脚本(含 ELECTRON_MIRROR 环境;mac 交叉打未签名 NSIS 供开发)—— S35,实测出 `alpha-code-win-x64.exe`
- [x] `@parcel/watcher-win32-x64` optionalDependencies 补齐 —— ⚠️ S35 实测:bun 只装当前平台 optionalDeps,**mac 交叉包不含 win32 原生件**(node-pty/watcher),正式包须 Windows 构建机产出(上游同款约束)
- [x] 清理 electron-builder 死 `native/` extraResources 配置(S35)
- [ ] Windows 真机/VM 冒烟:安装 → 启动 → 登录 → 跑通一条会话 → 深链 second-instance → 更新器 dry-run(**残单 → 真机批;用包须 Windows 机打**)

### T2 — 功能对齐(审计清单逐项清零)
- [x] platform seam 落地(`src/main/platform/{index,darwin,win32}.ts` + 13 条双平台单测;S35)
- [x] 阻断①:Windows 应用菜单(数据菜单全量 + 「帮助」关于/NOTICE;frameless 弹菜单 IPC 通道就位,**renderer 顶栏按钮随真机批**)
- [x] 阻断②:工具探测 seam 化(posix which+补目录逐字保留 / win32 where+原样 PATH)
- [x] db-safety Windows:明示禁用 + loud(完全等价方案 = T3 拍板捆绑 sqlite3.exe 或 node 内建,gate 不抢跑)
- [x] CSP 注入守卫扩 win32(WSL 非回环风险注记 + 逃生阀);open-path 编辑器映射(经 apps.resolveAppPath 落 .exe,无 shell);ext-config 白名单 head 归一(npx.cmd→npx)
- [x] About/NOTICE(B15)Windows 替代入口(帮助菜单);data-clear 文案 DPAPI 分支;密钥 0600 NTFS 降级 loud(server.ts fork 点)

### T3 — 安全与发布链(verified 的门)
- [ ] 密钥文件 Windows 保护拍板 + 落地(icacls ACL vs 明示降级;含 D7 明文兜底告警关切)
- [ ] Authenticode 证书(形态待拍板)+ `sign-windows` 接线;无证书期 SmartScreen 如实标注
- [ ] DISTRIBUTION.md Windows 章(发版 runbook);C 仓(alpha-web)下载页 + 更新 feed Windows 面
- [ ] 双平台真机批(Windows 首批含:装卸/更新链/定制中心四类装卸/自动化到点/深链登录)→ verified

## 验收标准

1. Windows 10/11 x64 上 NSIS 安装包装得上、冷启动进首页、登录 + 平台代付/BYOK 会话跑通(核心链路与 mac 等价)。
2. 审计文档「阻断级」两项在 Windows 实测可用(应用菜单动作可达;MCP 安装预检对已装/未装工具判定正确)。
3. 「适配级」逐项:实测通过或**明示降级**(文档 + UI 告知),零静默 placebo。
4. `.alpha` / `~/Alpha` / 项目 `.alpha/` 在 Windows 按同构路径落点,引擎经 `alpha.jsonc` 通道正常发现(路径归一无反斜杠泄漏)。
5. 北极星守卫零波动(全部改动为 alpha 自有文件新增/修改)。
6. 更新链:Windows 包经 GitHub Releases `latest.yml` 完成一次真实自动更新(B9 同款语义)。

## 非目标

- Linux(electron-builder 段保留休眠不启用);web/tui/console/enterprise 照旧(NON_GOALS#6 存留部分)。
- WSL 深度功能对齐(冻结前端早于上游部分 WSL 契约,ADR-020 已知缺口;基础 win32 运行不受影响)。
- Windows on ARM 首发(x64 先行,arm64 跟随评估,待拍板)。
- 微软商店(MS Store)分发;CI Windows matrix(初期手工/VM 验证,YAGNI)。

## 待拍板(入 BACKLOG 队列)

1. ~~Authenticode 证书形态~~ **部分拍板(2026-07-09,用户)**:主体 = **公司**(个人 IV 形态排除,候选收敛 OV vs EV;Azure Trusted Signing 对中国公司主体可用性受限,留调研项);**采购时机 = T3 时再定**——开发/内测期用未签名包(SmartScreen 拦截如实标注,不装样子),正式发布前回来 OV/EV 二选一。事实底:Windows 签名**无需微软开发者账号**(仅 MS Store 需要,非目标),证书向商业 CA 按年采购(OV 约 ¥1500-3500/年、EV 约 ¥3000-6000/年,行情价);2023 起私钥强制硬件托管(USB token / CA 云签名),CI 自动签需云签名通道。
2. 密钥文件 Windows 保护:icacls ACL vs 明示降级(T3 前置;倾向 ACL,工作量小)。
3. Windows on ARM 是否随首发(默认 x64 先行;ARM 机可经系统模拟运行 x64 包)。

## 关联

- 方案:[[ADR-026]];审计:[audits/2026-07-09-windows-portability-audit.md](../audits/2026-07-09-windows-portability-audit.md)
- 宪法修订(2026-07-09 同日):POSITIONING(一句话定位/画像/不解决问题)、NON_GOALS#6、GLOSSARY(alpha-code/ui-mac/platform seam 词条)、ARCHITECTURE(技术栈/部署)、CLAUDE.md 定位行、DECISIONS 索引。
- 归并:Parked **D7**(safeStorage 明文兜底告警)重开条件触发 → 关切并入本 REQ T3,不单独重开。
- 上游耦合:win/nsis 打包段、WSL 通道、`sign-windows.ps1` 均上游继承;sync 契约 diff 纪律照旧覆盖。
