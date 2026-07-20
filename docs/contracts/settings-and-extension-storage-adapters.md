---
title: Settings and extension storage typed adapters
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-20
review_after: 2026-10-13
---

# Settings 与扩展存储 typed adapters

本文拥有 REQ-090 Settings 持久化 adapter 与 Settings 消费的扩展 CAS/GC adapter 合同。
它只定义 main/preload 间的 typed 数据与命令，不定义 Settings UI，也不改变上游配置持久化
内核或 CAS GC 算法。

## 1. Settings 权威值与接口

Settings 真源仍是 Electron `userData/default.dat` 的 `settings.v3` 值；其字段形状与当前
`packages/app/src/context/settings.tsx` 的 `Settings` 一致。语言、配色、shell、自动授权等由
各自既有真源拥有，不由本 adapter 聚合或迁移。

```ts
settings.read(): Promise<SettingsReadResult>
settings.validate(value: unknown): Promise<SettingsValidateResult>
settings.write(input: {
  value: AlphaSettings
  expectedRevision: string
}): Promise<SettingsWriteResult>
```

- `read` 对既有 Alpha 首启写入的 partial seed 补齐当前默认值，但不在读取时改盘；未知字段、
  错误类型和危险 key 均 fail closed。成功返回完整 typed value 与 opaque revision。
- `validate` 是无副作用预检；`write` 必须再次执行相同校验，renderer 的预检结果不构成授权。
- `write` 先读当前权威值。目标与权威值完全相同时按 exact replay 幂等成功，哪怕调用方仍携带
  第一次提交前的 revision；已存在权威文件时，exact replay 也要求文件与父目录 fsync
  成功才返回成功。否则 revision 不匹配返回冲突且零写入。
- typed Settings 提交直接更新 `default.dat` 的 `settings.v3`，保留文件中其它顶层键；
  该权威键不经由 `electron-store.set` 的写路径。提交使用与目标同目录的临时文件，严格按
  「写临时文件 → fsync 临时文件 → 同目录原子 rename → fsync 父目录」完成；不存在
  EXDEV/直接覆盖 fallback。临时文件以 `wx` 独占创建，命名为
  `.目标名.tmp-<pid>-<8hex>-<host-id>-<process-instance-id>`；前两段保留写入尝试身份，后两段绑定创建
  主机与进程实例。命名碰撞会令提交失败，且不会删除或覆盖已存在的同名临时文件。
- 上述任一步（包括父目录 fsync）失败都 fail closed 为 `write-failed`，即使 rename 后的新值
  在当前文件视图已可见也不升级为成功。只有完整持久提交结束且重读确认目标权威值后才返回
  `ok: true`。
- rename 前失败会删除本次写入创建的唯一临时文件，且清理失败不得覆盖原始提交错误。adapter
  启动时只考虑与当前目标及完整创建身份严格匹配的临时文件：host-id 必须与本机一致，且记录的
  pid 只有在 `process.kill(pid, 0)` 明确返回 `ESRCH` 时才可判为孤儿并删除；成功或 `EPERM`
  均按活跃处理，其它错误、旧格式、身份损坏、异机身份及任何清扫异常一律保守保留。该删除判定
  fail closed，但残留临时文件或清扫失败不阻断正常权威值读写。
- 失败结果尽力附上重新读取的 `authoritative` 值，供消费者保留草稿并显示仍生效的值。进程
  重启后 `read` 重新从同一 `default.dat/settings.v3` 读取，不采信 renderer 内存或成功提示。

稳定错误码：

| code | 语义 | 是否写入 |
| --- | --- | --- |
| `invalid-input` | candidate/revision 不满足 closed schema | 否 |
| `authority-invalid` | 已存权威值不可解码；`read` 返回其 opaque revision，允许显式修复写 | 否 |
| `read-failed` | 权威存储不可读 | 否 |
| `revision-conflict` | 非 exact replay 且 expected revision 已陈旧 | 否 |
| `write-failed` | 无法证明目标已经成为权威值 | 未知或否；调用方必须以返回/后续 `read` 为准 |

所有失败只返回上述 code、opaque revision 和可验证的 typed authoritative value；底层异常、
本地路径、secret 与原始损坏内容不得跨 preload。

## 2. 扩展存储接口与白名单

```ts
extensionStorage.snapshot(): Promise<ExtensionStorageSnapshot>
extensionStorage.inspect(): Promise<ExtensionStorageResult> // dryRun=true
extensionStorage.collect(): Promise<ExtensionStorageResult> // dryRun=false
```

`inspect` 与 `collect` 复用定时 GC 的同一 production worker 入口、冻结环境根/seed lock/grace
配置，以及既有 CAS/Bundle 锁。因此手动操作与定时轮次、扩展事务之间保持原有互斥、宽限和
fail-closed 语义；adapter 不提供同步 main-thread 回退。

Renderer-safe 结果是 closed projection，字段只允许：

```ts
type ExtensionStorageResult = {
  code: "ok" | "busy" | "fail-closed" | "worker-failed"
  blobsTotal: number
  sweepableCount: number
  sweptCount: number
  keptByGrace: number
  warningCount: number
}
```

| code | 语义 |
| --- | --- |
| `ok` | worker 以可信摘要完成 |
| `busy` | CAS/事务锁忙，或本进程已有手动轮次；本次零新增触发 |
| `fail-closed` | mark root/身份/协议事实不足，collector 拒绝 sweep |
| `worker-failed` | worker 创建、执行或通信失败；无 main-thread 回退 |

`snapshot.state` 只允许 `not-run / checking / collecting / ready`；`ready` 携带最后一次上述
结果，其余状态不带结果。时间戳、容量/bytes、逐项或百分比进度均不在数据合同内。

完整 `CasGcReport` 和 worker `CasGcRoundSummary` 都不是 renderer wire 类型。投影必须丢弃
`reason`、`marked`、`dryRun`，并禁止任何 digest、实际删除路径、`sweepable`/`swept` 数组、
warnings 明细或其它未知字段。warning 只允许聚合为 `warningCount`。

## 3. 边界与验证

- 无用户/租户参数；设置与扩展存储只作用于当前本机 app 环境。
- 不提供通用设置注册框架，不修改上游 Settings UI、配置持久化内核或 GC collector。
- adapter 契约测试位于
  `packages/ui-mac/src/main/settings-adapters.test.ts`，Settings 用例使用真实临时 `userData/default.dat`，
  并通过子进程重新打开验证成功提交。同步 fs 测试接缝记录写目标、open 路径与 flags、fd、fsync、
  close 及 rename 两端，要求一次成功写入严格出现「以 `wx` 写入契约命名且不同于目标的同目录
  临时文件 → 以 `r` 打开并 fsync 同一临时文件 → 从该临时文件 rename 到不同的目标 → 以 `r`
  打开并 fsync 父目录 → 返回成功」。因此令 temp 等于目标、删除父目录 fsync，或绕过接缝直接
  使用 `node:fs`/`fs.promises` 都会缺失对象、flags 或事件绑定并使测试失败。该断言只证明这些
  系统调用对象与顺序，不声称用户态测试可以模拟掉电后的真实介质状态。
- 崩溃注入分别命中「文件 fsync 后、rename 前」与「rename 后、父目录 fsync 前」，只证明子进程
  未报假成功且重启后权威值是完整旧值或完整新值；它不单独证明目录项已掉电持久。前一窗口的
  同机且创建者 pid 已明确死亡的 orphan temp 必须由下一次 adapter 启动清扫，普通写入/文件
  fsync/hook/rename 失败则在本次失败路径清理。清扫测试另覆盖活跃 pid、异机/相似命名、进程
  状态判不准及清扫 I/O 失败的保守保留。其余覆盖 schema 正负例、注入的 rename/父目录 fsync
  系统调用失败、revision 冲突、exact replay 幂等、错误脱敏、手动 GC dry-run/collect、确定性
  busy 映射与 renderer 字段白名单。
