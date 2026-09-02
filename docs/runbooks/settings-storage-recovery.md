---
title: Settings storage recovery
kind: runbook
status: active
owners:
  - Code Puppy maintainers
last_reviewed: 2026-07-20
review_after: 2026-10-18
---

# Settings 存储恢复

本 runbook 处理 Settings 持久写在进程崩溃后可能留下的临时文件。权威值与提交协议由
[Settings and extension storage typed adapters contract](../contracts/settings-and-extension-storage-adapters.md)
定义。

## 识别与影响

Settings 权威文件是 Electron `userData/default.dat`；同目录中 basename 匹配
`.default.dat.tmp-<pid>-<8hex>` 的普通文件是某次未完成写入的临时文件。崩溃可能留下这些小文件，
adapter 不会自动清理。它们不会被读取为权威值，不会改变「临时文件 fsync → rename → 父目录
fsync」的提交顺序，也不会使一次未完成提交变成成功；后续随机名称若发生碰撞会 fail closed。

## 安全手工清理

只有同时满足以下条件才可删除候选临时文件：

1. 停止所有能访问同一 `userData` 目录的 Code Puppy 实例及其它 Settings writer；若目录由多台
   主机共享，必须在每台主机上完成并确认全局静默。无法证明全共享范围静默时保留文件。
2. 解析出确切的权威文件路径，只检查其同一目录、且 basename 以
   `.${权威 basename}.tmp-` 开头的普通文件。临时名称只用于发现候选，不证明所有权；PID 已死亡、
   文件年龄或目录内身份文件都不能单独证明可删除。
3. 用不跟随符号链接的文件检查确认每个候选是普通文件，并逐个核对绝对路径；不得选中
   `default.dat` 权威文件、目录、符号链接或其它目标 namespace。逐个删除明确候选，避免宽泛递归
   或未审阅的通配删除。
4. 重新启动应用，读取 Settings 并执行一次普通保存；若读取失败，保留其余候选并按权威文件损坏
   处理，不得把任一 temp 直接提升为权威值。

自动跨进程清扫故意不存在：共享目录中的本地 PID/主机判断不能证明远端 writer 已退出，而保留
小型残留只是运维观感问题，误删活跃 writer 的 temp 会破坏正确性。
