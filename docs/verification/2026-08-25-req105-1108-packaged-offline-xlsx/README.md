---
title: REQ-105 AC4 —— packaged 离线态经真实产品入口创建并复读 xlsx
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-25
review_after: 2026-11-23
---

# REQ-105 AC4 · packaged 离线 create/read xlsx 取证

票:[alpha-code#1108](https://github.com/jinjunnn/alpha-code/issues/1108) ·
父需求:[alpha-work#7](https://github.com/jinjunnn/alpha-work/issues/7)(REQ-105)**AC4**

> **AC4.** Excel 经真实产品入口以 local stdio 在 workspace 创建一个 xlsx,并由独立读取路径重新打开验证关键单元格/结构;过程不需要外网。

本目录只覆盖 AC4 的三格。AC1/AC2/AC3/AC5 分别由 `alpha-web#21`/`alpha-code#197`、`alpha-code#319`、
`alpha-code#254` 承载,本目录不重复它们,**也不新增票面之外的准入条件**。

## 结论

| 格 | 断言 | 结论 |
| --- | --- | --- |
| **C1 创建** | packaged 构建里经真实产品入口让 Excel MCP 在 workspace 内创建 xlsx | **PASS**(离线 4/4 轮,在线对照 1/1) |
| **C2 复读** | 独立读取路径重开并断言具名 sheet / 单元格值 / 结构特征 | **PASS**(16 条断言全绿,判据先经 11 个已知样本自检) |
| **C3 离线** | 全程等价隔离;降级如实记录 | **PASS,但带一条重要限定** —— 见 [§C3](#c3-离线) 与 [§未验证项](#未验证项) |

C3 的限定一句话版:**这一轮离线跑通了,而且全程零下载;但我没能在应用之外复现这份成功,
所以不能据此断言"一台干净机器上首次装 Excel 连接器也不需要外网"。** 详见 §未验证项 第 5 条。

## 被测件

| 项 | 值 |
| --- | --- |
| 分支 / base | `ac-1108` @ `8ba7d11ec`(`alpha`) |
| 构建 | `OPENCODE_CHANNEL=prod bun run build && OPENCODE_CHANNEL=prod bun run package:mac`,产物 `packages/ui-mac/dist/mac-arm64/alpha-code.app` |
| 签名 | ad-hoc(`codesign --force --deep --sign -`) |
| `CFBundleIdentifier` / 版本 | `com.tide.alphacode` / `0.1.3` |
| `app.isPackaged` | `true`(main.log:`packaged: true, onboardingTest: true`) |
| `office-mcp/server.py` | `sha256 14e74374…845d9`,与分支内 `packages/ui-mac/resources/office-mcp/server.py` **逐字节相同**(runner 每轮重算) |
| 隔离 | `OPENCODE_TEST_ONBOARDING=1` → `$TMPDIR/opencode-onboarding-<uuid>/`;真实 `~/.alpha`、`~/.config/opencode`、`~/Library/Application Support/com.tide.alphacode` 的 inode+mtime 每轮前后比对未变 |

**为什么被测件身份可信**:runner 不是"跑起来一个 alpha-code 就算数"。它断言落盘配置里的
`{alphaResources}` 解析结果 **逐字等于这一个 .app 的 Resources 路径**
(`durable.resourcesUnderThisApp`)。本轮排查中曾误连到隔壁 lane 占用 `9222` 的另一个 app 实例,
这条断言就是为此加的 —— runner 每轮自取一个空闲 CDP 端口,并用 `OPENCODE_PORT` 钉死引擎端口。

## 跑法

```bash
# 离线臂(默认)
bun docs/verification/2026-08-25-req105-1108-packaged-offline-xlsx/run.ts \
  --app packages/ui-mac/dist/mac-arm64/alpha-code.app --mode offline

# 在线对照臂
bun docs/verification/2026-08-25-req105-1108-packaged-offline-xlsx/run.ts \
  --app packages/ui-mac/dist/mac-arm64/alpha-code.app --mode online
```

原始输出:

| 文件 | 内容 |
| --- | --- |
| [`results/offline.json`](results/offline.json) · [`offline-round2`](results/offline-round2.json) · [`offline-round3`](results/offline-round3.json) · [`offline-round4`](results/offline-round4.json) | 离线臂四轮,每轮 **20 pass / 0 fail** |
| [`results/online.json`](results/online.json) | 在线对照臂,**19 pass / 0 fail** |
| [`results/offline-independent-read.json`](results/offline-independent-read.json) · [`online-independent-read.json`](results/online-independent-read.json) | C2 独立读取器的逐条断言 |
| [`results/gate-selftest.json`](results/gate-selftest.json) | C2 判据自检(1 绿 / 10 红) |

每份 results 里内嵌了**当轮实际使用的 sandbox profile 原文**、端口、workspace 路径与 app 日志尾部。

## C1 创建

链条(每一环都是打包产品自己的代码,runner 只负责触发与观测):

| 环 | 判据 id | 观测到的事实 |
| --- | --- | --- |
| main 侧 MCP 写盘策略闸 | `entry.persistMcp` | `window.api.ext.persistMcp` → `persistMcpWithPolicy` → `applyMcpWritePolicy`(`ext-mcp-policy.ts`)返回 `{ok:true}` |
| `{alphaResources}` 由 main 解析 | `durable.commandExact` | 落盘命令 = `["uv","run","--no-project","--with","openpyxl==3.1.5","<该 .app>/Contents/Resources/office-mcp/server.py","excel","{workspace}"]` |
| `{workspace}` 留字面量 | `durable.workspaceMarkerKept` | 末位仍是 `{workspace}`(REQ-134 契约) |
| 引擎按 local stdio 起进程 | `engine.mcpConnected` | `GET /mcp` → `{"alpha-excel":{"status":"connected"}}` |
| spawn 时把 `{workspace}` 换成当前 instance 目录 | `engine.spawnedPackagedServer` | 进程表实拍:`uv run --no-project --with openpyxl==3.1.5 <该 .app>/…/server.py excel /private/var/folders/…/req105-ac4-ws-XXXX` |
| 工具真的进了模型的工具表 | `c1.toolExposedToModel` | 本机模型桩收到的 `tools[]` 含 `alpha-excel_read_xlsx` / `alpha-excel_write_xlsx` |
| 真 agent 回合执行了它 | `c1.toolExecuted` | 从引擎**回读整段 transcript**:`{type:"tool", tool:"alpha-excel_write_xlsx", status:"completed"}`,output 含 `sheetsUpdated` |
| 写在 workspace 内 | `c1.toolInputWorkspaceScoped` / `c1.xlsxCreatedInWorkspace` | 工具入参路径与产出文件都在本轮临时 workspace 下 |

**"真实产品入口"的口径,以及唯一一处不是产品的部件。**
离线态没有任何可用模型(平台与 BYOK 都要外网),所以 runner 在 `127.0.0.1` 起一个
OpenAI-compatible 桩,并经**产品自带的自定义模型服务入口** `window.api.providers.add` 注册
—— 该入口的校验器 `persistProvider` 明确放行 loopback http(`isAllowedUrl`),这是产品本来就支持的
本地模型配置形态,不是为取证开的后门。桩只决定"这一回合调哪个工具";**从 composer 之后的
agent 回合、工具注册表、MCP 客户端、stdio spawn、workspace 策略到文件落盘,全部是打包产品的代码**。
`providers.add` 同时驱动 main 的 sidecar respawn,新 fork 因此读到刚落盘的 MCP 配置。

## C2 复读

读取器 [`read-xlsx-independent.py`](read-xlsx-independent.py) **刻意不用 openpyxl**(写入侧用的就是它):
只用 CPython 标准库 `zipfile` + `xml.etree` 直接解 OOXML,并在入口断言 `openpyxl` 不在 `sys.modules`
里 —— 写得对与读得对不共享任何实现。

期望值全部来自 [`fixture/xlsx-contract.json`](fixture/xlsx-contract.json) 这一份**独立锚点文件**:
它是纯 JSON,不 import 任何生产常量;写入请求(`run.ts` 读 `contract.sheets`)与复读断言
(`read-xlsx-independent.py` 读 `contract.expect`)引用同一份契约,**两侧都不从产出的 xlsx 反推期望值**。

16 条断言(离线轮实测,全绿):

- 结构:`sheetNamesInOrder = ["AC4Ledger","AC4Structure"]`、默认 `Sheet` 已被摘掉、worksheet part 数 = 2、
  OOXML 必需 zip 条目齐全;
- 值:7 个单元格逐个比对,**类型必须同类**(`type(got) is type(want)`);
- 类型:`AC4Ledger!B2` 必须是 **number**(不是 `"1108"` 文本)、`AC4Ledger!B3` 必须是 **boolean**(不是 `1`)。

**判据先证明能测出已知的坏。** [`selftest-known-bad.py`](selftest-known-bad.py) 造 11 个样本喂给同一个读取器,
要求 1 绿 10 红,并核对每个红是红在**该红的那条**上([`results/gate-selftest.json`](results/gate-selftest.json)):

| 样本 | 期望 | 实测 | 触发的断言 |
| --- | --- | --- | --- |
| `correct` | GREEN | GREEN | — |
| `empty-file`(0 字节) | RED | RED | `readable` |
| `not-a-zip` | RED | RED | `readable` |
| `empty-workbook`(合法 xlsx,零单元格) | RED | RED | 11 条 |
| `wrong-cell-value`(B2=9999) | RED | RED | `cell:AC4Ledger!B2` |
| `number-as-text`(B2="1108") | RED | RED | `cell:` + `kind:AC4Ledger!B2` |
| `bool-as-number`(B3=1) | RED | RED | `cell:` + `kind:AC4Ledger!B3` |
| `missing-second-sheet` | RED | RED | 4 条 |
| `default-sheet-left` | RED | RED | 3 条 |
| `sheet-order-swapped` | RED | RED | `sheetNamesInOrder` |
| `renamed-sheet` | RED | RED | 10 条 |

⇒ 「文件存在」「打开没报错」「值看着对但类型是文本」这三类错误实现,**都过不了这道闸**。

## C3 离线

macOS 没有 `--network none`。等价隔离用 `sandbox-exec`:**先 `deny network*`,再逐端口放行三个
loopback 端口**(引擎 / CDP / 模型桩),profile 原文每轮内嵌在 results 里。

**为什么必须逐端口而不是"放行整个 loopback"** —— 这条是实测踩出来的:本机全部出网走一个
**loopback 代理**(Clash Verge,`scutil --proxy` 显示 `127.0.0.1:7897`)。用「`deny network*` +
`allow remote ip localhost:*`」时,同一 profile 里 `uv pip install cowsay==6.1`(未缓存包)**553ms 就装上了**
—— 隔离等于没有。而 macOS SBPL 的 `(deny network-outbound (remote ip "localhost:7897"))` **不生效**
(host 只接受 `*` / `localhost`,端口段在 deny 方向不匹配;写成 `127.0.0.1:7897` 直接是解析错误
`host must be * or localhost`,此时 sandbox-exec 根本不启动进程 —— 那个"空输出"曾被我读成"拦住了")。
端口过滤在 **allow** 方向可用(实测:只放行 A 端口时,连 B 端口 `FAIL`),所以最终形态是逐端口白名单。

**对照探针**(同一 profile、同一轮内跑,`c3.egressBlocked`):

| 探针 | 离线臂 | 在线对照臂 |
| --- | --- | --- |
| `curl https://pypi.org/simple/`(直连) | `000` Couldn't connect | `200` |
| `curl -x http://127.0.0.1:7897 https://pypi.org/simple/`(走本机代理) | `000` | `000`(本轮系统代理已关:`HTTPEnable: 0`) |
| `curl https://alphacodeone.com/catalog/v1/channels/trust.json` | `000` | `000`(见未验证项 1) |

同一探针在无沙箱时给 `200`、在沙箱里给 `000` ⇒ **这个观测手段能测出已知的"通"**,不是恒 `000` 的假绿。

**零下载的正面证据**:离线轮结束后,该轮隔离 `XDG_CACHE_HOME` 下的 uv 缓存只有 **20 KB**
(`interpreter-v4` + 空的 `sdists-v9`),**没有任何 wheel、没有 openpyxl** ⇒ 这一轮的创建过程
确实一个字节都没从网上取。

**降级如实记录**:离线态下 `ext-install-catalog`(签名 catalog 安装入口)**按设计 fail-closed 拒绝**,
逐字返回 `{"ok":false,"reason":"entry not in verified catalog: mcp:alpha-excel"}`;
main.log 同时打出 `[remote-catalog] stable channel SECURITY failure (no verifiable trust …) — legacy v1
fallback FORBIDDEN` 与 `bundled catalog is browse-only; activation resolution REFUSED`。
随包 seed(`resources/extension-seed/`,5 个资产)只含 agent/skill,**不含任何 MCP 连接器**,
所以离线也补不上这条路。这条在 results 里记为 `INFO`(不是 FAIL):它是既有设计的正确行为,
但**它意味着"离线首次安装 Excel 连接器"这条产品路径在离线态不可用**,该事实同时被
未验证项 1 阻断了在线复核。

## 未验证项

写下来是因为它们**没被测到**,不是因为它们通过了。

1. **签名 catalog 安装入口(`ext-install-catalog`)在本机任何网络态下都没跑通,原因是环境不是产品。**
   离线态按设计拒绝(上文);**在线态也没跑通** —— 本机到 `alphacodeone.com` 恒不可达:
   `curl` 连测 8 次全部 `SSL_ERROR_SYSCALL` / `http=000`(DNS 给出 Clash fake-IP `198.18.0.131`)。
   ⇒ "从签名 catalog 装 `mcp:alpha-excel` → `mcpActivation.status === "connected"`"这条产品行为
   **本轮测不到**。本目录改走同一个 main 侧策略闸的另一条产品入口(`ext-persist-mcp` →
   `persistMcpWithPolicy`,即 Hub 的自定义 MCP 通道),它与 catalog 安装**共用**
   `applyMcpWritePolicy` 这一个咽喉,所以 `{alphaResources}` 解析与 `{workspace}` 契约是同一份代码;
   但 catalog 验签、receipt 与 digest 一致性**不在本轮证据里**(那本来也是 AC2 / `alpha-code#319`)。

2. **模型不是产品的。** 见 §C1。离线态没有可用模型,回合由本机 loopback 桩驱动。
   "真实模型在真实网络下会不会选这个工具"不在本轮范围。

3. **离线臂给 Electron 加了 `--no-sandbox --disable-gpu`。** 不加时 Chromium 的 GPU/网络子进程
   在 `sandbox-exec` 里初始化失败(`sandbox initialization failed: Operation not permitted` →
   `GPU process isn't usable. Goodbye.`),app 起不来。这削弱的是 **Chromium 自己的渲染进程沙箱**,
   与本轮被测的 MCP/引擎链路无关,但它是一处与生产不同的启动形态。在线对照臂**不加**这两个开关,
   同样全绿 —— 两臂结论一致,所以这处差异没有改变结论。

4. **`POST /global/dispose`(`reloadInstalledMcp` 用的那一步)在本 harness 下会让 renderer 重挂**,
   随后所有引擎调用超时。本目录改用 `providers.add` 触发 main 的 sidecar respawn 让引擎读到新配置。
   ⇒ "catalog 安装返回的 `mcpActivation` 立刻 connected"这条**产品内联行为**没有被直接测到。

5. **【最重要】离线为什么能成功,我没能在应用之外复现,因此不能外推到干净机器。**
   应用内:4/4 轮成功,且隔离缓存证明零下载(上文)。
   应用外:把同一条生产命令按 sidecar 环境白名单忠实重建后**跑不通** —— 六组变体全部卡在
   `https://pypi.org/simple/openpyxl/`(`Operation not permitted`):

   | 变体 | 结果 |
   | --- | --- |
   | 严格 deny-net + 冷 uv 缓存 | FAIL(取索引) |
   | 严格 deny-net + **热** `~/.cache/uv` | FAIL(仍取索引) |
   | 逐端口白名单 + 热缓存 + 无 `VIRTUAL_ENV` | FAIL |
   | 只保留白名单变量(PATH/HOME/USER/…)的忠实重建 | FAIL |
   | 指定 Homebrew python 3.12(= 进程表里实拍到的解释器)+ 热/冷缓存 | FAIL |
   | PATH 里 venv 优先 + 无 `VIRTUAL_ENV` + 冷 `XDG_CACHE_HOME` | FAIL |
   | **带 `VIRTUAL_ENV=/Users/tide/app/trader/.venv`**(该 venv 已装 `openpyxl 3.1.5`) | **PASS** |

   即:`uv run --no-project --with openpyxl==3.1.5` 只有在**已有环境能直接满足依赖**时才不取索引。
   本机登录 shell 恰好导出着这样一个 venv,而 sidecar 的环境白名单
   (`sidecar-env.ts`,default-deny)**并不放行 `VIRTUAL_ENV`** —— 所以应用内那次成功的
   本地依赖来源**我没能确定**。
   ⇒ **不能据此断言"一台没有 uv/pip 历史的干净机器,离线也能完成首次 Excel 创建"。**
   建议(仅建议,不改本票矩阵):单开一张窄票,勘破 Alpha Office 四连接器的依赖获取路径
   —— 首次运行是否必须联网、是否应把钉版 wheel 随包/随 seed 落成离线 store。

   顺带一条**取证方法自身的盲区**,值得进 `CLAUDE.md`:本机 shell 常驻
   `VIRTUAL_ENV=/Users/tide/app/trader/.venv`,而它已装 `openpyxl 3.1.5`;第一次"冷缓存离线也能装"
   的测量因此是**假的**(uv 直接用了活动 venv)。判据:测 `uv run --with X` 的离线能力,
   必须先 `env -u VIRTUAL_ENV`,并核对"取一个确定未缓存的包(如 `cowsay==6.1`)会失败"。

6. **依赖版本漂移、receipt/digest 一致性、catalog/seed/bundle 一致性**不在本目录范围
   (AC2 / `alpha-code#319`);**workspace 边界与 traversal 反例**也不在(AC3,证据已由
   `alpha-code#254` 承载,本轮不重复)。

7. 离线轮中除本轮临时 workspace 外,引擎也为默认工作目录 `/Users/tide/Alpha` 起过一个
   `alpha-excel` 实例(进程表实拍)。该目录**没有**被本轮写入任何文件;断言只认临时 workspace。

## 与生产代码的关系

本目录**只含证据、夹具与 runner,零生产代码改动**。runner 生成的 sandbox profile 写在 `$TMPDIR`,
不入库;每轮实际使用的原文内嵌在对应 results JSON 里。
