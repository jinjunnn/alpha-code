---
title: "cap:artifact-lifecycle 矩阵 — #329 配额边界 / retention dry-run / OOXML 与 MIME fixture"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-19
review_after: 2026-10-19
---

# cap:artifact-lifecycle 证据 — #329(2026-07-19)

归并 REQ-093 的配额/retention/MIME/provenance 验证(capability = artifact lifecycle)。范围 = `alpha-code`
主进程 registry/manifest/download 逻辑(OOXML 高保真 subtype 与生产端 magic 检测在平台仓 B,非本仓被测面)。
基点 HEAD = `a5613686`。证据主体 = 确定性主进程单测(临时隔离目录,真实原子写/守卫/降级),复跑
`artifact-service.test.ts` + `artifact-manifest.test.ts` + `alpha-artifact-download.test.ts` = **104 pass / 0 fail**。

## 矩阵结果

| # | 项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 单件配额 100 MiB fail-closed(descriptor.size / Content-Length / 未知长度 / 少报长度 四路越界前置或首字节即停,零残留) | PASS | `alpha-artifact-download.test.ts:156,167,180,190`(over-limit,body 不拉取、upstream 取消、无 `.part`) |
| 2 | manifest schema 完整性 + 未知未来版本只读拒绝 + 损坏即 corrupt(不静默重写) | PASS | `artifact-manifest.test.ts:152,161,166,173,184`;register/list/usage 遇 future-version 一律 read-only(`artifact-service.test.ts:165,236,375`) |
| 3 | 同名不覆盖(同 savedPath 被他 id 占用即拒)+ 路径穿越 / symlink 逃逸 / 控制字符守卫 | PASS | `artifact-service.test.ts:136,151`、`artifact-manifest.test.ts:71,136,202`、`alpha-workdir.ts` realpath 圈禁 |
| 4 | MIME fixture 路由(detected>claimed>扩展名;冲突诚实并列 warning,不改 trust) | PASS | `artifact-service.test.ts:108`(claimed vs detected 冲突 warning);消费端 detected 路由真机见 #324 renderer-safety |
| 5 | digest 复核:同尺寸改内容 → verify 检出不符,降级持久化(重启不回显旧 verified) | PASS | `artifact-service.test.ts:78,185,196,257`(mismatch/missing 降级持久化) |
| 6 | legacy run 只读发现(无 manifest → 不持久化、不假报 verified)+ manifest 外残留文件登记 legacyFiles | PASS | `artifact-service.test.ts:217,228` |
| 7 | byte accounting 分列供数(账面/盘上/legacy/missing)+ 集中 limits 暴露 | PASS | `artifact-service.test.ts:325,353,375` |
| 8 | provenance 不含 bearer/绝对 URL(contentRef 必 server-relative,凭据不落 manifest) | PASS | `artifact-manifest.test.ts:210`、`artifact-service.test.ts:399`(renderer 可见面无绝对路径/凭据) |
| 9 | run 512 MiB / project 5 GiB 配额**执行前置** admission | **FAIL** | 常量在 `artifact-service.ts:39-40`,但越基线只 `warnings.push`(`artifact-service.ts:142-146`),register 不拒绝已落盘文件,无并发原子 admission。已由**开放** CODE 票 #279(REQ-093)承载 |
| 10 | 30 天 retention 计划 / pin·export·source-file 豁免 / dry-run / confirm / 审计记录 | **FAIL** | 仅 `removeArtifact` GC 钩子(`artifact-service.ts:295` 单测在案),无策略、无 dry-run、无生产调用者。已由**开放** CODE 票 #280(REQ-093)承载 |
| 11 | OOXML 容器 subtype 检测并据结构 gate 特权渲染 | **FAIL** | 本仓消费端只并列记录 detectedMime,OOXML 生产端只识别为 ZIP;docx/xlsx 现走 fallback(诚实外部打开,见 #324)。subtype 检测已由**开放** CODE 票 #281(REQ-093,平台+本仓)承载 |
| 12 | Windows 保留名 / 大小写折叠冲突 的碰撞安全文件名保留 | **FAIL(部分)** | 穿越/symlink/控制字符/同名已守卫(见 #3);Windows 保留名(CON/PRN…)与 case-fold 未处理。已由**开放** CODE 票 #282(REQ-093)承载 |

8 PASS / 4 FAIL(其中 #12 为部分)。

## FAIL 处置(不修码)

四项 FAIL 均为容量/生命周期治理能力缺口,已在 2026-07-14 S40–S49 审计(REQ-093)disposition 中开出对应
**开放** CODE 票,不重复新开:
- #279 `[REQ-093][CODE] Enforce atomic run and project artifact quota admission before final rename`
- #280 `[REQ-093][CODE] Plan and confirm 30-day managed-run retention with pin, export, and source-file exemptions`
- #281 `[REQ-093][CODE] Detect OOXML container subtypes and gate privileged rendering on detected structure`
- #282 `[REQ-093][CODE] Reserve collision-safe artifact filenames across incremental downloads and case-folded filesystems`
- (provenance 完整字段另有 #283;配额/retention 竞态 VERIFY 另有 #403)

## 判定

单件配额 fail-closed、manifest 完整性/版本拒绝、碰撞守卫、MIME 路由、digest 降级、legacy 只读发现、byte
accounting、provenance 凭据排除 8 项 PASS;run/project 配额 admission、retention dry-run、OOXML subtype、
Windows/case-fold 碰撞 4 项 FAIL(能力未实现,已挂开放父需求 CODE 票)。矩阵执行完毕,本票关闭(completed)。
