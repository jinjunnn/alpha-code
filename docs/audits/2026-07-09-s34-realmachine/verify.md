# S34 真机批 —— REQ-074/075 验证(2026-07-09)

> 环境:正式安装包(prod 渠道本地打包,ad-hoc 签名,装入 `/Applications/alpha-code.app`)+
> **真实 profile**(登录态·免费版;BYOK 智谱 key 已配,composer 沿用 glm-5.1)。
> 走查方式:`ALPHA_CDP=1` 启动 + CDP 驱动;截图 = 本目录 `*.png`。
> 结论:**两需求全部 verified,当轮归档(用户开工时预授权)**。

## 轮次记录

### 第一轮(13:12 包,PR #163)——REQ-075 PASS,REQ-074 逮出补丁二

- **REQ-075 ✅**:审查面板开启态(用户真实持久布局,列宽 885px),Emulation 1600/1200/1000 三档
  composer 全部在窗内(overflow -475/-75/-32;1000 档列被 clamp 885→728),inline style 带
  `max-width: 100%`。修复前同机制下 1200 档溢出 +291(dev 复现记录见 sprint 档)。
- **REQ-074 ❌ 第一轮(有价值的失败)**:glm-5.1 发真实消息 → **loud 红条
  `Not Found: {"detail":"Not Found"}`** —— 静默失败已消(探针/运行时同拼法生效),但会话仍不通。
  引擎日志栈实锤第二层机制:`OpenAICompatibleChatLanguageModel.doStream` —— **models.dev 合并
  模型保留其 npm(@ai-sdk/openai-compatible),仅目录 declared 模型用我们的 provider.npm**;
  anthropic 端点只对 declared(glm-5.2/4.5-air)成立,合并模型(用户在用的 glm-5.1)以 openai
  拼法打 anthropic baseURL = 死路。→ 补丁二(PR #165):BYOK 目录统一 OpenAI 兼容端点。

### 第二轮(补丁二包,PR #165)——双项 PASS

| REQ | 场景 | 结果 |
|---|---|---|
| **074** | glm-5.1 新会话发真实消息 →「你好!我是 alpha-code,随时准备帮你处理代码任务。」落款 **Build · GLM-5.1 · 7秒**,零错误条;会话标题由 GLM title agent 正常生成(`01-glm-reply.png`) | ✅ PASS |
| **075** | 审查面板开启态,1600/1200/1000 三档 composer 全在窗内(overflow -475/-75/-32,1000 档列 clamp 885→728),`max-width:100%` 在位(`02-resize-*.png`) | ✅ PASS(两轮包一致) |

## 附注

- 「测试通过但 4000ms」定性:智谱首 token 正常延迟(curl 实测 ~1.1s,含 TLS/冷连接时更长),非缺陷;
  真正的病是「测试与运行时不同 URL」,已由约定统一根治(测试通过 = 会话能用)。
- 修复链共两段:PR #163(探针/运行时同拼法 + composer clamp)+ PR #165(BYOK 目录统一 OpenAI
  兼容端点,真机批第一轮逮出)——真机批把「测试通过≠真机能用」又演了一遍,gate 值回票价。
