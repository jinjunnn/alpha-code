# REQ-036 验收记录 —— 创建技能化(S18 T2)

> 2026-07-05。验证组合:裸引擎实测(workspace 源码 `serve`,决定性)+ dev 主进程日志/fs + 单测。
> dev 桌面像素验证被环境阻断(详见「环境事故记录」),入真机批残单——机制级证据已闭环。

## 通道拍板变更(实现期实测推翻原设计,档内目标②的实现形态修正)

原设计 = `injectAlphaConfig` 写 `OPENCODE_CONFIG_CONTENT.skills.paths`。**实测二分推翻**:
- 裸引擎 + 同样 env:`/skill` **不含** factory 技能(env 内容源的 skills 键被引擎忽略);
- 同样内容写进项目 `opencode.jsonc`:`/skill` **含** agent-creator → 机制在,env 通道对 skills 不通(上游行为,只读不修)。

**改走 ADR-019 已实证的 symlink 桥**:main 每次 fork 前幂等 reconcile `~/.opencode/skill/<name>` → app 资源目录(零拷贝、引擎原生扫描)。开关关(`ALPHA_FACTORY_SKILLS_DISABLE=1`)→ 只拆自有链;用户自建同名真实目录绝不接管(ADR-019 §4)。

## 逐条结果

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 定制中心无创建表单(导入保留);i18n/死代码清理 | ✅ 代码级 PASS,像素→真机批 | 表单/CTA/`ext-write-skill|agent` IPC 链全删(main `writeSkill/writeAgent` 保留供 vendored 管线);tab 更名「导入」+ 对话式创建指引卡(出厂注入关闭时文案诚实降级);typecheck+alpha-check 绿 |
| 2 | 会话内经 skill-creator 创建技能→引擎发现 | ◐ 发现链 PASS,端到端→真机批 | **裸引擎实测**:symlink 桥后 `/skill` 列出 skill-creator + agent-creator(决定性);会话内访谈→写盘→发现的全流程需真模型会话 |
| 3 | 会话内经 agent-creator 创建 agent,alpha_reload 后免重启可用 | ◐ 机制 PASS,端到端→真机批 | agent-creator SKILL.md(frontmatter 对齐引擎 `ConfigAgentV1` schema,方法论对齐上游 generate.txt);alpha_reload 两段式(见 #4) |
| 4 | alpha_reload in-session 实测 | ✅ 语义级 PASS(设计因此修正) | **X9 实锤**:真引擎流中 `POST /instance/dispose` → assistant 消息 err 终止、0 字 —— 立即 dispose 会打断自己的回复。**alpha_reload 改两段式**:工具只登记待重载,ext event 钩子在本会话 `session.idle`(回复完成)后执行 dispose;sessionID 不匹配的 idle 不触发;dispose 失败 loud 降级(重启后生效) |
| 5 | 默认项目级落点不触发 external_directory;全局走 `~/.alpha` 桥 | ✅ 设计入 SKILL | agent-creator 明确默认 `<project>/.opencode/agent/`;全局 = `~/.alpha/agents` + 桥,桥缺失时诚实回退 `~/.opencode/agent/` 并说明 |
| 6 | `ALPHA_FACTORY_SKILLS_DISABLE` 生效 | ✅ PASS(单测) | reconcile 单测:开关关 → 只拆自有链、用户真实目录不动;`factorySkillIds()` 返回空(hub 徽标随之消失、条目回到可安装态) |
| 7 | 零改上游 | ✅ PASS | north-star guard 绿;通道 = `~/.opencode/skill` symlink(引擎原生扫描面)+ ext plugin 工具 |

## 实现落点
- `main/factory-skills.ts`(reconcile symlink 桥,7 单测)· `server.ts`(fork 前 reconcile + anti-B11 日志)· `sidecar.ts`(新增 anti-B11 注入日志;skills env 注入按实测撤除)
- `ext/src/plugin.ts`:`alpha_reload` 两段式(登记 → session.idle 后 dispose)
- `resources/factory-skills/agent-creator/SKILL.md`(alpha 自写,MIT)
- hub:表单删除、「导入」语义、对话式创建指引、卡片「出厂内置」徽标(receipts 语义不变,X1);`ext-factory-skill-ids` IPC
- 打包:electron-builder extraResources `factory-skills/` + seed-assets 守卫两条

## 环境事故记录(dev 像素验证为何受阻,过程知识)
1. dev 窗口可能加载 `oc://renderer`(陈旧内置 bundle)而非 vite —— memory [[dev-window-stale-bundle-trap]];
2. dev 渲染器经共享 `~/.local/state/opencode` lock 发现连上**已安装 prod app 的引擎**(65069,21:02 启动)——因此桌面 slash 菜单查的是 prod 旧引擎,非 dev 新链;`setDefaultServerUrl` 亦不改变其选择;
3. 5173 端口被既有进程占连,dev9 renderer 大面积 404。
→ 桌面像素三项(hub 徽标/导入 tab/斜杠菜单含 factory 技能)入真机批;机制级已由裸引擎决定性覆盖。

## 残单(→ 真机批)
- hub「导入」tab/出厂徽标/指引卡像素([[visual-verify-required]])
- 会话内「帮我创建一个技能/agent」端到端(访谈→写盘→alpha_reload→下一条消息可用)
- 打包态 factory 链指向 `/Applications/...Resources`(reconcile 重指逻辑已单测)


## codex 审计(0 Critical / 2 High / 4 Medium / 1 Low)与修复(同 PR)
- **High-1 接管用户异源链** → 修复:自有链判定收紧为「精确等于当前 src ∥ 同名 + alpha 资源布局(`…/(resources|Resources)/(skills|factory-skills)/<同名>`)」,异源 symlink(哪怕同名)一律 skip + 如实上报;
- **High-2 禁用清理正则误删** → 同一判定复用于清理路径,宽泛尾部正则移除;
- **M1 pendingReload 单槽跨会话覆盖** → per-session Map,任一登记会话 idle 即全局 dispose 一次并清表;
- **M2 无超时/失败重试** → 登记 >5min 后任意 idle 兜底(登记会话 error 也能兑现);dispose 失败保留重试,连败 3 次 loud 放弃;
- **M3 skill-creator 无 opencode 落点/alpha_reload 收尾** → agent-creator 增「Creating SKILLS (opencode specifics)」节 + description 扩触发(vendored skill-creator 保持 pristine);
- **M4 出厂徽标只看开关** → `factorySkillIds()` 改返回上次 reconcile 真正就位(active)名单,失败/被用户内容占位 → 条目回到可安装态;
- **Low TOCTOU** → rm 前重读 readlink 确认未变。
新增/更新单测:异源链不接管(enabled+disabled 双路径)、active 徽标真相、isAlphaFactoryLink 判定矩阵 —— 10/10 绿。
