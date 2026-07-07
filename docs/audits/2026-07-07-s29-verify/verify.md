# S29 真机批 — v0.1.1 发版 + B9/REQ-052 + γ 桶走查(2026-07-07)

> 环境:prod 签名+公证包;更新前装机 = 0.1.0(7-6 20:31 build);登录态 PRO(intl);引擎 = 内嵌(REQ-053 处置后干净态)。
> 走查方式:CDP(`ALPHA_CDP=1` 终端拉起)只读驱动 + 截图;无损确认框经用户授权自动点(「全部自动化」),破坏性确认框零触碰。
> 用户全程报障两条(项目空/chips 点不动),均当场定位:一条预期态、一条新 bug(REQ-054)。

## 一、发版链(runbook ①-⑤)

| 步 | 结果 |
|---|---|
| ⓪ 锚点契约 | 5/5 绿;视觉基线 = S27 场次二截图批(此后零 renderer diff)+ 本批关键屏重截 |
| ①′ 快照 | 2026-07-06.4,28 条,无变化(meta 时间戳还原不提交) |
| ① 版本 | 0.1.0 → 0.1.1(PR #134) |
| ② 打包 | 签名(Developer ID RQX6X6A635)+ **公证成功** |
| ③ 三验 | stapler `validate action worked` · spctl `Notarized Developer ID` · dmg/zip/yml 三件齐 |
| ④ Release | [v0.1.1](https://github.com/jinjunnn/alpha-code/releases/tag/v0.1.1)(dmg+zip+2 blockmap+latest-mac.yml,target alpha) |
| ⑤ feed | `releases/latest/download/latest-mac.yml` → **200** |

## 二、B9 更新链 → verified

装机 0.1.0 的 updater 状态机全程留痕(main.log):10 分钟周期检查 → `11:10:37 Found version 0.1.1` → downloading(**19s**,Squirrel 本地代理)→ ready(持久化,重启后复用缓存直达 ready)→ 「Update Ready」确认框点 Restart → quitAndInstall → ShipIt 换包 → **0.1.1 自动重启**(`app starting {version: '0.1.1', packaged: true}`)。`allowDowngrade:false` 全程生效。注:`autoInstallOnAppQuit=false` 为设计——普通退出不装,须显式 Restart。

## 三、REQ-052 出厂技能两跳桥迁移 → verified(四要件)

v0.1.1 首启 main.log:
```
factory-skills: linked { linked: [ 'skill-creator', 'agent-creator' ] }
factory-skills: legacy direct links migrated to .alpha two-hop bridge (REQ-052) { migrated: [ 'skill-creator', 'agent-creator' ] }
```
1. ✅ 旧位 `~/.opencode/skill/` 两直链拆除,空目录顺手删(目录不存在);
2. ✅ 真源 `~/.alpha/skills/{skill-creator,agent-creator}` → app Resources(零拷贝链);
3. ✅ 桥 `~/.opencode/skills` → `~/.alpha/skills`(dir-link);
4. ✅ 真会话冒烟(Claude Sonnet 4.6,6 秒流式):「skill-creator: 有 / agent-creator: 有」(`session-smoke.png`)——引擎经两跳链可见技能。

## 四、γ 桶走查结果

| 项 | 结果 | 证据 |
|---|---|---|
| REQ-032 远程 catalog | ✅ verified:连接器 tab 实见钉钉/DBHub/Playwright 等远端条目(70 卡) | hub-connectors.png |
| REQ-037 治理层 | ✅ verified:内置(上游)区 build/general/plan 隐藏/禁用/重写、customize-opencode 禁用、/init /review 重写、黑白名单切换 | hub-installed.png |
| REQ-036 创建技能化 | ✅ verified:导入 tab 无旧表单、「创建 = 对话」+ folder/git/npm;出厂技能真会话可见 | 导入 tab 文本 + session-smoke.png |
| REQ-030 模型收口 | intl 半边 ✅:picker = 代理节点 9 模型 + PRO 额度条;cn 半边留 REQ-039 复验 | model-open.png |
| REQ-002 代理链 | 0.1.1 复证核心链(登录态→代理模型→6s 流式);④过期路径仍归 B2 | session-smoke.png |
| REQ-033 开放安装面 | 入口实见(添加自定义连接器 + Agent 导入带 Claude Code 显式映射转换);**表单未提交**(不造真安装),完整腿留下批 | 导入 tab 文本 |
| E2 钉钉 | 联网条目在架 ✅;真凭证 e2e 留用户在场 | hub-connectors.png |
| B11 诚实呈现(侧写) | 飞书/语雀连接器密钥被 C16 抹 → 已安装 tab 如实亮 `MCP error -32000`,不装正常 | hub-installed.png |

**新发现 → [[REQ-054]]**(用户报障复现):①零工作区首页模型 chip 死点(上游 composer 未挂载,转发落空静默;send 按钮同场景有 REQ-038④ 处理,模型 chip 漏);②首页 effort 对 claude-sonnet-4.6(配置有 低/中/高)切「高」不生效(隐藏上游 variant 控件驻留「默认」)且失败反馈随 popover 关闭即丢。均为首页驱动隐藏上游控件路径;in-session 侧不受影响(REQ-041 S27 已验)。

## 五、用户报障两条的裁决

1. **「项目是空的」= 预期态**(C16 抹库,非 0.1.1 部署错误);选工作区后侧栏项目/会话恢复正常(after-ws.png)。**全新安装首启同样是零工作区** → REQ-054 ① 的修复对 onboarding 是真价值。
2. **「effort/model 点不动」= REQ-054**(见上);当场经选工作区解堵,模型选择器/effort(有档模型)在会话语境即恢复。

## 六、未覆盖(留后续批)

REQ-028 三档实测 · REQ-043 in-session 复测 · B12/B23/B20/B21 · REQ-025 A 侧拉回 · REQ-016 残单 · C17/B2(破坏性/长窗,用户在场)· cn 复验(REQ-039/030 另半)· REQ-033 表单真提交。
