# alpha-code #225 — L 级方案基线

> 标题：`[Privacy] Create main-owned cloud upload manifest and consent token`  
> 父需求：`alpha-work#10 (Privacy)`  
> 复杂度：L（跨仓 wire、安全信任边界、Electron IPC、用户可见确认、发布验证）  
> 勘破基线：`origin/alpha@e6507b01`，工作树干净；本次只读，未修改任何文件。  
> Ready 判定：**暂不可升 Ready**。实现方案已收敛，但必须先取得下文列出的 `alpha-platform#32` commit-pinned 契约产物。

## ① 只读勘破：当前真实行为

### 1. 仓与上游边界

| 区域 | 归属 | 当前事实 |
|---|---|---|
| `packages/desktop`、`packages/app` | 上游 OpenCode 既有 | Electron 壳、共享 renderer、附件/文件引用等上游行为。 |
| `packages/ui-mac` | Alpha fork 自有 | 从上游桌面壳派生后加入 Alpha 登录、Cloud Jobs、MCP、自动化、权限与产品 UI；生产 Alpha 包实际从这里构建。 |
| `packages/ui-mac/src/main/attachment-picker.ts` | 上游派生，当前与上游文件字节相同 | main 产生 sender-bound picker token、20 MiB 读取预算；不是上传 consent。 |
| `alpha-cloud-*`、`cloud-ipc.ts`、`cloud-dispatch-box.tsx` | 本 epic 之前已增加 | Cloud Jobs、旧 B16 项目级出境提示、MCP/自动化云能力；均不是 #225 所需一次性 manifest consent。 |
| UploadManifestV1 / `upload_consent` | #225 待新增 | 仓内搜索无实现、无 schema pin、无 golden fixtures。 |

Alpha 生产包由 [`packages/ui-mac/package.json:14`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/package.json:14) 的 `build/package:mac/package:win` 构建，electron-builder 打包 `out/**/*`，见 [`electron-builder.config.ts:53`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/electron-builder.config.ts:53)。因此 #225 的 main/preload 代码会自然进入 asar，不需要为普通 TS 模块另改打包清单。

### 2. 现有上传与云交互入口

#### A. App 即时 Cloud Jobs 派发（Alpha epic 既有）

真实调用链：

1. renderer 在 [`cloud-dispatch-box.tsx:51`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/renderer/extensions/cloud-dispatch-box.tsx:51) 让用户选择项目目录。
2. renderer 调 `window.api.cloud.gitDiff(directory)`；main 执行 `git diff`，再把完整 diff 字符串返回 renderer。
3. renderer 构造 `input: { diff }`，经 `window.api.cloud.dispatch(envelope, directory)` 派发。
4. preload 只是透传，见 [`preload/index.ts:227`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/preload/index.ts:227)。
5. main 的 [`cloud-ipc.ts:90`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/cloud-ipc.ts:90) 接收 renderer 提供的完整 envelope 和可选 directory。
6. [`alpha-cloud-jobs.ts:30`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/alpha-cloud-jobs.ts:30) 使用 main-held platform access token，将 `JSON.stringify(envelope)` POST 到 Cloud Jobs。

当前缺口：

- diff 内容先进入 renderer，main 没有内容权威快照；
- 没有文件级 path/size/digest；
- 没有 UploadManifestV1；
- 没有平台签发的 `upload_consent`；
- `directory` 是可选参数，省略时旧 consent 被直接跳过；
- renderer 可以自造 envelope，也可以用非空 `denied_paths` 替换默认规则。

#### B. 旧 B16 cloud consent（Alpha epic 既有，必须退出授权角色）

[`alpha-cloud-consent.ts:1`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/alpha-cloud-consent.ts:1) 只定义：

```ts
{ version: 1, acceptedAt: string }
```

main 在 [`cloud-ipc.ts:52`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/cloud-ipc.ts:52)：

- 读取 `<project>/.alpha/prefs.json`；
- 若当前版本已同意，永久放行该项目后续派发；
- 否则显示 main 发起的原生 `dialog.showMessageBox`；
- 同意后持久化 `cloudConsent`；
- `directory` 缺失时不弹、不拒绝，直接派发。

这只是“项目首次告知”，不是内容级 consent。它无法绑定 tenant、具体文件、字节、purpose、retention，也没有过期、一次性或重放语义。#225 后历史 `cloudConsent` 字段可以作为未知 prefs 数据保留，但**绝不能再提供任何上传授权**；不做迁移或兼容 shim。

#### C. Agent → Cloud MCP（Alpha epic 既有旁路）

[`sidecar.ts:361`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/sidecar.ts:361) 在 platform 模式下注册远程 `mcp.cloud`，其 bearer 由 main 写入 `0600` 文件，再以 `{file:...}` 引用交给 sidecar。

这条路径：

- 不经过 Electron `cloud-dispatch` IPC；
- agent 可以调用远程 cloud 工具；
- sidecar 当前持有的是 platform access token，不是 upload consent；
- main 无法在本地拦截远程 MCP 工具参数。

因此 #225 必须保证 upload consent 永不进入 sidecar/MCP；MCP upload 的禁止必须由 #33 服务端 gate 兜底。现有非上传 MCP Cloud Jobs 可以继续存在。

#### D. Scheduled Cloud Jobs（Alpha epic 既有旁路）

[`alpha-cloud-schedules.ts:66`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/alpha-cloud-schedules.ts:66) 构造固定 research envelope，保存时由 main 直接注册云 schedule。

当前它只发送任务文本，不选择本地文件。#225 不为它增加 upload manifest/token，也不允许 renderer 将即时 upload proof 复用到 scheduled job。

#### E. Composer 附件与文件引用（上游及 fork 既有，需明确排除）

上游 renderer 会把图片/PDF读成 data URL，见 [`packages/app/src/components/prompt-input/attachments.ts:11`](/Users/tide/app/alpha-code/.worktrees/225/packages/app/src/components/prompt-input/attachments.ts:11)。Alpha Composer 也在 renderer 中处理图片/PDF，见 [`composer-attachments-core.ts:1`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/renderer/alpha-ui/composer-attachments-core.ts:1)。

这些内容进入 Session/模型调用链，不进入 Cloud Jobs upload endpoint。根据本票给出的 #32/#33 地图，#225 的 UploadManifestV1 范围应限定为：

> **Cloud Jobs 即时 HTTP 上传 payload，不含普通模型 prompt/attachment。**

若父需求的“任何 Alpha 云上传”字面上也包括模型 prompt 附件，则当前 #32 契约不足以覆盖，必须另行登记需求；不得在 #225 中暗自扩大协议。

#### F. Artifact 下载（Alpha epic 既有，非本票上行）

Cloud artifact 下载已由 main 持 bearer、流式落 `.part`、校验 size/sha256，再原子完成。它是云到本地的入站链，不是 #225 上传产生端。

### 3. main ↔ renderer IPC 与信任模型

主窗口在 [`windows.ts:164`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/windows.ts:164) 明确设置：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webviewTag: false`
- off-origin navigation/popup 拒绝或外置

preload 仅通过 `contextBridge.exposeInMainWorld("api", api)` 暴露窄 API，见 [`preload/index.ts`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/preload/index.ts)。

这些设置限制 renderer 能力，但**不使 IPC 参数可信**。当前 preload 仍允许 renderer 提供：

- 完整 `CloudJobEnvelope`；
- 任意字符串 directory；
- `input` 中任意键值；
- 可省略 directory。

因此 #225 必须把 renderer 视为“只能提出动作意图”的不可信调用方。manifest、tenant、文件快照、purpose、retention、token 和最终 upload body 都不能由 renderer 提供。

### 4. 现有 consent/permission UI

| UI | 当前作用 | 可否作为 #225 权威 |
|---|---|---|
| B16 原生 `dialog.showMessageBox` | 项目首次出境告知，写 `prefs.json` | 原生 main 对话框机制可复用；持久项目级授权语义必须删除。 |
| Alpha `PermissionDialog` | 展示 SessionV2 permission request，支持 once/always/reject | 不可复用为上传权威。它在普通 renderer 中运行，且 `always` 与上传的一次性、精确 scope 相冲突。 |
| 原生 open-file/open-directory picker | main 发起并返回选择结果 | 可作为用户文件选择入口，但 #225 应在同一 main 调用中消费选择，不把文件字节或授权 token交 renderer。 |

### 5. 现有 path/size/digest 能力

- [`attachment-picker.ts:4`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/attachment-picker.ts:4) 有 20 MiB 总预算、sender 绑定和一次读取，但会把字节交 renderer，也没有相对路径、SHA-256 或 consent 绑定。
- [`cloud-envelope-guard.ts:13`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/cloud-envelope-guard.ts:13) 只计算 JSON envelope 的 UTF-8 大小，上限仍是旧 1 MiB；它不计算实际上传文件字节。
- 该 guard 会接受 renderer 提供的非空 `denied_paths` 并完全尊重，见 [`cloud-envelope-guard.ts:57`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/cloud-envelope-guard.ts:57)，不能承担 consent scope 权威。
- [`alpha-workdir.ts:45`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/alpha-workdir.ts:45) 有 realpath、symlink 和 `.alpha` 输出圈禁，但服务的是本地 managed run 输出路径；不能直接等同于项目上传枚举器。
- 当前 Cloud Jobs 上行没有逐文件 SHA-256、实际传输字节数或发送前 immutable snapshot。

### 6. 打包与用户可见证据链

- L0 权威门是 [`scripts/alpha-check.sh`](/Users/tide/app/alpha-code/.worktrees/225/scripts/alpha-check.sh)，执行 `ui-mac` typecheck 和全部 `src` 单测。
- `ui-mac` 构建入口是 `electron-vite build`，打包入口为 `package:mac/package:win`。
- 已有 RC packaged 证据格式见 [`docs/verification/2026-07-17-packaged-macos-rc-smoke.md`](/Users/tide/app/alpha-code/.worktrees/225/docs/verification/2026-07-17-packaged-macos-rc-smoke.md)。
- #225 的 packaged 证据应追加到下一个 RC 的统一 smoke，不修改或覆盖历史验证文档，也不为单票重复建一轮 L3。

---

## ② 选定方案与被否决替代

### Ready 前的契约阻塞

当前给出的 #32 摘要尚不足以逐字实现：

1. UploadManifestV1 字段表没有 `purpose` 或 `retention`，但 AC1 要求两者与 manifest 绑定。
2. `upload_consent` 摘要没有 retention claim；#33 明确要求 retention、TTL、clock skew、expiry≤retention。
3. 未给出 canonical JSON bytes：字段顺序、数组排序、数字表示、Unicode normalization、hash 编码。
4. 未给出 consent issuance API 的 method/path/request/response。
5. 未给出 `iss`、JWT header `alg/kid/typ`、轮换和失败码的确切值。
6. 未定义 Cloud Jobs 中上传 payload 的唯一 wire 位置，因此当前 `input.diff` 是否属于上传旁路无法机械判定。
7. 未给出 pipeline `kind/operation` 到 upload purpose/scope 的精确映射。
8. 本仓没有 #32 发布的 schema 或 golden fixtures，也没有 immutable commit pin。

Ready 门：

- pin `alpha-platform#32` 不可变 commit；
- vendor/pin 其 schema 与全部 upload golden fixtures，并记录来源；
- #32 明确上述字段和 issuance/upload HTTP wire；
- #33 确认同一 commit/fixtures。

不能依据摘要自行发明字段或 canonicalizer。

### 选定的权威流

```text
不可信 renderer
  │ 只提交“即时 pipeline 上传意图”
  ▼
Electron main
  ├─ 验证登录身份、pipeline/kind/operation allowlist
  ├─ main 发起原生文件/目录选择
  ├─ 展开并校验精确 project-relative 文件集合
  ├─ 一次读取到 main-owned bounded snapshot，计算 size/sha256
  ├─ 生成 canonical UploadManifestV1 bytes + manifest_sha256
  ├─ main 原生对话框展示完整 scope/purpose/retention
  ├─ 用户取消 → 丢弃 snapshot，零签发、零上传
  ├─ 用户确认 → main 调平台 consent issuance API
  ├─ main 收取 opaque、一次性 upload_consent token
  └─ 同一函数立即发送同一 manifest bytes + 同一 snapshot bytes
       └─ 无论成功/超时/失败都销毁本地 proof；重试必须重新预览并取得新 token
```

### 1. IPC 形状

新增 upload IPC 只能接收意图，例如：

- project directory hint；
- pipeline kind/operation；
- 选择模式；
- 其他非内容控制项。

preload 和 renderer 类型中明确**不得出现**：

- `manifest`
- `manifest_id`
- `manifest_sha256`
- `tenant_id`
- `consent_token`
- `jti`
- 文件字节/data URL
- renderer 自由填写的 purpose/retention
- renderer 自由填写的最终文件列表

用户选择应由 upload IPC handler 内部直接打开原生 picker。picker 结果留在 main，不先返回 renderer。

现有通用 `cloud.dispatch(envelope, directory?)` 必须增加上传旁路检测：

- 发现 #32 定义的任何上传内容时，返回稳定的 `upload-main-gate-required` 类错误；
- 不允许把 manifest/token 作为普通 envelope 字段传入；
- 当前 `input.diff` 若被 #32 判为上传内容，必须改为 main 内生成并通过唯一 upload payload 发送；
- 在 #32 尚未定义 diff 表示前，宁可禁用该 code-review 上传入口，也不得继续隐式绕过。

### 2. main-owned 文件 scope 与 snapshot

main 按 #32 精确规则处理：

1. project directory 必须存在、为绝对非根目录并可确认真实身份。
2. 用户未选择、目录缺失、目录在枚举中消失、空目录都产生空 scope 并拒绝；绝不回退项目根。
3. 目录选择立即展开为当时的具体 regular files；之后新增文件不进入 manifest。
4. 每段路径均拒绝 symlink；拒绝 socket/device/FIFO 等非普通文件。
5. 文件必须位于 canonical project root 内。
6. 生成 contract 指定的 POSIX project-relative path；拒绝 absolute、盘符、反斜杠、NUL、`.`、`..`。
7. Unicode normalization 和规范化后重复判定完全依 #32，不自行假定 NFC/NFD。
8. 文件集合按 #32 canonical order 排列。
9. 一次读取每个文件到 main-owned immutable `Buffer` snapshot，同时计算实际 `size_bytes` 和 SHA-256。
10. 对 256 文件、100 MiB 总量及 256 KiB control envelope 在副作用前 fail-closed。
11. 最终上传必须使用同一 snapshot，不在用户确认后重新读取磁盘。

100 MiB 是明确有界内存，首版直接保留 snapshot 最简单且能消除 preview→upload TOCTOU。改为临时文件 spool 只可作为后续内存优化参考，不是 #225 门控项。

### 3. tenant、purpose、retention

- tenant 只从 main-held、登录流程取得的 platform access JWT 严格提取 `sub`；不得使用邮箱、显示名、renderer 值或路径。
- 本地解析 `sub` 仅用于构造 manifest；最终权威仍是平台对 access token 签名的验证以及 `upload_consent.sub == manifest.tenant_id` 比较。解析失败即拒绝。
- purpose 由 main 根据 #32 发布的 `autonomy + kind + operation` 映射表计算。#33 已禁止 bounded-agent file upload，首版只允许列明的 pipeline operation。
- retention 由 main 从 #32 发布的受控 policy enum/期限中选择并展示；renderer 不能要求更宽或更长 retention。
- 平台不支持的 retention 必须在 issuance 或 upload 前拒绝，客户端不得静默延长。

按当前字段摘要，不在 UploadManifestV1 擅加 purpose/retention 字段。最小兼容解释是：

> token claims 绑定 purpose/retention，token 又通过 `manifest_sha256` 绑定完整 manifest bytes，因此“manifest + consent proof”整体绑定 purpose/retention。

但这只有在 #32 明确批准 retention claim 和该复合绑定语义后才成立。若 AC1 要求两字段物理存在于 manifest JSON，必须由 #32 更新 schema；#225 不能单仓扩展 v1。

### 4. 预览与取消

首版沿用 main 发起的原生 Electron message box，而不是普通 renderer Dialog：

- 默认焦点与 Escape 均为“取消”；
- 正向按钮写明“同意本次上传”，不提供“始终允许”；
- detail 必须列出全部 canonical relative path、每项 size、file count、total bytes、purpose、retention；
- token、tenant、manifest hash 不显示；
- 需显式 checkbox/ack 后才接受；
- 对话框结果只在 main 内消费。

如果原生对话框无法完整呈现全部路径，必须以 `preview-too-large` 拒绝并要求减少选择；不得退化为“256 个文件”之类摘要 consent。单独开发可滚动的特权 consent window 仅作为未来可选参考，不属于当前 4 条 AC 的最简实现。

取消行为：

- picker 取消：不生成 manifest、不签发、不派发；
- preview 取消：丢弃 manifest/snapshot，不调用 issuance；
- issuance 后发生网络取消/超时：token 作废且不重用；重试从重新选择、预览、确认开始；
- job 创建成功后的 job cancel 沿用现有 `cloud-cancel`，不改变 upload consent 已消费事实。

### 5. token 生命周期

- token 是平台签发的 opaque JWT，只存在 main 内存；
- 不写 `prefs.json`、electron-store、日志、crash report、run contract；
- 不进入 preload、renderer、sidecar、MCP、自动化或 Session；
- 本地 proof 在网络请求开始前原子标记 consumed，避免并发双发；
- 任一结果都删除本地引用；
- 不因 timeout、5xx、backend failure 自动复用；
- 不复用 platform access token、Job token 或旧 B16 boolean；
- 平台 #33 仍负责全局 `jti` 一次性、并发最多一个成功和 replay tombstone。

### 6. main 是唯一 consent 权威的论证

renderer 能做的只有请求 main 开始一次流程。它不能：

- 选择最终文件集合：原生 picker 结果由 main 直接消费；
- 提供或修改 manifest：类型和 IPC 都不接收该字段；
- 修改 tenant：取自 main-held身份；
- 放大 purpose/retention：main 使用固定映射；
- 伪造用户确认：确认由 main 发起的原生对话框产生；
- 替换确认后的文件内容：上传使用确认前已形成的 main snapshot；
- 取得 token：token 不出 main；
- 调通用 dispatch 携带内容：生产 gate 在发送前拒绝；
- 通过 agent/MCP/schedule 获得 token：这些进程和接口从未收到 upload consent。

agent 即使调用远程 MCP，也只有 platform access token；服务端 upload gate 会因缺少 `upload_consent` 拒绝。客户端不宣称自己能拦截 MCP 网络流。

### 7. 被否决的替代

| 替代 | 否决理由 |
|---|---|
| 继续使用 `.alpha/prefs.json cloudConsent` | 项目级、长期、无文件/tenant/digest/retention，一次同意可无限放大。 |
| renderer 生成 manifest 或传 consent boolean | renderer 可换路径、大小、purpose，或直接伪造确认。 |
| 复用 Alpha `PermissionDialog` 的 `once/always` | 普通 renderer 不是本票权威；`always` 与一次性精确 scope 冲突。 |
| main 本地自签 JWT | #33 只接受平台注册信任根；客户端自签不被接受。 |
| 复用 platform access token / Job token | `aud/token_use/purpose` 错误，且没有 manifest hash 与 replay 语义。 |
| 目录名或 glob 作为 scope | 无法精确验证；新增文件会自动获得 consent，违反 AC3。 |
| preview 后重新读原文件 | 存在 TOCTOU，确认的摘要与发送内容可不同。 |
| 只展示 count/total，不展示全部 path | 用户没有看到实际目录展开结果，不是精确 path scope consent。 |
| 让现有通用 `cloud.dispatch` 接受可选 manifest/token | 保留旁路，renderer/MCP 可绕过 main admission。 |
| 为 #225 自建“更通用”的跨仓 consent 框架 | 会形成需与 #32/#33 逐点同步的新真相源；本票只 pin schema、serializer、fixtures 和单一即时上传路径。 |

### 8. 红旗自检

- **阻塞**：#32 的 manifest 字段与 AC1 的 purpose/retention 表述不一致。
- **阻塞**：无 canonical bytes、hash encoding、JWT header/claim、issuance API 和 upload payload wire。
- **阻塞**：本仓没有可 pin 的 schema/golden fixtures。
- **阻塞**：当前 `input.diff` 已传本地内容，但尚无契约说明如何放入 UploadManifestV1。
- **范围红旗**：模型 prompt/attachment 也是本地内容出境，但不属于所给 Cloud Jobs manifest 契约；父票需明确排除或另票承载。
- **UI 红旗**：原生对话框若不能完整显示某一 scope，必须拒绝，不能静默截断。
- **禁止声明完成**：仅有 main-held access bearer、secret scan 或旧 PIPL 告知，不等于 upload consent。

---

## ③ 安全面与必守不变量

### 攻击/边界整类

| 类别 | 典型攻击 | 实现控制 |
|---|---|---|
| renderer 伪造 consent | 直接调用 confirm、提交假 token/manifest | 原生 main 对话框；IPC 不接收 proof；sender 只能发 intent。 |
| renderer 放大 scope | 替换 projectDir、加路径、把单文件改目录 | main 原生 picker、root 圈禁、完整 preview、main snapshot。 |
| agent 放大或伪造 | MCP/工具参数里塞 manifest、token、files | token 不进 sidecar；服务端同一 upload gate；客户端不开放 MCP upload。 |
| 缺失目录→项目根 | `undefined`、空字符串、ENOENT 被解释为 root | 缺失/空/不可确认全部返回零 scope 并拒绝。 |
| path traversal | absolute、`..`、盘符、UNC、反斜杠、NUL | #32 路径 validator，POSIX project-relative only。 |
| normalization collision | Windows 大小写、Unicode 等价、重复路径 | 依 #32 canonicalization 后再判重；任一重复整单拒绝。 |
| symlink escape | 文件、目录或中间组件指向项目外 | 对每段 `lstat`；任何 symlink 拒绝，不跟随授权。 |
| preview→send TOCTOU | 用户确认后原文件被改写/替换 | manifest 和上传都使用同一 main-owned snapshot。 |
| size 绕过 | 字符数代替 UTF-8 bytes、base64前后口径不同、stat 后增长 | 以实际 snapshot/实际解码后传输 bytes 为准；size/digest 同一次读取产生。 |
| 摘要错绑 | hash 普通 object，而发送另一序列化形式 | token hash 绑定实际发送的 canonical manifest byte array。 |
| purpose confusion | code-review token用于 research/agent | main 固定映射；token scope/purpose与 route action 精确比较。 |
| tenant confusion | 邮箱、显示名、renderer tenant | 仅 access JWT `sub`；平台再次比较认证 tenant。 |
| retention 放大 | renderer 要求“永久”、服务端静默延长 | main enum allowlist；平台不支持即拒；expiry≤retention。 |
| token replay | timeout 后重试、双击、并发提交 | main 预消费且不重用；平台 `jti` tombstone 保证全局单成功。 |
| token 泄漏 | renderer、日志、contract.json、错误详情 | opaque main-only；稳定错误码；静态 token-surface ratchet。 |
| preview 泄漏/欺骗 | 把本地路径写日志、只显示摘要、截断隐藏文件 | 路径仅出现在用户主动打开的原生预览；完整或拒绝；日志无路径。 |
| generic dispatch 旁路 | `input.files/csv/code/diff`、额外 payload | #32 定义的 content predicate 在发送前统一拒绝，只有 upload handler 能调用上传 transport。 |
| scheduled/MCP/bounded-agent upload | 把即时 consent 搬到其他入口 | token 不暴露；三类入口无 proof 参数；服务端拒绝。 |
| 版本降级/未来版本 | 缺失、未知或未来 schema | producer 只产 `schema_version:1`；consumer fixture/test 对其他版本拒绝。 |

### 必守不变量

1. **Consent 唯一权威在 Electron main。**
2. **renderer/agent 只能提出意图，不能提供 manifest、scope、tenant、purpose、retention、token 或上传字节。**
3. **一个 consent 对应一个 immutable byte snapshot、一个 manifest_id、一个 manifest hash、一个 token。**
4. **preview 的文件集合与实际发送集合逐项相同；无法完整 preview 就拒绝。**
5. **空 scope、缺失目录、空目录、无选择永远表示“零文件获准”，绝不表示 root/wildcard。**
6. **目录只授权预览时展开的文件；后续新增文件不自动获得授权。**
7. **manifest canonical bytes 是 hash、issuance 和 upload 三处共同的同一字节数组。**
8. **purpose/retention 由 main 的严格映射产生，且与 token/route/manifest hash 联合绑定。**
9. **token 一次性、短期、main-only、不持久化、不自动重用。**
10. **任何 path/size/digest/tenant/purpose/retention/token/content 不匹配都 fail-closed。**
11. **错误响应和日志不回显 token、tenant、manifest、文件名或本地绝对路径。**
12. **旧 `cloudConsent`、access token、Job token 和 renderer permission receipt 均不构成 upload consent。**
13. **即时 HTTP 是首版唯一上传入口；MCP、scheduled、bounded-agent upload 不开放。**
14. **无兼容 shim、无 legacy 并行接受、无未知字段宽松解析。**

---

## ④ 子票切分与验证基线

### 是否继续拆票

**不再拆 CODE 子票。**

#225 已是 `alpha-work#10` 的实现票，而安全正确性要求 manifest snapshot、预览、token issuance、通用旁路拒绝和最终 upload 在同一变更中接通。拆成“先生成 manifest”“以后再接 gate”会产生可合并但无生产权威的中间状态。

不新建 PLAN/DECIDE：

- 未决事实由 `alpha-platform#32` 在其现有契约票中发布；
- #225 等 commit-pinned 契约后直接实现；
- packaged 验证进入统一 RC checklist，不为 #225 单独重复一张 L3 票。

若 portfolio 已有 Privacy capability VERIFY 票，将 #225 的 L1/L3 行并入；没有则父票保持 open，等待下一 RC 证据，不妨碍 CODE 合并。

### 具体文件边界

| 文件 | 计划变化 |
|---|---|
| `packages/ui-mac/src/main/alpha-upload-manifest.ts`（新） | 严格 contract decode、路径枚举、immutable snapshot、size/digest、canonical bytes/hash；纯 main/electron-free。 |
| `packages/ui-mac/src/main/alpha-upload.ts`（新） | main 上传状态机：原生 picker、预览、取消、issuance、一次性 consume、最终发送。 |
| `packages/ui-mac/src/main/alpha-upload-manifest.test.ts`（新） | golden vectors、Windows/Unicode/duplicate/symlink/missing/limits/digest 测试。 |
| `packages/ui-mac/src/main/alpha-upload.test.ts`（新） | consent、取消、并发、重放、错误卫生、实际生产调用链测试。 |
| `packages/ui-mac/src/main/testvectors/upload-manifest-v1/*`（新） | 从 #32 immutable commit 原样 pin 的 schema/fixtures/SOURCE；禁止手编预期值。 |
| [`alpha-auth.ts`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/alpha-auth.ts) | main-only 严格 tenant `sub` 提取；不加入 renderer `AuthState`。 |
| [`alpha-cloud-jobs.ts`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/alpha-cloud-jobs.ts) | 加入 main-only issuance/upload transport；不得导出 token；使用 #32 control/payload limits。 |
| [`cloud-envelope-guard.ts`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/cloud-envelope-guard.ts) | 对通用 dispatch 的 upload content/manifest/token fail-closed；不再以旧 1 MiB 规则替代 v1 256 KiB control limit。 |
| [`cloud-ipc.ts`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/cloud-ipc.ts) | 注册唯一 upload handler；删除旧 per-project consent 放行和 optional-directory upload 行为；生产入口只调用 `alpha-upload`。 |
| [`alpha-cloud-consent.ts`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/alpha-cloud-consent.ts) | 移除 `CLOUD_CONSENT_VERSION/hasCloudConsent/withCloudConsent` 授权语义；旧字段不迁移、不采信。 |
| [`alpha-workdir.ts`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/main/alpha-workdir.ts) | generic prefs parser 与旧 cloud consent 解耦，继续服务 extension prefs。 |
| [`preload/types.ts`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/preload/types.ts) | 新增窄 upload intent/result；不得声明 manifest/token/tenant/bytes。 |
| [`preload/index.ts`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/preload/index.ts) | 仅透传 upload intent；无 proof 返回面。 |
| [`cloud-dispatch-box.tsx`](/Users/tide/app/alpha-code/.worktrees/225/packages/ui-mac/src/renderer/extensions/cloud-dispatch-box.tsx) | 改走 main upload flow；展示稳定取消/失败结果，不再持有 diff/file bytes。 |
| `docs/contracts/platform-integration.md` | 同变更更新 canonical contract pin、唯一上传入口、main authority、旁路禁止和错误语义。 |
| `docs/contracts/platform-endpoint-discovery.md` | 仅当 #32 发布新的独立 issuance base 时更新；若复用 cloud base 则不改。 |

无需改：

- `packages/desktop`、`packages/app` 等上游路径；
- Protocol/Server `HttpApi`；
- generated client；
- electron-builder files 清单。

### AC → 实现边界 → 验证

| AC | 实现边界 | L0 | L1 测试名 | L3 |
|---|---|---|---|---|
| AC1 manifest 绑定 tenant、path scope、size、purpose、retention、摘要 | `alpha-upload-manifest.ts`、`alpha-auth.ts`、#32 fixtures、token issuance request | `bash scripts/alpha-check.sh` | `upload manifest matches alpha-platform v1 canonical golden bytes and manifest_sha256`; `upload proof binds access-token sub, exact paths, actual byte sizes, digests, purpose and retention`; `upload transport sends the exact snapshotted bytes described by the manifest`; `future or missing schema_version is rejected` | RC stub 记录请求的 canonical hash/count/bytes 与本地 fixture 相同，不记录 token/tenant/path。 |
| AC2 renderer/agent 无法伪造或放大 | `cloud-ipc.ts`、`preload/*`、`cloud-envelope-guard.ts`、`alpha-upload.ts`、`sidecar.ts` 静态边界 | 同上 | `renderer upload intent cannot provide manifest tenant purpose retention token or bytes`; `forged manifest or consent fields on generic cloud dispatch are rejected before network`; `production cloud upload IPC calls main admission exactly once and cannot call raw dispatch`; `upload consent token never crosses preload renderer sidecar logs or persisted run state`; `concurrent or retried local proof is consumed at most once`; `MCP schedule and bounded-agent surfaces have no upload consent channel` | packaged app 中通过真实 `window.api` 尝试附加伪 proof，用户只见稳定拒绝码且 loopback stub 零请求。 |
| AC3 缺失目录绝不变整项目 consent | `alpha-upload-manifest.ts`、main picker、scope validator | 同上 | `missing project directory yields zero scope and never resolves to project root`; `cancelled or empty selection never issues consent`; `missing or empty selected directory authorizes zero files`; `directory consent contains only the files expanded for preview`; `files created after preview are not uploaded`; `absolute traversal backslash NUL symlink and normalized duplicates fail closed` | packaged fixture 选择空目录/随后新增文件，预览无隐式 root；stub 接收文件集合与预览一致。 |
| AC4 取消、预览、packaged 用户可见证据 | `alpha-upload.ts` 原生 dialog、renderer 错误呈现、RC smoke | 同上 | `picker cancellation performs no issuance or upload`; `preview cancellation performs no issuance or upload`; `native consent preview lists every path size purpose retention and defaults to cancel`; `unrenderable preview is rejected instead of summarized`; `cloud upload UI reports cancellation without creating a job id` | 下一 RC 的统一 packaged smoke 增加“完整预览截图 + Cancel + stub issuance/upload 计数均为 0”；再跑一次确认路径，证明成功 job 使用同一 manifest hash。 |

### 分层执行

L0：

```bash
bash scripts/alpha-check.sh
```

L1：

```bash
bun run --cwd packages/ui-mac typecheck
bun run --cwd packages/ui-mac test
```

L1 必须包含一条从生产 IPC 注册入口到 `alpha-upload` 的断言，不能只测孤立 serializer。

L2/L3：

- 本变更有用户可见原生 preview；截图由 packaged RC 取证即可，不重复建立一套开发态视觉证据。
- 下一个 RC 按 [`distribution.md:45`](/Users/tide/app/alpha-code/.worktrees/225/docs/runbooks/distribution.md:45) 产包。
- 原生 dialog 在所发平台矩阵执行；macOS/Windows 均发布时均需覆盖。
- 使用非敏感 fixture 路径；截图、日志与验证文档不得出现真实 tenant、token 或用户私有文件名。
- CODE 合并不等于父需求完成；父票仅在 AC1–AC4 对上述证据逐条 PASS 后由验收人手工关闭。

## CONTRACT ALIGNMENT

### UploadManifestV1

按当前 `alpha-platform#32` 摘要，本票只能生成以下已发布字段，不添加私有扩展：

```json
{
  "schema_version": 1,
  "manifest_id": "<contract-defined id>",
  "tenant_id": "<platform access JWT sub>",
  "created_at": "<contract-defined timestamp>",
  "file_count": 0,
  "total_bytes": 0,
  "files": [
    {
      "path": "<canonical POSIX project-relative path>",
      "size_bytes": 0,
      "sha256": "<contract-defined SHA-256 encoding>",
      "media_type": "<optional>"
    }
  ]
}
```

逐字不变量：

- `schema_version == 1`
- `file_count == files.length`
- `total_bytes == Σ files[].size_bytes`
- `files[].path` 唯一、规范化、POSIX relative
- 禁止 absolute、盘符、反斜杠、NUL、`.`、`..`、symlink、规范化后重复
- 最多 256 files
- `total_bytes <= 100 MiB`
- `size_bytes` 与 `sha256` 基于实际发送/实际解码后的 bytes
- manifest control envelope 在发送/持久化前满足 256 KiB 全开销限制
- `manifest_sha256` 必须计算实际发送的完整 canonical UTF-8 manifest bytes

当前 schema 未包含 `purpose`、`retention`。#225 不得自行增加；#32 必须选择并发布以下两种之一：

1. 把它们作为 UploadManifestV1 字段；或
2. 明确规定由下述 token claims 经 `manifest_sha256` 对 manifest 作复合绑定。

### `upload_consent` token

当前已知 JWT claims：

```json
{
  "schema_version": 1,
  "iss": "<#32-defined upload consent issuer>",
  "aud": "alpha-platform-upload",
  "sub": "<manifest.tenant_id>",
  "token_use": "upload_consent",
  "purpose": "artifact.upload",
  "scope": ["artifact.upload", "<#32-defined exact pipeline binding>"],
  "iat": 0,
  "exp": 0,
  "jti": "<high-entropy globally one-use id>",
  "manifest_id": "<manifest.manifest_id>",
  "manifest_sha256": "<hash of exact canonical manifest bytes>",
  "<#32-defined retention claim>": "<exact retention value>"
}
```

JWT header 也必须由 #32 逐字发布：

```json
{
  "alg": "<approved asymmetric algorithm>",
  "kid": "<active platform signing key id>",
  "typ": "<#32-defined token type>"
}
```

必须对齐的比较关系：

- `token.sub == manifest.tenant_id`
- `token.manifest_id == manifest.manifest_id`
- `token.manifest_sha256 == SHA256(exact transmitted manifest bytes)`
- `token.purpose` 在 `token.scope` 中，且等于当前 upload route action
- pipeline kind/operation 与 scope 精确匹配
- token retention 与用户预览值精确匹配
- `exp <= retention deadline`
- 过期、未来版本、未知 `kid`、错误 issuer/audience/token_use/purpose 均拒绝
- `jti` 首次成功 consume 后不可重放；并发最多一个成功
- timeout/backend failure 后客户端重新取得新 consent，不复用旧 token
- token 不用于 MCP、scheduled upload 或 bounded-agent file upload

### #32 必须随 pin 一并提供

- UploadManifestV1 JSON schema；
- canonicalization 与 hash encoding；
- consent issuance HTTP request/response；
- 即时 upload HTTP payload 的唯一位置；
- purpose/retention 精确字段与映射；
- JWT issuer/header/TTL/skew/rotation；
- 稳定错误码族；
- 正常、Windows/Unicode、遗漏目录、重复规范路径、超限、digest mismatch、过期 token、并发 replay golden fixtures。

在这些产物发布并 pin 前，#225 保持 **Not Ready**；发布后按本基线实施，不再重新设计信任边界。
