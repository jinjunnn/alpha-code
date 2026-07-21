import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import {
  ALPHA_SETTINGS_DEFAULTS,
  type AlphaSettings,
  type ExtensionStorageResult,
  type ExtensionStorageSnapshot,
  type SettingsAuthority,
  type SettingsWriteResult,
} from "../../shared/settings-adapters"
import { Banner } from "./Banner"
import { Button } from "./Button"
import { settingsSurfaceApi, type SettingsSurfaceApi } from "./settings-authority-client"
import { t } from "../i18n"
import "./settings.css"

type SettingsSection = "general" | "shortcuts" | "storage"

const GENERAL_TOGGLES = [
  { key: "autoSave", label: "alpha.settings.autoSave", description: "alpha.settings.autoSaveDesc" },
  { key: "releaseNotes", label: "alpha.settings.releaseNotes", description: "alpha.settings.releaseNotesDesc" },
  { key: "showReasoningSummaries", label: "alpha.settings.reasoning", description: "alpha.settings.reasoningDesc" },
  { key: "showSessionProgressBar", label: "alpha.settings.progress", description: "alpha.settings.progressDesc" },
  { key: "showCustomAgents", label: "alpha.settings.customAgents", description: "alpha.settings.customAgentsDesc" },
] as const

const INTERFACE_TOGGLES = [
  { key: "showFileTree", label: "alpha.settings.fileTree", description: "alpha.settings.fileTreeDesc" },
  { key: "showNavigation", label: "alpha.settings.navigation", description: "alpha.settings.navigationDesc" },
  { key: "showSearch", label: "alpha.settings.search", description: "alpha.settings.searchDesc" },
  { key: "showStatus", label: "alpha.settings.status", description: "alpha.settings.statusDesc" },
  { key: "showTerminal", label: "alpha.settings.terminal", description: "alpha.settings.terminalDesc" },
] as const

const SHORTCUTS = [
  { id: "settings.open", label: "alpha.settings.shortcutOpenSettings", fallback: "⌘," },
  { id: "command.palette", label: "alpha.settings.shortcutCommands", fallback: "⌘K" },
  { id: "project.open", label: "alpha.settings.shortcutOpenProject", fallback: "⌘O" },
  { id: "session.new", label: "alpha.settings.shortcutNewSession", fallback: "⌘N" },
  { id: "session.previous", label: "alpha.settings.shortcutPrevious", fallback: "⌥↑" },
  { id: "session.next", label: "alpha.settings.shortcutNext", fallback: "⌥↓" },
] as const

const STORAGE_FAILURE: ExtensionStorageResult = {
  code: "worker-failed",
  blobsTotal: 0,
  sweepableCount: 0,
  sweptCount: 0,
  keptByGrace: 0,
  warningCount: 0,
}

const STORAGE_FIELDS = [
  { key: "blobsTotal", label: "alpha.settings.storageCached" },
  { key: "sweepableCount", label: "alpha.settings.storageSweepable" },
  { key: "sweptCount", label: "alpha.settings.storageSwept" },
  { key: "keptByGrace", label: "alpha.settings.storageGrace" },
  { key: "warningCount", label: "alpha.settings.storageWarnings" },
] as const

const storageCodeLabel = (code: ExtensionStorageResult["code"]) => {
  if (code === "ok") return t("alpha.settings.storageOk")
  if (code === "busy") return t("alpha.settings.storageBusy")
  if (code === "fail-closed") return t("alpha.settings.storageFailClosed")
  return t("alpha.settings.storageWorkerFailed")
}
const STORAGE_POLL_INTERVAL_MS = 100
const STORAGE_POLL_ATTEMPTS = 100

type SettingsWriteFailureCode = Extract<SettingsWriteResult, { ok: false }>["code"]

const settingsErrorLabel = (code: SettingsWriteFailureCode) => {
  if (code === "invalid-input") return t("alpha.settings.errorInvalid")
  if (code === "read-failed") return t("alpha.settings.errorRead")
  if (code === "revision-conflict") return t("alpha.settings.errorConflict")
  return t("alpha.settings.errorWrite")
}

export function AlphaSettings(props: { open: boolean; onClose: () => void; api?: SettingsSurfaceApi }) {
  const api = () => props.api ?? settingsSurfaceApi()
  const [section, setSection] = createSignal<SettingsSection>("general")
  const [authority, setAuthority] = createSignal<SettingsAuthority | null>(null)
  const [expectedRevision, setExpectedRevision] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal<AlphaSettings | null>(null)
  const [loadState, setLoadState] = createSignal<"idle" | "loading" | "ready" | "repair" | "failed">("idle")
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [saved, setSaved] = createSignal(false)
  const [storage, setStorage] = createSignal<ExtensionStorageSnapshot>({ state: "not-run", result: null })
  let closeButton: HTMLButtonElement | undefined
  let surface: HTMLDivElement | undefined
  let errorSummary: HTMLDivElement | undefined
  let restoreFocus: HTMLElement | null = null
  let loadRun = 0
  let storageRun = 0
  let storagePoll: ReturnType<typeof setTimeout> | undefined

  const dirty = () => {
    const value = draft()
    if (!value) return false
    if (loadState() === "repair") return true
    return JSON.stringify(value) !== JSON.stringify(authority()?.value ?? ALPHA_SETTINGS_DEFAULTS)
  }
  const readyToEdit = () => loadState() === "ready" || loadState() === "repair"
  const storageBusy = () => storage().state === "checking" || storage().state === "collecting"
  const storageResult = () => {
    const snapshot = storage()
    return snapshot.state === "ready" ? snapshot.result : null
  }
  const storageValue = (key: (typeof STORAGE_FIELDS)[number]["key"]) => {
    const snapshot = storage()
    if (snapshot.state === "ready") return String(snapshot.result[key])
    if (snapshot.state === "checking" || snapshot.state === "collecting") return t("alpha.settings.processing")
    return t("alpha.settings.shownAfterCheck")
  }
  const storageCode = () => storageResult()?.code ?? storage().state
  const canCollect = () => {
    const result = storageResult()
    return !storageBusy() && result?.code === "ok" && result.sweepableCount > 0
  }

  const loadSettings = () => {
    const run = ++loadRun
    setLoadState("loading")
    setSaving(false)
    setSaveError(null)
    setSaved(false)
    void api()
      .settings.read()
      .then(
        (result) => {
          if (run !== loadRun || !props.open) return
          if (result.ok) {
            setAuthority({ value: structuredClone(result.value), revision: result.revision })
            setExpectedRevision(result.revision)
            setDraft(structuredClone(result.value))
            setLoadState("ready")
            return
          }
          if (result.code === "authority-invalid") {
            setAuthority(null)
            setExpectedRevision(result.revision)
            setDraft(structuredClone(ALPHA_SETTINGS_DEFAULTS))
            setLoadState("repair")
            return
          }
          setAuthority(null)
          setExpectedRevision(null)
          setDraft(null)
          setLoadState("failed")
        },
        () => {
          if (run !== loadRun || !props.open) return
          setAuthority(null)
          setExpectedRevision(null)
          setDraft(null)
          setLoadState("failed")
        },
      )
  }

  const cancelStoragePoll = () => {
    if (!storagePoll) return
    clearTimeout(storagePoll)
    storagePoll = undefined
  }

  const loadStorage = () => {
    const run = ++storageRun
    cancelStoragePoll()
    const poll = (attempts: number) => {
      void api()
        .extensionStorage.snapshot()
        .then(
          (result) => {
            if (run !== storageRun || !props.open) return
            setStorage(result)
            if (result.state !== "checking" && result.state !== "collecting") return
            if (attempts === 0) {
              setStorage({ state: "ready", result: STORAGE_FAILURE })
              return
            }
            storagePoll = setTimeout(() => {
              storagePoll = undefined
              if (run !== storageRun || !props.open) return
              poll(attempts - 1)
            }, STORAGE_POLL_INTERVAL_MS)
          },
          () => {
            if (run !== storageRun || !props.open) return
            setStorage({ state: "ready", result: STORAGE_FAILURE })
          },
        )
    }
    poll(STORAGE_POLL_ATTEMPTS)
  }

  createEffect(() => {
    if (!props.open) {
      loadRun += 1
      storageRun += 1
      cancelStoragePoll()
      return
    }
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSection("general")
    loadSettings()
    loadStorage()
    queueMicrotask(() => closeButton?.focus())
  })

  const close = () => {
    props.onClose()
    queueMicrotask(() => restoreFocus?.focus())
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (!props.open) return
    if (event.key === "Escape") {
      if (event.isComposing) return
      event.preventDefault()
      close()
      return
    }
    if (event.key !== "Tab" || !surface) return
    const focusable = Array.from(
      surface.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    )
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) {
      event.preventDefault()
      surface.focus()
      return
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  document.addEventListener("keydown", onKeyDown)
  onCleanup(() => {
    cancelStoragePoll()
    document.removeEventListener("keydown", onKeyDown)
  })

  const updateGeneral = <Key extends keyof AlphaSettings["general"]>(
    key: Key,
    value: AlphaSettings["general"][Key],
  ) => {
    setDraft((current) => (current ? { ...current, general: { ...current.general, [key]: value } } : current))
    setSaved(false)
    setSaveError(null)
  }
  const updateNotification = (key: keyof AlphaSettings["notifications"], value: boolean) => {
    setDraft((current) =>
      current ? { ...current, notifications: { ...current.notifications, [key]: value } } : current,
    )
    setSaved(false)
    setSaveError(null)
  }
  const updateShortcut = (id: string, value: string) => {
    setDraft((current) => {
      if (!current) return current
      const keybinds = { ...current.keybinds }
      if (value.trim()) keybinds[id] = value
      if (!value.trim()) delete keybinds[id]
      return { ...current, keybinds }
    })
    setSaved(false)
    setSaveError(null)
  }

  const save = () => {
    const value = draft()
    const revision = expectedRevision()
    if (!value || !revision || saving()) return
    const run = loadRun
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    void api()
      .settings.validate(value)
      .then<SettingsWriteResult, SettingsWriteResult>(
        (validated) => {
          if (!validated.ok) return { ok: false, code: "invalid-input" }
          return api().settings.write({ value, expectedRevision: revision })
        },
        () => ({ ok: false, code: "read-failed" }),
      )
      .then(
        (result) => {
          if (run !== loadRun || !props.open) return
          setSaving(false)
          if (result.ok) {
            setAuthority({ value: structuredClone(result.value), revision: result.revision })
            setExpectedRevision(result.revision)
            setDraft(structuredClone(result.value))
            setSaveError(null)
            setSaved(true)
            setLoadState("ready")
            return
          }
          if (result.authoritative) {
            setAuthority({
              value: structuredClone(result.authoritative.value),
              revision: result.authoritative.revision,
            })
            setExpectedRevision(result.authoritative.revision)
          }
          if (!result.authoritative && result.revision) setExpectedRevision(result.revision)
          setSaveError(settingsErrorLabel(result.code))
          queueMicrotask(() => errorSummary?.focus())
        },
        () => {
          if (run !== loadRun || !props.open) return
          setSaving(false)
          setSaveError(settingsErrorLabel("write-failed"))
          queueMicrotask(() => errorSummary?.focus())
        },
      )
  }

  const runStorage = (kind: "inspect" | "collect") => {
    if (storageBusy()) return
    cancelStoragePoll()
    const run = ++storageRun
    setStorage({ state: kind === "inspect" ? "checking" : "collecting", result: null })
    const operation = kind === "inspect" ? api().extensionStorage.inspect : api().extensionStorage.collect
    void operation().then(
      (result) => {
        if (run !== storageRun || !props.open) return
        setStorage({ state: "ready", result })
      },
      () => {
        if (run !== storageRun || !props.open) return
        setStorage({ state: "ready", result: STORAGE_FAILURE })
      },
    )
  }

  const ToggleRow = (rowProps: {
    checked: boolean
    label: string
    description: string
    onChange: (value: boolean) => void
  }) => (
    <label class="alpha-settings-row alpha-settings-toggle-row">
      <span class="alpha-settings-row-copy">
        <strong>{rowProps.label}</strong>
        <small>{rowProps.description}</small>
      </span>
      <input
        class="alpha-settings-switch"
        type="checkbox"
        checked={rowProps.checked}
        disabled={!readyToEdit() || saving()}
        onChange={(event) => rowProps.onChange(event.currentTarget.checked)}
      />
    </label>
  )

  return (
    <Show when={props.open}>
      <div
        ref={(element) => (surface = element)}
        class="a-ui alpha-settings-page"
        role="dialog"
        aria-modal="true"
        aria-labelledby="alpha-settings-title"
        tabIndex={-1}
        data-alpha-settings
      >
        <header class="alpha-settings-head">
          <button
            ref={(element) => (closeButton = element)}
            type="button"
            class="alpha-settings-back"
            aria-label={t("alpha.settings.back")}
            onClick={close}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <div>
            <h1 id="alpha-settings-title">{t("alpha.settings.title")}</h1>
            <Show when={saveError()}>
              <p>{t("alpha.settings.authorityStillActive")}</p>
            </Show>
          </div>
          <Show when={dirty()}>
            <span class="alpha-settings-unsaved">
              <i aria-hidden="true" />
              {t("alpha.settings.unsaved")}
            </span>
          </Show>
        </header>

        <div class="alpha-settings-layout">
          <nav class="alpha-settings-nav" aria-label={t("alpha.settings.categories")}>
            <For
              each={[
                { id: "general" as const, label: t("alpha.settings.general") },
                { id: "shortcuts" as const, label: t("alpha.settings.shortcuts") },
                { id: "storage" as const, label: t("alpha.settings.extensionStorage") },
              ]}
            >
              {(item) => (
                <button
                  type="button"
                  data-settings-section={item.id}
                  aria-current={section() === item.id ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </nav>

          <main class="alpha-settings-main">
            <Show when={loadState() === "loading"}>
              <div class="alpha-settings-loading" role="status">
                {t("alpha.settings.loading")}
              </div>
            </Show>
            <Show when={loadState() === "failed"}>
              <Banner
                kind="error"
                title={t("alpha.settings.loadFailed")}
                detail={t("alpha.settings.loadFailedDetail")}
                action={{ label: t("alpha.common.retry"), onClick: loadSettings }}
              />
            </Show>
            <Show when={loadState() === "repair"}>
              <Banner
                kind="warning"
                title={t("alpha.settings.invalidStored")}
                detail={t("alpha.settings.invalidStoredDetail")}
              />
            </Show>
            <Show when={saveError()}>
              {(message) => (
                <div ref={(element) => (errorSummary = element)} tabIndex={-1}>
                  <Banner
                    kind="error"
                    title={t("alpha.settings.saveFailed")}
                    detail={message()}
                    action={{ label: t("alpha.settings.retrySave"), onClick: save }}
                  />
                </div>
              )}
            </Show>
            <Show when={saved()}>
              <Banner kind="success" title={t("alpha.settings.saved")} detail={t("alpha.settings.savedDetail")} />
            </Show>

            <Show when={section() === "general" && draft()}>
              {(current) => (
                <>
                  <div class="alpha-settings-section-head">
                    <div>
                      <h2>{t("alpha.settings.general")}</h2>
                      <p>{t("alpha.settings.generalDetail")}</p>
                    </div>
                    <Button
                      variant="primary"
                      loading={saving()}
                      disabled={!dirty() || !readyToEdit()}
                      data-settings-save
                      onClick={save}
                    >
                      {saveError() ? t("alpha.settings.retrySave") : t("alpha.settings.save")}
                    </Button>
                  </div>

                  <section class="alpha-settings-group" aria-labelledby="settings-behavior-title">
                    <h3 id="settings-behavior-title">{t("alpha.settings.behavior")}</h3>
                    <For each={GENERAL_TOGGLES}>
                      {(item) => (
                        <ToggleRow
                          checked={current().general[item.key] ?? ALPHA_SETTINGS_DEFAULTS.general[item.key] ?? false}
                          label={t(item.label)}
                          description={t(item.description)}
                          onChange={(value) => updateGeneral(item.key, value)}
                        />
                      )}
                    </For>
                  </section>

                  <section class="alpha-settings-group" aria-labelledby="settings-interface-title">
                    <h3 id="settings-interface-title">{t("alpha.settings.interface")}</h3>
                    <label class="alpha-settings-row">
                      <span class="alpha-settings-row-copy">
                        <strong>{t("alpha.settings.fontSize")}</strong>
                        <small>{t("alpha.settings.fontSizeDesc")}</small>
                      </span>
                      <input
                        class="alpha-settings-number"
                        type="number"
                        min="8"
                        max="72"
                        aria-label={t("alpha.settings.fontSize")}
                        data-setting="font-size"
                        value={current().appearance.fontSize}
                        disabled={!readyToEdit() || saving()}
                        onInput={(event) => {
                          setDraft((value) =>
                            value
                              ? {
                                  ...value,
                                  appearance: { ...value.appearance, fontSize: Number(event.currentTarget.value) },
                                }
                              : value,
                          )
                          setSaved(false)
                          setSaveError(null)
                        }}
                      />
                    </label>
                    <For each={INTERFACE_TOGGLES}>
                      {(item) => (
                        <ToggleRow
                          checked={current().general[item.key]}
                          label={t(item.label)}
                          description={t(item.description)}
                          onChange={(value) => updateGeneral(item.key, value)}
                        />
                      )}
                    </For>
                  </section>

                  <section class="alpha-settings-group" aria-labelledby="settings-notifications-title">
                    <h3 id="settings-notifications-title">{t("alpha.settings.notificationsPermissions")}</h3>
                    <ToggleRow
                      checked={current().permissions.autoApprove}
                      label={t("alpha.settings.autoApprove")}
                      description={t("alpha.settings.autoApproveDesc")}
                      onChange={(value) => {
                        setDraft((settings) =>
                          settings
                            ? {
                                ...settings,
                                permissions: { autoApprove: value },
                              }
                            : settings,
                        )
                        setSaved(false)
                        setSaveError(null)
                      }}
                    />
                    <For
                      each={[
                        { key: "agent" as const, label: t("alpha.settings.notifyAgent") },
                        { key: "permissions" as const, label: t("alpha.settings.notifyPermission") },
                        { key: "errors" as const, label: t("alpha.settings.notifyError") },
                      ]}
                    >
                      {(item) => (
                        <ToggleRow
                          checked={current().notifications[item.key]}
                          label={item.label}
                          description={t("alpha.settings.notifyDesc")}
                          onChange={(value) => updateNotification(item.key, value)}
                        />
                      )}
                    </For>
                  </section>
                </>
              )}
            </Show>

            <Show when={section() === "shortcuts" && draft()}>
              {(current) => (
                <>
                  <div class="alpha-settings-section-head">
                    <div>
                      <h2>{t("alpha.settings.shortcuts")}</h2>
                      <p>{t("alpha.settings.shortcutsDetail")}</p>
                    </div>
                    <Button
                      variant="primary"
                      loading={saving()}
                      disabled={!dirty() || !readyToEdit()}
                      data-settings-save
                      onClick={save}
                    >
                      {saveError() ? t("alpha.settings.retrySave") : t("alpha.settings.save")}
                    </Button>
                  </div>
                  <section class="alpha-settings-group" aria-label={t("alpha.settings.shortcutList")}>
                    <For each={SHORTCUTS}>
                      {(shortcut) => (
                        <label class="alpha-settings-row alpha-settings-shortcut-row">
                          <span class="alpha-settings-row-copy">
                            <strong>{t(shortcut.label)}</strong>
                            <small>
                              <code>{shortcut.id}</code>
                            </small>
                          </span>
                          <input
                            class="alpha-settings-shortcut"
                            type="text"
                            aria-label={t("alpha.settings.shortcutLabel", { label: t(shortcut.label) })}
                            placeholder={shortcut.fallback}
                            value={current().keybinds[shortcut.id] ?? ""}
                            disabled={!readyToEdit() || saving()}
                            onInput={(event) => updateShortcut(shortcut.id, event.currentTarget.value)}
                          />
                        </label>
                      )}
                    </For>
                  </section>
                </>
              )}
            </Show>

            <Show when={section() === "storage"}>
              <div class="alpha-settings-section-head">
                <div>
                  <h2>{t("alpha.settings.extensionStorage")}</h2>
                  <p>{t("alpha.settings.extensionStorageDetail")}</p>
                </div>
              </div>
              <section class="alpha-settings-group alpha-settings-storage" aria-labelledby="extension-storage-title">
                <div class="alpha-settings-storage-title">
                  <span>
                    <strong id="extension-storage-title">{t("alpha.settings.storageCheck")}</strong>
                    <small>{t("alpha.settings.storageSafeCounts")}</small>
                  </span>
                  <span class="alpha-settings-local">{t("alpha.settings.local")}</span>
                </div>
                <div class="alpha-settings-usage-grid">
                  <For each={STORAGE_FIELDS}>
                    {(field) => (
                      <div class="alpha-settings-usage-card" data-storage-field={field.key}>
                        <span>{t(field.label)}</span>
                        <strong>{storageValue(field.key)}</strong>
                      </div>
                    )}
                  </For>
                </div>
                <div
                  class="alpha-settings-storage-status"
                  role="status"
                  aria-live="polite"
                  data-storage-code={storageCode()}
                >
                  <i aria-hidden="true" />
                  <Show
                    when={storageResult()}
                    fallback={
                      <span>
                        {t("alpha.settings.storageStatus")}
                        {storage().state === "not-run"
                          ? t("alpha.settings.storageNotRun")
                          : storage().state === "checking"
                            ? t("alpha.settings.storageChecking")
                            : t("alpha.settings.storageCollecting")}
                      </span>
                    }
                  >
                    {(result) => (
                      <span>
                        {t("alpha.settings.storageStatus")}{storageCodeLabel(result().code)} <code>{result().code}</code>
                      </span>
                    )}
                  </Show>
                </div>
                <Show when={storageResult()?.code !== "ok" ? storageResult() : null}>
                  {(result) => (
                    <Banner
                      kind={result().code === "busy" ? "warning" : "error"}
                      title={result().code === "busy" ? t("alpha.settings.storageBusyTitle") : t("alpha.settings.storageOperationFailed")}
                      detail={t("alpha.settings.storageFailureDetail")}
                    />
                  )}
                </Show>
                <div class="alpha-settings-storage-actions">
                  <p>{t("alpha.settings.storageActionNote")}</p>
                  <Button
                    variant="secondary"
                    loading={storage().state === "checking"}
                    disabled={storageBusy()}
                    data-storage-inspect
                    onClick={() => runStorage("inspect")}
                  >
                    {storageResult()?.code !== "ok" && storageResult() ? t("alpha.settings.storageRecheck") : t("alpha.settings.storageInspect")}
                  </Button>
                  <Button
                    variant="primary"
                    loading={storage().state === "collecting"}
                    disabled={!canCollect()}
                    data-storage-collect
                    onClick={() => runStorage("collect")}
                  >
                    {t("alpha.settings.storageCollect")}
                  </Button>
                </div>
              </section>
              <p class="alpha-settings-storage-note">
                {t("alpha.settings.storagePrivacy")}
              </p>
            </Show>
          </main>
        </div>
      </div>
    </Show>
  )
}
