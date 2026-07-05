---
id: A6
title: sidecar env 白名单:阻断秘钥继承给第三方 MCP/LSP 子进程
type: security
priority: P0
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-03-s9-proxy-e2e
source: 册 §6.1 / R2 / R3
---

## 背景/证据
sidecar 全量 `process.env`(含 `ALPHA_API_KEY` 计费 JWT、全部 BYOK 密钥、`ALPHA_CLOUD_TOKEN`、`EXA_API_KEY`)被每个本地 MCP/LSP 子进程原样继承——任何用户安装的 npx/uvx MCP 包可窃取租户计费身份 + 全部模型密钥。泄漏 site 在上游(`mcp/index.ts:334-344`、`lsp/lsp.ts:176-179` 的 `...process.env` 展开,不可改);**唯一 in-rule 修点 = alpha 的 `createSidecarEnv`(`ui-mac/src/main/server.ts:220`)改白名单透传**(T3.4)。发布短名单 #2,唯一剩余硬阻断。

## 验收标准
1. `createSidecarEnv` 改为白名单透传(替代全量拷贝),白名单显式列出 sidecar 自用必需项;
2. 实测第三方 MCP 子进程的 env dump:无 `ALPHA_API_KEY` / BYOK 密钥 / `ALPHA_CLOUD_TOKEN` / `EXA_API_KEY`;
3. 登录态 E2E 功能回归:平台代理、BYOK、websearch、cloud MCP 全部正常(deferred 原因即此,随 REQ-002 联调环境完成);
4. 落地后在 BACKLOG 记录 R3 门控解除(解锁 A2b、E2/E6 上架)。

## 边界
不改上游 spawn 展开;单测补进 ui-mac test(延续 T7.4 安全路径优先)。

## 采纳方案(2026-07-03,PR #40)
> 勘察发现泄漏是**两条通道**,白名单单独做不了:平台 apiKey 走 `{env:ALPHA_API_KEY}` 引用、BYOK apiKey **明文内联**进 `OPENCODE_CONFIG_CONTENT`——前者要求密钥必须在 sidecar env(白名单剥了就断),后者让 `OPENCODE_CONFIG_CONTENT`(本身也是被继承的 env var)携密。故方案 = **白名单 + `{file:}` 密钥通道**联动:

1. **SecretSink(`alpha-secret-files.ts`,新)**:main 在**每次** sidecar fork/respawn 前(`spawnLocalServer`)把密钥 env(`ALPHA_API_KEY`、`ALPHA_CLOUD_TOKEN`、全部 catalog BYOK keyEnv)镜像到 `<userData>/alpha-secrets/<VAR>`(文件 0600 / 目录 0700);env 里消失的var **即删文件**(登出 / 删 key = 吊销),目录内不明遗留一并清扫。
2. **配置改 `{file:}` 引用(`alpha-models.ts` / `sidecar.ts`)**:BYOK 与平台 provider 的 `apiKey`、云 MCP 的 `Authorization: Bearer …` 全部改为 `{file:<绝对路径>}` token,由上游 `config/variable.ts` 在 config **加载时**解析(已核:`OPENCODE_CONFIG_CONTENT` 全文过 `ConfigVariable.substitute`,含 mcp headers;路径带空格 OK)——密钥值不再出现在任何 env var 中。「已配 key」判定同步改为**密钥文件存在性**(env-alone 不再激活 provider)。
3. **白名单透传(`sidecar-env.ts`,新)**:`createSidecarEnv` 改 default-deny——显式放行系统基础(PATH/HOME/SHELL/TMPDIR/LANG/TZ/SSH_AUTH_SOCK 等)、代理栈(HTTP(S)_PROXY/NO_PROXY 大小写)、node 旋钮、`ALPHA_*` 非密控制项(BASE_URL/CLOUD_MCP_URL/DEFAULT_MODEL/各 DISABLE);前缀放行 `OPENCODE_*`/`XDG_*`/`LC_*`/`ELECTRON_*` 且 credential-shaped 名称(KEY/TOKEN/SECRET/PASSWORD)一票否决。旧实现的 DEBUG/LD_PRELOAD 特判由 default-deny 自然覆盖。
4. **逃生口**:`ALPHA_ENV_ALLOWLIST_EXTRA=VAR1,VAR2` 显式透传指定 var(用户自担该 var 的子进程继承)。

**行为变化(接受并记录)**:① `EXA_API_KEY` 剥离 → websearch 回落 keyless 公共端点(ADR-009 默认本就 keyless,验收③的「websearch 正常」按 keyless 口径);② 用户 opencode.jsonc 自配 provider 的 `{env:MY_VAR}` 引用失效 → 迁 `{file:}` 或走逃生口;③ agent shell(非 login spawn)不再见到用户全量 shell 导出——`echo $ALPHA_API_KEY` 为空是预期收益。
**残余风险(诚实记录)**:密钥文件 0600 但同 UID 进程**主动去读**仍可读——与今日 alpha.env 同级暴露;A6 目标是**被动 env 继承通道**(子进程 dump/log/上报 env),该通道已封死。同 UID 主动攻击不在本项威胁模型内。

## 验证记录
- **2026-07-03(PR #40,单测级)**:typecheck(31 包)+ 115 tests 绿(+18:sink 写/删/权限/吊销回路、白名单默认拒绝/前缀否决/逃生口、`{file:}` 引用与 env-alone 不激活回归);验收①已达。
- **真机验收(待重打包执行,verified 门槛)**:① 第三方 MCP 子进程 env dump 无 `ALPHA_API_KEY`/BYOK/`ALPHA_CLOUD_TOKEN`/`EXA_API_KEY`(验收②) ② 登录态四链路复验:平台代理/BYOK/websearch(keyless)/cloud MCP(验收③) ③ 登出后 `alpha-secrets/` 吊销确认 ④ 通过后 BACKLOG 翻 verified 并解除 R3 门控(验收④)。

## 关联
REQ-002(验证环境)、A2(被门控)、C2(供应链同伞)、册 §7g deferred 记录。
