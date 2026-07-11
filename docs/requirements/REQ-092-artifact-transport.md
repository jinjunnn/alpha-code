---
id: REQ-092
title: 产物传输去 base64 化 —— descriptor-only 状态/MCP/result + 认证流式下载 + 先限额后落盘
type: security
github_issue: https://github.com/jinjunnn/alpha-work/issues/1
repo: X
created: 2026-07-10
source: alpha 三仓全面审计与产物能力专项(2026-07-10);用户确认拆为独立开发 REQ(2026-07-10)
---

## 背景

当前产物字节在平台 pipeline 的公开 `result`、job status、MCP 返回和 artifact list 中重复出现；桌面端又执行 `arrayBuffer → Buffer → base64 → Buffer`。512 KiB 二进制经 base64 后约 683 KiB，若进入 MCP 文本或模型上下文，会同时放大 token、网络、序列化和内存成本。

现有 100 MiB 单文件限制发生在完整缓冲及 base64 转换之后，无法阻止峰值内存放大。证据面：

- B 仓 `packages/gateway/src/pipelines.ts`、`lib/cloud-contract.ts`、`cloud-mcp.ts`、`routes/cloud-jobs.ts`；
- A 仓 `packages/ui-mac/src/main/alpha-cloud-jobs.ts` 的 `fetchCloudArtifact`；
- A 仓 `packages/ui-mac/src/preload/types.ts` 的 `CloudArtifactContent.base64`；
- A 仓 `packages/ui-mac/src/main/alpha-workdir.ts` 的下载后解码与限额。

## 目标与交付

1. 定义跨仓版本化 `ArtifactDescriptor` 契约。status、MCP、result 与 list 只携带 descriptor/ID/关系，不携带 artifact 内容、base64、data URL 或内联二进制。
2. 平台提供独立、认证的 content endpoint，以流响应字节；正确返回 `Content-Type`、`Content-Length`（已知时）、`Content-Disposition`、digest/ETag，并支持取消。需要媒体随机访问时支持 HTTP Range。
3. 桌面 main process 直接把响应流写入同目录 `.part` 文件，边读边计数并计算 sha256；通过全部校验后原子 rename。Bearer token 不离开 main process。
4. 限额必须发生在分配完整缓冲之前：先校验 descriptor/`Content-Length`，未知长度或对端撒谎时继续按流累计，越界立即 abort、关闭文件并删除 `.part`。
5. Electron IPC 只传 descriptor、进度、控制命令与受控句柄/URI，不传完整 base64、`ArrayBuffer` 或 `Buffer`。MCP/tool result 同样不得返回字节。
6. 为 A/B 契约切换提供有期限的兼容窗口和迁移顺序：B 先同时提供新 endpoint，A 切换后再删除旧内联字段；兼容路径不得把旧 base64 转发给 renderer 或模型。

建议最小 descriptor 字段：`schemaVersion`、`id`、`source`、`name`、`size`、`claimedMime`、`detectedMime`、`sha256`、`trust`、`role`、`primaryId`、`previewIds`、`contentRef` 与 verification 摘要。字段完整定义由 [[REQ-093]] 持有。

## 可验证验收标准

1. 对一个含二进制产物的真实 cloud run，以下响应的 JSON 均不包含 `base64`、data URL 或内容字段：job status、pipeline result、artifact list、MCP `cloud_status`/`cloud_artifacts` 及模型 transcript；只返回 descriptor/ID。
2. 100 MiB fixture 可从平台流式保存至 `.alpha/runs/<runId>/artifacts/`，sha256 与源端一致；A 进程相对基线的峰值 RSS 不随文件大小线性增长，100 MiB 用例的传输额外峰值不超过 32 MiB，并保留测量日志。
3. `Content-Length` 超限时在读取 body 前拒绝；无 `Content-Length`、长度少报和 chunked 三种用例均在累计字节首次越界时中止，目标文件与 `.part` 均不残留。
4. 网络断开、取消、校验失败和磁盘写满均返回 loud、可分类错误；不得生成看似成功的最终文件，重试不与旧 `.part` 冲突。
5. 下载期间 bearer/token 不出现在 renderer IPC、日志、manifest、文件名或错误文案中。
6. A/B 契约与端到端测试覆盖：空文件、正常文件、超限、长度欺骗、断流、Range、重复下载、sha256 不符及并发下载；旧客户端兼容窗口和删除日期有版本记录。
7. 代码扫描门禁止向 cloud artifact status/MCP/result/preload 类型重新增加 `base64`/data URL 内容字段。

## 非目标

- 不在本需求实现 Workbench、renderer 或 Office 视觉验证；分别归 [[REQ-094]]、[[REQ-095]]、[[REQ-097]]。
- 不禁止模型供应商协议内部对图片/PDF attachment 使用其必需编码；本需求只约束 Alpha artifact transport、状态、MCP/tool result 与 Electron IPC。
- 不把任意本地绝对路径暴露给 renderer 或远端；本地访问仍经 main-owned service/policy。
- 不在本需求定义完整磁盘保留与 manifest 策略；归 [[REQ-093]]。

## 依赖与激活条件

- 无产品代码硬前置，且是后续 Artifact Workbench 的阻断项；实施状态、优先级和 Sprint 归关联 GitHub Issue 与 Alpha Delivery 管理。
- 复用 [[ADR-019]] 的 `.alpha/runs` 落点与路径逃逸守卫；跨运行时边界遵守 [[ADR-006]]。
- [[REQ-093]] 依赖本需求提供稳定 descriptor/stream；[[REQ-094]] 及后续 renderer 不得绕过该传输层取字节。
