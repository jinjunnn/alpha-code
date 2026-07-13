# 设计 v2:项目级扩展物 `.alpha`-only —— 五类全收敛,项目**只有一个目录**,XDG provider 域接管

> 状态:draft v2(v1 的「指针形态 D1」被用户两条追加指令取代;待 T0 spike 后立 REQ)
> 日期:2026-07-07;调研 = 源码钉死(file:line 见文内)
> 用户拍板(需求源,2026-07-07 三连):
> ①「用户在项目中生成的 skill command agent mcp 和 plugin 都应该落到 .alpha 中」
> ②「(XDG provider 域 + 项目级 .opencode)这两个都应该接管,使用桥可以实现吗」
> ③「我不希望每个项目都出现 .alpha .opencode 两个目录」
> 前置:[[REQ-059]](全局 `~/.alpha/alpha.jsonc` 真源,ready)

## 〇、结论先行

> **v3(同日晚,用户第四条拍板)**:「用户级也一并消灭 `.opencode`,不用 symlink,全面彻底不产任何 `.opencode`」→ REQ-059 的指针方案撤销,全局层改走 §七 无-`.opencode` 通道;**alpha 从此在任何层级不再创建任何 `.opencode`**。

1. **项目级可以做到只剩 `.alpha` 一个目录,连指针都不要**——通道不是桥,是 **alpha ext 插件的 `config` hook**(上游稳定 hook)按 instance 注入 `<proj>/.alpha/alpha.jsonc`。`.opencode` 在项目里彻底绝迹(alpha 侧永不创建)。
2. **XDG provider 域接管:桥可行但脆,推荐「写入面搬家」**——alpha 的 provider 写入改落 `~/.alpha/alpha.jsonc`(home 通道 merge 序在 XDG 之后 → 同键压制),一次性拷贝迁移;XDG 从此只属引擎/生态,alpha 面 100% 在 `.alpha`。
3. 附带红利:项目没有 `.opencode` 后,引擎对每个发现的 config 目录自动做的 `ensureGitignore` + `npm install @opencode-ai/plugin`(→ package.json / node_modules / package-lock / .gitignore 四件垃圾,`config.ts:294,439-447` 实证)在项目里**一并绝迹**——「目录乱」的另一半根源同步消灭。
4. 未用扩展/云/自动化的项目连 `.alpha` 都不出现(全链懒创建保证)。

## 一、现状核查(当前是否已实现 —— **主通道未实现**)

| 类型 | Hub 安装/导入 | 会话内创建(REQ-036,主通道) | 项目级现状 |
|---|---|---|---|
| skill | 恒全局(`resolveRoots` 项目分支存在但 **UI 从不传 InstallTarget**,休眠) | skill-creator = Anthropic 通用稿,无 alpha 落点规范 | 未实现 |
| agent | 同上 | **agent-creator 默认写 `<proj>/.opencode/agent/`(REQ-036 目标3 明文)** | 落 .opencode,冲突 |
| command | 无任何 alpha 通道(ADR-014 O2;REQ-036 非目标) | 模型按上游惯例写 `.opencode/command/` | 空白 |
| mcp | `persistMcp` 恒全局;`workspace` 参数只是 `{workspace}` 占位符替换(`use-extensions.ts:177`),非 scope | 无引导(customize-opencode 已被治理禁用) | 无通道 |
| plugin | 恒全局 | 模型写 `.opencode/plugin/*.ts` → 生 TS 桌面必崩(ADR-006 雷) | 无通道 + 雷 |

可复用资产:项目 scope fs 底座(`ext-fs-installer.ts:69`)、项目 receipts、`alpha_reload` ext 工具(dispose 闭环)、REQ-059 reconcile 剧本。

## 二、机制事实(源码钉死)

1. **`config` hook 存在、稳定、按 instance**:契约 `packages/plugin/src/index.ts:225` `config?: (input: Config) => Promise<void>`;`PluginInput` 自带 `directory`/`worktree`(:56-60)= 插件按 instance 实例化、知道自己在哪个项目;dispatch 在 Plugin 实例态 init(`packages/opencode/src/plugin/index.ts:240-249`,「Notify plugins of current config」,传入当前 cfg 对象),同函数的事件订阅按 `ctx.directory` 过滤(:251-252)证实 per-instance;instance dispose 重建 → 重 init → hook 重触发 = 免重启语义免费获得。
2. **⚠️ hook 语义标注是 "Notify"**:传入 cfg 引用,变异能否被 mcp / skills / agent / command 各消费方看到,取决于各服务读 config 的时序 → **T0 spike 四路逐一实测**;不通的路逐路回退指针形态(§六)。
3. **config 是五类全能通道且项目作用域天然正确**(per-instance 装配):`mcp.<n>` / `plugin: [abs.js]` / `agent.<n>`(上游自己就是「.md → config 条目」,`config/agent.ts:27`)/ `command.<n>`(`config/command.ts:29`;治理层在用)/ `skills: [paths]`(`core/src/config.ts:90`)。`{file:}`/`{env:}` 替换是全 config 文本级(`config/variable.ts:34`)——但走 hook 注入时我们自己读文件更直接。
4. **v1 merge 顺序**(`config.ts:398-434` + `paths.ts directories()`):XDG 全局 → OPENCODE_CONFIG → 项目直连文件 → 项目 `.opencode` 目录 → **home `.opencode`(最后,同键压制前者)** → OPENCODE_CONFIG_DIR。⇒ 写进 `~/.alpha/alpha.jsonc`(经 home 通道)的 provider 键**压过 XDG 残留**,拷贝迁移安全。
5. **引擎写 XDG、不写 home jsonc**:loadGlobal 种子/updateGlobal/CLI mcp add 都打 XDG(`config.ts:250-271`);还会对每个 config 目录 ensureGitignore + npm install(:439-447)。⇒ home/项目真源无碾链风险;**XDG 文件做 symlink 桥则有**(引擎/CLI/编辑器原子写会把链换成普通文件 → 静默裂脑)——这是「XDG 用桥」被否的根据。

## 三、目标设计

### 心智模型(验收标准)
- 项目:**只有 `.alpha`**(且懒创建)。`.opencode` alpha 永不创建;用户/生态自建的照旧尊重(§4 边界)。
- 全局:`~/.alpha` 是 alpha 的一切;`~/.opencode`/`~/.config/opencode` 是引擎的(alpha 只留 REQ-059 一个指针,provider 写入退出 XDG)。

### 布局(项目)
```
<项目>/.alpha/
  alpha.jsonc          # 项目级真源:mcp/plugin/agent/command 条目 + skills 路径
  skills/<name>/SKILL.md
  agents/<name>.md     # 正文;条目字段由注入器补
  commands/<name>.md
  plugins/<name>.js    # 自包含 bundle(ADR-006 不变;拒收生 TS,loud)
  installs.json / prefs.json / runs/
```

### 注入通道:`@alpha-code/ext` 新插件 `alpha-project-bridge`(ADR-002 接缝,零改上游)
1. **config hook**:per instance 读 `<directory>/.alpha/alpha.jsonc`(不存在即零开销返回)→ 把 mcp / agent(prompt=读 `.alpha/agents/*.md`)/ command(template 同理)/ skills 路径合并进 cfg。全局层不经此 hook(REQ-059 指针通道已覆盖,不叠双通道)。
2. **plugin host fan-out**:项目级 plugin 由本插件动态 import `<proj>/.alpha/plugins/*.js`(自包含 ESM)并把收到的每个 hook 转发给它们(解决「插件列表在 hook 前已定」的鸡生蛋;上游 local/global plugin scope 语义由 host 对齐)。
3. **信任门(必做,安全红线)**:项目自带 mcp/plugin = 打开陌生仓库即加载可执行物。首次在某项目发现 `.alpha/alpha.jsonc` 含 mcp/plugin 时,per-project 确认(复用 ADR-021 consent 模式,`.alpha/prefs.json` 落 `extensionsConsent`,版本化;拒绝则该项目仅加载 skill/agent/command 文本类)。skill/agent/command 为文本注入,风险面低,不设门。
4. **生效**:创建/修改后调 `alpha_reload`(既有)→ instance 重建 → hook 重注入。

### 创建流改造(主缺口)
- agent-creator:项目级落点改 `<proj>/.alpha/agents/` + 登记条目(**取代 REQ-036 目标3 的 `.opencode/agent/`,REQ-036 需修订**);skill-creator 加 alpha 落点引导段;command 顺手纳入(轻量指导章)。
- **注册手段 = `alpha_register` ext 工具**(与 alpha_reload 同族):入参(type/name/scope)→ 校验(SAFE_NAME/字段白名单,复用 ext-config 纯逻辑)→ 原子写对应真源 alpha.jsonc → dispose。模型不直接手改 config,写坏面收敛。
- Hub/导入:fs-installer 项目分支从「.opencode 目录桥」改「.alpha + 条目」(bridgeItem 项目分支退役);MCP/plugin 增 target;「安装到当前项目」UI 入口可分期。

### XDG provider 域接管(全局,并入/扩展 REQ-059)
- `persistProvider`/`removeProvider` 等写入目标:XDG → `~/.alpha/alpha.jsonc`(同一真源,alpha 全局配置一个文件管完);读取方(`alpha-models.ts` allowlist merge / `readConfiguredProviderKeys` / provider-status)跟改。
- 一次性迁移:XDG 内 provider 条目**拷贝**进真源(merge 序压制,copy-don't-delete 零破坏);若整文件按所有权判定属 alpha(键 ⊆ {$schema,provider,mcp,plugin})可顺手清源,否则留(loud 注记)。
- alpha 此后永不写 XDG;引擎对 XDG 的种子/junk 属引擎行为,不管。**不做 XDG symlink 桥**(§二.5 碾链裂脑风险)。

### 与 REQ-059 的关系
- REQ-059(全局指针 + alpha.jsonc)不变,仍是全局层通道;本设计新增「provider 写入迁移」扩其范围(或并档实施)。
- 全局既有目录桥(skills/agents)保留(已验证态,服务原生 CLI 可见性);项目级因「零 .opencode」要求走 hook。**已知 trade-off:项目级扩展只在 alpha app 内可见**(原生 opencode CLI 无 alpha 插件 → 看不到),租户产品形态下可接受,文档注明。

## 四、T0 spike(半天,GO 前唯一闸门)
1. hook 注入四路实测(fixture 项目 + 真机):mcp 连接 / skill 被发现 / agent 进选择器 / command 可用;**逐路记录读序结论**;
2. dispose → 重注入生效(改 `.alpha/alpha.jsonc` 后下一条消息可用);
3. plugin host fan-out:动态 import 自包含 JS + hook 转发(tool.execute.before 之类打点验证);
4. 相邻项目隔离断言(A 项目注入物在 B 项目不可见);
5. 任一路不通 → 该路回退方案:**单指针**(`<proj>/.opencode/opencode.jsonc → ../.alpha/alpha.jsonc` 唯一文件,v1 设计 D1-A),`.opencode` 内仍零内容、垃圾仍绝迹(engine junk 只落真实目录,链文件不触发?——回退路径同样要验 npm install 行为)。

## 五、验收草案(立 REQ 时细化)
1. 会话内「给这个项目建 skill/agent/command」→ 产物全在 `<proj>/.alpha/`,项目里**不存在** `.opencode`,dispose 后下一条消息可用(真机);
2. 项目级 mcp/plugin 经 hub 或会话登记 → 条目在 `<proj>/.alpha/alpha.jsonc`,仅该项目可见;首次加载过信任门;
3. 未用扩展的项目零目录新增;用过的项目仅 `.alpha` 一个;
4. provider:设置界面增删自定义供应商 → 写 `~/.alpha/alpha.jsonc`,XDG 零新写;存量拷贝迁移后模型选择器/BYOK 行为零回归;
5. 生 TS plugin 拒收 loud;信任门拒绝路径功能如述;北极星守卫 + alpha-check 绿。

## 六、回写清单(GO 后)
- 立 REQ-060(本档为方案附件)+ BACKLOG;REQ-059 扩 provider 迁移条款(或并档);
- ADR-019 修订(项目级:hook 通道 + 单目录不变量;全局:provider 域并入真源);ADR-002 顺手注记(ext 插件新增职责);
- **REQ-036 修订**(目标3/验收5 落点);GLOSSARY(`alpha.jsonc` 项目级语义 + alpha-project-bridge);REQ-026 文档口径。

## 七、全局层一并归零(v3,用户追加拍板 2026-07-07 晚)

**通道 G1(主推):`OPENCODE_CONFIG=~/.alpha/alpha.jsonc`(sidecar env,引擎原生「额外配置文件」合并)** —— v1 源码证实(`config.ts:401-404`,在 `loadInstanceState` 内):
- **per-instance 合并**(每个 instance 装配时读)→ 作用域正确;
- **dispose 重建即重新读文件** → 安装免重启语义与指针方案等效(env 只冻结路径,路径永不变);
- **零引擎 junk**:ensureGitignore + `npm install @opencode-ai/plugin` 循环只扫 `directories` 列表(`config.ts:425-447`),OPENCODE_CONFIG 文件不在其中 → `~/.alpha` 不会被引擎塞 node_modules;
- merge 位序:XDG 之后(provider 压制成立)、项目之前(项目可覆盖全局,语义正确);
- 待验:v2 core 装载器是否消费 OPENCODE_CONFIG(v2 已见仅 OPENCODE_CONFIG_DIR,`core/global.ts:64`)→ T0 逐路裁定,v2-路由缺口由 G2 补。

**通道 G2(备援/补漏)**:与 §三 同一 ext 插件 config hook,读 `~/.alpha/alpha.jsonc` 注入(全局与项目两级同一套代码)。

**明确不用 `OPENCODE_CONFIG_DIR`**:v1 把它并入 `directories` → 会对 `~/.alpha` 做 ensureGitignore+npm install(junk 进品牌目录),且钉死文件名 `opencode.json(c)`;v2 语义又是「替换全局目录」——双栈语义分裂,否。

**全局既有桥全部退役**:`~/.opencode/skills` 链(REQ-052 两跳桥)、fs-installer 全局目录桥、REQ-059 指针,一律不再产生;全局 skills 经 G1/G2 的 `skills: ["~/.alpha/skills"]`(路径稳定,新装技能 dispose 重扫即见);agents/commands/mcp/plugin/provider 条目全在 `~/.alpha/alpha.jsonc`。

**存量清理(启动 reconcile)**:alpha-owned 判定(REQ-059 同款)→ 内容迁真源 + 拆自有链/删自有 jsonc;目录残余仅引擎 junk 白名单(package.json 单依赖 @opencode-ai/plugin / node_modules / package-lock / bun.lock / .gitignore)时**整目录删除**(REQ-052「拆空 `~/.opencode/skill/`」先例);含用户自建内容 → 保留 + loud(该机降级共存)。

**接受的损失(用户指令覆盖)**:原生 opencode CLI 从此看不到 alpha 安装物(ADR-019 D1「装一次处处用」理由正式作废);任何回退到 symlink 形态需用户重新拍板。

**不在射程**:`~/.config/opencode` 与 `~/.local/share/opencode` 是引擎自己的家(目录名也不叫 `.opencode`)——alpha 停写(provider 迁移)即达标;引擎不会自发新建 `~/.opencode`(paths.ts 的 home walk 只发现**已存在**的目录)。

## 附:v1 → v2 变更记录
- v1 的「项目级 = 单指针 + 纯 config」主案降级为**回退方案**;主案改 hook 注入(用户指令③「不要两个目录」直接决定);
- v1 的「XDG provider 不迁」verdict 被用户指令②推翻 → 改「写入面搬家 + 拷贝迁移」,并论证否掉 XDG symlink 桥;
- v1 的 D1/D2/D3 拍板点:D1 由用户指令解决;D2 定 `alpha_register`(a 案);D3 维持「底座先行,UI 入口可分期」。

### v2 → v3(同日晚)
- 用户第四条拍板「全局也不要 symlink、全面零 `.opencode`」→ 新增 §七:全局通道改 G1(`OPENCODE_CONFIG` 原生文件合并,junk-free、dispose 重读)+ G2(hook 备援);全局桥/指针全退役 + 存量 `~/.opencode` 清理 + CLI 可见性损失声明;REQ-059 doc/ADR-019/ADR-014/GLOSSARY/BACKLOG 已同步修订。
