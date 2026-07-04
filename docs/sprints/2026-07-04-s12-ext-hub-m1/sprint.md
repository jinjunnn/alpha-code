# Sprint 2026-07-04 S12 —— 定制中心 v3-M1:全类型通用化地基

**目标**:REQ-018 一批落地——四类扩展(MCP/skill/agent/plugin)「装 → 亮 → 用 → 卸」全通;**免重启生效**(instance/global dispose,装完当前会话下一条消息可用);`.alpha` 双层落盘 + `~/.opencode` 桥 + 存量迁移;MCP 密钥 `{file:}` 化;Agent tab + 官方 skill 补打包。方案真源:[designs/2026-07-04-extension-hub-v3-universal.md](../../designs/2026-07-04-extension-hub-v3-universal.md)(§4/§5.2/§5.4/§8 M1);验收真源:[requirements/REQ-018](../../requirements/REQ-018-ext-hub-universality.md)。
**抽取**:REQ-018(headline)· 顺带同域:REQ-006(ADR-014 转正验收,真机批同场)· A2 尾项(存量钉版迁移,与 T3 同场;**放行门 = A6 R3 解锁**)· REQ-016 之 A6 真机子项(T8 同场消化 → 解 R3)。D3/D4/E11 已 dup 进 REQ-018/019,不另抽。
**批准**:用户 2026-07-04「制定SPRINT 推进」(前序拍板 D1–D5 见设计文档 §9)。
**不抽**:REQ-019/020/021/022(依赖 M1,后续 sprint 按优先级推进);B16 维持 parked。

## Task 表(模型档位按 PROCESS §4 风险×模糊度)

| Task | 内容 | 对应 ID | 模型 | 状态 |
|---|---|---|---|---|
| **Track α —— 落盘地基(主进程)** | | | | |
| T1 | 安装账本 receipts:`~/.alpha/installs.json` + `<项目>/.alpha/installs.json`;receipt schema;读写 IPC + 守卫;单测 | REQ-018 T1 | opus | ✅ **PR #66**(11 单测;损坏隔离自愈,永不静默覆写) |
| T2 | `.alpha` 双层落盘 + 桥:全局 `~/.alpha/{skills,agents,commands,plugins}` 真源;`~/.opencode/<类>` symlink 桥(已存在目录退化逐条目链);**全局 MCP/plugin write-through `~/.opencode/opencode.jsonc`(文件通道,免重启前提)**;项目 scope 选择;写路径守卫扩 root;单测 | REQ-018 T3 | fable | ✅ **PR #66**(桥 10 单测 + installer 22 重写 + ext-config 双文件卸载;实现修订:不设 connectors.json,jsonc+receipts 即全部真相) |
| T3 | 存量迁移弹窗(检测根 A alpha 写入物 → 清单确认 → 搬移+receipt;`ALPHA_LEGACY_INSTALL_ROOT=1` 逃生)+ **A2 存量钉版迁移同场**;⚠️ 弹窗放行门 = T8 解 R3(代码可合、开关后开) | REQ-018 T4 + A2 尾项 | fable | ☐ |
| **Track β —— 生效与密钥** | | | | |
| T4 | 免重启生效:先 spike 实测(dispose→重建耗时 / 活跃 PTY·SSE 影响 / MCP 重连风暴)→ 安装/卸载后自动 `instance.dispose`(项目)/`global.dispose`(全局)+ 进行中流式守卫;respawn 降兜底;「重启后生效」文案全清 | REQ-018 T2 | fable | ✅ **spike CONFIRMED + 接线 PR #67**:隔离 headless server 实测——写盘后缓存不可见(placebo 实锤)→ `POST /instance/dispose` 8ms → 下一请求 101ms 重建,**经 symlink 桥的 skill/agent 立即可见**;`/global/dispose` 310ms 同验;skill/agent/plugin 安装后自动 `global.dispose`,失败降级「待重载」文案;活跃流打断残险 → T8 真机;PTY/MCP 风暴观察项 → T8 |
| T5 | MCP 密钥 `{file:}` 化:requiredEnvVars 密文输入 → `alpha-mcp-secrets/<server>/<VAR>`(0600,独立命名空间不被 syncSecretFiles 清扫);config 只落 `{file:}` 引用;文案修正(钥匙串误导) | REQ-018 T5 | opus | ✅ **PR #68**:根因发现——**确认弹窗此前根本不采集密钥值**(github/feishu/yuque 装了不能用),T5 补密文采集 UI + `alpha-mcp-secrets.ts` file 通道(live add 用真值/durable 只落 ref,9 单测,序列化 config 断言无明文)+ removeMcp 吊销密钥 + 文案修正(删钥匙串误导);251 pass |
| **Track γ —— UI 与内容** | | | | |
| T6 | 全类型已安装列表(类型/名称/scope/版本/状态点/操作)+ 卸载(receipt 驱动,确认弹窗列将删内容)+ plugin 已装态(config `plugin[]` ∪ receipts) | REQ-018 T6+T8 | opus | ☐ |
| T7 | Agent tab(catalog agent 条目 schema + 安装链路)+ composer agent 选择器核实(缺则最小补,数据源 `app.agents()`)+ 官方 4 skill 资产打包 `resources/skills/` + NOTICE | REQ-018 T7(吸收 D3) | opus 实现 · fable 审 | ☐ |
| **验收批** | | | | |
| T8 | 真机四步验收:四类各「装→亮(下一条消息可用)→用→卸」录证([[visual-verify-required]])+ REQ-006 四用例(装 markitdown/免重启/卸载/依赖预检)+ **A6 MCP 子进程 env dump(解 R3)**+ 迁移/密钥负向验证(`~/.config/opencode` 零新增写入、config 零明文)→ 状态回写 + ADR 修订 | REQ-018 验收 / REQ-006 / REQ-016(A6 子项) | fable | ☐ |

## 依赖与排序

- **T1 → T2 → T3**(账本先行,迁移最后);**T4 spike 可与 T1 并行先跑**(结论决定 T2 的 write-through 细节与安装流时序);T5 独立;T6 依赖 T1;T7 依赖 T2(落盘位)。T8 收口全部。
- **撞点**:`ext-ipc.ts`、`preload/{index,types}.ts` 是 α/β/γ 共享注册点 → **归 Track α 统一持有**,β/γ 按接口约定接入;并发 session 分派时 α 先行落接口,或单 session 按 α→β→γ 串行。
- PR 粒度:T1+T2 地基一个 PR;T3、T4、T5 各一个;T6+T7 可拆两个;T8 出 audit 文档 + 回写 PR。

## Gates(每个实现 PR)

typecheck ☐ · bun test ☐ · 北极星守卫 ☐ · /app:review ☐ · visual-verify(UI 变更 CDP 截图)☐
本批附加硬门:**免重启验收**(装完不重启任何进程,当前会话下一条消息可用)☐ · 迁移后 `~/.config/opencode` 零新增写入 ☐ · 全 config grep 零明文密钥 ☐

## 拍板提醒(执行中撞到必停,不代替决策)

- **A6 R3 门控**:T8 真机 A6 验证不过 → T3 迁移弹窗不放行(代码合、开关不开),停下来报告;A2 尾项同门。
- **dispose spike 若证伪**(重建过慢 / PTY 断裂不可接受)→ 回退 respawn 主机制并回写设计 §4.3,不带病上「免重启」承诺(反 placebo,C28 精神)。
- ADR-014 修订(v3)+ ADR-019 修订(全局 `~/.alpha` 层)随实现 PR 提交;REQ-006 trial→accepted 随 T8;GLOSSARY 补条(插件 vs 套件 / 安装账本 / dispose 生效)随 T8 回写。
- B16 维持 parked(本批不公开分发,不触发重启条件)。

## 结果

(待收尾填写)

## 回写清单

BACKLOG ☐ · CHANGELOG ☐ · 需求档 frontmatter ☐ · verify 记录 ☐ · retro 链接:—
