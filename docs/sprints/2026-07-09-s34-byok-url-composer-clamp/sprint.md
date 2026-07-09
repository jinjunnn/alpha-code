# S34 — BYOK URL 约定统一 + composer 宽度 clamp(2026-07-09)

> 抽取:REQ-074 + REQ-075(均快车道 bug,用户当日报障并下令「作为一个小的 fix sprint;做完直接 ship:mac 本机测试直接 archived」)。
> 附带用户指令:全量核查 5 家 BYOK baseURL(已完成,结论见 REQ-074 行内)。

## 目标

1. **REQ-074**:BYOK 智谱 GLM「测试通、会话不通」根治——anthropic 兼容 baseURL 约定统一为「一律含 `/v1`」,测试探针与运行时(`@ai-sdk/anthropic` `${baseURL}/messages`)打同一个 URL。
2. **REQ-075**:composer 中间宽度溢出根治——`patch-upstream.ts` 给上游会话列补 `"max-width":"100%"`(审查面板开启时列宽为持久化固定 px、resize 无 clamp;alpha 的 0.64×启动宽默认值放大了它)。

## Task 表

| # | 任务 | REQ | 状态 |
|---|---|---|---|
| T1 | BACKLOG 登记(074/075,in-sprint)+ sprint 契约 | — | ☑ |
| T2 | 5 家 BYOK baseURL 全量核查(裸探 401=路径对;唯智谱坏) | 074 | ☑ |
| T3 | catalog `zhipuai.baseURL` → `…/api/anthropic/v1` + `provider-test.ts` anthropic 分支拼 `/messages` + 添加表单提示语注明 /v1 约定 + 单测 | 074 | ☐ |
| T4 | `patch-upstream.ts` 会话列 `"max-width":"100%"` 补丁 + 锚点守卫覆盖 | 075 | ☐ |
| T5 | alpha-check 全绿 → PR → merge → 四件套回写(BACKLOG 翻 shipped + CHANGELOG) | — | ☐ |
| T6 | ship:mac 本机装包 → 真机核验(GLM 会话真跑通 + 中间宽度不溢出,CDP 截图)→ verified→archived(用户已预授权) | — | ☐ |

## Gates

- push gate = `scripts/alpha-check.sh`(北极星守卫 + typecheck + 单测);
- 真机 gate = 正式装包后 CDP 实拍:① GLM(glm-5.2/5.1)会话发消息有真实回复;② 审查面板开启态缩窗至中间宽度 composer 不溢出;
- 归档 = 真机双项 PASS 后 BACKLOG 直接翻 verified→archived(用户 2026-07-09 预授权)。

## 诊断记录(证据)

- **REQ-074 根因链**:`alpha-models.json:151` baseURL 无 `/v1` → 运行时 `…/api/anthropic/messages` 收 HTTP 200 + `{"code":500,"msg":"404 NOT_FOUND"}`(智谱网关对错误路径回 200 包错误体)→ AI SDK 按 200 走流式解析、零 chunk 静默结束(引擎日志 `loop step=1 → exiting loop`,全程零 ERROR,UI 无任何提示 = 双重静默);测试探针 `provider-test.ts:23` 拼 `/v1/messages` 打对端点故通过。curl 实测:错误路径复现错误体;正确路径 glm-5.2 与 glm-5.1 均正常回复(测试各耗 1 token,用户 key)。「测试 4000ms」为智谱首 token 正常延迟(curl 实测 ~1.1s),非缺陷。
- **REQ-074 全量核查**:deepseek(`api.deepseek.com/v1`)/minimax(`api.minimax.chat/v1`)/alibaba(`dashscope…/compatible-mode/v1`)/moonshot(`api.moonshot.cn/v1`)+ `/chat/completions` 裸探全部 401 品牌鉴权错 = 路径存在且正确;`@ai-sdk/openai-compatible` 运行时同样拼 `/chat/completions`,与测试探针一致 → 不动。
- **REQ-075 复现**(dev 实例 CDP,Emulation 逐档 1500→700):vw 1200 时会话列(`@container`,`shrink-0 md:flex-none`)inline `width:1239px` 不随父级(944)重排,overflow +291,composer 右缘被祖先 `overflow-hidden` 裁切 = 用户截图同症;vw 1000 以下恢复 `width:100%`。列宽写方 = `session.tsx:1615 sessionPanelWidth()`(审查面板开启 → `layout.session.width()` 固定 px,仅拖动更新,resize 零 clamp);放大器 = alpha patch `DEFAULT_SESSION_WIDTH = innerWidth×0.64`(启动时一次性取值)。复现过程中面板曾被联动关闭一次(写方未定位,不影响根因与修复;修复后该态自然消失)。
- 复现脚本(一次性,scratchpad):cdp-measure.ts / cdp-inspect.ts / cdp-threshold.ts。

## 结果(随执行回写)

- (待回写)
