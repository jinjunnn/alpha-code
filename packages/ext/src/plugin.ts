import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { isGlobalAlphaDir, mergeProjectConfig } from "./project-config"
import { loadProjectPlugins, mergeHooks } from "./plugin-fanout"
import { applyRegister, type RegisterType } from "./register"
import { applyPromptTakeover } from "./alpha-prompts"
import { injectFactorySkillPaths } from "./factory-paths"
import { rebrandSystem } from "./prompt-rebrand"

/**
 * alpha-code backend isolation extension.
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

  // REQ-060 边界:home 目录实例(`<dir>/.alpha` == 全局 `~/.alpha`)不走项目级通道 —— 全局 alpha.jsonc
  // 已经 G1(OPENCODE_CONFIG)注入,再当项目配置读会把全局 mcp 误 gated,且 ~/.alpha/plugins 有双载风险。
  const globalAlphaRoot = process.env.ALPHA_GLOBAL_DIR?.trim() || join(homedir(), ".alpha")
  const projectScoped = !isGlobalAlphaDir(input.directory, globalAlphaRoot)

  const ownHooks: Awaited<ReturnType<Plugin>> = {
    // REQ-060 项目级扩展物 `.alpha`-only:config hook 按 instance 读 `<directory>/.alpha/alpha.jsonc`
    // 并把项目级 mcp / agent / command / skills.paths 合并进 cfg —— 引擎经 config 消费,项目不产生
    // `.opencode`(零桥)。变异可见性由真机 spike 验(hook "Notify" 语义,T0 gate)。dispose 重建重
    // 触发 = 免重启。信任门(项目自带 mcp/plugin = 加载可执行物)= T1 后续,当前 spike 只验通道。
    async config(cfg) {
      try {
        if (projectScoped) {
          const f = join(input.directory, ".alpha", "alpha.jsonc")
          if (existsSync(f)) {
            // 信任门:项目自带 mcp(可执行连接器)只在项目已 consent 时加载。consent 落 `.alpha/prefs.json`
            // 的 extensionsConsent(版本化,ADR-021 模式);未 consent → mcp 被 gated,记 loud 供 renderer 弹窗。
            const trustExecutable = readProjectExtensionsConsent(input.directory)
            const { added, gatedExecutable } = mergeProjectConfig(cfg as Record<string, unknown>, readFileSync(f, "utf8"), {
              trustExecutable,
              directory: input.directory,
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
        // REQ-062 T3/T6:alpha 内容层 set-if-absent 接管(/init /review 模板 + general/explore prompt)。
        // 置于项目 merge 之后 → 项目/全局/治理任何层的同名配置都先落位、alpha 出厂让位(优先级:
        // 用户治理 > alpha 出厂 > 上游内置)。与 T1 转写同一逃生门 = 路线A 一键整体回退。
        if (process.env.ALPHA_PROMPT_REBRAND_DISABLE !== "1") {
          const takeover = applyPromptTakeover(cfg as Record<string, unknown>)
          if (process.env.ALPHA_EXT_VERBOSE && takeover.applied.length)
            console.log(`[@alpha-code/ext] prompt takeover applied: ${takeover.applied.join(", ")}`)
        }
      } catch (error) {
        console.error(`[@alpha-code/ext] project config hook failed: ${error instanceof Error ? error.message : String(error)}`)
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
          "Register a project-scoped extension entry into <project>/.alpha/alpha.jsonc (the ONLY alpha directory in a project — never create .opencode). " +
          "Use type=agent|command with an entry object (agent: {description,prompt,mode,...}; command: {template,description,...}); " +
          "type=mcp with the connector config (loading executable connectors additionally requires the user's per-project consent dialog); " +
          "type=skill takes no entry — it registers the ./.alpha/skills path; write the skill itself to .alpha/skills/<name>/SKILL.md. " +
          "Plugins are NOT registered here: drop a self-contained ESM .js into .alpha/plugins/ (raw TypeScript is rejected). " +
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
          if (isGlobalAlphaDir(ctx.directory, globalAlphaRoot))
            return {
              title: "alpha_register",
              output: "refused: this session runs in the home directory — project-scoped registration needs a project. Global installs go through the Extension Hub.",
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
          const alphaDir = join(ctx.directory, ".alpha")
          const file = join(alphaDir, "alpha.jsonc")
          const current = existsSync(file) ? readFileSync(file, "utf8") : null
          const r = applyRegister(current, args.type as RegisterType, args.name, entry)
          if (!r.ok) return { title: "alpha_register", output: `refused: ${r.reason}`, metadata: { ok: false } }
          try {
            mkdirSync(alphaDir, { recursive: true })
            const tmp = file + ".tmp"
            writeFileSync(tmp, r.next)
            renameSync(tmp, file)
          } catch (error) {
            return {
              title: "alpha_register",
              output: `write failed: ${error instanceof Error ? error.message : String(error)}`,
              metadata: { ok: false },
            }
          }
          pendingReloads.set(ctx.sessionID ?? "", { reason: `alpha_register ${args.type} ${args.name}`.trim(), at: Date.now() })
          const consentNote =
            args.type === "mcp" && !readProjectExtensionsConsent(ctx.directory)
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
          "Echo back the provided text. Proof that an alpha-code plugin-registered tool is available with zero opencode source edits.",
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
          "Health-check tool: returns 'pong' plus the session directory. Proof that the alpha-code extension is loaded.",
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

  // REQ-060 plugin host fan-out:加载项目 `.alpha/plugins/*.js`(信任门:未 consent 不加载可执行物)
  // 并与 ownHooks 合并 return —— 项目插件的 hook 经引擎照常派发,项目零 `.opencode`/零 config.plugin[]。
  const trusted = projectScoped && readProjectExtensionsConsent(input.directory)
  const projectHooks = await loadProjectPlugins(input.directory, input, trusted, {
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

/** 项目扩展信任门 consent:`<dir>/.alpha/prefs.json` 的 `extensionsConsent.granted === true`(版本化,
 *  ADR-021 模式)。缺失/坏/未授 = 不信任(默认拒绝可执行物,安全红线)。 */
function readProjectExtensionsConsent(dir: string): boolean {
  try {
    const p = join(dir, ".alpha", "prefs.json")
    if (!existsSync(p)) return false
    const prefs = JSON.parse(readFileSync(p, "utf8")) as { extensionsConsent?: { granted?: unknown } }
    return prefs?.extensionsConsent?.granted === true
  } catch {
    return false
  }
}

export default AlphaExt
