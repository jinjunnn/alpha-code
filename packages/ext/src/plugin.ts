import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { pathToFileURL } from "node:url"
import { wrapEngineShell } from "./shell-sandbox"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { mergeProjectConfig, projectDirectoryIdentity, requireAlphaGlobalRoot, withProjectDirectoryIdentity } from "./project-config"
import { loadProjectPlugins, mergeHooks } from "./plugin-fanout"
import { applyRegister, type RegisterType } from "./register"
import { applyPromptTakeover } from "./alpha-prompts"
import { applyFactoryDeny } from "./factory-deny"
import { injectFactorySkillPaths } from "./factory-paths"
import { injectSkillGenerationPaths } from "./gen-skill-paths"
import { rebrandSystem } from "./prompt-rebrand"
import { validateCloudToolInput, validateCloudToolOutput } from "./cloud-contract-hook"
import {
  assertWebSearchToolAllowed,
  computeMcpOwnership,
  installCloudMcp,
  UNVERIFIED_MCP_OWNERSHIP,
  type McpOwnership,
} from "./cloud-websearch-kill"

/**
 * Code Puppy backend isolation extension.
 *
 * A zero-edit opencode server plugin. In the fork model this package is a NATIVE
 * workspace member, so `@opencode-ai/plugin` resolves via `workspace:*` with no
 * symlink hacks. It is loaded into the embedded server through
 * OPENCODE_CONFIG_CONTENT injected by ui-mac's sidecar — opencode's own files are
 * never touched.
 *
 * Contract (packages/plugin/src/index.ts):
 *   Plugin = (input: PluginInput, options?) => Promise<Hooks>
 */
export const AlphaExt: Plugin = async (input) => {
  // REQ-036 生效闭环,两段式(S18 X9 实测拍板):/instance/dispose 会**打断进行中的流式回复**
  // (实测:流中 dispose → assistant 消息 err 终止、0 字)。因此 alpha_reload 不立即 dispose,
  // 而是登记「待重载」,由 event 钩子在**登记会话 session.idle(回复完成)后**执行 —— 新建的
  // skill/agent/command 从下一条消息起可用,且不牺牲当前这条回复。
  //
  // codex 审计修复:① per-session Map(并发会话各自的承诺不被覆盖;任一登记会话 idle 即全局
  // dispose 一次、清空全表 —— dispose 本就是全局重扫);② 陈旧兜底:登记超 5 分钟后,任何会话的
  // idle 都可触发(登记会话 error/中断后承诺仍能兑现);③ dispose 失败保留待重试(下一次 idle),
  // 连败 3 次 loud 放弃(server log)。
  const pendingReloads = new Map<string, { reason: string; at: number }>()
  let reloadAttempts = 0
  const STALE_MS = 5 * 60 * 1000
  // REQ-062 T1:转写残留 warning 去重(每进程每签名一次)
  const rebrandWarned = new Set<string>()

  // sidecar 初始化批次先复验 main 派生 root 的 canonical 身份；缺失、相对、退休根或 alias 都拒绝。
  const globalAlphaRoot = requireAlphaGlobalRoot()
  const projectRootFor = (directory: string) => {
    const identity = projectDirectoryIdentity(directory)
    return identity.status === "project" ? identity : null
  }

  // #223 R7 Blocker:MCP 治理归属是**本实例**的状态,不是模块的。插件模块由 Bun 动态 import
  // **缓存**(一个引擎进程一份),而 Plugin / MCP 状态按 directory 建实例 —— 快照存在模块级变量上
  // 时,后跑的实例会覆盖先跑的:实例 B 记录一个 foreign `cloud_web` 后,实例 A 的 `cloud_web_search`
  // 立刻被误拒(跨项目串扰,回归见 cloud-websearch-kill.test.ts「跨实例隔离」)。因此归属只活在
  // 这个闭包里,由本实例的 config 钩子写、显式传给本实例的执行钩子,模块侧不留任何可变状态。
  let mcpOwnership: McpOwnership = UNVERIFIED_MCP_OWNERSHIP

  const ownHooks: Awaited<ReturnType<Plugin>> = {
    "tool.execute.before": async (hookInput, output) => {
      // #223 R3→R5:web search 主权判决在 **MCP 工具**一侧的最终闸,必须是本钩子的第一句 ——
      // 引擎在 `ctx.ask` 之前触发本钩子(普通 MCP 与 code-mode 两条路都是),抛出即终止调用,
      // 且完全不查 permission ruleset。命中面覆盖**任何** MCP server 上的 web search 形态
      // (含用户自己配置的 remote MCP,例如 `exa_web_search_exa`),alpha 治理的云 server 例外
      // 只在 kill-switch 下关 —— 「是不是治理云 server」按 config 钩子核验过的**端点身份**判,
      // 不是名字前缀(#223 R6),且核验结果取**本实例**的那一份(#223 R7)。理由、产品语义与
      // 边界见 cloud-websearch-kill.ts。
      assertWebSearchToolAllowed(hookInput.tool, process.env, mcpOwnership)
      validateCloudToolInput(hookInput.tool, output.args)
    },
    "tool.execute.after": async (hookInput, output) => {
      validateCloudToolOutput(hookInput.tool, output)
    },
    // REQ-060 项目级扩展物 `.code-puppy`-only:config hook 按 instance 读 `<directory>/.code-puppy/alpha.jsonc`
    // 并把项目级 mcp / agent / command / skills.paths 合并进 cfg —— 引擎经 config 消费,项目不产生
    // `.opencode`(零桥)。变异可见性由真机 spike 验(hook "Notify" 语义,T0 gate)。dispose 重建重
    // 触发 = 免重启。信任门(项目自带 mcp/plugin = 加载可执行物)= T1 后续,当前 spike 只验通道。
    async config(cfg) {
      // #223 R4→R5:ext 装载回执,必须是本钩子的**第一句** —— 下面的项目配置分支有多条 early
      // return(身份漂移 / 读失败),排在它们之后就会让「项目配置读不了」顺带把云工具一起关掉。
      // 本句能执行 = 插件已返回 hooks = 同一对象上的 `tool.execute.before` 闸已注册,于是注入面
      // 托管的云 MCP server 定义现在可以安全**装进配置**。R4 那版把定义先写成 `enabled:false`
      // 再由本句翻开 —— R5 判其为回归:`/mcp/:name/connect` 会无条件把它复制成 `enabled:true`。
      // 现在定义在 ext 确认之前根本不在配置里(理由见 cloud-websearch-kill.ts)。
      const installed = installCloudMcp(cfg)
      if (installed)
        console.log(
          `[@alpha-code/ext] cloud MCP server "${installed}" installed — the web search sovereignty gate is registered in this engine process`,
        )
      // REQ-138 #1075:把「引擎为工具派生的 shell」围进工作区 —— 紧接装载回执之后、任何项目配置
      // early return 之前,越界写入才无从静默得手(咽喉点与不变量见 shell-sandbox.ts)。云回执必须
      // 仍是第一句(#223,websearch-copies.test.ts 钉住),故本块置于其后而非其前。
      // fail-closed(I1):装不上时 cfg.shell 被顶成 deny stub / /usr/bin/false,绝不回落裸 shell。
      // globalAlphaRoot 在插件初始化时已 canonical 校验过(校验失败则整个插件根本不加载)。
      const fence = wrapEngineShell(cfg as { shell?: string }, globalAlphaRoot, process.env, {
        platform: process.platform,
        envShell: process.env.SHELL,
        statIsFile: (p) => {
          try {
            return statSync(p).isFile()
          } catch {
            return false
          }
        },
        which: (name) => whichSync(name, process.env.PATH),
        mkdirSync: (p) => void mkdirSync(p, { recursive: true }),
        writeFileSync: (p, data) => writeFileSync(p, data),
        chmodSync: (p, mode) => chmodSync(p, mode),
      })
      if (fence.fenced) {
        if (process.env.ALPHA_EXT_VERBOSE)
          console.log(
            `[@alpha-code/ext] engine shell fenced: cfg.shell=${fence.shell} real=${fence.realShell} profile=${fence.profile}`,
          )
      } else if (process.platform === "darwin") {
        // darwin 上没围成 = 已 fail-closed 到 deny stub。响亮记录:引擎会吞掉 config hook 的抛错,
        // 所以 I1 的「启动即失败可读」靠这条 loud log + deny stub 被调用时的可读拒绝共同兑现。
        console.error(
          `[@alpha-code/ext] engine shell sandbox FAILED to install (${fence.reason}) — cfg.shell forced to a deny stub (${fence.shell}); tool-derived shells will refuse to run rather than execute unfenced`,
        )
      }
      // #223 R7:归属在**本实例全部配置合并完成之后**才算 —— 下面的项目 alpha.jsonc 合并还会往
      // `cfg.mcp` 里加 server,先算就会漏掉它们(漏掉 foreign ⇒ 豁免可能错给)。放在 finally 里,
      // 上面那些 early return 也照样重算;合并中途**抛错**则 cfg 只合了一半,倒向 fail-closed。
      let merged = true
      try {
        const project = projectRootFor(input.directory)
        if (project) {
          const f = join(project.root, "alpha.jsonc")
          const present = withProjectDirectoryIdentity(project, (root) => existsSync(join(root, "alpha.jsonc")))
          if (!present.ok) {
            console.error(`[@alpha-code/ext] project config refused: ${present.reason}`)
            return
          }
          if (present.value) {
            // 信任门:项目自带 mcp(可执行连接器)只在项目已 consent 时加载。consent 落 `.code-puppy/prefs.json`
            // 的 extensionsConsent(版本化,ADR-021 模式);未 consent → mcp 被 gated,记 loud 供 renderer 弹窗。
            const trustExecutable = readProjectExtensionsConsent(project)
            if (trustExecutable === null) {
              console.error("[@alpha-code/ext] project config refused: project alpha root identity drifted")
              return
            }
            const configRead = withProjectDirectoryIdentity(project, (root) => readFileSync(join(root, "alpha.jsonc"), "utf8"))
            if (!configRead.ok) {
              console.error(`[@alpha-code/ext] project config refused: ${configRead.reason}`)
              return
            }
            const { added, gatedExecutable } = mergeProjectConfig(cfg as Record<string, unknown>, configRead.value, {
              trustExecutable,
              directory: project.directory,
            })
            if (gatedExecutable.length)
              console.log(
                `[@alpha-code/ext] project has UNTRUSTED executable extensions (${gatedExecutable.join(", ")}) — not loaded until consent: ${input.directory}`,
              )
            if (process.env.ALPHA_EXT_VERBOSE && added.length)
              console.log(`[@alpha-code/ext] project config merged from ${f}: ${added.join(", ")}`)
          }
        }
        // REQ-065 修订:出厂技能路径内存注入(main 经 env 传入;alpha.jsonc 只放用户自己的东西,
        // 磁盘零系统路径 —— 用户拍板 2026-07-08,对齐 Claude Code「内置能力不进用户配置」心智)。
        const factoryAdded = injectFactorySkillPaths(cfg as Record<string, unknown>, process.env.ALPHA_FACTORY_SKILL_DIRS)
        if (process.env.ALPHA_EXT_VERBOSE && factoryAdded.length)
          console.log(`[@alpha-code/ext] factory skill paths injected in-memory: ${factoryAdded.length}`)
        // REQ-100 #310:把 skill generation 的 live 目录(ext-store/skill--*/current.json)投影进
        // skills.paths —— 从磁盘现读,每次 config 重建反映最新安装,current.json 是唯一原子真源。
        const genAdded = injectSkillGenerationPaths(cfg as Record<string, unknown>, globalAlphaRoot)
        if (process.env.ALPHA_EXT_VERBOSE && genAdded.length)
          console.log(`[@alpha-code/ext] skill generation paths injected in-memory: ${genAdded.length}`)
        // REQ-067:上游默认禁项零明文 —— main 算 effective(出厂清单 − 用户解禁)经 env 传入,内存注入
        // permission.skill deny + 键入兜底占位(同为「出厂内置行为不进用户配置」口径)。
        const denied = applyFactoryDeny(cfg as Record<string, unknown>, process.env.ALPHA_FACTORY_DENY_SKILLS)
        if (process.env.ALPHA_EXT_VERBOSE && denied.length)
          console.log(`[@alpha-code/ext] factory-denied skills injected in-memory: ${denied.join(", ")}`)
        // REQ-062 T3/T6:alpha 内容层 set-if-absent 接管(/init /review 模板 + general/explore prompt)。
        // 置于项目 merge 之后 → 项目/全局/治理任何层的同名配置都先落位、alpha 出厂让位(优先级:
        // 用户治理 > alpha 出厂 > 上游内置)。与 T1 转写同一逃生门 = 路线A 一键整体回退。
        if (process.env.ALPHA_PROMPT_REBRAND_DISABLE !== "1") {
          const takeover = applyPromptTakeover(cfg as Record<string, unknown>)
          if (process.env.ALPHA_EXT_VERBOSE && takeover.applied.length)
            console.log(`[@alpha-code/ext] prompt takeover applied: ${takeover.applied.join(", ")}`)
        }
      } catch (error) {
        merged = false
        console.error(`[@alpha-code/ext] project config hook failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        // #223 R6 Blocker:治理豁免绑定的是**端点身份**,不是名字前缀 —— 拿本实例已合并完成的 cfg
        // 核验「哪个 server 名真的是 alpha 那份定义」。#223 R7 Blocker:结果写进**本实例的闭包**,
        // 不是模块级变量,否则并存的另一个项目实例会覆盖它。核不上(或这一句没跑到)就没有任何
        // server 拿得到豁免 —— fail-closed。
        mcpOwnership = merged ? computeMcpOwnership(cfg) : UNVERIFIED_MCP_OWNERSHIP
        if (process.env.ALPHA_EXT_VERBOSE)
          console.log(`[@alpha-code/ext] MCP ownership (${input.directory}): ${JSON.stringify(mcpOwnership)}`)
      }
    },
    // REQ-062 T1(路线A):系统提示词品牌转写 —— 精选子串对(见 prompt-rebrand.ts 纪律说明)。
    // experimental hook(NON_GOALS#4 标注,ADR-015 修订成文):签名漂移/失效最坏退化 = 品牌未转写
    // (外观级,不伤功能);逃生 ALPHA_PROMPT_REBRAND_DISABLE=1。warning 每进程每签名一次(防刷屏)。
    "experimental.chat.system.transform": async (_input, output) => {
      if (process.env.ALPHA_PROMPT_REBRAND_DISABLE === "1") return
      try {
        const r = rebrandSystem(output.system)
        if (r.changed) {
          output.system.length = 0
          output.system.push(...r.system)
        }
        for (const w of r.warnings) {
          if (rebrandWarned.has(w)) continue
          rebrandWarned.add(w)
          console.warn(`[@alpha-code/ext] prompt-rebrand: ${w}`)
        }
      } catch (error) {
        // 转写失败 = 保底上游原样(外观级退化),绝不让 hook 异常伤及请求主链
        console.error(`[@alpha-code/ext] prompt-rebrand failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    // tool map: key === final tool id verbatim (no namespace prefix).
    tool: {
      alpha_reload: tool({
        description:
          "Schedule a reload of the opencode engine's extension registry (skills / agents / commands / plugins) without restarting the app. Call this after creating or editing a skill or agent on disk. The reload runs right after the current reply finishes (an immediate reload would cut this reply off), so the new skill/agent is available from the NEXT message in this session.",
        args: {
          reason: tool.schema.string().describe("What was created/changed (for the tool log)").default(""),
        },
        async execute(args, ctx) {
          pendingReloads.set(ctx.sessionID ?? "", { reason: args.reason, at: Date.now() })
          return {
            title: "alpha_reload",
            output:
              "reload scheduled — it runs as soon as this reply completes; newly created skills/agents/commands are available from the NEXT message in this session." +
              (args.reason ? `\nreason: ${args.reason}` : ""),
            metadata: { ok: true, scheduled: true, directory: ctx.directory, sessionID: ctx.sessionID },
          }
        },
      }),
      alpha_register: tool({
        description:
          "Register a project-scoped extension entry into <project>/.code-puppy/alpha.jsonc (the ONLY alpha directory in a project — never create .opencode). " +
          "Use type=agent|command with an entry object (agent: {description,prompt,mode,...}; command: {template,description,...}); " +
          "type=mcp with the connector config (loading executable connectors additionally requires the user's per-project consent dialog); " +
          "type=skill takes no entry — it registers the ./.code-puppy/skills path; write the skill itself to .code-puppy/skills/<name>/SKILL.md. " +
          "Plugins are NOT registered here: drop a self-contained ESM .js into .code-puppy/plugins/ (raw TypeScript is rejected). " +
          "The change is validated, written atomically, and auto-reloaded after this reply finishes (available from the NEXT message).",
        args: {
          type: tool.schema.enum(["mcp", "agent", "command", "skill"]).describe("Extension kind to register"),
          name: tool.schema.string().describe("Entry name (letters/digits/._- , max 64 chars); ignored for type=skill").default(""),
          entry: tool.schema
            .string()
            .describe("The entry as a JSON object string, e.g. {\"description\":\"...\",\"prompt\":\"...\"}; empty for type=skill")
            .default(""),
        },
        async execute(args, ctx) {
          const project = projectRootFor(ctx.directory)
          if (!project)
            return {
              title: "alpha_register",
              output: "refused: the session directory identity cannot be confirmed as a project. Global installs go through the Extension Hub.",
              metadata: { ok: false },
            }
          let entry: Record<string, unknown> | undefined
          if (args.entry.trim()) {
            try {
              const parsed: unknown = JSON.parse(args.entry)
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
              entry = parsed as Record<string, unknown>
            } catch {
              return { title: "alpha_register", output: "refused: entry is not a valid JSON object string", metadata: { ok: false } }
            }
          }
          const present = withProjectDirectoryIdentity(project, (root) => existsSync(join(root, "alpha.jsonc")))
          if (!present.ok)
            return { title: "alpha_register", output: `refused: ${present.reason}`, metadata: { ok: false } }
          const currentRead = present.value
            ? withProjectDirectoryIdentity(project, (root) => readFileSync(join(root, "alpha.jsonc"), "utf8"))
            : { ok: true as const, value: null }
          if (!currentRead.ok)
            return { title: "alpha_register", output: `refused: ${currentRead.reason}`, metadata: { ok: false } }
          const current = currentRead.value
          const r = applyRegister(current, args.type as RegisterType, args.name, entry)
          if (!r.ok) return { title: "alpha_register", output: `refused: ${r.reason}`, metadata: { ok: false } }
          const trusted = args.type === "mcp" ? readProjectExtensionsConsent(project) : true
          if (trusted === null)
            return { title: "alpha_register", output: "refused: project alpha root identity drifted", metadata: { ok: false } }
          try {
            const created = withProjectDirectoryIdentity(project, (root) => mkdirSync(root, { recursive: true }))
            if (!created.ok)
              return { title: "alpha_register", output: `refused: ${created.reason}`, metadata: { ok: false } }
            const written = withProjectDirectoryIdentity(project, (root) =>
              writeFileSync(join(root, "alpha.jsonc.tmp"), r.next),
            )
            if (!written.ok)
              return { title: "alpha_register", output: `refused: ${written.reason}`, metadata: { ok: false } }
            const committed = withProjectDirectoryIdentity(project, (root) =>
              renameSync(join(root, "alpha.jsonc.tmp"), join(root, "alpha.jsonc")),
            )
            if (!committed.ok)
              return { title: "alpha_register", output: `refused: ${committed.reason}`, metadata: { ok: false } }
          } catch (error) {
            return {
              title: "alpha_register",
              output: `write failed: ${error instanceof Error ? error.message : String(error)}`,
              metadata: { ok: false },
            }
          }
          pendingReloads.set(ctx.sessionID ?? "", { reason: `alpha_register ${args.type} ${args.name}`.trim(), at: Date.now() })
          const consentNote =
            args.type === "mcp" && !trusted
              ? "\nnote: this project has not yet been granted permission to load executable extensions — the connector stays gated until the user confirms the trust dialog (it appears when the project session is opened)."
              : ""
          return {
            title: "alpha_register",
            output: `${r.summary}\nreload scheduled — available from the NEXT message.${consentNote}`,
            metadata: { ok: true, type: args.type, name: args.name, directory: ctx.directory },
          }
        },
      }),
      alpha_echo: tool({
        description:
          "Echo back the provided text. Proof that a Code Puppy plugin-registered tool is available with zero opencode source edits.",
        args: {
          text: tool.schema.string().describe("The text to echo back"),
          shout: tool.schema.boolean().describe("Uppercase the echoed text").default(false),
        },
        async execute(args, ctx) {
          const echoed = args.shout ? args.text.toUpperCase() : args.text
          return {
            title: "alpha_echo",
            output: `alpha_echo: ${echoed}`,
            metadata: { sessionID: ctx.sessionID, directory: ctx.directory, shout: args.shout },
          }
        },
      }),
      alpha_ping: tool({
        description:
          "Health-check tool: returns 'pong' plus the session directory. Proof that the Code Puppy extension is loaded.",
        args: {
          note: tool.schema.string().describe("Optional note echoed back with the pong").default(""),
        },
        async execute(args, ctx) {
          const suffix = args.note ? ` (${args.note})` : ""
          return {
            title: "alpha_ping",
            output: `pong${suffix}\ndirectory: ${ctx.directory}\nworktree: ${ctx.worktree}`,
            metadata: { directory: ctx.directory, worktree: ctx.worktree },
          }
        },
      }),
    },
    // event hook: ① alpha_reload 两段式的执行端 —— 登记会话 idle(或存在陈旧登记时任意 idle)才
    // dispose,防止打断进行中的流(X9);② liveness proof(ALPHA_EXT_VERBOSE 时打印事件)。
    async event({ event }) {
      if (process.env.ALPHA_EXT_VERBOSE) console.log(`[@alpha-code/ext] event: ${event.type}`)
      if (pendingReloads.size === 0 || event.type !== "session.idle") return
      const sid = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      const now = Date.now()
      const hasStale = [...pendingReloads.values()].some((p) => now - p.at > STALE_MS)
      // 触发条件:idle 的正是某个登记会话(其回复已完成,dispose 不再伤及它),或存在陈旧登记
      // (登记会话可能已 error/被弃,由任意会话的安全 idle 点兜底兑现)。
      if (!(sid && pendingReloads.has(sid)) && !hasStale) return
      const reasons = [...pendingReloads.values()].map((p) => p.reason).filter(Boolean)
      try {
        await input.client.instance.dispose()
        pendingReloads.clear()
        reloadAttempts = 0
        console.log(`[@alpha-code/ext] alpha_reload executed after idle${reasons.length ? ` (${reasons.join("; ")})` : ""}`)
      } catch (error) {
        // 保留登记,下一次 idle 重试;连败 3 次 loud 放弃(诚实降级:重启后生效)。
        reloadAttempts += 1
        const msg = error instanceof Error ? error.message : String(error)
        if (reloadAttempts >= 3) {
          pendingReloads.clear()
          reloadAttempts = 0
          console.error(`[@alpha-code/ext] alpha_reload dispose FAILED 3x — giving up; new skills/agents appear after app restart: ${msg}`)
        } else {
          console.error(`[@alpha-code/ext] alpha_reload dispose failed (attempt ${reloadAttempts}/3, will retry on next idle): ${msg}`)
        }
      }
    },
  }

  // REQ-060 plugin host fan-out:加载项目 `.code-puppy/plugins/*.js`(信任门:未 consent 不加载可执行物)
  // 并与 ownHooks 合并 return —— 项目插件的 hook 经引擎照常派发,项目零 `.opencode`/零 config.plugin[]。
  const project = projectRootFor(input.directory)
  const consent = project ? readProjectExtensionsConsent(project) : false
  if (consent === null) {
    console.error("[@alpha-code/ext] project plugin fan-out refused: project alpha root identity drifted")
    return ownHooks
  }
  const projectHooks = await loadProjectPlugins(project?.root ?? "", input, consent, {
    verifyIdentity: () => !!project && withProjectDirectoryIdentity(project, () => true).ok,
    existsSync,
    readdirSync,
    importModule: (u) => import(u),
    pathToFileURL: (p) => pathToFileURL(p).href,
    join,
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  })
  return (projectHooks.length ? mergeHooks(ownHooks as Record<string, unknown>, projectHooks) : ownHooks) as Awaited<
    ReturnType<Plugin>
  >
}

/** 项目扩展信任门 consent:`<dir>/.code-puppy/prefs.json` 的 `extensionsConsent.granted === true`(版本化,
 *  ADR-021 模式)。缺失/坏/未授 = 不信任(默认拒绝可执行物,安全红线)。 */
function readProjectExtensionsConsent(
  project: Extract<ReturnType<typeof projectDirectoryIdentity>, { status: "project" }>,
): boolean | null {
  const present = withProjectDirectoryIdentity(project, (root) => existsSync(join(root, "prefs.json")))
  if (!present.ok) return null
  if (!present.value) return false
  try {
    const read = withProjectDirectoryIdentity(project, (root) => readFileSync(join(root, "prefs.json"), "utf8"))
    if (!read.ok) return null
    const prefs = JSON.parse(read.value) as { extensionsConsent?: { granted?: unknown } }
    return prefs?.extensionsConsent?.granted === true
  } catch {
    return false
  }
}

/** REQ-138:裸名字 shell 的 PATH 解析(= `@opencode-ai/core` `which` 的常见路径,不引入 npm `which`
 *  依赖)。含斜杠的名字直接当路径判存在;返回第一个存在的普通文件。找不到返回 undefined。 */
function whichSync(name: string, pathEnv: string | undefined): string | undefined {
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (name.includes("/")) return isFile(name) ? name : undefined
  const dirs = (pathEnv ?? "").split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

export default AlphaExt
