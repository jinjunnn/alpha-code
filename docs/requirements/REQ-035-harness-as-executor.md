---
id: REQ-035
title: 本地 harness-as-executor:Claude Code / Codex 委托执行(tool/MCP 接缝)—— 多 harness 演进第一阶段(长期目标 = 会话级并轨)
type: feature
priority: P2
status: parked
repo: A
created: 2026-07-05
---

## 背景(为什么)

用户拍板多 harness 战略(2026-07-05,GOALS G5 同步登记):让 alpha-code 背后拥有 opencode / Claude Code / Codex 三个 harness 的能力。分层现状与路径:

- **云侧已是双 harness 事实**:alpha-platform `packages/gateway/src/harness/{coding-claudecode.ts, noncoding-openai.ts}`——云端编码任务就是 Claude Code 跑的(容器 `ANTHROPIC_BASE_URL` 指 gateway,cap token 换真 key);codex 云 harness 为将来顺理成章的 B 侧增量(不在本档)。
- **本地第一阶段 = executor 委托(本档)**:opencode 仍是唯一交互会话引擎;Claude Code / Codex 作为**被委托的执行器**,经零-fork 接缝(自定义 tool 或 MCP,ADR-002)接收界定清楚的任务、在本机 CLI 无头执行、结果回流 opencode 会话。与 B 侧 harness 模式同构。
- **隐藏红利**:任务跑在 Claude Code 体内时,其生态插件/skills **原生可用**,零适配(与 [[REQ-034]] 转换器互补,ADR-023)。

## 目标(第一阶段 executor,本档范围)

1. **委托接缝**:自定义 tool 或 MCP(`alpha-code/ext` 或 `.opencode/tool`,预 bundle,ADR-006)——输入 = 任务描述 + 工作目录 + 边界(可写范围/超时/预算),执行 = 本机 `claude` 无头模式 / `codex exec --json`,输出 = 最终回复 + 产物清单,回流会话内呈现(引擎原生工具调用形态,同 B3 验收④)。
2. **依赖预检**:`which claude` / `which codex`,未装诚实提示 + 安装指引(不代装),同 ADR-014 §7 纪律。
3. **凭证**:Claude Code 可选两路——用户自有登录(默认)或 `ANTHROPIC_BASE_URL` 指 alpha-gateway(平台代付,B 侧 `/v1/messages` ingress 既有,需登录态 token);Codex 用户自有凭证(平台代付不承诺)。
4. **边界与留痕**:委托任务超时上限、run 记录落 `.alpha/runs/`(ADR-019/ADR-022 同款守卫);执行器崩溃/超时 loud 回流,不静默。

## 演进目标(第二阶段,用户 2026-07-05 拍板方向,不在本档实现)

**会话级并轨:alpha UI 直驱 opencode / Claude Code / Codex 三引擎会话。** 启动硬前置(届时逐项过门,本档只登记不实施):
1. `/app:challenge` + **POSITIONING/GOALS 修订**——产品定位从「基于 opencode 的产品」扩为「多 harness 编排产品」,是定位级变更;
2. **承载方案 spike**:两条路线对比拍板——「翻译 sidecar 实现 opencode SDK 契约子集(harness 协议 → opencode 消息形状,复用冻结前端组件)」vs「每 harness 独立会话 UI(放弃复用)」;前者要自担第二契约的漂移追踪成本,后者工作量倍增——都昂贵,必须 spike 实证再选;
3. 立独立 ADR(北极星范围、维护面、凭证/计费拓扑连带修订)。

## 验收标准(第一阶段,可验证)

1. 会话内委托一个真实任务给 Claude Code(如「审查此目录并出报告」)→ 工具调用形态回流结果,run 记录落 `.alpha/runs/`;
2. 同一任务委托 codex(`exec --json`)成功回流;
3. 未装 CLI → 诚实提示,不假成功;执行器超时/崩溃 → loud 错误回流;
4. 委托任务的写盘困在声明的工作目录(守卫复用实测);
5. gateway 代付路径(Claude Code + ANTHROPIC_BASE_URL)在登录态下实测出账(metering 可见);
6. 零改上游文件(北极星守卫绿)。

## 非目标(第一阶段)

- 不做会话级并轨的任何实现(含翻译层试写)——见上方演进前置;
- 不做 B 侧 codex 云 harness(独立 B 仓增量,需要时另登记);
- 不做执行器进度流式回放(第一阶段结果回流即可,流式属并轨阶段课题);
- 不代管 Codex 凭证/计费。

## 方案 / 关联

- [[ADR-002]](接缝)/ [[ADR-006]](预 bundle)/ [[ADR-019]]/[[ADR-022]](run 落盘与边界)/ [[ADR-023]](与转换器互补)/ [[REQ-034]];
- GOALS G5(多 harness 能力线)为本档的目标层锚点;
- 先例:B 侧 `coding-claudecode.ts`(同构模式)、开发环境 codex-rescue 子代理(委托心智验证)。

## 状态说明

**parked(用户 2026-07-05:暂不开发,等想清楚再启动)**;激活条件 = 用户拍板启动第一阶段;第二阶段另有硬前置(见「演进目标」)。
