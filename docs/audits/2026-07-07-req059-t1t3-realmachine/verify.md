# REQ-059 T1+T3 真机验证 — 全局引擎配置真源迁 `~/.alpha/alpha.jsonc`

> 2026-07-07,ship:mac 本地包(REQ-057 补签,dev 渠道)两轮(skills bug 修复后重 ship)。用户在场。
> 分支 `feat/req059-060-config-truth`。方法:装机二进制 + CDP;引擎 `/config` 端点 + 定制中心 UI 核验。

## 结论:PASS(修复 2 个真机暴露 bug 后)

存量机器(本机)`~/.opencode`(alpha 装的 mcp 连接器 + 治理键 + skills 桥)**干净消失**,内容迁进单一真源 `~/.alpha/alpha.jsonc`,引擎经 `OPENCODE_CONFIG` 读到,mcp/provider/已安装态全部零回归。

## 逐项证据

| 验收 | 结果 | 证据 |
|---|---|---|
| `~/.opencode` 消失 | ✅ | main.log `[req059] removed ~/.opencode (only engine junk remained)`;`[ -d ~/.opencode ]` → 不存在 |
| 存量迁移 alpha.jsonc | ✅ | main.log `engine config truth updated`;alpha.jsonc 含 mcp(markitdown/filesystem/fetch/dingtalk)+ agent/command/permission(治理键)+ skills.paths |
| 无 receipt mcp loud | ✅ | `migrating legacy mcp without receipts { unaccounted: [markitdown, filesystem, fetch] }`(放宽判定:.opencode 是 alpha 领地→迁移+记账留痕) |
| skills 桥退役 | ✅ | `unbridged ~/.opencode/skills (pointed into ~/.alpha)`;出厂技能真源 `~/.alpha/skills/{agent-creator,skill-creator}` 保留 |
| 引擎读 alpha.jsonc | ✅ | `/config` **200**;mcp servers = [fetch, markitdown, feishu-lark, yuque, github, filesystem, dingtalk, cloud](alpha 迁移的 + XDG 用户的 + cloud) |
| skills.paths 生效 | ✅ | `/config` 含 `/.alpha/skills`;alpha.jsonc `skills:{paths:["~/.alpha/skills"]}` |
| provider/BYOK 零回归 | ✅ | keyStatus deepseek `{configured:true, source:keychain, hint:ee03}` |
| 定制中心已安装态零回归 | ✅ | 连接器 tab:filesystem/markitdown/fetch/feishu/语雀/GitHub/钉钉 全显「✓ 详情」(已装),未装显「添加」(hub-connectors-intact.png) |

## 真机暴露并修复的 2 个 bug(单测未覆盖,真机 config 校验/存量数据抓到)

1. **skills.paths 被 ownership bail-out 连带阻断**(commit 7cc36878):reconcile 在 bail-out 时 `return` 在 skills.paths 注入之前 → 凡 legacy mcp 无 receipt 的存量机器出厂技能全失效。修:bail-out 只跳过迁移,skills.paths 恒注入。
2. **skills 字段写成数组而非 object**(commit e88e3731):引擎 schema `skills = {paths:[]}`(OBJECT),写成数组 → `ConfigInvalidError` → 整份 alpha.jsonc 被拒 → mcp 不生效。修:ensureSkillsPath 写 `{paths}` + 自愈数组存量;+4 回归锁单测。**教训:纯逻辑单测须对齐真实引擎 schema**。

## 附带确认的引擎行为

- **全局 config 进程级缓存**(B23 同源):`OPENCODE_CONFIG` 文件在 sidecar fork 时读入,`dispose`/`/global/dispose` 不重读 → 改 alpha.jsonc 需 respawn/重启方生效(非 dispose)。REQ-059 T0「dispose 重读免 respawn」对全局文件通道**不成立**,安装免重启仍依赖 respawn(现有链路已有)。记入已知行为,不阻断(安装本就触发 respawn)。

## 残留

- `~/.opencode.pre-req059-bak`(验证前备份,用户确认后可删)。
- 存量迁移一次性;重复启动 reconcile 幂等 no-op(skills.paths 已 object)。
