# Windows 可移植性审计(2026-07-09)

> 触发:用户问「项目当前在 mac 上构建,转 Windows 版本应该如何做,是否需要全部改写,还是直接 ship:windows」。
> 方法:逐文件清点 alpha 自有代码(`packages/ui-mac/` 全量 + `packages/ext/` 全量)的平台绑定点;上游包不审计(引用其跨平台事实作背景)。
> 结论先行:**不需要改写;`ship:windows` 今天不存在(无脚本),自有代码无硬崩溃点,真功能缺口 2 处 + 适配项若干;达到功能基本对齐约 2–4 人日,完全等价再加 2–3 人日。**
> 载体:[[REQ-076]](../requirements/REQ-076-windows-support.md);方案决策 [[ADR-026]](../../.claude/rules/adrs/ADR-026-windows-platform-support.md)。

## 0. 背景事实(推翻两个直觉前提)

1. **上游 opencode 官方本就发 Windows 版**:`publish.yml` 出 Windows CLI 三档(x64/arm64/x64-baseline)+ Authenticode 签名 + Windows desktop 包;`packages/desktop` 有现成 `package:win`;仓库根有 `script/sign-windows.ps1`。**引擎层(agent core/server/PTY)继续白嫖,零移植工作**。冻结前端(packages/app,ui,ADR-020)是 renderer 代码,平台无关。
2. **`packages/ui-mac/native/` 不存在**:`mac_window.node`/`swift-build` 是上游 desktop 的东西,alpha 没有克隆。`electron-builder.config.ts:71-76` 残留一条指向 `native/` 的 extraResources filter(目录不在 → 打包 no-op),运行时**无任何 `.node` require** → Windows 不会因原生模块崩。(附带:该死配置待清理。)
3. **symlink 桥已退役**:全仓 `fs.symlinkSync` 仅存于 `alpha-bridge.ts:bridgeItem()`,而其运行时零调用者(只剩测试引用);REQ-059/065 后引擎走 `alpha.jsonc` 文件通道。存量 link 代码(factory-skills / engine-config-truth-boot / data-clear / ext-fs-installer.unbridgeItem)**只读链/删链,不创建链**——Windows 上读/删 symlink 不需要提权,只有「创建」才需要。**Windows 最经典的 symlink 提权风险对本仓不成立。**
4. `ui-mac` 虽名为 mac,已内置大量 Windows 管线(继承上游 desktop 模式):完整 `wsl/` 子系统(node-pty win32 prebuild)、electron-builder win/nsis/linux 目标、`icon.ico`、`apps.ts` 的 `where`/.cmd/.bat 解析、深链 second-instance 分支、win32 titlebar overlay、`finalize-latest-yml.ts` 的 Windows `latest.yml` feed。

## 1. 阻断级(Windows 上必坏——功能直接不可用)

| 位置 | 说明 |
|---|---|
| `src/main/menu.ts:24` | `createMenu` 非 darwin 直接 return → Windows **没有任何应用菜单**。alpha 自有「数据」菜单(DB 备份/导出、清除数据、卸载说明,`menu.ts:41-61`)只在此构建,Windows 用户完全无法触达。需 Windows 菜单或把动作挪进 UI 入口。 |
| `src/main/ext-ipc.ts:37-55` | `checkRuntime` 用 `execFile("which", …)` + `:` 拼接 `PROBE_PATH`(含 `/opt/homebrew/bin` 等)。Windows 无 `which`(是 `where`)、PATH 分隔符是 `;` → 运行时工具探测(node/python/uv/git,供 MCP 安装判定)**恒返回「未安装」**,MCP 安装前置检查全线误报。(同仓 `apps.ts` 同类探测已有 `where` 分支,此处属漏改。) |

## 2. 适配级(要改但工作量小;守卫扩展 / 白名单补项 / 安全降级取舍)

| 位置 | 说明 |
|---|---|
| `src/main/db-safety.ts:16` + `db-safety-boot.ts:47-49,209` | `SQLITE3 = "/usr/bin/sqlite3"` 硬编码(注释明写「产品 Mac-only」)。Windows 无此路径 → boot fail-open 静默跳过,**不崩但 DB 安全带整体失效**(迁移水位拦截 + 备份/导出/恢复)。方案:捆绑 sqlite3.exe 或换 node 内建 sqlite。 |
| `src/main/ipc.ts:236` | open-path:darwin 走 `open -a <app>`,else `execFile(app, [path])`——但 `app` 是显示名("Visual Studio Code"),Windows 上不是可执行名(应为 `code`)→ 白名单「在编辑器打开」报错。需 app→exe 平台映射。 |
| `src/main/ext-config.ts:39,233` | MCP command 校验 `SAFE_ABS_PREFIXES = [/opt/homebrew/bin/, /usr/local/bin/, /usr/bin/]`;Windows 绝对路径命令(`C:\…`)或 `.cmd`/`.exe` head(`npx.cmd` 不在 `SAFE_COMMAND_HEADS`)被误拒 → config-time 装 MCP 受限。 |
| `src/main/windows.ts:33` | `shouldInjectCsp = app.isPackaged && process.platform === "darwin" …` → **Windows 打包版不注入 CSP**,renderer 加固弱于 mac。守卫扩展即可(WSL 远端连接白名单一并处理)。 |
| 密钥文件 0600/0700:`alpha-auth.ts:84,88,92,95,215-216`、`alpha-byok-keys.ts:46,50,54,56`、`alpha-secret-files.ts:63-64,75-76`、`alpha-mcp-secrets.ts:48-52`、`alpha-endpoints.ts:86` | `chmod 0o600/0o700` 在 NTFS 近乎 no-op → 登录 token/BYOK 密钥**明文兜底路径**与 `alpha.env` 密钥文件在 Windows 不受 owner-only 限制。safeStorage 主路径 = DPAPI 加密(无碍),但兜底与 secrets 文件的权限保证失效。需 icacls ACL 或明示接受降级(反 placebo,不许装样子)。**关联:Parked D7(safeStorage 明文兜底告警)重开条件就此触发,关切并入 REQ-076 T3。** |
| `package.json:62-70` | `optionalDependencies` 只列 `@parcel/watcher-darwin-*`;而 `server.ts:99` 默认 `OPENCODE_EXPERIMENTAL_FILEWATCHER="true"` → 内嵌 server 文件监视在 Windows 可能加载不到原生件。补 win32 prebuild 或实测上游降级。另:缺 `package:win`/`ship:windows` 脚本(config 支持,脚本没接)。 |
| `src/main/index.ts:214` | `setAboutPanelOptions` 在 Windows 无效 no-op →「关于 alpha-code」(含 B15 NOTICE 呈现)不可达,需替代入口。 |
| `scripts/install-local.ts`(整文件) | 全 mac:`pkill`/`codesign`/`lsregister`/`mdimport`/`/Applications`/`mac-arm64`。Windows 缺本地 dev 装机流程(分发靠 NSIS)。 |
| `src/main/data-clear-boot.ts:156` | 卸载残留文案写死「macOS 钥匙串 safeStorage」,Windows 实为 DPAPI。琐碎。 |
| `electron-builder.config.ts:71-76` | 指向不存在 `native/` 的死配置(§0.2),顺带清理。 |

## 3. 无碍(已有守卫 / 天然跨平台 / Windows 分支齐备)

- `windows.ts:75,102,120-124,143-155`:win32 `.ico` iconPath;`titleBarOverlay`/`frame:false`(win32)与 `titleBarStyle:"hidden"`/`trafficLightPosition`(darwin)双分支;`updateTitlebar` win32-only;`setDockIcon` 非 darwin return。
- `apps.ts:14-22,39-136`:完整 Windows `where` + `.cmd/.bat/.exe` 解析。
- `migrate.ts:14-22`:Tauri 目录三平台齐全。
- `server.ts:65`:shell 探测 win32 短路;`shell-env.ts` 全链仅非 win32 触达。
- `sidecar.ts` 整文件:utilityProcess bundle,纯 node API + `path.join`,信号走 parentPort 消息,无 darwin 假设。
- 深链:`index.ts:299` second-instance(argv,Windows 路径)+ `index.ts:311` open-url(mac)双通道 + `setAsDefaultProtocolClient`(`index.ts:422-425`);NSIS 装机注册协议。
- 自动更新:electron-updater 按平台读 feed;`finalize-latest-yml.ts:82-91` 已生成 Windows `latest.yml`。
- `electron-builder.config.ts:156-182`:win(nsis + icon.ico + signWindows pwsh)+ linux 段齐全;`scripts/utils.ts`:SIDECAR_BINARIES 含 Windows 目标、`windowsify` 加 `.exe`、二进制复制有 Windows 签名分支;`resources/icons/icon.ico` 存在。
- safeStorage:Windows = DPAPI,`isEncryptionAvailable()` 恒 true,兜底路径有 loud warn。
- WSL 子系统 `src/main/wsl/*` + node-pty:win32-gated;node-pty 带 `win32-arm64/x64` prebuild(PTY 仅用于 Windows-only 的 WSL 通道)。
- `automation-scheduler.ts`(powerMonitor)、`automation-ipc.ts:112`(setLoginItemSettings):跨平台 Electron API。
- git 操作(`cloud-ipc.ts:25`、`ext-fs-installer.ts:464`):跨平台 git + `os.tmpdir()` + `path.join`。
- **`packages/ext` 全包无碍**:零 `process.platform`、零硬编码路径;`engine-config-truth.ts:51` 已做 `\\`→`/` 归一。
- 构建脚本 `launch.ts`/`prebuild.ts`/`predev.ts`/`copy-icons.ts`/`patch-upstream.ts`:bun 环境下跨平台(bun `$` 内建 cp/rm/mkdir,`path.sep` 归一)。

## 4. 总量级判断

- **无硬崩溃点**;必坏功能缺口 2 个文件(menu.ts / ext-ipc.ts)。
- 需动自有文件合计约 **14–16 个**;真功能工作量集中 4 处(Windows 菜单、工具探测、DB 安全带 sqlite、密钥权限 ACL 决策),其余为 1–3 行守卫/白名单/文案。
- 粗估:功能基本对齐 **2–4 人日**;菜单/DB 安全带/ACL 做到与 mac 等价再加 **2–3 人日**。
- 通常最痛的项(构建/打包/更新/深链/PTY/原生模块/symlink)**本仓已提前就绪**(继承上游 + REQ-059 退役 symlink 的红利)。
- 发布侧净新增:Authenticode 证书(无证书 = SmartScreen 拦截,可先诚实标注)、C 仓(alpha-web)下载页与 feed 的 Windows 面、DISTRIBUTION.md Windows 章、双平台真机批。

## 5. 已知诚实边界

- **WSL 深度功能**:上游 546 后前端有 WSL 契约演进,alpha 冻结前端(ADR-020)早于其中一部分——Windows+WSL 深度对齐不在首期承诺内(基础 win32 运行不受影响)。
- **CI 无 Windows runner**:alpha-ci 的 typecheck/单测平台无关;Windows 构建验证初期靠手工/VM 真机,CI matrix 后议(YAGNI)。
