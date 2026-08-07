// #607:注入组合体的执行级可测面。injectAlphaConfig 与 materializeV2EngineConfig 从
// sidecar.ts 逐字搬来(含那层函数级 catch)。#613:catch 仍在(裸崩溃是票面明令禁止的另一种谎),
// 但失败不再只是进程内一行 warn —— 结果作为返回值交给 sidecar.ts,随 ready IPC 上报 main,
// 由终态生产者发布 "injection-failed"(与 ready/failed 并列,见 sidecar-generation.ts)。
//
// 为什么必须单独成模块:sidecar.ts 的第一个 import 就是 `node:module` 的 registerHooks
// (ADR-006 的 TS 解析桥),bun 1.3.14 未实现该 API —— 错误发生在 import 语句上,stub 任何东西
// 都救不了;其后顶层还有 `const parentPort = getParentPort()`,在非 utility process 中必抛。
// 于是「注入是否真的跑起来」全仓零覆盖,而函数级 catch 会把内部任何抛错静默吞掉
// (可见症状只是「模型全灰/正在同步」,2026-07-24 事故的表现)。抽出后本模块对 parentPort /
// registerHooks 零依赖,测试可 import 并**真实执行生产 composition**(alpha-config-injection.test.ts:
// 正向闸门锁 model/enabled_providers/provider/三个 alpha agent/{file:} ref,反向闸门锁 catch 的
// 真实爆炸半径 + 失败必须出声)。

import * as fs from "node:fs"
import * as path from "node:path"
import { ALPHA_BEHAVIOR_MD } from "./alpha-behavior"
import { buildAlphaCapabilities, buildAlphaIdentity } from "./alpha-identity"
import { buildAlphaModelConfig } from "./alpha-models"
// `#733`:`secretFileRef` 随静态 bearer 一起从本文件退场 —— 云 MCP 的 Authorization 头没了,
// 就没有第二个 `{file:}` 引用要发。`hasSecretFile` 留着:它是 ADR-009 的「平台代付」判据
// (见下方 `platformPays`),与 MCP 怎么认证无关,删掉会顺手关掉 web search 主权闸。
import { hasSecretFile } from "./alpha-secret-files"
import {
  applyWebSearchDenies,
  CLOUD_MCP_ARM_ENV,
  CLOUD_MCP_DEF_ENV,
  CLOUD_MCP_SERVER_ENV,
  CLOUD_MCP_SERVER_NAME,
  WITHHELD_CLOUD_MCP,
} from "./cloud-web-search"
import { alphaGlobalRoot, alphaJsoncPath } from "./engine-config-truth"
import { injectDisabledOverrides } from "./ext-disabled-injection"
import { injectMcpDefaultDeny } from "./mcp-default-deny"
import { materializeCloudMcpConfig } from "./cloud-sidecar-config"
import type { ChannelName } from "./catalog-channels"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../shared/alpha-config"

// Inject alpha-code's customizations into opencode via OPENCODE_CONFIG_CONTENT. This env var is
// MERGED with the user's global/project config — it does NOT replace it (opencode config.ts
// loads global config unconditionally and merges this as a "local" source), so untouched fields
// (auth, other instructions) are preserved. We layer two independent, separately-gated pieces:
//
//   1. Brand identity (ALPHA_IDENTITY_DISABLE): a global instruction file written to
//      userDataPath (stable absolute path in both dev and the packaged .app) added to
//      `instructions`, so the agent calls itself "alpha-code". Now also carries per-session
//      capability facts (websearch / cloud dispatch) — see buildAlphaIdentity(caps). Behavior-neutral.
//   1b. Response guidance (ALPHA_BEHAVIOR_DISABLE): a SEPARATE instruction file (alpha-behavior.ts)
//      that deliberately tunes agent behavior (Tier-3, ADR-015). Gated independently of identity and
//      carries a drift caveat — re-validate after every upstream prompt bump.
//   2. Curated model menu (ALPHA_MODELS_DISABLE): provider allowlist + per-provider model
//      whitelist + custom/ALPHA gateways + default model. See alpha-models.ts for the shape and
//      the {env:VAR} key story.
//
//   4. B6(=G1):@alpha-code/ext 装载 —— main 解析好的自包含 bundle 绝对路径合并进 V1 `plugin`
//      (单数键,见 opencode-config-v1-schema)数组,保留用户自己的 plugin 列表。zod 跨实例路径
//      (ADR-006 caveat)的运行时证明 = alpha_ping 出现在工具表且能执行(真机批核验)。

// #613:注入失败的可上报形态(结构化,可过 IPC)。爆炸半径随抛点而异:最早(identity mkdir)
// = 整份注入丢失(OPENCODE_CONFIG_CONTENT / OPENCODE_CONFIG_DIR 双双缺席);最晚(v2 桥,
// R1 Blocker 1)= v1 已写出、但 picker 唯一读取的 v2 目录缺席。两端的用户可见症状同为
// 模型全灰,故一律 {ok:false} 上报 —— 不存在「可忽略的局部降级」。
export type AlphaConfigInjectionFailure = { message: string; stack?: string }
export type AlphaConfigInjectionResult = { ok: true } | { ok: false; error: AlphaConfigInjectionFailure }

export function injectAlphaConfig(
  userDataPath: string,
  extPluginPath?: string,
  registryChannel?: ChannelName,
): AlphaConfigInjectionResult {
  try {
    // REQ-059 G1:引擎经 OPENCODE_CONFIG 加载当前环境的 alpha.jsonc(mcp/plugin/
    // provider/治理键)。文件通道 → dispose 重建重读文件 = 安装免重启;merge 序 XDG 后(压 provider)/
    // 项目前(可覆盖);junk 循环不扫单文件 → 当前环境根零引擎垃圾(T0 spike 判定)。全新机器 seed
    // {$schema},否则 loadFile 指向不存在文件。逃生 ALPHA_JSONC_TRUTH_DISABLE / ALPHA_LEGACY_INSTALL_ROOT
    // 不注入(回 REQ-018 home walk 行为,ext-config 写入目标也随之回退,两侧一致)。
    if (process.env.ALPHA_JSONC_TRUTH_DISABLE !== "1" && process.env.ALPHA_LEGACY_INSTALL_ROOT !== "1") {
      const truth = alphaJsoncPath()
      fs.mkdirSync(path.dirname(truth), { recursive: true })
      if (!fs.existsSync(truth)) {
        fs.writeFileSync(truth, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2))
      }
      process.env.OPENCODE_CONFIG = truth
    }

    const existing = process.env.OPENCODE_CONFIG_CONTENT
    const config = existing ? JSON.parse(existing) : { $schema: "https://opencode.ai/config.json" }
    // ADR-009 B1 的「平台代付」判据(云 MCP URL + 密钥文件同在)。caps 事实、云 MCP 注册与
    // web search 主权 deny 三处共用同一个判据,不许各算各的。
    const platformPays = Boolean(process.env.ALPHA_CLOUD_MCP_URL && hasSecretFile(userDataPath, "ALPHA_CLOUD_TOKEN"))
    // ADR-009 B2 的能力总闸。main 在每次 fork 前用同一个表达式判过一次并把判决写进
    // `ALPHA_CLOUD_WEBSEARCH_DENY`(server.ts);这里重算是因为注入面自己也要用(见下方云 MCP 注册)。
    const killSwitch = Boolean(process.env.ALPHA_WEBSEARCH_DISABLE)
    // 只记录本轮函数自己新放进 mcp 的名字;继承来的 OPENCODE_CONFIG_CONTENT 不是治理授权。
    const injectedMcpNames = new Set<string>()

    if (extPluginPath) {
      const plugins: string[] = Array.isArray(config.plugin) ? config.plugin : []
      if (!plugins.includes(extPluginPath)) plugins.push(extPluginPath)
      config.plugin = plugins
    }

    const wantIdentity = !process.env.ALPHA_IDENTITY_DISABLE
    const wantBehavior = !process.env.ALPHA_BEHAVIOR_DISABLE
    if (wantIdentity || wantBehavior) {
      fs.mkdirSync(userDataPath, { recursive: true })
      const instructions: string[] = Array.isArray(config.instructions) ? config.instructions : []
      const addInstruction = (name: string, body: string) => {
        const file = path.join(userDataPath, name)
        fs.writeFileSync(file, body)
        if (!instructions.includes(file)) instructions.push(file)
      }

      if (wantIdentity) {
        // Capability facts the base prompt can't know — purely informational (ADR-009 / ADR-002).
        // The cloud token lives in the {file:} channel, never in this process's env (A6).
        const cloudDispatch = platformPays
        const caps = buildAlphaCapabilities({
          websearchDisabled: Boolean(process.env.ALPHA_WEBSEARCH_DISABLE),
          keylessWebsearch: process.env.OPENCODE_ENABLE_EXA !== "0",
          cloudDispatch,
        })
        addInstruction("alpha-identity.md", buildAlphaIdentity(caps))
      }

      // Tier-3 behavioral tuning (ADR-015), independently gated. See alpha-behavior.ts for the drift caveat.
      if (wantBehavior) addInstruction("alpha-behavior.md", ALPHA_BEHAVIOR_MD)

      config.instructions = instructions
    }

    // REQ-063:`<current-environment-root>/instructions/*.md` = 用户经导入门转换的全局指令(如 ~/.claude/CLAUDE.md
    // 快照)。存在即注入 —— 它们只在用户显式「导入」后出现,是 alpha 原生资产(非继承通道)。
    try {
      const instrDir = path.join(alphaGlobalRoot(), "instructions")
      const imported = fs.existsSync(instrDir)
        ? fs
            .readdirSync(instrDir)
            .filter((f) => f.endsWith(".md"))
            .sort()
            .map((f) => path.join(instrDir, f))
        : []
      if (imported.length) {
        const instructions: string[] = Array.isArray(config.instructions) ? config.instructions : []
        for (const f of imported) if (!instructions.includes(f)) instructions.push(f)
        config.instructions = instructions
      }
    } catch {
      /* unreadable dir → skip (imported instructions simply stay dark this fork) */
    }

    const models = buildAlphaModelConfig(userDataPath)
    if (models) {
      config.enabled_providers = models.enabled_providers
      if (models.model) config.model = models.model
      config.provider = { ...(config.provider ?? {}), ...models.provider }
    }

    //   5. 自动化 readonly agent(REQ-021 A1.5 / ADR-022)。无人值守执行的硬前提 = 零 ask:
    //      permission 静态配死(V1 schema:pattern→action 对象,agent 级合并),不依赖运行时弹窗。
    //      read 全放但 *.env* 保持 deny(密钥文件不进上下文);edit/bash/外部目录一律 deny;
    //      question deny(无人在场没人答);doom_loop deny(异常循环直接断)。逃生:ALPHA_AUTOMATION_DISABLE。
    if (!process.env.ALPHA_AUTOMATION_DISABLE) {
      config.agent = {
        ...(config.agent ?? {}),
        "alpha-automation": {
          description: "alpha 自动化定时任务专用只读 agent(无人值守;不能改文件、不能跑命令)",
          // REQ-055:对选择器隐藏(上游 agent.ts 原生 hidden 字段,仅影响可见列表;调度器按名 prompt 不受影响)
          hidden: true,
          mode: "primary",
          prompt:
            "你是 alpha-code 的自动化任务执行器,在无人值守的定时任务里运行。" +
            "只读环境:你不能修改文件、不能执行 shell 命令;需要变更时,把建议写进最终答复。" +
            "没有人会回答追问——绝不提问,基于可得信息直接完成任务。" +
            "最终答复即任务报告:用 Markdown,先一行结论,再列依据与建议;如实标注做不到的部分。",
          permission: {
            read: { "*": "allow", "*.env*": "deny" },
            glob: "allow",
            grep: "allow",
            list: "allow",
            webfetch: "allow",
            websearch: "allow",
            skill: "allow",
            edit: "deny",
            bash: "deny",
            external_directory: "deny",
            doom_loop: "deny",
            question: "deny",
            task: "deny",
          },
        },
      }
    }

    //   2b. REQ-028:交互只读 agent(composer「只读」档的真载体)。与 alpha-automation 的差异:
    //       交互场景有人在场 → question/task 允许(追问/委托子任务不破只读:子 agent 权限独立,
    //       且 plan 类子任务本身只读);写/执行仍静态 deny —— 「真被 deny」而非 UI 文案。
    //       逃生:ALPHA_READONLY_DISABLE。治理保护名单同 alpha-automation(X2,alpha-governance.ts)。
    if (!process.env.ALPHA_READONLY_DISABLE) {
      config.agent = {
        ...(config.agent ?? {}),
        "alpha-readonly": {
          description: "只读模式:可读取/检索/联网,不能修改文件、不能执行命令(composer 权限档「只读」)",
          // REQ-055:对选择器隐藏;AlphaComposer 只读档改为提交时 agent 参数,不再依赖可见列表轮转
          hidden: true,
          mode: "primary",
          prompt:
            "当前处于用户选择的只读模式:你不能修改文件、不能执行 shell 命令。" +
            "可以读取、检索、联网调研与分析;需要变更时,给出明确的修改建议(含文件与位置),由用户切回可写模式执行。" +
            "不要尝试绕过限制;做不到的部分如实说明。",
          permission: {
            read: { "*": "allow", "*.env*": "deny" },
            glob: "allow",
            grep: "allow",
            list: "allow",
            webfetch: "allow",
            websearch: "allow",
            skill: "allow",
            edit: "deny",
            bash: "deny",
            external_directory: "deny",
          },
        },
      }
    }

    //   2c. REQ-024(自动化 A2):standard 可写档 agent。无人值守语义同 alpha-automation
    //       (question/task/doom_loop deny,零 ask 硬前提);差异 = edit allow + bash 受限 allow
    //       (破坏类命令模式 deny —— 模式黑名单**非穷尽**,UI 启用时有显式风险确认,不谎称安全)。
    if (!process.env.ALPHA_AUTOMATION_DISABLE) {
      config.agent = {
        ...(config.agent ?? {}),
        "alpha-automation-standard": {
          description: "alpha 自动化 standard 档(可写:能改文件、能执行常规命令;破坏类命令仍被拦)",
          // REQ-055:对选择器隐藏(同 alpha-automation)
          hidden: true,
          mode: "primary",
          prompt:
            "你是 alpha-code 的自动化任务执行器,在无人值守的定时任务里运行(可写档)。" +
            "可以修改文件与执行常规命令;破坏性操作(删除大量文件、系统级变更、对外发布)被权限拦截,也不要尝试。" +
            "没有人会回答追问——绝不提问,基于可得信息直接完成任务。" +
            "最终答复即任务报告:用 Markdown,先一行结论,再列所做变更与依据;如实标注做不到的部分。",
          permission: {
            read: { "*": "allow", "*.env*": "deny" },
            glob: "allow",
            grep: "allow",
            list: "allow",
            webfetch: "allow",
            websearch: "allow",
            skill: "allow",
            edit: "allow",
            bash: {
              "*": "allow",
              // 破坏类直呼(codex 审计加固:绝对路径/包装器/嵌套 shell/find -delete/git clean 常见绕法补拦;
              // 黑名单仍非穷尽 —— UI 风险确认与 agent prompt 如实声明,根治=沙箱化(后续)):
              "rm *": "deny",
              "*/rm *": "deny",
              "command *": "deny",
              "exec *": "deny",
              "env *": "deny",
              "xargs *": "deny",
              "sh *": "deny",
              "bash *": "deny",
              "zsh *": "deny",
              "eval *": "deny",
              "find * -delete*": "deny",
              "find * -exec *": "deny",
              "git clean*": "deny",
              "git reset --hard*": "deny",
              "sudo *": "deny",
              "chmod *": "deny",
              "chown *": "deny",
              "dd *": "deny",
              "mkfs*": "deny",
              "shutdown*": "deny",
              "reboot*": "deny",
              "kill *": "deny",
              "killall *": "deny",
              "git push*": "deny",
              "npm publish*": "deny",
              "curl * | *": "deny",
              "wget * | *": "deny",
            },
            external_directory: "deny",
            doom_loop: "deny",
            question: "deny",
            task: "deny",
          },
        },
      }
    }

    //   3. Cloud tool gateway (alpha-platform B). Registered only when platform-pays is active —
    //      main derives the login state (alpha-auth.ts §③) from the presence of the
    //      ALPHA_CLOUD_TOKEN secret file, so logged-out / BYOK leaves it dark.
    //      (see docs/contracts/platform-integration.md).
    //
    //      `#733`: this server carries NO credential channel any more. It used to attach a static
    //      `Bearer {file:…ALPHA_CLOUD_TOKEN}` header with `oauth:false`; it now declares a standard
    //      MCP OAuth client and the engine holds/refreshes the credential itself. Two consequences
    //      worth spelling out here, because both were invisible before:
    //        - ALPHA_CLOUD_TOKEN is still read — but only as the platform-pays predicate above.
    //          It is no longer the MCP Authorization source. Rotating it does NOT fix an
    //          unauthenticated cloud MCP; the user re-authorizes from the extension hub instead.
    //        - `oauth:false` was not a neutral setting: it made `needs_auth` structurally
    //          unreachable for this server (engine `mcp/index.ts:241`), so a missing credential
    //          could only ever surface as `failed` with no user-visible remedy.
    const mcpUrl = process.env.ALPHA_CLOUD_MCP_URL
    if (mcpUrl && platformPays) {
      // #223 R4→R5 fail-closed:kill-switch 下 `cloud_web_search` 的**最终**闸住在 @alpha-code/ext
      // 的 tool.execute.before 钩子里(远端 MCP 无 per-tool 注册期过滤,permission deny 可被后置
      // allow 顶掉)。R3 用「extPluginPath 路径是否存在」判 ext 在不在场 —— R4 证明那不成立:
      // `OPENCODE_PURE=true` 让引擎整个跳过外部插件,bundle import 失败与插件初始化失败也都是
      // log-and-continue,三种情形下路径都还在而钩子不存在。
      //
      // R4 改成握手,但把定义先写成 `enabled:false` 再由 ext 翻开 —— **R5 判其为回归**:
      // `MCP.connect()`(`opencode/src/mcp/index.ts`)无条件把配置复制成 `enabled:true`,该能力
      // 公开为 `/mcp/:name/connect` 且产品 UI 真的在调,于是 ext 缺席时用户点一下就能把那份含
      // 完整 URL/header 的定义热连起来。`enabled:false` 从来不是「不可重开」。
      //
      // R5 形态:**完整定义根本不进配置**,只经 env 托管给 ext。
      //
      // #223 R6 Major:R5 只从继承来的 `OPENCODE_CONFIG_CONTENT` 对象里删掉 `mcp.cloud`,并据此
      // 声称「继承来的同名条目一并抹掉」—— 不成立。引擎另外还加载 XDG global、`OPENCODE_CONFIG`
      // (alpha.jsonc)、项目目录与 managed 配置,深合并里「缺少 cloud 键」**不会删除**先前来源的
      // 定义(`opencode/src/config/config.ts`)。所以这里改为写一份**中和条目**
      // (`WITHHELD_CLOUD_MCP`),用 later-wins 的标量覆盖把任何继承来的 `cloud` 的**连接控制字段**
      // (`type`/`url`/`enabled`/`oauth`;`headers`/`timeout` 会留下 —— #223 R7 措辞更正,它们已无处
      // 可发)压成一个连不上的 `127.0.0.1:1` 端点;ext 确认装载后由 `installCloudMcp()` 整条
      // 替换它。ext 缺席 ⇒ 留下的是中和条目 ⇒ `/connect` 连不上任何东西(连兄弟工具一起损失)——
      // 诚实降级,不是 AC4 的「误杀」:AC4 管的是闸生效时的正常态。
      // `#733`:这份定义里**没有任何凭证通道** —— 没有 `headers`、没有 `{file:}` 引用。
      // 云 MCP 走标准 OAuth,凭证由引擎自己的凭证库按 server URL 绑定持久化并自动刷新;
      // 拿不到令牌时该 server 进 `needs_auth`(而不是像 `oauth:false` 时那样只能 `failed`),
      // 用户在扩展中心有一个能点的补救入口。定义与常量见 `cloud-sidecar-config.ts`。
      const cloud = materializeCloudMcpConfig(mcpUrl)
      // ext 的闸靠这两个变量核验「哪个 MCP server 真的是 alpha 治理的云通道」——
      // #223 R6 Blocker:判据是 DEF 里那份定义的**端点身份**(URL),不再是名字前缀,所以 DEF 在
      // 代付的两条分支上都置位(ARM 只在 kill-switch 分支置位;ARM/DEF 缺一 ext 什么都不装)。
      process.env[CLOUD_MCP_SERVER_ENV] = CLOUD_MCP_SERVER_NAME
      process.env[CLOUD_MCP_DEF_ENV] = JSON.stringify(cloud)
      config.mcp = { ...(config.mcp ?? {}), [CLOUD_MCP_SERVER_NAME]: killSwitch ? { ...WITHHELD_CLOUD_MCP } : cloud }
      injectedMcpNames.add(CLOUD_MCP_SERVER_NAME)
      if (killSwitch) {
        process.env[CLOUD_MCP_ARM_ENV] = CLOUD_MCP_SERVER_NAME
        console.error(
          `[alpha-code#223] web search kill switch is set — the cloud MCP server definition is WITHHELD from the engine config (a neutralised ${WITHHELD_CLOUD_MCP.url} entry overrides any inherited one); only a confirmed @alpha-code/ext load installs the real one via ${CLOUD_MCP_ARM_ENV}/${CLOUD_MCP_DEF_ENV}${extPluginPath ? "" : ", and no ext bundle path was resolved this fork so it will stay dark"}`,
        )
      } else {
        // 代付但无 kill-switch:云工具是权威通道,不需要闸,也就不该依赖 ext 是否装载。
        delete process.env[CLOUD_MCP_ARM_ENV]
      }
    } else {
      delete process.env[CLOUD_MCP_ARM_ENV]
      delete process.env[CLOUD_MCP_DEF_ENV]
      delete process.env[CLOUD_MCP_SERVER_ENV]
    }

    // Remote MCP config only toggles whole servers, but the engine's global permission layer filters
    // individual registered MCP tool IDs from both ordinary and code-mode tool sets. Deny only the
    // model-visible cloud_web_search ID and keep the cloud server plus sibling tools live.
    // #223:同一处也 deny 本地 `websearch` —— env 层的 keyless force-off 压不住
    // `OPENCODE_EXPERIMENTAL` umbrella(见 cloud-web-search.ts)。必须排在 agent 注入之后。
    applyWebSearchDenies(config, { killSwitch, platformPays })

    // #395(Codex r11 pivot → 主权注入):把账本 disabled 的 mcp/agent 权威覆盖注入 OPENCODE_CONFIG_CONTENT
    // —— 它在引擎加载序 step 6(所有 in-scope 源之后:XDG / ~/.opencode / agent-md·plugin-script 自动
    // 发现目录 / 项目)。mergeDeep later-wins 使 alpha 的 `enabled:false`/`disable:true` **压过一切 in-scope
    // 源**,disabled 扩展永不被引擎加载 —— 无需逐源探测(探测器无底洞由此消除)。引擎 schema 显式允许
    // lone `{enabled:false}` mcp 叶(v1/config/config.ts:114)与 disable-only agent 叶(全 optional)。
    // plugin 是 union 无覆盖面,靠 alpha.jsonc 移除(无用户 = 无他源);cloud/skill 无此面。
    // 仅 global scope(项目 scope 由项目 config 面另管)。best-effort:账本不可读 → 跳过(alpha.jsonc
    // 投影仍在;主权注入是加固层)。#397:session-grant 记录在注入面强制按 disabled 处理
    // (持久 enable 非法;判定读已验 catalog,userDataPath/channel 由此传入)。channel 来自
    // StartCommand(main 冻结快照)—— 本进程调 catalogRegistryChannel() 必抛(见 StartCommand 注释),
    // 加固层的任何缺料只允许降级跳过,不允许波及上方 provider/identity/permission 注入。
    if (registryChannel) injectDisabledOverrides(config, { userDataPath, channel: registryChannel })
    else
      console.error(
        "[req104-397] registry channel missing from start command — skipping disabled-override injection (boot reconcile holds the fail-closed gate)",
      )

    // #535 / REQ-109 T6(基线 §② G1、§③):账本禁用覆盖落定后,枚举真实用户全局
    // XDG config 的三个文件。非治理 MCP 以末序 enabled:false 压住;治理 MCP 不复制、不改写。
    // 逐文件失败只 loud 跳过,不得破坏上方任何注入。
    injectMcpDefaultDeny(config, {
      alphaConfigPath: alphaJsoncPath(),
      injectedMcpNames,
    })

    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
    materializeV2EngineConfig(userDataPath, config, Boolean(models))
    return { ok: true }
  } catch (error) {
    // #613:catch 保留(sidecar 照常起,候选形态③),但失败必须离开本进程:
    // warn 是 #607 反向闸门锁住的进程内出声,返回值是送往 main/renderer 的结构化事实。
    console.warn("failed to inject alpha config", error)
    return {
      ok: false,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) },
    }
  }
}

// 2026-07-23 上游 sync 断层修补:v2 Config.Service(packages/core/config.ts)只读
// `OPENCODE_CONFIG_DIR ?? ~/.config/opencode` 目录下的 opencode.json/opencode.jsonc 文件 ——
// OPENCODE_CONFIG_CONTENT 与 OPENCODE_CONFIG(alpha.jsonc)它一概不读。而 picker 已切 v2
// `/api/model`(model-contract.ts → catalog.model.available()),于是 v1 注入再成功,v2 目录里
// 也没有 alpha/BYOK provider → 全部「当前不可用」。此桥把 v2 需要的最小子集物化成文件:
//   opencode.json  ← alpha.jsonc 原样拷贝(用户自定义节点;先加载)
//   opencode.jsonc ← { $schema, model, provider }(注入的 provider 表,后加载压过用户同名项)
// 并设 OPENCODE_CONFIG_DIR 指向该 alpha 自有目录。v1 加载读的是 Global.Path.config 静态路径,
// 不受此 env 影响;推理仍走 v1(有 {file:}/{env:} 解析),故 v2 文件一律剥掉 apiKey —— v2 无
// 变量解析,catalog 可用性判定也不需要 key(no-integration 路径)。
// 失败不自吞(#613 R1 Blocker 1):picker 只经 v2 目录读模型,桥失败(磁盘满/权限/目录不可写)
// = alpha/BYOK 模型全灰 = 票面事故症状,「只损失 v2 目录」不是可忽略的局部降级 —— 桥内不设
// catch,抛错经 injectAlphaConfig 外层 catch 以 {ok:false} 离开进程。桥排在
// OPENCODE_CONFIG_CONTENT 写出**之后**,抛错不撤销已就位的 v1 注入
// (顺序由反向闸门锁死:alpha-config-injection.test.ts 的 v2 桥用例)。
type V1ProjectedModel = { name?: unknown }
type V1ProjectedProvider = {
  name?: unknown
  npm?: unknown
  api?: unknown
  options?: { baseURL?: unknown }
  models?: unknown
}

function governedModelsBase(config: { enabled_providers?: unknown; provider?: unknown }): Record<string, unknown> {
  const enabled = Array.isArray(config.enabled_providers)
    ? config.enabled_providers.filter((id): id is string => typeof id === "string")
    : []
  const providers = (config.provider ?? {}) as Record<string, V1ProjectedProvider>

  // An enabled id without a complete provider/model projection is a user/file-owned provider.
  // Do not publish the early marker for a partial set: the renderer will keep waiting for the
  // ordinary ConfigProvider commit, which has already merged those file sources.
  if (
    enabled.some((id) => {
      const item = providers[id]
      return !item || !item.models || typeof item.models !== "object" || Array.isArray(item.models)
    })
  )
    return {}

  const base: Record<string, unknown> = {}
  for (const id of enabled) {
    const item = providers[id]!
    const npm = typeof item.npm === "string" ? item.npm : undefined
    const api =
      typeof item.options?.baseURL === "string"
        ? item.options.baseURL
        : typeof item.api === "string"
          ? item.api
          : undefined
    const modelProvider = npm || api ? { ...(npm ? { npm } : {}), ...(api ? { api } : {}) } : undefined
    const models = Object.fromEntries(
      Object.entries(item.models as Record<string, V1ProjectedModel>).map(([modelID, model]) => [
        modelID,
        {
          id: modelID,
          name: typeof model.name === "string" ? model.name : modelID,
          release_date: "1970-01-01",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: false,
          limit: { context: 0, output: 0 },
          modalities: { input: [], output: [] },
          ...(modelProvider ? { provider: modelProvider } : {}),
        },
      ]),
    )
    base[id] = {
      id,
      name: typeof item.name === "string" ? item.name : id,
      env: [],
      ...(api ? { api } : {}),
      ...(npm ? { npm } : {}),
      models,
    }
  }
  base[ALPHA_V2_CATALOG_READY_PROVIDER_ID] = {
    id: ALPHA_V2_CATALOG_READY_PROVIDER_ID,
    name: "Alpha catalog readiness marker",
    env: [],
    models: {},
  }
  return base
}

function materializeV2EngineConfig(
  userDataPath: string,
  config: { model?: unknown; enabled_providers?: unknown; provider?: unknown },
  governedModels: boolean,
) {
  const dir = path.join(userDataPath, "alpha-engine-config")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const userCopy = path.join(dir, "opencode.json")
  try {
    fs.copyFileSync(alphaJsoncPath(), userCopy)
  } catch {
    fs.rmSync(userCopy, { force: true }) // 无真源(或读失败)则清掉旧拷贝,不留陈尸
  }
  const provider: Record<string, unknown> = Object.fromEntries(
    Object.entries((config.provider ?? {}) as Record<string, { options?: Record<string, unknown> }>).map(
      ([id, def]) => {
        const { apiKey: _apiKey, ...options } = def.options ?? {}
        return [id, { ...def, ...(Object.keys(options).length ? { options } : { options: undefined }) }]
      },
    ),
  )
  provider[ALPHA_V2_CATALOG_READY_PROVIDER_ID] = {
    name: "Alpha catalog readiness marker",
    env: [],
  }
  const v2 = {
    $schema: "https://opencode.ai/config.json",
    ...(typeof config.model === "string" ? { model: config.model } : {}),
    provider,
  }
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), JSON.stringify(v2, null, 2), { mode: 0o600 })
  process.env.OPENCODE_CONFIG_DIR = dir

  // #857:when Alpha model governance is active, every available built-in provider/model is already
  // described by the provider projection above. Letting ModelsDev fall through to the bundled
  // snapshot still makes the first V2 request decode and materialize 6,132 unrelated rows before
  // ConfigProvider commits (2.8-6.1s in the signed packaged matrix). Materialize a minimal ModelsDev
  // base mechanically from that SAME projection so the earlier ModelsDevPlugin commit carries the
  // exact governed identities and readiness marker. ConfigProvider remains authoritative for the
  // richer late metadata/variants. If an enabled user/file provider is absent from this in-memory
  // projection, governedModelsBase returns {} WITHOUT the marker, preserving the conservative late
  // barrier instead of exposing a partial first set. No key field is read or written here.
  // Preserve ALPHA_MODELS_DISABLE as a real escape hatch by leaving any inherited path untouched.
  if (governedModels) {
    const modelsPath = path.join(dir, "models.json")
    fs.writeFileSync(modelsPath, `${JSON.stringify(governedModelsBase(config), null, 2)}\n`, { mode: 0o600 })
    process.env.OPENCODE_MODELS_PATH = modelsPath
  }
}
