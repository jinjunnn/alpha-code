# REQ-003 审计:两条 SSE 链路健壮性 — 2026-07-03

> 验收①的审查报告(file:line 取证)。链路 1 = 模型代理流式(A→B 网关→上游 LLM);链路 2 = 云任务事件流(alpha-cloud ↔ alpha-cloud-events)。

## 链路 1:模型代理流式转发(B `lib/metered-stream.ts` + `worker.ts`)

| 维度 | 结论 | 取证 |
|---|---|---|
| 缓冲/卡顿 | ✅ 逐 chunk 透传(pull 驱动 `ctrl.enqueue(value)` 原样下发,旁路 sniff 不阻塞) | metered-stream.ts pull() |
| 背压 | ✅ pull 驱动 = client 不读则不拉上游(期望行为) | 同上 |
| 上游断流 | ✅ read() throw → `settleOnce()` 结算 partial 再 `ctrl.error`(REQ-002 修复后不丢账) | pull() catch |
| client 断连 | ✅ `cancel()` → settleOnce + `reader.cancel()` 上游及时释放 | cancel() |
| 收尾计量 | ✅ 三态恰好一次(settled 守卫);末 usage 无换行的 tail flush 已修 | settleOnce/tail scan |
| 心跳 | ⚠️ 无 keep-alive 注释帧——reasoning 模型长思考期(分钟级零输出)中间层可能掐空闲连接。**建议**(未改,钱路径保守):上游 >30s 无 chunk 时插 `: keep-alive\n\n` 注释帧;A 侧 opencode 引擎自带流超时兜底 | 建议项 |
| 上游悬挂 | ⚠️ `fetch(upstream)` 无 read 超时——上游永挂则连接悬到平台时限。**建议**同上批处理(与心跳同改更顺) | worker.ts 上游 fetch |

## 链路 2:云任务事件流

**B 侧(cloud.ts /events)**:✅ 有界 live-tail ~55s 关闭(避 Worker 时限)+ `Last-Event-ID` DO 重放 + client 断连 `cancel()` 置位及时 break(AR-12,不空转)。SSE 头齐(`x-accel-buffering:no` 等)。55s 内无事件即静默——A 侧 90s 空闲阈值兼容。

**A 侧(alpha-cloud-events.ts)——C23 四病灶,本批(PR #50)全修**:
| C23 病灶 | 旧行为 | 修 |
|---|---|---|
| 空转 200 关闭无退避 | 立即重连 → 紧凑风暴 | 指数退避+抖动(1s→30s cap),**只对失败/空转**;收到过事件的 55s 分页关闭仍立即续读 |
| 终态帧缺 `event:` 漏判 | 默认 "message" 永不终态 → 重连空转 | `terminalEventName` 从 `data.type` 兜底 |
| 非数字 id 丢失 | `Number(id) || last` | `lastId` 原样字符串透传 |
| 终态后 subs 泄漏(NEW-2) | 账簿条目永留 | cloud-ipc 终态即清账(`isTerminalCloudEvent`) |
| (新增)悬挂检测 | 无 → 僵死连接永挂 | 90s 无字节 abort → 退避重连(验收④) |

已知未做(诚实):SSE 多行 `data:` 拼接(规范允许,B 不产此形态,消费端注释留痕);链路 1 的两个「建议」项。

## 验收对照
① 本报告 ✅;② C23 关闭 ✅(上表,PR #50 + 纯逻辑单测);③ 弱网模拟 UI 呈现 → 真机批(联动 B20/B11,模型流中断呈现属 B11 统一错误面);④ 悬挂检测:链路 2 ✅(90s idle abort),链路 1 = 建议项待批。
