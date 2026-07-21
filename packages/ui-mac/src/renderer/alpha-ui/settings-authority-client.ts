import type {
  Settings,
  SettingsAuthorityCoordinator,
  SettingsAuthoritySnapshot,
} from "@opencode-ai/app"
import type {
  AlphaSettings,
  SettingsAuthority,
  SettingsReadResult,
  SettingsWriteResult,
} from "../../shared/settings-adapters"

type SettingsAdapterApi = {
  read: () => Promise<SettingsReadResult>
  validate: (value: unknown) => Promise<{ ok: true } | { ok: false; code: "invalid-input" }>
  write: (input: { value: AlphaSettings; expectedRevision: string }) => Promise<SettingsWriteResult>
}

export function createSettingsAuthorityCoordinator(api: SettingsAdapterApi) {
  const state: { authority?: SettingsAuthority; tail: Promise<void> } = { tail: Promise.resolve() }
  const listeners = new Set<(snapshot: SettingsAuthoritySnapshot) => void>()

  const enqueue = <Result>(operation: () => Promise<Result>) => {
    const result = state.tail.then(operation)
    state.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const publish = (authority: SettingsAuthority) => {
    state.authority = {
      value: structuredClone(authority.value),
      revision: authority.revision,
    }
    const snapshot: SettingsAuthoritySnapshot = {
      value: structuredClone(authority.value),
      revision: authority.revision,
    }
    listeners.forEach((listener) => listener(snapshot))
    return snapshot
  }
  const trackRead = (result: SettingsReadResult) => {
    if (result.ok) publish(result)
    if (!result.ok && result.code === "authority-invalid") state.authority = undefined
    return result
  }
  const trackWrite = (result: SettingsWriteResult) => {
    if (result.ok) publish(result)
    if (!result.ok && result.authoritative) publish(result.authoritative)
    return result
  }
  const requireAuthority = (result: SettingsReadResult) => {
    if (result.ok) return { value: structuredClone(result.value), revision: result.revision }
    throw new Error(`Settings authority unavailable: ${result.code}`)
  }
  const commit = async (
    change: (current: Settings) => Settings,
    attempts: number,
  ): Promise<SettingsAuthoritySnapshot> => {
    const authority = state.authority ?? requireAuthority(trackRead(await api.read()))
    const value = change(structuredClone(authority.value))
    const validated = await api.validate(value)
    if (!validated.ok) throw new Error(`Settings candidate rejected: ${validated.code}`)
    const result = trackWrite(await api.write({ value, expectedRevision: authority.revision }))
    if (result.ok) return { value: structuredClone(result.value), revision: result.revision }
    if (result.code === "revision-conflict" && result.authoritative && attempts > 0) {
      return commit(change, attempts - 1)
    }
    throw new Error(`Settings commit failed: ${result.code}`)
  }

  const client = {
    read: () => enqueue(() => api.read().then(trackRead)),
    validate: (value: unknown) => api.validate(value),
    write: (input: { value: AlphaSettings; expectedRevision: string }) =>
      enqueue(() => api.write(input).then(trackWrite)),
  }
  const coordinator: SettingsAuthorityCoordinator = {
    read: () => client.read().then(requireAuthority),
    update: (change) => enqueue(() => commit(change, 2)),
    subscribe(listener) {
      listeners.add(listener)
      if (state.authority) {
        listener({ value: structuredClone(state.authority.value), revision: state.authority.revision })
      }
      return () => listeners.delete(listener)
    },
  }

  return { client, coordinator }
}

const authority = createSettingsAuthorityCoordinator({
  read: () => window.api.settings.read(),
  validate: (value) => window.api.settings.validate(value),
  write: (input) => window.api.settings.write(input),
})

export const settingsAuthorityClient = authority.client
export const settingsAuthorityCoordinator = authority.coordinator

export type SettingsSurfaceApi = {
  settings: {
    read: () => Promise<SettingsReadResult>
    validate: (value: unknown) => ReturnType<typeof settingsAuthorityClient.validate>
    write: (input: { value: AlphaSettings; expectedRevision: string }) => Promise<SettingsWriteResult>
  }
  extensionStorage: Window["api"]["extensionStorage"]
}

export function settingsSurfaceApi(): SettingsSurfaceApi {
  return {
    settings: settingsAuthorityClient,
    extensionStorage: window.api.extensionStorage,
  }
}
