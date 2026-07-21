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
import "./settings.css"

type SettingsSection = "general" | "shortcuts" | "storage"

const GENERAL_TOGGLES = [
  { key: "autoSave", label: "自动保存文件", description: "编辑文件时自动写入磁盘。" },
  { key: "releaseNotes", label: "显示版本说明", description: "更新后显示本版本的重要变化。" },
  { key: "showReasoningSummaries", label: "显示推理摘要", description: "在时间线中显示模型提供的推理摘要。" },
  { key: "showSessionProgressBar", label: "显示会话进度", description: "运行期间在会话顶部显示状态进度。" },
  { key: "showCustomAgents", label: "显示自定义 Agent", description: "在可选 Agent 列表中显示本地自定义项。" },
] as const

const INTERFACE_TOGGLES = [
  { key: "showFileTree", label: "文件树", description: "在会话工作区显示文件树入口。" },
  { key: "showNavigation", label: "导航控件", description: "显示工作区导航控件。" },
  { key: "showSearch", label: "搜索入口", description: "显示工作区搜索入口。" },
  { key: "showStatus", label: "状态信息", description: "显示工作区状态信息。" },
  { key: "showTerminal", label: "终端入口", description: "显示会话终端入口。" },
] as const

const SHORTCUTS = [
  { id: "settings.open", label: "打开设置", fallback: "⌘," },
  { id: "command.palette", label: "打开命令面板", fallback: "⌘K" },
  { id: "project.open", label: "打开项目", fallback: "⌘O" },
  { id: "session.new", label: "新建会话", fallback: "⌘N" },
  { id: "session.previous", label: "上一个会话", fallback: "⌥↑" },
  { id: "session.next", label: "下一个会话", fallback: "⌥↓" },
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
  { key: "blobsTotal", label: "缓存项目" },
  { key: "sweepableCount", label: "可安全回收" },
  { key: "sweptCount", label: "已回收" },
  { key: "keptByGrace", label: "宽限期内保留" },
  { key: "warningCount", label: "提醒" },
] as const

const STORAGE_CODE_LABEL: Record<ExtensionStorageResult["code"], string> = {
  ok: "正常",
  busy: "忙碌",
  "fail-closed": "安全关闭",
  "worker-failed": "工作进程失败",
}

type SettingsWriteFailureCode = Extract<SettingsWriteResult, { ok: false }>["code"]

const SETTINGS_ERROR_LABEL: Record<SettingsWriteFailureCode, string> = {
  "invalid-input": "设置值没有通过校验。请修正后重试。",
  "read-failed": "无法读取当前权威值。请稍后重试。",
  "revision-conflict": "设置已在别处更新。草稿仍保留，请复核后重试保存。",
  "write-failed": "无法确认更改已经持久保存。草稿仍保留，请重试。",
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

  const dirty = () => {
    const value = draft()
    if (!value) return false
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
    if (snapshot.state === "checking" || snapshot.state === "collecting") return "处理中"
    return "检查后显示"
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

  const loadStorage = () => {
    const run = ++storageRun
    void api()
      .extensionStorage.snapshot()
      .then(
        (result) => {
          if (run !== storageRun || !props.open) return
          setStorage(result)
        },
        () => {
          if (run !== storageRun || !props.open) return
          setStorage({ state: "ready", result: STORAGE_FAILURE })
        },
      )
  }

  createEffect(() => {
    if (!props.open) {
      loadRun += 1
      storageRun += 1
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
  onCleanup(() => document.removeEventListener("keydown", onKeyDown))

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
          setSaveError(SETTINGS_ERROR_LABEL[result.code])
          queueMicrotask(() => errorSummary?.focus())
        },
        () => {
          if (run !== loadRun || !props.open) return
          setSaving(false)
          setSaveError(SETTINGS_ERROR_LABEL["write-failed"])
          queueMicrotask(() => errorSummary?.focus())
        },
      )
  }

  const runStorage = (kind: "inspect" | "collect") => {
    if (storageBusy()) return
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
            aria-label="返回应用"
            onClick={close}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <div>
            <h1 id="alpha-settings-title">设置</h1>
            <Show when={saveError()}>
              <p>上次生效的权威值仍在使用</p>
            </Show>
          </div>
          <Show when={dirty()}>
            <span class="alpha-settings-unsaved">
              <i aria-hidden="true" />
              有更改未保存
            </span>
          </Show>
        </header>

        <div class="alpha-settings-layout">
          <nav class="alpha-settings-nav" aria-label="设置类别">
            <For
              each={[
                { id: "general" as const, label: "通用" },
                { id: "shortcuts" as const, label: "快捷键" },
                { id: "storage" as const, label: "扩展存储" },
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
                正在读取权威设置…
              </div>
            </Show>
            <Show when={loadState() === "failed"}>
              <Banner
                kind="error"
                title="无法读取设置"
                detail="没有显示或写入未经确认的值。请重试读取。"
                action={{ label: "重试", onClick: loadSettings }}
              />
            </Show>
            <Show when={loadState() === "repair"}>
              <Banner
                kind="warning"
                title="已存设置无法校验"
                detail="页面显示安全默认值。保存后会以 typed adapter 显式修复权威值。"
              />
            </Show>
            <Show when={saveError()}>
              {(message) => (
                <div ref={(element) => (errorSummary = element)} tabIndex={-1}>
                  <Banner
                    kind="error"
                    title="无法保存更改"
                    detail={message()}
                    action={{ label: "重试保存", onClick: save }}
                  />
                </div>
              )}
            </Show>
            <Show when={saved()}>
              <Banner kind="success" title="设置已保存" detail="页面已切换到刚刚确认的权威值。" />
            </Show>

            <Show when={section() === "general" && draft()}>
              {(current) => (
                <>
                  <div class="alpha-settings-section-head">
                    <div>
                      <h2>通用</h2>
                      <p>调整 Alpha 工作区的本机行为。</p>
                    </div>
                    <Button
                      variant="primary"
                      loading={saving()}
                      disabled={!dirty() || !readyToEdit()}
                      data-settings-save
                      onClick={save}
                    >
                      {saveError() ? "重试保存" : "保存更改"}
                    </Button>
                  </div>

                  <section class="alpha-settings-group" aria-labelledby="settings-behavior-title">
                    <h3 id="settings-behavior-title">行为</h3>
                    <For each={GENERAL_TOGGLES}>
                      {(item) => (
                        <ToggleRow
                          checked={current().general[item.key]}
                          label={item.label}
                          description={item.description}
                          onChange={(value) => updateGeneral(item.key, value)}
                        />
                      )}
                    </For>
                  </section>

                  <section class="alpha-settings-group" aria-labelledby="settings-interface-title">
                    <h3 id="settings-interface-title">界面</h3>
                    <label class="alpha-settings-row">
                      <span class="alpha-settings-row-copy">
                        <strong>字号</strong>
                        <small>界面基础字号，允许 8–72。</small>
                      </span>
                      <input
                        class="alpha-settings-number"
                        type="number"
                        min="8"
                        max="72"
                        aria-label="字号"
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
                          label={item.label}
                          description={item.description}
                          onChange={(value) => updateGeneral(item.key, value)}
                        />
                      )}
                    </For>
                  </section>

                  <section class="alpha-settings-group" aria-labelledby="settings-notifications-title">
                    <h3 id="settings-notifications-title">通知与权限</h3>
                    <ToggleRow
                      checked={current().permissions.autoApprove}
                      label="自动批准权限"
                      description="仅用于已有权限合同允许的请求；默认关闭。"
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
                        { key: "agent" as const, label: "Agent 完成通知" },
                        { key: "permissions" as const, label: "权限请求通知" },
                        { key: "errors" as const, label: "错误通知" },
                      ]}
                    >
                      {(item) => (
                        <ToggleRow
                          checked={current().notifications[item.key]}
                          label={item.label}
                          description="在本机显示相应的系统通知。"
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
                      <h2>快捷键</h2>
                      <p>输入组合键名称；留空会恢复应用默认值。</p>
                    </div>
                    <Button
                      variant="primary"
                      loading={saving()}
                      disabled={!dirty() || !readyToEdit()}
                      data-settings-save
                      onClick={save}
                    >
                      {saveError() ? "重试保存" : "保存更改"}
                    </Button>
                  </div>
                  <section class="alpha-settings-group" aria-label="快捷键列表">
                    <For each={SHORTCUTS}>
                      {(shortcut) => (
                        <label class="alpha-settings-row alpha-settings-shortcut-row">
                          <span class="alpha-settings-row-copy">
                            <strong>{shortcut.label}</strong>
                            <small>
                              <code>{shortcut.id}</code>
                            </small>
                          </span>
                          <input
                            class="alpha-settings-shortcut"
                            type="text"
                            aria-label={`${shortcut.label}快捷键`}
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
                  <h2>扩展存储</h2>
                  <p>检查扩展缓存，并安全回收不再被引用的内容。</p>
                </div>
              </div>
              <section class="alpha-settings-group alpha-settings-storage" aria-labelledby="extension-storage-title">
                <div class="alpha-settings-storage-title">
                  <span>
                    <strong id="extension-storage-title">缓存检查</strong>
                    <small>只显示 renderer-safe 聚合计数</small>
                  </span>
                  <span class="alpha-settings-local">本机</span>
                </div>
                <div class="alpha-settings-usage-grid">
                  <For each={STORAGE_FIELDS}>
                    {(field) => (
                      <div class="alpha-settings-usage-card" data-storage-field={field.key}>
                        <span>{field.label}</span>
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
                        状态：
                        {storage().state === "not-run"
                          ? "尚未检查"
                          : storage().state === "checking"
                            ? "正在检查"
                            : "正在回收"}
                      </span>
                    }
                  >
                    {(result) => (
                      <span>
                        状态：{STORAGE_CODE_LABEL[result().code]} <code>{result().code}</code>
                      </span>
                    )}
                  </Show>
                </div>
                <Show when={storageResult()?.code !== "ok" ? storageResult() : null}>
                  {(result) => (
                    <Banner
                      kind={result().code === "busy" ? "warning" : "error"}
                      title={result().code === "busy" ? "扩展存储当前忙碌" : "本次操作未完成"}
                      detail="没有清理未经可信摘要确认的内容。请稍后重新检查。"
                    />
                  )}
                </Show>
                <div class="alpha-settings-storage-actions">
                  <p>先检查，再决定是否回收；已安装扩展不会被删除。</p>
                  <Button
                    variant="secondary"
                    loading={storage().state === "checking"}
                    disabled={storageBusy()}
                    data-storage-inspect
                    onClick={() => runStorage("inspect")}
                  >
                    {storageResult()?.code !== "ok" && storageResult() ? "重新检查" : "检查可回收项"}
                  </Button>
                  <Button
                    variant="primary"
                    loading={storage().state === "collecting"}
                    disabled={!canCollect()}
                    data-storage-collect
                    onClick={() => runStorage("collect")}
                  >
                    立即回收
                  </Button>
                </div>
              </section>
              <p class="alpha-settings-storage-note">
                这里只显示项目数量；具体文件、内部标识和完整提醒内容不会出现在设置中。
              </p>
            </Show>
          </main>
        </div>
      </div>
    </Show>
  )
}
