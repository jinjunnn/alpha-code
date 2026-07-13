---
id: ADR-026
title: Windows 平台支持 — 桌面平台扩展(macOS+Windows)与平台差异收敛(路径全平台同构 + platform seam 单点分发 + 安全诚实降级)
status: accepted
date: 2026-07-09
related: [ADR-005, ADR-012, ADR-019, ADR-020, ADR-025, REQ-076]
---

## 背景

用户拍板(2026-07-09):**修改宪法,支持 Windows 版本**——撤回 NON_GOALS#6 的「不支持非 Mac 平台」(Windows 部分),POSITIONING 由「Mac 编码 agent 产品」扩为桌面双平台。技术前提经全量审计钉死(证据:[audits/2026-07-09-windows-portability-audit.md](../../../docs/audits/2026-07-09-windows-portability-audit.md)):

1. **上游本就跨平台**:opencode 官方发 Windows CLI(三 arch + Authenticode)与 desktop 包;`ui-mac` 从上游 desktop 模式继承了 win/nsis/linux 打包段、`icon.ico`、Windows `latest.yml` feed 生成、深链 second-instance 分支、WSL 子系统 —— 引擎层零移植,打包层基本就绪。
2. **alpha 自有代码无硬崩溃点**:mac-only 逻辑要么已平台守卫、要么 fail-open 降级;symlink 桥已退役(REQ-059/065),Windows 最经典的 symlink 提权风险不成立;`packages/ext` 全包零平台假设。
3. **真缺口小而可枚举**:阻断级 2 处(Windows 无应用菜单 / `which` 工具探测恒误报)+ 适配级 ~9 处(DB 安全带 sqlite 硬编码、0600 在 NTFS 无效、CSP 守卫漏 win32、白名单/映射/文案等);合计 2–4 人日核心 + 2–3 人日完全等价。

本 ADR 钉死「mac/windows 差异如何最优雅实现」:共享与差异在项目中的分层定义、路径落点约定、安全降级纪律、发布链分工。

## 决策

1. **平台范围**:桌面 = **macOS(主平台/首发)+ Windows(本 ADR 纳入)**;**Linux 明确不做**(electron-builder linux 段保留休眠,同 ADR-012「机制保留不删」逻辑);web/tui/console/enterprise 照旧不做(NON_GOALS#6 存留部分)。

2. **路径与数据落点 = 全平台同构,零特例**:
   - 全局 `~/.alpha`、用户工作目录 `~/Alpha`(ADR-025)、项目 `.alpha/`(ADR-019)在 Windows 一律经 `os.homedir()` 同构解析(`C:\Users\<u>\.alpha` / `…\Alpha`);**不引入 `%APPDATA%`/`%LOCALAPPDATA%` 特例**。理由:①与 `.claude`/`.codex` 生态同构(它们在 Windows 同样用 home dot-dir),用户口径/文档/排障单一;②代码已收敛在 `alphaGlobalRoot()` 等单点,同构 = 零改动;③「`.alpha` 是 harness 的,`~/Alpha` 是你的」心智口径(ADR-019/025)天然平台无关。
   - Electron userData(内部件:auth/secrets/identity/behavior)走 `app.getPath("userData")`,平台原生落点(mac `~/Library/Application Support` / win `%APPDATA%`),**不动**。
   - 引擎侧路径(home `.opencode`、XDG)是上游职责且上游已跨平台,不接管(§4 边界一致)。
   - **路径字符串纪律**:凡进 config/jsonc 的路径经 `\\`→`/` 归一(`engine-config-truth.ts:51` 既有做法),新代码同款;文件系统操作一律 `node:path`,禁手拼分隔符。

3. **平台差异收敛 = platform seam(运行时唯一分叉点)**:新增 `ui-mac/src/main/platform/{index,darwin,win32}.ts` —— `index.ts` 按 `process.platform` 导出单例适配器,接口承载审计清单的全部运行时差异:命令探测(`which`/`where` + probe 路径集)、DB 安全带 sqlite 策略、密钥文件保护(chmod 0600 vs NTFS ACL/诚实降级)、应用菜单构建、「在编辑器打开」app→可执行名映射、CSP 注入谓词、About/NOTICE 呈现入口。**纪律:新代码禁止新增散落的 `process.platform` 分支,一律走 seam**;存量已守卫分支(windows.ts titlebar、apps.ts 探测、migrate.ts 等)渐进收编、不强制一次性重构(避免无功能收益的 churn)。

4. **共享/差异的目录定义(四层,共享是默认态)**:
   | 层 | 落点 | 说明 |
   |---|---|---|
   | 运行时差异 | `src/main/platform/*` | 唯一运行时分叉点(决策 3) |
   | 打包差异 | `electron-builder.config.ts` 的 mac/win/nsis 段 | 既有,上游模式,不另起文件 |
   | 脚本差异 | `scripts/` per-platform 文件(如 `install-local.ts` / `install-local-win.ts`) | bun 构建脚本层,不进 runtime seam |
   | 资产差异 | `resources/icons`(.icns/.ico)+ NSIS 资源 | 已就位 |

   其余一切**默认共享**:renderer 全量、`packages/ext` 全包、`src/shared` 全包(审计实证零平台假设)。不做 `src/main/mac/` vs `src/main/win/` 的目录级平行结构——差异面太小(~14 文件、多为几行),平行目录会制造双维护面。

5. **安全在 Windows 的诚实降级(反 placebo,C28 纪律)**:
   - 密钥文件 `0600/0700` 在 NTFS 无效 → T3 拍板 **icacls ACL** 或**明示降级**(文档 + UI 告知),二选一,不许静默装样子;Parked **D7**(safeStorage 明文兜底告警)的重开条件(「NON_GOALS#6 撤回」)就此触发,其关切并入 [[REQ-076]] T3,不单独重开。
   - CSP 注入守卫(`windows.ts:33`)扩至 win32 打包态,Windows 加固面与 mac 对齐。
   - safeStorage 主路径在 Windows = DPAPI(机制健全,无碍);electron fuses / asar integrity 双平台同样生效。
   - 平台安全基线差异如实声明:Windows 无公证/gatekeeper 对应物,SmartScreen 信誉靠 Authenticode 证书累积。

6. **打包/发布分工**:
   - 补 `package:win` + `ship:windows` 脚本;本地 mac 可交叉打**未签名** NSIS 供开发迭代;正式分发前置 = **Authenticode 证书**(采购形态待拍板;无证书期间 SmartScreen 拦截如实标注,不伪装)。
   - 更新链复用 electron-updater + GitHub Releases `latest.yml`(`finalize-latest-yml.ts` 已产 Windows feed);渠道语义(dev/beta/prod,ADR-012)双平台同构。
   - **C 仓(alpha-web)配套**:下载页 + 自动更新 feed 增 Windows 面(跨仓交付物,登记于 REQ-076)。
   - docs/runbooks/distribution.md 增 Windows 章(签名/发布 runbook)。

7. **包名 `ui-mac` 保留**:改名 = 全仓路径/引用 churn,零功能收益;GLOSSARY 补词条澄清「历史名,承载全部桌面平台外壳」。将来仓库 re-org 时机再议(YAGNI)。

8. **北极星不变**:Windows 支持全部落 alpha 自有文件(ui-mac / ext / scripts),**零改上游**;win/linux 打包段与 WSL 通道本就继承自上游。冻结前端(ADR-020)平台无关不受影响;唯一已知缺口 = 冻结基点早于上游部分 WSL 前端契约 → **WSL 深度功能对齐不在承诺内**(基础 win32 运行不受影响,诚实边界)。

## 后果

- ✅ 触达 Windows 用户群;移植成本被审计实证为小(核心 2–4 人日),且不需要任何「重写」——「只增不改 + 接缝叠加」纪律的直接红利。
- ✅ 差异有唯一分叉点(platform seam)与四层定义,不会随功能演进散落 `process.platform` 判断;路径同构使文档/支持单口径。
- ⚠️ **新增长期维护面**:双平台真机批(verified 语义 = 两平台各自实测)、Windows 签名/发布链、seam 接口随差异点演进。
- ⚠️ Windows 安全基线低于 mac(无公证;0600 无效需 ACL 决策;SmartScreen 信誉冷启动)——逐项诚实标注,不许 placebo。
- ⚠️ CI 无 Windows runner:typecheck/单测平台无关照旧,Windows 构建验证初期靠手工/VM 真机;CI matrix 后议(YAGNI)。
- ⚠️ WSL 深度功能受冻结前端限制(§8),需求出现时按 ADR-020 §5 re-freeze 路径评估。
- 🔭 执行载体 [[REQ-076]](分期 T1 出包冒烟 / T2 功能对齐 / T3 安全与发布);待拍板点(Authenticode 证书形态、密钥 ACL vs 明示降级、Windows on ARM)入 BACKLOG 待拍板队列。
