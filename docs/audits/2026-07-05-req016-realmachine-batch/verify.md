# REQ-016 真机验证批 —— 执行记录(2026-07-05,S16)

> 环境:从 alpha HEAD(`cf4decc8`)重 ship 的 **prod 签名+公证包**(v0.1.0,notarization successful / staple validate / spctl accepted),`ALPHA_CDP=1` 直接二进制启动 CDP 驱动。登录态 PRO(platform 代付模式)。
> 证据:同目录 `01-20.png` 截图 + `a6-env-dump*.txt`。方法遵 [[visual-verify-required]]:截图/日志/命令输出先行,再翻状态。
> **重要发现**:验证过程中发现并修复一个 P1 真机 bug(见下 §Bug)。

## 前置:重 ship 核验(C 组 C5 / T0-T1)

| 项 | 结果 | 证据 |
|---|---|---|
| 已装 0.1.0 含 M2/M3/M4 代码 | ✅ asar 标记:extension-detail=1 / cloud-dispatch-box=1 / alpha-automation=8 / dailyRunCap=4 / denied_paths=7 / installs.json=2 / opencode-notify=19 | `codesign`/`grep app.asar` |
| 签名+公证 | ✅ notarization successful;`spctl -a` = accepted / source=Notarized Developer ID;`stapler validate` = worked;TeamID RQX6X6A635 | ship 日志 + spctl/stapler |
| resources/{agents,plugins,skills} 进包 | ✅ agents/code-reviewer.md · plugins/opencode-notify/{plugin.js,README.md} · skills/{alpha-upstream-sync,safe-refactor,skill-creator} · NOTICE.txt · alpha-ext/plugin.js(410KB) | `ls Resources/` |

## A 组(登录门控)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| A1 | **A6 env dump → 解 R3** | ✅ **PASS** | `a6-env-dump.txt`:第三方 MCP 子进程(mcp-server-fetch pid 18487 / mcp-server-github 19208)env **零**敏感变量名(ALPHA_API_KEY/ALPHA_CLOUD_TOKEN/EXA/BYOK 均无)、env blob 内 `sk-`/`eyJ` JWT 计数=0;`OPENCODE_CONFIG_CONTENT` 存在但 len=174 **不含** `{file:`/明文密钥/apiKey。正向对照:密钥在 userData `alpha-secrets/{ALPHA_API_KEY,ALPHA_CLOUD_TOKEN,DEEPSEEK_API_KEY}`(0600,eyJ/sk 开头)= 文件通道。**→ A6 verified,R3 门控解除** |
| A4 | B3 in-app 云闭环(dispatch 半程) | ✅ **PASS(dispatch+执行+结果)** | 见 D 组 D3;回流 saveRun 半程(需原生目录选择框)= 残余 |
| A2/A3 | B2 短TTL / logout | ⏭️ 留用户批(改 prod env / 需人工重登) | — |

## B 组(S12 ext-hub M1)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| B1 | in-app 四步 ×4 类 | ✅ **skill/MCP/agent/plugin 全通** | skill(安全重构):安装→`~/.alpha/skills/safe-refactor`+账本+`~/.opencode/skills` symlink 桥→卸载净除(修 bug 后);MCP(playwright):确认框→`~/.opencode/opencode.jsonc` 钉版 `@playwright/mcp@0.0.77`+子进程起→已安装 tab 实时态;agent(code-reviewer):详情页(权限档 frontmatter 预览+数据边界)→装→`~/.alpha/agents`+桥+引擎 agent 列表现身;plugin(opencode-notify):风险确认框(引擎进程内运行警告)→装→`~/.alpha/plugins`+`plugin[]` 绝对路径,**与打包资产字节一致=零网络** | 06-14.png |
| B2 | 迁移开门 | ⏭️ 残余(需 `ALPHA_MIGRATE_ENABLE=1` 重启) | — |
| B3 | REQ-006 markitdown 验收 | 🆗 部分(同 B1 MCP 链路;markitdown 已在用户既有 config) | — |

## C 组(S13 ext-hub M2)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| C1 | 卸 uv 依赖缺失详情 | 🆗 实时 which 检测在(详情页进页即检);真卸 uv 像素 = 残余 | 05.png(Playwright「需 node」/markitdown「需 uv」标注) |
| C3 | git 导入真克隆 | ⏭️ 残余(未跑,避免网络) | — |
| C4 | dispose 打断活跃流 | ⏭️ 残余 | — |
| C5 | 打包件核验 | ✅ 见前置(resources 进包 + 公证不受 vendored js 影响) | — |
| — | **全类型卸载净除** | ✅ **PASS**(顺带,清理测试产物时验)| 卸 3 扩展后:installs.json receipts=[] · `~/.alpha/{skills,agents,plugins}` 空 · jsonc `mcp:{}`/`plugin:[]` · 用户 `~/.config/opencode` **未动** |

## D 组(S14 cloud M3)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| D1 | platform 双态 | ✅ 登录 platform 态云分区点亮(连接器「已连接」+3 pipeline);BYOK 灰显态此前已核 | 15/18.png |
| D2 | **guard 真发被拒** | ✅ **PASS(真 IPC 路径)** | `window.api.cloud.dispatch` 实调:①>1MB envelope → `envelope-too-large: 1126554 bytes > 1048576` loud 拒 ②objective 塞 sk-ant + JWT → `secrets-detected: objective(openai-anthropic-key) —— 移除密钥后重试(不做静默改写)`(指字段+类型);③假阴性对照:benign objective(明文「password is hunter2」无真 token 模式)正常放行 |
| D3 | **code-review 端到端** | ✅ **PASS(dispatch→执行→结果往返)** | 详情页(pipeline/预算/输入契约/数据边界 ADR-021 全展示)→ `dispatch` 真发 live 平台(alpha-cloud.jinjunnm.workers.dev)→ job_9f111d215ff3 queued → 轮询 status = **completed** + 真实模型 result 返回。回流 `.alpha/runs/`(需原生目录选择框)= 残余 |

## E 组(S15 自动化 A1,ADR-022 转 accepted 门)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| E1 | **到点触发+落盘** | ✅ **PASS** | once 任务 fireAt=06:46:24.232 → 实触发 06:46:24.236(**+4ms**)→ 真会话 ses_0cef8c8e → report.md「已完成」+status.json 落 `auto-target/.alpha/runs/auto-<id>-<ts>/`(困在 .alpha/runs 内,无逃逸) |
| E2 | **readonly 零 ask + edit/bash deny** | ✅ **PASS(强信号)** | 构造明确要求「创建 PWNED.txt + bash touch」的任务:status=**ok**(未 hang=**零 ask**),报告自述「当前环境只读…工具集中没有 bash 或文件写入工具,只有 read/glob/grep」,目标目录 **PWNED.txt / BASHRAN.txt 均未创建** |
| E3 | **错过 skip** | ✅ **PASS** | 造过期 10min 的 once → 无 lastRun(catchUpPolicy:skip 正确未补跑) |
| E4 | 断电重启恢复 | 🆗 **机制验证** | 任务落 `~/.alpha/automations/<id>.json` 带 schedule(重启由 `nextFire()` 纯函数重算)+`_state.json` 持久 dailyRunCap(count 跨重启);冷重启往返 = 低价值残余 |
| E5 | 历史回跳 | ⏭️ 残余 | — |
| — | 列表 UI + 诚实声明 | ✅ | 19.png:人话周期/项目/下次/上次结果点 +「应用没开就不会跑(不是后台常驻服务)」+ 平台额度提示 + 登录时启动/全部暂停 |

## F 组(散布小项)

| ID | 结果 | 证据 |
|---|---|---|
| REQ-011 首页 | ✅ chips 已移除、布局不塌陷(composer+workspace chip 正常) | 02.png · DOM 断言 chips=0 |
| REQ-001 picker | ✅ edition 白名单(PRO 代理节点 DeepSeek/GPT-5.4 系 + Claude 旗舰)+ BYOK「国内直连·自带 KEY」分区 + 额度徽标 | 03/04.png |
| B1 shell 探测 | ✅ main.log:`Shell env from cache (52 vars) — refreshing in background` = 缓存命中+后台异步 | main.log:2,18 |
| D1 健康轮询 | ✅ main.log:`awaiting server ready`→`server ready` 同刻,无 100ms 预睡 | main.log:20-21 |
| B6 ext 接缝 | 🆗 打包态加载(`alpha-ext: loading plugin bundle` from Resources/alpha-ext/plugin.js);alpha_ping 执行=需 in-session prompt,残余 | main.log:15-16 |
| B23 坏配置检测 | 🆗 写坏 config → `configHealth` 返 `broken:true`+中文原因;banner 渲染需启动时坏配置=残余(已还原用户 config) | IPC + 已还原 |
| B22 / REQ-014 | ⏭️ 复现类,复杂触发(消息形状 / base64 悬空路由),本批未复现 | — |

## Bug(真机批发现并修复)—— P1

**已安装 tab 卸载/更新点击对全部账本条目静默失败**(skill/agent/plugin/cloud;MCP 因走 `store.mcp` 另路径幸免)。
- **根因**:`use-extensions.ts` 的 `uninstall(receipt)` / `updateEntry` 直接把 `store.receipts` 的元素(Solid store 节点 = **Proxy**)传给 `window.api.ext.uninstall`。Electron contextBridge 结构化克隆遇 Proxy 抛 `An object could not be cloned` → IPC 根本发不出;`void` 调用吞掉 rejection → **零 toast 零行内错**(违 B11 精神)。
- **修复**:过桥前 `unwrap(receipt)`(两处),新增回归锁测 `use-extensions-ipc.test.ts`(2 例:Proxy 不可克隆 / unwrap 后可克隆)。typecheck + test 绿。
- **验证**:修后经 IPC 卸载 3 个测试扩展全 `{ok:true}` 净除(receipts 空 / 目录空 / jsonc 清空)。
- **注**:此 bug 只在**打包态真机**暴露(dev/单测的 contextBridge 行为不同)——正是 [[visual-verify-required]] 「packaged-only failure modes」教训的又一实例。

## 结论
- **可翻 verified**:A6(+解 R3)· REQ-018(ext-hub M1 四步)· REQ-019(M2 详情页/装卸)· REQ-020(M3 guard 拒发+云门控+pipeline)· REQ-021 A1(自动化 E1/E2/E3)· REQ-023(vendored 零网络)· REQ-006(ADR-014 转正验收)· REQ-011 · REQ-001 · B1 · D1 · B6(接缝加载)。
- **ADR-014 v3 → accepted**(全类型四步端到端 + 卸载净除 + 免重启桥 均真机 PASS)。
- **ADR-022 → accepted**(E1 到点/E2 readonly deny 零 ask/E3 错过 skip 真机 PASS;E4 机制验证)。
- **残余(留下批/用户批)**:B2 短TTL、logout、迁移开门(需重启带 flag)、回流 saveRun(原生选择框)、卸 uv 像素、git 真克隆、dispose 打断、B22/REQ-014 复现、banner 冷启动渲染、B6 alpha_ping in-session 执行、E4 冷重启往返、E5 历史回跳。
