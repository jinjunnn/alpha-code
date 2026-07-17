# REQ-103 切片 2a 取证:governance 只读 IPC + AC3 扩权闸 + AC4 硬边界钉测(2026-07-13,S50)

- Issue:jinjunnn/alpha-code#195(parent jinjunnn/alpha-code#212;AC3 静默扩权阻断 / AC4 硬边界)
- 分支:`feat/195-req103-hub-governance`(承接切片 1:五维所有权 + 三态数据面)
- 范围:刻意收窄、零 UI —— ① governance 只读 IPC/preload 通道;② 更新/重装路径的静默扩权
  阻断闸(主进程);③ AC4 四条硬边界逐条取证 + 钉测。Hub UI(2b)与重确认对话(3)不在本切片。

## 1. governance 只读通道(零写面)

- 通道:`ext-governance-view`(唯一 governance 通道;`ipcMain.handle` 单点注册于
  `src/main/ext-ipc.ts`,源级钉死无第二注册点/无同名写姊妹)。
- 核心:`src/main/ext-governance.ts` 的 `createGovernanceQuery`(electron-free 工厂)——
  catalog 输入复用 ext-ipc 既有已验 resolve 面(remote/cache 验签 → bundled 快照,提取为
  `resolveEffectiveCatalog` 与 planner 共用);输出 = 切片 1 的 `GovernanceView` 纯 JSON。
- preload:`window.api.ext.governanceView(projectDir?)`(`src/preload/index.ts` + `types.ts`
  同步;renderer 唯一输入 = projectDir,与既有 `ext-list-installs(-v2)` 同信任面)。
- 负向测试(`ext-governance.test.ts`):查询前后**全根目录树逐字节一致**(含敌意输入:
  非 string projectDir、不存在路径、对象注入)—— renderer 经此面触达不了任何写操作;
  catalog resolve 抛错 → catalog=null + loud warning,不清零账本/seed 面;输出 JSON round-trip
  纯值(结构化克隆安全)。

## 2. AC3 主进程闸:更新/重装的静默扩权阻断(`ext-install-planner.ts`)

复用 REQ-100 已有 authorize 链,不重造:

- 基线 = `ext-capability-grants` 的授权账(`<root>/ext-store/<kind>.<name>/grants.json`);
  diff/覆盖判定 = 既有 `evaluateCapabilityDiff` + `confirmationCovers`(覆盖式确认防 TOCTOU,
  与 `ext-transaction` 的 authorize 阶段同语义)。
- 闸点:`installCatalog` 在**任何磁盘副作用/事务 begin 之前**——(kind,name)已在本 scope 账本
  (v2 record 或 v1-only receipt)即更新/重装;新 manifest capability 集扩张或授权账缺失
  (fail closed:v1 遗留、grants 落账前存量)且意图未带覆盖完整请求集的
  `confirmedCapabilities` 令牌 → 结构化拒绝 `{ ok:false, stage:"authorize", authorization:
  CapabilityDiff }`(slice 3 对话 UI 直接消费)。缩权/等权不拦;全新安装不经闸;bundle 子条目
  逐项过闸。
- 授权账生命周期接入 planner 主路径:安装 committed 后写 `grants.json`(REQ-100 提交序纪律 ——
  拒绝/回滚零触碰;写失败 = 下次多问一次,loud warning);卸载一并清除(安装拥有的路径)。
- 测试钉死(`ext-install-planner.test.ts`,AC3 describe):拒绝后 installer 零调用、事务零
  begin、账本与授权账逐字节原样、旧 record 原样(旧版本继续运行);只确认增量仍拒;全集确认
  放行且基线/generation 前进;v1 遗留 fail-closed;卸载清账;`confirmedCapabilities` 严格解码
  (≤32、capability 格式,垃圾 loud 拒绝)。

## 3. AC4 硬边界逐条裁决(钉测:`src/main/ext-governance-boundaries.test.ts`)

| # | 边界 | 真源/装载路径 | 裁决 |
|---|---|---|---|
| ① | 第三方不可注册顶级路由 | 路由静态组合于上游冻结 `app/src/app.tsx` 路由树(ADR-020 冻结面);alpha 侧唯一消费口 `shared/legacy-route-abi.ts`;扩展内容(skill/agent/mcp/plugin/cloud)零 renderer 代码通道 | **结构免疫 + 已钉**:parseRoute 路由宇宙封闭(任意顶级段只解释为目录 slug/invalid/unknown,唯一字面量路由 new-session);renderer 源无动态路由注册面 |
| ② | 扩展不可读其它命名空间设置 | `ext-config.ts` 写面只触 `mcp[<name>]` 单叶(SAFE_NAME 先验,名字非路径通道);renderer 可达读面 configHealth 只回健康摘要 | **结构免疫 + 已钉**:跨叶字节不变、敌意名(`__proto__`/遍历)盘前拒绝、configHealth 零内容泄漏(邻居 secret 值不出现) |
| ③ | 扩展拿不到主 renderer preload bridge / 不可注入 renderer JS | preload 静态打包、只 import electron/类型、单一 exposeInMainWorld;主窗 contextIsolation+sandbox+nodeIntegration:false + 单一 preload 配置点;隔离预览 host 刻意零 preload(REQ-096);安装管线(ext-config/ext-fs-installer)零窗口触点;CSP script-src 'self'(renderer-security.test 已有钉) | **结构免疫 + 已钉**(源级锚点扫描) |
| ④ | Electron webview 标签全仓禁用 | Electron ≥5 默认禁;`html-preview-host.ts` 原已显式 false;本切片给 `windows.ts` 主窗补显式 `webviewTag: false`(小改关缺口) | **已钉**:每个 BrowserWindow 创建点(锚点清单 windows.ts + html-preview-host.ts)显式 false;全仓零 `webviewTag:true`、零 webview 标签 |

OPEN(如实记,后续切片/Issue 领地):renderer 侧「扩展进程」本就不存在 —— 扩展全部运行在
引擎 sidecar(skills/agents=文本、mcp=子进程、plugin=引擎进程 JS、cloud=receipts),故 ①③ 的
免疫是装载路径级的;若未来引入任何 renderer 侧扩展执行面,上表锚点测试会先红。本切片无其它 OPEN。

## 4. 门禁(本机,2026-07-13)

```
✅ all local gates green — safe to push (alpha-ci will mirror this in ~40s).
 1412 pass / 0 fail(packages/ui-mac,94 files;typecheck ✓,north-star ✓)
OK: seam and all anchors survive restore from frontend-freeze-base-3; restored trees match HEAD freeze set
```

## 5. 后续切片接口要点

- 切片 2b(Hub UI,待设计评审):数据 = `window.api.ext.governanceView(projectDir?)` →
  `GovernanceView`(preload/types 已导出 `GovernanceRow`/`GovernanceView` 类型);无需新增通道。
- 切片 3(重确认对话):消费 `installCatalog` 的 `{ stage:"authorize", authorization:
  CapabilityDiff }` 拒绝结果(previous/requested/added/removed 齐备)→ 用户确认后带
  `confirmedCapabilities`(完整新集合,覆盖式)重驱同一意图;与未来 planner→ext-transaction
  改线(ADR-028 residual)天然同语义(同一 `confirmationCovers` 链)。
