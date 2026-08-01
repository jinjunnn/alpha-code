// BuiltinControlsPanel — 定制中心「已安装」内的「内置(上游)」治理分组(REQ-037,即 REQ-019 递延的 V2
// 内置管理位)。列原生 agent / 内置 skill / 内置 command,逐项 隐藏·禁用·重写;保护项灰显并说明
// 原因(C28 诚实控件);denylist/allowlist 可切;「重置治理」全量净除。
//
// 数据流:extIpc.builtinRead/builtinApply/builtinReset(main 校验+物化 home jsonc 受控叶子)→
// props.refreshEngine()(POST /global/dispose)→ 下一条消息热生效 → props.reloadAgents() 刷新列表。
// 泄漏诚实声明:skill deny 后引擎 GET /skill 与斜杠菜单仍会列出该技能(上游行为),但执行被拒 +
// 斜杠命中的是 alpha 占位模板 —— 面板文案如实说明,不谎称彻底移除。

import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { AlphaBuiltinPolicy } from "../../preload/types"
import type { HubAgent } from "./use-extensions"
import { t } from "../i18n"
import { extIpc } from "./ext-ipc"

/** 引擎内置 skill / command(REQ-037 机制核实面;上游冻结,变更随 sync retro 复核)。 */
const BUILTIN_SKILLS = ["customize-opencode"]
const BUILTIN_COMMANDS = ["init", "review"]
/** REQ-067:出厂默认禁项(与 main alpha-governance.FACTORY_DENIED_SKILLS 同名单;开关走解禁语义)。 */
const FACTORY_DENIED_SKILLS = ["customize-opencode"]

const DEFAULT_GOV: AlphaBuiltinPolicy = {
  version: 1,
  mode: "denylist",
  agents: { hide: [], disable: [], allow: [], override: {} },
  skills: { deny: [], allowFactory: [] },
  commands: { override: {} },
}

export function BuiltinControlsPanel(props: {
  agents: HubAgent[]
  refreshEngine: () => Promise<boolean>
  reloadAgents: () => Promise<void>
  flash: (msg: string, kind?: "success" | "error") => void
}) {
  const [gov, setGov] = createSignal(structuredClone(DEFAULT_GOV))
  const [protection, setProtection] = createSignal<{ hard: string[]; alphaInjected: string[]; confirm: string[] }>({ hard: [], alphaInjected: [], confirm: [] })
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal("")
  const [cmdEdit, setCmdEdit] = createSignal<{ name: string; template: string } | null>(null)
  const [agentEdit, setAgentEdit] = createSignal<{ name: string; prompt: string } | null>(null)

  onMount(() => {
    void extIpc.builtinRead().then((r) => {
      setGov(r.gov)
      setProtection(r.protection)
    }).catch(() => {
      // load failed → keep the empty DEFAULT_GOV but say so, or the user might apply over real config
      setErr(t("alpha.builtin.loadFailed"))
    })
  })

  // 面板列出的 agent = 引擎可见原生 agent ∪ 治理中已隐藏/禁用的名字(否则藏了就找不回)
  const agentNames = createMemo(() => {
    const names = new Set<string>()
    for (const a of props.agents) if (a.native !== false) names.add(a.name)
    for (const n of gov().agents.hide) names.add(n)
    for (const n of gov().agents.disable) names.add(n)
    return [...names].sort()
  })
  const visibleAgentNames = createMemo(() => props.agents.map((a) => a.name))

  const protectedReason = (name: string): string | null => {
    const p = protection()
    if (p.hard.includes(name)) return t("alpha.builtin.protHard")
    if (p.alphaInjected.includes(name)) return t("alpha.builtin.protAlpha")
    return null
  }

  const apply = async (next: AlphaBuiltinPolicy, confirmBuild = false) => {
    if (busy()) return // codex M2:硬闸 —— 全量快照式 apply 并发会互相覆盖(last-write-wins 丢改动)
    setBusy(true)
    setErr("")
    try {
      const r = await extIpc.builtinApply(next, visibleAgentNames(), confirmBuild)
      if (!r.ok) {
        setErr(r.reason ?? "apply failed")
        props.flash(r.reason ?? t("alpha.builtin.applyFailed"), "error")
        return
      }
      setGov(next)
      const refreshed = await props.refreshEngine()
      void props.reloadAgents()
      props.flash(refreshed ? t("alpha.builtin.applied") : t("alpha.builtin.appliedPendingReload"), "success")
    } catch {
      // builtinApply threw (IPC/main error) — callers do `void apply(...)`, so without this catch the
      // rejection is silent: busy clears but nothing changed and no feedback (silent-failure class).
      setErr(t("alpha.builtin.applyFailed"))
      props.flash(t("alpha.builtin.applyFailed"), "error")
    } finally {
      setBusy(false)
    }
  }

  const toggle = (list: "hide" | "disable", name: string) => {
    const g = structuredClone(gov())
    const arr = g.agents[list]
    const i = arr.indexOf(name)
    if (i >= 0) arr.splice(i, 1)
    else arr.push(name)
    const needConfirm = list === "disable" && arr.includes(name) && protection().confirm.includes(name)
    if (needConfirm && !window.confirm(t("alpha.builtin.buildConfirm"))) return
    void apply(g, needConfirm)
  }
  const toggleAllow = (name: string) => {
    const g = structuredClone(gov())
    const i = g.agents.allow.indexOf(name)
    if (i >= 0) g.agents.allow.splice(i, 1)
    else g.agents.allow.push(name)
    void apply(g)
  }
  const toggleSkillDeny = (name: string) => {
    const g = structuredClone(gov())
    // REQ-067:出厂默认禁项的开关操作的是「解禁名单」(allowFactory),不写 deny 明文 ——
    // 出厂禁是内置行为(env → 引擎内存注入),用户配置里只记录用户的解禁动作。
    if (FACTORY_DENIED_SKILLS.includes(name)) {
      g.skills.allowFactory ??= []
      const i = g.skills.allowFactory.indexOf(name)
      if (i >= 0) g.skills.allowFactory.splice(i, 1)
      else g.skills.allowFactory.push(name)
    } else {
      const i = g.skills.deny.indexOf(name)
      if (i >= 0) g.skills.deny.splice(i, 1)
      else g.skills.deny.push(name)
    }
    void apply(g)
  }
  const saveCmdOverride = () => {
    const e = cmdEdit()
    if (!e) return
    const g = structuredClone(gov())
    if (e.template.trim()) g.commands.override[e.name] = { template: e.template }
    else delete g.commands.override[e.name]
    setCmdEdit(null)
    void apply(g)
  }
  const saveAgentOverride = () => {
    const e = agentEdit()
    if (!e) return
    const g = structuredClone(gov())
    if (e.prompt.trim()) g.agents.override[e.name] = { ...(g.agents.override[e.name] ?? {}), prompt: e.prompt }
    else {
      const o = { ...(g.agents.override[e.name] ?? {}) }
      delete o.prompt
      if (Object.keys(o).length) g.agents.override[e.name] = o
      else delete g.agents.override[e.name]
    }
    setAgentEdit(null)
    void apply(g)
  }
  const switchMode = (mode: "denylist" | "allowlist") => {
    if (gov().mode === mode) return
    const g = structuredClone(gov())
    g.mode = mode
    if (mode === "allowlist" && g.agents.allow.length === 0) g.agents.allow = visibleAgentNames() // 起步 = 现状全允许,避免一键全隐
    void apply(g)
  }
  const reset = async () => {
    if (!window.confirm(t("alpha.builtin.resetConfirm"))) return
    setBusy(true)
    try {
      const r = await extIpc.builtinReset()
      if (!r.ok) {
        setErr(r.reason ?? "reset failed")
        return
      }
      setGov(structuredClone(DEFAULT_GOV))
      await props.refreshEngine()
      void props.reloadAgents()
      props.flash(t("alpha.builtin.resetDone"), "success")
    } finally {
      setBusy(false)
    }
  }

  const g = gov
  return (
    <div class="alpha-gov">
      <div class="alpha-ext-callout">
        {t("alpha.builtin.note")}
        <span class="alpha-gov-mode">
          <button data-on={g().mode === "denylist" ? "" : undefined} disabled={busy()} onClick={() => switchMode("denylist")}>
            {t("alpha.builtin.denylist")}
          </button>
          <button data-on={g().mode === "allowlist" ? "" : undefined} disabled={busy()} onClick={() => switchMode("allowlist")}>
            {t("alpha.builtin.allowlist")}
          </button>
        </span>
        <button class="alpha-ext-inline-cta" disabled={busy()} onClick={() => void reset()}>
          {t("alpha.builtin.reset")}
        </button>
      </div>
      <Show when={err()}>
        <p class="alpha-ext-import-err">{err()}</p>
      </Show>

      {/* agents */}
      <div class="alpha-ext-manage">
        <For each={agentNames()}>
          {(name) => {
            const prot = () => protectedReason(name)
            const hidden = () => g().agents.hide.includes(name)
            const disabled = () => g().agents.disable.includes(name)
            const overridden = () => !!g().agents.override[name]?.prompt
            const allowed = () => g().agents.allow.includes(name)
            return (
              <div class="alpha-ext-man" data-gov-dim={disabled() || hidden() ? "" : undefined}>
                <span class="alpha-ext-man-name">
                  {name}
                  <span class="alpha-ext-chip">agent</span>
                  <Show when={hidden()}>
                    <span class="alpha-ext-chip" data-warn="">{t("alpha.builtin.stateHidden")}</span>
                  </Show>
                  <Show when={disabled()}>
                    <span class="alpha-ext-chip" data-warn="">{t("alpha.builtin.stateDisabled")}</span>
                  </Show>
                  <Show when={overridden()}>
                    <span class="alpha-ext-chip">{t("alpha.builtin.stateOverridden")}</span>
                  </Show>
                </span>
                <Show
                  when={!prot()}
                  fallback={<span class="alpha-gov-prot" title={prot() ?? undefined}>{t("alpha.builtin.protected")}</span>}
                >
                  <span class="alpha-gov-acts">
                    <Show when={g().mode === "allowlist"}>
                      <button disabled={busy()} onClick={() => toggleAllow(name)}>
                        {allowed() ? t("alpha.builtin.inAllow") : t("alpha.builtin.notInAllow")}
                      </button>
                    </Show>
                    <button disabled={busy()} onClick={() => toggle("hide", name)}>
                      {hidden() ? t("alpha.builtin.unhide") : t("alpha.builtin.hide")}
                    </button>
                    <button disabled={busy()} onClick={() => toggle("disable", name)}>
                      {disabled() ? t("alpha.builtin.enable") : t("alpha.builtin.disable")}
                    </button>
                    <button
                      disabled={busy()}
                      onClick={() => setAgentEdit({ name, prompt: String(g().agents.override[name]?.prompt ?? "") })}
                    >
                      {t("alpha.builtin.override")}
                    </button>
                  </span>
                </Show>
              </div>
            )
          }}
        </For>

        {/* builtin skills(出厂默认禁项:denied = 未被解禁;REQ-067) */}
        <For each={BUILTIN_SKILLS}>
          {(name) => {
            const denied = () =>
              FACTORY_DENIED_SKILLS.includes(name)
                ? !(g().skills.allowFactory ?? []).includes(name)
                : g().skills.deny.includes(name)
            return (
              <div class="alpha-ext-man" data-gov-dim={denied() ? "" : undefined}>
                <span class="alpha-ext-man-name">
                  {name}
                  <span class="alpha-ext-chip">skill</span>
                  <Show when={denied()}>
                    <span class="alpha-ext-chip" data-warn="">{t("alpha.builtin.stateDenied")}</span>
                  </Show>
                </span>
                <span class="alpha-gov-acts">
                  <button disabled={busy()} onClick={() => toggleSkillDeny(name)} title={t("alpha.builtin.skillLeakNote")}>
                    {denied() ? t("alpha.builtin.allow") : t("alpha.builtin.deny")}
                  </button>
                </span>
              </div>
            )
          }}
        </For>

        {/* builtin commands */}
        <For each={BUILTIN_COMMANDS}>
          {(name) => {
            const overridden = () => !!g().commands.override[name]
            return (
              <div class="alpha-ext-man">
                <span class="alpha-ext-man-name">
                  /{name}
                  <span class="alpha-ext-chip">command</span>
                  <Show when={overridden()}>
                    <span class="alpha-ext-chip">{t("alpha.builtin.stateOverridden")}</span>
                  </Show>
                </span>
                <span class="alpha-gov-acts">
                  <button
                    disabled={busy()}
                    onClick={() => setCmdEdit({ name, template: g().commands.override[name]?.template ?? "" })}
                    title={t("alpha.builtin.cmdNote")}
                  >
                    {overridden() ? t("alpha.builtin.editOverride") : t("alpha.builtin.override")}
                  </button>
                </span>
              </div>
            )
          }}
        </For>
      </div>

      {/* command 重写编辑器(极简:模板 textarea;空 = 恢复上游) */}
      <Show when={cmdEdit()}>
        {(e) => (
          <div class="alpha-gov-editor">
            <div class="alpha-ext-flabel">/{e().name} {t("alpha.builtin.cmdTemplate")}</div>
            <textarea
              class="alpha-ext-input alpha-ext-textarea alpha-mono"
              value={e().template}
              onInput={(ev) => setCmdEdit({ ...e(), template: ev.currentTarget.value })}
              placeholder={t("alpha.builtin.cmdPlaceholder")}
            />
            <div class="alpha-gov-acts">
              <button class="alpha-ext-add" data-variant="primary" disabled={busy()} onClick={saveCmdOverride}>
                {t("alpha.builtin.save")}
              </button>
              <button class="alpha-ext-add" onClick={() => setCmdEdit(null)}>{t("alpha.builtin.cancel")}</button>
            </div>
          </div>
        )}
      </Show>
      <Show when={agentEdit()}>
        {(e) => (
          <div class="alpha-gov-editor">
            <div class="alpha-ext-flabel">{e().name} {t("alpha.builtin.agentPrompt")}</div>
            <textarea
              class="alpha-ext-input alpha-ext-textarea alpha-mono"
              value={e().prompt}
              onInput={(ev) => setAgentEdit({ ...e(), prompt: ev.currentTarget.value })}
              placeholder={t("alpha.builtin.agentPromptPlaceholder")}
            />
            <div class="alpha-gov-acts">
              <button class="alpha-ext-add" data-variant="primary" disabled={busy()} onClick={saveAgentOverride}>
                {t("alpha.builtin.save")}
              </button>
              <button class="alpha-ext-add" onClick={() => setAgentEdit(null)}>{t("alpha.builtin.cancel")}</button>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
