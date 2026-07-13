# REQ-004 spike:`.alpha/` 桥接三法实测(→ ADR-019 回填)

> 日期:2026-07-03 · sprint:[S11 T1](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/sprints/2026-07-03-s11-cloud-loop/sprint.md) · 需求档:[REQ-004](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-004-alpha-workdir-spike.md)
> 方法:两路代码勘察(上游扫描机制 / alpha 注入接缝)+ 引擎同款 glob 运行时 fixture 实测。零改上游。

## 一、总 verdict

| 桥接法 | verdict | 依据 |
|---|---|---|
| ① config 注入(绝对路径) | ✅ **CONFIRMED(生产在用)** | `injectAlphaConfig` 已在用同机制:instructions[] 写盘绝对路径、plugin[] 绝对路径、`{file:}` 密钥引用(见 §二);上游三类字段均支持绝对路径(见 §三) |
| ② symlink 桥(目录扫描类) | ✅ **CONFIRMED(实测 6/6 PASS)** | 上游所有 `.opencode/` 扫描均传 `symlink:true` → npm glob `follow:true`(`packages/core/src/util/glob.ts:13-20`,glob@13.0.5);fixture 实测见 §四 |
| ③ 双写同步(回退) | **不需要** | ①② 全通,回退案不启用 |

**附加发现(优于预期)**:静态推断的「glob 只跟一跳 symlink」被运行时**证伪**——`follow:true` 下多跳链也被跟随(仅防环)。symlink 桥无链深限制。

## 二、alpha 注入接缝现状(config 注入法的生产实证)

- `injectAlphaConfig`:`packages/ui-mac/src/main/sidecar.ts:146-219`,merge 进 `OPENCODE_CONFIG_CONTENT`(fail-soft,`:216-218`)。
- 注入形态:`plugin[]` = ext bundle **绝对路径**(`:151-155`);`instructions[]` = 先写盘 `<userData>/alpha-{identity,behavior}.md` 再推**绝对路径**(`:161-184`);provider apiKey / mcp.cloud auth = **`{file:}` 引用**(`alpha-models.ts:72,94`、`sidecar.ts:209`),密钥永不内联。
- 上游消费:`packages/opencode/src/config/config.ts:467-475`,merge 语义 = instructions[] 并集去重(`config.ts:47-49`)、plugin[] 按 origin 去重(`:329-348`)、**`enabled_providers` 整体替换**(既知,`alpha-models.ts:100-106` 已补偿)。`{file:}` 在 `config/variable.ts:34-85` 解析,支持绝对路径与 `~/`。
- **结论**:alpha 私有产物(identity/behavior/secrets/云任务 artifact)引擎不扫描、全靠绝对路径引用 → 搬 `.alpha/` = 改 base 参数,零桥接成本。改动面:`sidecar.ts:163`(userDataPath base)、`alpha-secret-files.ts:39,62`。注:identity/behavior/secrets 属**全局级**产物,仍留 userData;进 `.alpha/` 的只是**项目级**产物(runs/prefs)。

## 三、上游发现机制(per 原语 file:line)

全部经 `packages/core/src/util/glob.ts:13-20`(`symlink→follow`、`include!=="all"→nodir`),glob@13.0.5:

| 原语 | 扫描点 | pattern | symlink verdict |
|---|---|---|---|
| tool | `packages/opencode/src/tool/registry.ts:171-174` | `{tool,tools}/*.{js,ts}` | 文件链 ✓(单层 `*`,目录链不适用) |
| plugin | `packages/opencode/src/config/plugin.ts:21-28` | `{plugin,plugins}/*.{ts,js}` | 文件链 ✓ |
| agent | `packages/opencode/src/config/agent.ts:13-18` | `{agent,agents}/**/*.md` | 文件链/目录链 ✓ |
| command | `packages/opencode/src/config/command.ts:15-20` | `{command,commands}/**/*.md` | 文件链/目录链 ✓ |
| skill ⭐ | `packages/opencode/src/skill/index.ts:24,150-156,205-208` | `{skill,skills}/**/SKILL.md` | 目录链 ✓(核心场景) |
| `.opencode` 本体 | `packages/core/src/fs-util.ts:151-165`(stat 族,跟随) | — | **整目录链 ✓**(`.opencode → .alpha/<bridge>` 可行) |

config 字段绝对路径:`plugin[]` ✓(`config/plugin.ts:42-60`,目标解析 statAsync 跟随 `plugin/shared.ts:171-189`);`instructions[]` ✓(`session/instruction.ts:135-149`;注意其 glob **未传** symlink——纯绝对文件路径不受影响,勿用「穿过目录链的 glob」形态);`mcp.servers` cwd/command ✓(`mcp/index.ts:343-356`)。全局 `~/.config/opencode` 与项目 `.opencode/` 同一套扫描(`config/paths.ts:23-41`)。
**skills 另有 symlink-free 替代**:`config.skills.paths[]` 支持绝对路径 + `~/`(`skill/index.ts:211-219`)——若未来 symlink 出平台问题,skills 可改经 config 注入直指 `.alpha/skills/`。

## 四、运行时实测(fixture,引擎同款 options)

脚本:scratchpad `req004-bridge-test/run.ts`(引擎同款 pattern + `{absolute,dot,follow:true,nodir:true}`,glob@13.0.5 取自本仓 node_modules)。**6/6 PASS**:

1. skill 目录链 `.opencode/skill/foo → .alpha/skills/foo`(含 SKILL.md)→ 发现 ✓
2. 目录链内普通子目录(`nested/sub/SKILL.md`)→ 发现 ✓
3. 真目录内一跳链(`chained-host/inner`)→ 发现 ✓;**二跳链(`twohop/hop2/*`)→ 也发现**(one-hop 假说证伪)
4. tool 文件链 ✓;tool 目录链在单层 `*` + nodir 下不可见(符合预期,tool 桥须逐文件链)
5. plugin 文件链 ✓ · agent 目录链 ✓ · command 文件链 ✓
6. **整目录桥** `project2/.opencode → .alpha/opencode-bridge` → 内部 skill 发现 ✓

复现:`bun run run.ts`(脚本建 fixture → 跑 6 case → exit 0)。

## 五、残余风险与注记

- **ADR-006 不变**:symlink 只解决**发现**;桥进 `.alpha/` 的 tool/plugin 依旧必须是预 bundle 自包含 JS(生 TS 在打包态 Electron-Node 会炸)。skill/agent/command 为 md,无此约束。
- 实测在 bun 运行时做(glob 语义纯 JS/fs,跨运行时一致);打包态 in-app 冒烟随 B3 T2 同场补(verified 门槛)。
- 顺带发现(已另行登记 REQ-017):`scripts/alpha-check.sh` 北极星守卫仍扫 `packages/app`,未跟 ADR-020 移出 app/ui → 本地自检恒假红,与 alpha-ci 不再 1:1。
- 顺带发现(并入 REQ-017 备注):定制中心两个写盘根不一致——`ext-config.ts:50-58` 走 XDG,`ext-fs-installer.ts:18-20` 硬编码 `~/.config/opencode`(设 `XDG_CONFIG_HOME`/`OPENCODE_CONFIG_DIR` 的用户会写读分叉)。

## 六、`.alpha/` schema 与 gitignore(→ 已回填 ADR-019 修订)

```
.alpha/
  runs/<runId>/          # 云任务:contract.json · status.json · artifacts/(B3/G4 回流落点)
  prefs.json             # alpha 项目偏好
  skills/ tools/ agents/ commands/   # 桥接真源(.opencode/ 内放同名 symlink;tools 逐文件链)
```
gitignore:**整个 `.alpha/` 建议 ignore**(运行时产物);可提交子集暂不引入(YAGNI,共享偏好需求出现再放开)。写盘守卫复用既有:`safeResolve`(realpath 防逃逸,`ext-fs-installer.ts:24-43`)+ `writeKey` 原子写(`ext-config.ts:144-183`)+ `syncSecretFiles` 0600 模式。
