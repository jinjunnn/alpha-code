---
id: REQ-093
title: Artifact Manifest 与 Registry —— artifacts.json、内容鉴别、配额、保留和 provenance 真相源
type: feature
github_issue: https://github.com/jinjunnn/alpha-work/issues/2
repo: X
created: 2026-07-10
source: alpha 三仓全面审计与产物能力专项(2026-07-10);用户确认拆为独立开发 REQ(2026-07-10)
---

## 背景

当前平台 normalized status 的 `artifact_ids` 不稳定，list endpoint 临时推导 ID；A 仓仅保存 `contract.json`、`status.json` 与实际文件，没有 `artifacts.json`。应用重启后缺少可恢复的 descriptor、来源、主产物/预览关系和验证状态。文件扩展名与远端声明 MIME 也没有统一的 magic 检测与冲突策略。

现有基础是 [[ADR-019]] 的 `.alpha/runs/<runId>/` 目录，以及 `packages/ui-mac/src/main/alpha-workdir.ts` 的路径净化、realpath 防逃逸和原子写；本需求在其上增加持久真相源，不另造第二套 run 目录。

## 目标与交付

1. 在每个 managed run 下建立版本化 `.alpha/runs/<runId>/artifacts.json`，以原子写维护；manifest 可在进程重启后独立恢复，不依赖内存 list 或再次请求平台。
2. 定义统一 `ArtifactDescriptor`：
   - 身份：`schemaVersion`、稳定 `id`、`runId`、`source`、`uri`、`name`；
   - 完整性：`size`、`sha256`、`claimedMime`、`detectedMime`、检测器版本；
   - 信任与关系：`trust`、`role`、`primaryId`、`previewIds`、`verificationId`；
   - provenance：producer（agent/tool/pipeline）、source repo/job/turn、createdAt、original locator、生成参数摘要；
   - 生命周期：状态、lastAccessedAt、retention/pinned、warnings/error。
3. 由 main-owned `ArtifactService` 对 workspace/local/cloud/message/automation source 做统一 stat、magic MIME、大小、sha256、流读取与 policy；renderer 只消费 descriptor 和受控流。
4. MIME 决策以 magic/容器结构为安全依据，保留远端 claimed MIME 和扩展名用于诊断。冲突必须产生 warning；renderer 不得仅凭扩展名选择高权限路径。OOXML ZIP subtype 需根据内部 content types/结构识别。
5. 建立三层配额与数量限制，默认基线为：单 artifact 100 MiB、单 run 512 MiB/256 件、managed project artifacts 5 GiB。所有值集中配置并在 UI/错误中可见；越界前置拒绝且不会留下半成品。
6. managed run 默认保留 30 天；pinned run、用户明确导出的副本和项目源文件不自动清理。清理先形成可审计计划，只删除 Alpha 管理目录内满足条件的内容，并同步原子更新 manifest。
7. 支持 legacy run：缺少 `artifacts.json` 时只读发现 `artifacts/`，生成内存 descriptor 并标记 `legacy/unverified`；经显式迁移或下一次受控写入后再持久化，不能把未知文件假报为 verified。

## 可验证验收标准

1. 保存一个 run 后，`artifacts.json` 可通过 schema 校验，所有落盘文件的 size/sha256 与 descriptor 一致；杀进程并离线重启后仍能恢复相同 ID、关系、来源和验证状态。
2. 正常、扩展名错误、claimed MIME 错误、无扩展名、polyglot/未知格式、OOXML subtype 六组 fixture 得到确定结果；冲突有 warning，高权限 renderer 依据 detected MIME/结构而不是扩展名启动。
3. 单件、单 run 件数/总量、项目总量的边界值与越界值均有测试；并发写入不能越过总配额，manifest 不损坏，不遗留未登记 final 文件。
4. sha256 在 [[REQ-092]] 流式写入时单遍计算；内容被离线篡改后，下次打开能检测 digest 不符并降级为 untrusted，不继续显示旧 verified 状态。
5. retention dry-run 能列出将清理的 run、字节和原因；pinned/未到期/项目源文件不在列表。确认清理后只删除计划内 managed 内容，保留审计记录且 manifest/index 无悬挂引用。
6. 两个同名 artifact 不发生覆盖，ID/文件名映射稳定；路径穿越、symlink、控制字符、保留名和大小写冲突 fixture 全部被安全处理。
7. provenance 能从 Workbench 卡片追溯到 run/job/turn/producer；不得记录 bearer、secret、完整 prompt 或未经允许的敏感环境变量。
8. schema migration 测试至少覆盖当前版本、前一版本和未知未来版本；未知版本只读/报错，不静默重写。

## 非目标

- 不实现具体 Preview UI 或格式 renderer；分别归 [[REQ-094]]、[[REQ-095]]、[[REQ-096]]。
- 不把 `.alpha/runs` 变成用户文档的永久备份系统；导出后的用户副本不受 managed retention 管理。
- 不做全局内容去重或远端对象存储迁移；sha256 首先服务完整性、缓存键和 provenance。
- 不信任远端 verification 字段替代本地 policy；远端结论必须保留来源并可被本地降级。

## 依赖与激活条件

- 依赖 [[REQ-092]] 的 descriptor-only 契约和流式落盘；可先用 fixture stream 开发 schema/registry，但不得以 base64 临时接口定型。
- 沿用 [[ADR-019]] 的目录所有权和 [[REQ-065]] 的 `.alpha` 纯度边界。
- 为 [[REQ-094]]、[[REQ-095]]、[[REQ-097]] 提供唯一 descriptor/manifest 契约；这些消费者不得各自重新猜 MIME 或扫描出第二真相源。
