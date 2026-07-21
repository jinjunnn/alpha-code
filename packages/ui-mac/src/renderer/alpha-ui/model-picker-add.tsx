// AddProvider — the "添加自定义节点 / 供应商" two-step flow, rendered as an overlay over the model
// picker popover (ADR-016: alpha owns this UI). Step 1: pick a known provider (filled from the catalog
// — user only pastes a Key) or "其他/自定义" (manual model ids). Step 2: configure + 测试连接 (1-token
// chat) + 保存. Save → preset keys go to alpha's encrypted keychain (providers.setKey); custom endpoints
// persist to alpha.jsonc (providers.add), then that IPC awaits the shared sidecar respawn so the new
// provider enters enabled_providers before the picker refreshes the real model.list. Config-driven.

import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import type { AlphaModelCatalog, ByokProvider, ProviderKeyStatus } from "../../shared/alpha-model-types"
import { t } from "../i18n"

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "custom"
  )
}

export function AddProvider(props: {
  catalog: AlphaModelCatalog | null
  onClose: () => void
  onSaved?: () => void
  /** When set, open straight into this provider's config form (e.g. clicking a 需 Key BYOK row). */
  initialId?: string
  /** Per-provider key state (drives 已配置 / 替换 / 移除 for a provider that already has a key). */
  keyStatus?: ProviderKeyStatus
}) {
  const [sel, setSel] = createSignal<ByokProvider | "custom" | null>(null) // null = step 1 (preset list)
  const [name, setName] = createSignal("")
  const [compat, setCompat] = createSignal<"openai" | "anthropic">("openai")
  const [baseURL, setBaseURL] = createSignal("")
  const [apiKey, setApiKey] = createSignal("")
  const [showKey, setShowKey] = createSignal(false)
  const [models, setModels] = createSignal<string[]>([])
  const [modelInput, setModelInput] = createSignal("")
  const [test, setTest] = createSignal<{ s: "idle" | "testing" | "ok" | "err"; msg: string }>({ s: "idle", msg: "" })
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")

  const presets = createMemo<ByokProvider[]>(() => {
    const cat = props.catalog
    if (!cat) return []
    const byId = new Map(cat.byokProviders.map((p) => [p.id, p]))
    return cat.presetIds.map((id) => byId.get(id)).filter((p): p is ByokProvider => Boolean(p))
  })

  const isCustom = () => sel() === "custom"
  const inForm = () => sel() !== null
  // Key state for the provider currently open in the form (preset only; a fresh custom has none yet).
  const currentStatus = createMemo(() => {
    const s = sel()
    if (!s || s === "custom") return undefined
    return props.keyStatus?.[(s as ByokProvider).id]
  })
  const title = () => (sel() === "custom" ? t("alpha.provider.customEndpoint") : sel() ? (sel() as ByokProvider).name : t("alpha.provider.addTitle"))

  function openPreset(p: ByokProvider) {
    setSel(p)
    setName(p.name)
    setCompat(p.compat)
    setBaseURL(p.baseURL)
    setModels([...p.models])
    setApiKey("")
    setShowKey(false)
    setTest({ s: "idle", msg: "" })
    setError("")
  }
  function openCustom() {
    setSel("custom")
    setName("")
    setCompat("openai")
    setBaseURL("")
    setModels([])
    setApiKey("")
    setShowKey(false)
    setTest({ s: "idle", msg: "" })
    setError("")
  }

  // Opened to configure a specific provider (a 需 Key row) → jump straight to its form.
  onMount(() => {
    const id = props.initialId
    if (!id) return
    const p = props.catalog?.byokProviders.find((x) => x.id === id)
    if (p) openPreset(p)
  })
  function back() {
    if (inForm()) {
      setSel(null)
      setError("")
    } else props.onClose()
  }
  function addModel() {
    const v = modelInput().trim()
    if (v && !models().includes(v)) setModels([...models(), v])
    setModelInput("")
  }

  async function runTest() {
    if (!baseURL() || !apiKey() || models().length === 0) {
      setTest({ s: "err", msg: t("alpha.provider.testIncomplete") })
      return
    }
    setTest({ s: "testing", msg: "" })
    const r = await window.api.providers.test({
      compat: compat(),
      baseURL: baseURL(),
      apiKey: apiKey(),
      model: models()[0],
    })
    if (r.ok) setTest({ s: "ok", msg: t("alpha.provider.testConnected", { ms: r.ms }) })
    else setTest({ s: "err", msg: r.reason })
  }

  async function save() {
    setError("")
    if (!name().trim()) {
      setError(t("alpha.provider.nameRequired"))
      return
    }
    if (models().length === 0) {
      setError(t("alpha.provider.modelRequired"))
      return
    }
    const id = isCustom() ? slug(name()) : (sel() as ByokProvider).id
    // Empty key on an already-configured provider = keep the existing key (don't overwrite). Only
    // require a key when none is configured yet.
    if (!apiKey().trim()) {
      if (currentStatus()?.configured) {
        props.onSaved?.()
        props.onClose()
        return
      }
      setError(t("alpha.provider.keyRequired"))
      return
    }
    setSaving(true)
    // Catalog presets: the key goes to alpha's encrypted keychain (the catalog already defines
    // baseURL/models; buildAlphaModelConfig injects the node from keychain→env). Off-catalog custom
    // endpoints: persist the full definition to opencode.jsonc as before (custom-key migration = Phase 5).
    const r = isCustom()
      ? await window.api.providers.add({
          id,
          name: name(),
          compat: compat(),
          baseURL: baseURL(),
          apiKey: apiKey(),
          models: models(),
        })
      : await window.api.providers.setKey(id, apiKey())
    setSaving(false)
    if (r.ok) {
      props.onSaved?.()
      props.onClose()
    } else setError(r.reason)
  }

  // Remove the stored key. Config keys are removed via opencode.jsonc; env keys can't be touched from
  // here (they live in alpha.env) — tell the user where to clear them.
  async function removeKey() {
    const s = sel()
    if (!s || s === "custom") return
    const p = s as ByokProvider
    const src = currentStatus()?.source
    if (src === "env") {
      setError(t("alpha.provider.removeEnvKey", { key: p.keyEnv }))
      return
    }
    setSaving(true)
    // keychain is the normal store; "config" is a legacy inline key in opencode.jsonc.
    const r = src === "config" ? await window.api.providers.remove(p.id) : await window.api.providers.removeKey(p.id)
    setSaving(false)
    if (r.ok) {
      props.onSaved?.()
      props.onClose()
    } else setError(r.reason)
  }

  return (
    <div class="a-mpa" onClick={(e) => e.stopPropagation()}>
      <div class="a-mpa-head">
        <button class="a-mpa-back" onClick={back} aria-label={t("alpha.common.back")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <span class="a-mpa-title">{title()}</span>
      </div>

      <div class="a-mpa-body">
        {/* Step 1 — choose provider */}
        <Show when={!inForm()}>
          <p class="a-mpa-hint">{t("alpha.provider.intro")}</p>
          <For each={presets()}>
            {(p) => (
              <button class="a-mpa-preset" onClick={() => openPreset(p)}>
                <span class="a-pico" style={{ background: p.pico.color }}>
                  {p.pico.letter}
                </span>
                <span class="a-mpa-pn">
                  <span class="nm">{p.name}</span>
                  <span class="sb">{t("alpha.provider.presetHint", { compat: p.compat === "anthropic" ? t("alpha.provider.anthropicCompatible") : t("alpha.provider.openaiCompatible") })}</span>
                </span>
                <Show when={props.keyStatus?.[p.id]?.configured}>
                  <span class="a-mpa-pstate">{t("alpha.provider.configured")}</span>
                </Show>
                <Chevron />
              </button>
            )}
          </For>
          <button class="a-mpa-preset custom" onClick={openCustom}>
            <span class="a-mpa-plus">+</span>
            <span class="a-mpa-pn">
              <span class="nm">{t("alpha.provider.otherEndpoint")}</span>
              <span class="sb">{t("alpha.provider.compatibleSummary")}</span>
            </span>
            <Chevron />
          </button>
        </Show>

        {/* Step 2 — configure */}
        <Show when={inForm()}>
          <div class="a-mpa-field">
            <label>
              {t("alpha.provider.name")} <span class="req">*</span>
            </label>
            <input
              class="a-mpa-input"
              value={name()}
              readOnly={!isCustom()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder={t("alpha.provider.namePlaceholder")}
            />
          </div>
          <div class="a-mpa-field">
            <label>{t("alpha.provider.compatibility")}</label>
            <div class="a-mpa-compat">
              <div class="opt" aria-pressed={compat() === "openai"} onClick={() => isCustom() && setCompat("openai")}>
                {t("alpha.provider.openaiCompatible")}
              </div>
              <div
                class="opt"
                aria-pressed={compat() === "anthropic"}
                onClick={() => isCustom() && setCompat("anthropic")}
              >
                {t("alpha.provider.anthropicCompatible")}
              </div>
            </div>
          </div>
          <div class="a-mpa-field">
            <label>
              {t("alpha.provider.baseUrl")} <span class="req">*</span>
            </label>
            <input
              class="a-mpa-input mono"
              value={baseURL()}
              onInput={(e) => setBaseURL(e.currentTarget.value)}
              placeholder="https://api.example.com/v1"
            />
            <Show when={compat() === "anthropic"}>
              <p class="a-mpa-hint">{t("alpha.provider.anthropicUrlHint")}</p>
            </Show>
          </div>
          <div class="a-mpa-field">
            <label>
              {t("alpha.provider.apiKey")}
              <Show when={!currentStatus()?.configured}>
                {" "}
                <span class="req">*</span>
              </Show>
              <span class="a-mpa-keytoggle" onClick={() => setShowKey((v) => !v)}>
                {showKey() ? t("alpha.provider.hideKey") : t("alpha.provider.showKey")}
              </span>
            </label>
            <Show when={currentStatus()?.configured}>
              <div class="a-mpa-keystate">
                <span class="ks-badge">{t("alpha.provider.configuredKey", { hint: currentStatus()?.hint ?? "" })}</span>
                <span class="ks-src">
                  {currentStatus()?.source === "keychain"
                    ? t("alpha.provider.sourceKeychain")
                    : currentStatus()?.source === "env"
                      ? t("alpha.provider.sourceEnv")
                      : t("alpha.provider.sourceConfig")}
                </span>
                <Show when={currentStatus()?.source !== "env"}>
                  <button class="ks-remove" onClick={removeKey} disabled={saving()}>
                    {t("alpha.common.remove")}
                  </button>
                </Show>
              </div>
            </Show>
            <input
              class="a-mpa-input mono"
              type={showKey() ? "text" : "password"}
              value={apiKey()}
              onInput={(e) => setApiKey(e.currentTarget.value)}
              placeholder={currentStatus()?.configured ? t("alpha.provider.keyReplacePlaceholder") : "sk-..."}
            />
            <Show when={currentStatus()?.configured && currentStatus()?.source === "env"}>
              <p class="a-mpa-note">
                {t("alpha.provider.envKeyNote", { key: (sel() as ByokProvider).keyEnv })}
              </p>
            </Show>
          </div>
          <div class="a-mpa-field">
            <label>
              <Show when={isCustom()} fallback={t("alpha.provider.enabledModels", { count: models().length })}>
                {t("alpha.provider.modelId")} <span class="req">*</span>
              </Show>
            </label>
            <div class="a-mpa-modelchips">
              <For each={models()}>
                {(m) => (
                  <span class="a-mpa-mc">
                    {m}
                    <Show when={isCustom()}>
                      <b onClick={() => setModels(models().filter((x) => x !== m))}>×</b>
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <Show when={isCustom()}>
              <input
                class="a-mpa-input mono"
                value={modelInput()}
                onInput={(e) => setModelInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addModel()
                  }
                }}
                placeholder={t("alpha.provider.modelPlaceholder")}
                style={{ "margin-top": "6px" }}
              />
            </Show>
            <Show when={!isCustom()}>
              <p class="a-mpa-note">{t("alpha.provider.presetModelsNote")}</p>
            </Show>
          </div>
          <div class="a-mpa-testrow">
            <button class="a-mpa-testbtn" disabled={test().s === "testing"} onClick={runTest}>
              {test().s === "testing" ? t("alpha.provider.testing") : t("alpha.provider.test")}
            </button>
            <Show when={test().s === "ok"}>
              <span class="a-mpa-teststatus ok">✓ {test().msg}</span>
            </Show>
            <Show when={test().s === "err"}>
              <span class="a-mpa-teststatus err">✗ {test().msg}</span>
            </Show>
          </div>
          <Show when={error()}>
            <p class="a-mpa-error">{error()}</p>
          </Show>
        </Show>
      </div>

      <Show when={inForm()}>
        <div class="a-mpa-foot">
          <button class="a-mpa-cancel" onClick={back}>
            {t("alpha.common.back")}
          </button>
          <button class="a-mpa-save" disabled={saving()} onClick={save}>
            {saving() ? t("alpha.provider.saving") : t("alpha.provider.saveEnable")}
          </button>
        </div>
      </Show>
    </div>
  )
}

const Chevron = () => (
  <svg class="a-mpa-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="m9 18 6-6-6-6" />
  </svg>
)
