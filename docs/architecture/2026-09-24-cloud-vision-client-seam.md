---
title: 云端识图的客户端半场:凭据从哪来、图走哪条钩子、看不了图的模型怎么被喂(REQ-228 `#1419`)
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-24
review_after: 2027-03-24
---

# 云端识图的客户端半场(REQ-228 `#1419`)

需求与 AC 见 jinjunnn/alpha-work#105;方案基线是 alpha-platform 的
[`docs/design/2026-09-23-req228-cloud-vision.md`](https://github.com/jinjunnn/alpha-platform/blob/main/docs/design/2026-09-23-req228-cloud-vision.md)
§2-B(客户端)与 §2-0 / §2-A(云端,`ap#484` 已上线)。本文只记**本仓落地时勘破出来的地面真相**与据此做的取舍;
代码住在 [`packages/ext/src/cloud-vision.ts`](../../packages/ext/src/cloud-vision.ts)、
[`cloud-vision-hooks.ts`](../../packages/ext/src/cloud-vision-hooks.ts)、[`vision-image.ts`](../../packages/ext/src/vision-image.ts),
接线在 [`plugin.ts`](../../packages/ext/src/plugin.ts)。

## 1. 凭据与路由(只读勘破,2026-09-24)

基线 §2-B 第 1 条要求自动转写「直接调 HTTP 接口,鉴权用引擎访问 gateway 的同一份凭据」。实读:

| 问题 | 地面真相 | 坐标 |
| --- | --- | --- |
| 引擎访问云端用的是哪份凭据 | 登录铸的 `mcp_access` token,以 `{file:…ALPHA_MCP_TOKEN}` 引用装进云 MCP 定义的 `headers.Authorization`;ui-mac 每次 fork 把这份定义经 `ALPHA_CLOUD_MCP_DEF` 交给 ext,ext 的 `installCloudMcp()` 已经在解析那个 `{file:}` | `packages/ui-mac/src/main/alpha-config-injection.ts:386-391`、`cloud-sidecar-config.ts`、`packages/ext/src/cloud-websearch-kill.ts` `resolveFileRefs` |
| gateway 的识图路由收不收这份凭据 | 收。`POST /v1/tools/vision` 是封印路由,`authTenant` 对**这一条**额外带 `FORWARDED_MCP_AUTH_OPTS`,动作判定额外接受 `cloud.dispatch`;云 MCP 的 `cloud_vision` 本身也只是把调用方的 Authorization **原样转发**到同一条路由 | alpha-platform `packages/gateway/src/worker.ts` visionHandler、`cloud-mcp.ts` mount(`cloud_vision`) |
| 主机从哪来 | `ALPHA_BASE_URL` = `<platform>/v1`(`alpha-auth.ts:301`),platform 就是 gateway 主机(`shared/alpha-config.ts:30`);识图 URL = 它的 origin + `/v1/tools/vision` | `packages/ext/src/cloud-vision.ts` `cloudVisionEndpoint` |
| 凭据何时读 | **每次调用现读文件**(令牌续期会重写文件;引擎装配置时只解析一次,ext 比它新) | `cloudVisionAccess` |

结论:自动转写用的**就是**引擎经 MCP 访问云端的那份凭据,不另铸、不回退到 `ALPHA_CLOUD_TOKEN` / `ALPHA_API_KEY`。

「云端是否可用」与 `alpha-code#1411` / PR `#1442` 同一根轴(`platformPays = ALPHA_CLOUD_MCP_URL && ALPHA_MCP_TOKEN 密钥文件在场`;
桌面侧「登录+有额度」与「登录+无额度」不可区分,额度只在调用时以 402 出面):

| 状态 | 判据 | 用户看到的话(登记项,见 §4) |
| --- | --- | --- |
| 未登录 / BYOK | `ALPHA_BASE_URL` 或 `ALPHA_CLOUD_MCP_DEF` 缺席,或定义不带 `headers.Authorization`(密钥文件缺席时 ui-mac 给的 `enabled:false` 形状) | 尚未登录 Code Puppy 账号(**不出网**) |
| 凭据文件读不到 | `{file:}` 解析抛 | 登录凭据无效或已过期(**不出网**) |
| 401 / 403 | gateway | 同上 |
| 402 | gateway preauth | 账户额度不足 |
| 429 | 租户容量 | 云端识图暂时繁忙(已限流) |
| 400 / 413 | 图片校验 | 云端拒收了这张图片 |
| 422 `content_refused` / `content_blocked` | 审核 | **这张图片无法识别** |
| 5xx / 504 / 连不上 | 上游 / 网络 | 服务暂时故障 / 连不上云端识图服务 |

## 2. 五个钩子各管一格

| 钩子 | 做什么 | 引擎侧依据 |
| --- | --- | --- |
| `chat.message` | 登记用户贴的图;模型看不了图 ⇒ 每张图**追加**一个 `synthetic:true` 的 text part(转写块或失败块),图片 part **保留**;同会话按 sha256 去重(同内容只出网一次,在途也去重) | `session/prompt.ts:1042`:hook 拿到的 `parts` 就是随后持久化的那个数组;parts 读回按 id 排序(`message-v2.ts` `orderBy PartTable.id`),追加的 part id = `<图片 part id>-vision`,`PartID` 只要求 `prt` 前缀(`session/schema.ts:19`) |
| `experimental.chat.messages.transform` | ①从历史消息重建登记簿(进程重启后内存是空的;哈希按 part id 缓存);②模型看不了图时把**已带转写块**的用户消息里的图片 part、**已带标记**的 Read 结果里的图片附件从**本次请求的副本**里剔掉 | `session/prompt.ts:1299`:`msgs` 每步从库里重读(`filterCompactedEffect`),替换数组元素只影响本次 `toModelMessagesEffect`;不剔的话 `provider/transform.ts` `unsupportedParts` 会把图换成 `ERROR: Cannot read … Inform the user.`,与转写块打架 |
| `tool.execute.after` | Read 读到图片:登记(记绝对路径);看不了图 ⇒ 转写块接在 `output.output` 尾部、`output.metadata.alpha_vision` 打标记、附件保留;`cloud_cloud_vision` 结果 `content_refused` / `content_blocked` ⇒ 文本换成「这张图片无法识别」 | `session/tools.ts:170-200`:hook 拿到的 `output` 对象带 `attachments`,随后原样交给 `completeToolCall` 持久化(`processor.ts:180-194`);MCP 那条路 hook 拿到的是原始 `CallToolResult`,`content[].text` 在 hook 之后才被读(`tools.ts:520-530`) |
| `tool.execute.before` | 模型调 `cloud_cloud_vision`:`args.image` 由引用**原地**换成压缩后的 base64、补 `mime`,并写死 `model:"qwen"`、`fallback_on_refusal:false`(模型传什么都覆盖) | 基线 §1b:`session/tools.ts:498-508` hook 的 `output.args` 与随后 `execute(args)` 是同一对象,整体替换不生效 |
| `experimental.chat.system.transform` | 只对 `capabilities.input.image !== true` 的模型追加一段登记过的说明(云端可用 ⇒ 带工具 id 的那句;不可用 ⇒ 离线那句);**不提 gemini** | `llm/request.ts:72-80`:多出的段被引擎 join 进第二段 |

「模型能不能看图」的真源是引擎的 `capabilities.input.image`(`#1437` 起如实):system.transform 直接读引擎递进来的
Model;`chat.message` 只给 `{providerID, modelID}`,经 `client.provider.list()`(`/provider`,`Provider.ListResult`)查同一格,
按 `providerID/modelID` 缓存在**插件实例**里(#223 R7 的纪律:模块级不留可变态)。查不到 ⇒ 按看不了处理(基线 §2-B 第 6 条:
代价是多一次识图,不会漏识)。字段路径与真引擎一致由 `cloud-vision-engine-shape.test.ts` 钉住(跑真引擎 `models --verbose`)。

## 3. 三个取舍(与基线原文的差别,评审看这里)

1. **图片 part 保留、转写块另加,而不是「把图片 part 换成文本」。** 基线 §2-B 第 1 条原文是「换」。实读 UI:用户气泡按 part 渲染,
   换掉 = 用户自己的截图从气泡里消失、换成一段识图文字;换到能看图的模型时图也永远没了。保留 + 追加 synthetic part
   (UI 对 `synthetic` 的 text 不渲染,`packages/app/src/utils/prompt.ts:45`)+ 请求时剔掉,三条要求(模型拿到转写、
   持久化不重复调用、按哈希去重)一条不少,而用户界面**一个像素不变**、数据不丢。
2. **模型追问的路径读取不从磁盘读,只认本会话出现过的图。** 基线 §3 要求「与 Read 工具同一套权限判定」;插件里没有
   `ctx.ask`,手写一份权限求值就是替别人的文法造替身。所以 `image` 只能指向用户贴过的(附件编号 / 文件名)或 Read
   读到过的(路径 / 文件名)图 —— Read 那一步走的就是引擎自己的权限判定;没读过的路径得到一句「先用 Read 读它」的工具错误。
3. **压缩用引擎自己那份 photon(同一个 patched 包、同一份 wasm)**,不引第二套图像库、不调 `sips`。ext 是自包含 bundle
   (ADR-006),wasm 经 `with { type: "file" }` 随 bundle 落到 `dist/`,electron-builder 把 `*.wasm` 与 `plugin.js` 一起
   复制到 `<resources>/alpha-ext/`。实测(2026-09-24):Bun.build 产物在系统 Node 22.22 与 Electron 42.3.3 的内嵌
   Node 24.15 下同样跑通(3000×2000 → 1280×853 JPEG,FF D8);纯噪声 3000×2000 在长边 1280 下靠低质量档就能进 256 KiB。

## 4. 进模型上下文的字全部登记

转写块外框(wrapper)、九种失败句(template)、审核拒绝替换文本(text)、两句系统说明(template / text)全部在
[`context-injection.ts`](../../packages/ext/src/context-injection.ts) 登记,新 sink `vision-block` 与新 kind `wrapper`
的形状见 [`2026-09-08-context-injection-registry.md`](2026-09-08-context-injection-registry.md) §1 / §3;
三个新钩子的咽喉在 `context-injection.test.ts` ③b / ③d / ③g / ③h。

## 5. 判据地图

| 判据 | 在哪 |
| --- | --- |
| 看不了图 ⇒ 转写且只调一次(哈希去重、同消息两张同图一次、在途去重);体恒为 `{image,mime,model:"qwen",fallback_on_refusal:false}`;bearer 是云 MCP 那份;能看图 ⇒ 零调用 parts 逐字不变 | [`cloud-vision.test.ts`](../../packages/ext/src/cloud-vision.test.ts)(真 AlphaExt 钩子 + 真 HTTP 到桩 gateway + 真 photon) |
| `tool.execute.before` 原地改写(同一 args 对象)、引用解析、找不到即抛、别的工具不动、base64 本体也压 | 同上 |
| `content_refused` 两条路的文案;云端不可用十一格(402 / 401 / 429 / 502 / 504 / 413 / 三种未登录 / 凭据文件 / 连不上),未登录三格**不出网** | 同上 |
| Read 附件转写 + 按路径追问;messages.transform 剔图 + 登记簿重建;system.transform 两句逐字 | 同上 |
| 压缩:长边 ≤ 1280、JPEG、≤ 262144 B / 349528 chars、小图不放大、竖图、垃圾字节响亮失败、魔数表 | [`vision-image.test.ts`](../../packages/ext/src/vision-image.test.ts) |
| `capabilities.input.image` 字段路径与真引擎一致 | [`cloud-vision-engine-shape.test.ts`](../../packages/ext/src/cloud-vision-engine-shape.test.ts) |

## 6. 没做的 / 已知边界

- 登记簿每会话最多 32 张(挤出去的不再重新编号,模型引用不漂移);挤出去的图要再追问得让用户重贴或 Read 一次。
- 子会话(task 工具起的)有自己的 sessionID,看不到父会话的图。
- `chat.message` 里的识图是同步等的(线上默认档约 10 s/张,多张并行):用户这条消息要等识图回来才落库 —— 与上游 `!file`
  读文件的行为同形,没有另开异步通道。
- 打包版真机(打包 `.app` 里 wasm 真的落到 `<resources>/alpha-ext/`、真模型真 gateway)没有在本票跑,归 REQ-228 的 VERIFY 子票。
