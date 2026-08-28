// REQ-125 C2 / REQ-142 — test-only fake of the `useServerSync` typed channel.
// The component cases install it via `mock.module("@opencode-ai/app", …)` so the
// real data containers run against a controllable, keyed store with the same
// shape as the upstream channel: the synced `message` store keyed by sessionID
// (REQ-142: turn diffs live on the turn's user message), an idempotent
// `session.sync` loader, `ready`, and the global project list.
import { createSignal } from "solid-js"

export interface FakeProject {
  worktree: string
  vcs?: string
}

const DEFAULT_PROJECTS: FakeProject[] = [{ worktree: "/tmp/workspace", vcs: "git" }]

const [ready, setReady] = createSignal(true)
const [projects, setProjects] = createSignal<FakeProject[]>(DEFAULT_PROJECTS)
const [messages, setMessages] = createSignal<Record<string, unknown[] | undefined>>({})
const syncCalls: string[] = []

const sync = () => ({
  get ready() {
    return ready()
  },
  data: {
    get project() {
      return projects()
    },
  },
  session: {
    data: {
      get message() {
        return messages()
      },
    },
    sync(sessionID: string) {
      syncCalls.push(sessionID)
      return Promise.resolve()
    },
  },
})

/** Drop-in for the real `useServerSync` export: returns an accessor to the channel. */
export function useServerSync() {
  return sync
}

export function fakeSyncSyncCalls(): readonly string[] {
  return syncCalls
}

/** Simulate a message page (or a live `message.updated` batch) landing in the keyed store. */
export function fakeSyncSetMessages(sessionID: string, value: unknown[]) {
  setMessages((current) => ({ ...current, [sessionID]: value }))
}

/** A real-shaped user message carrying the turn's diff records (REQ-142 supply shape). */
export function fakeSyncUserMessage(id: string, diffs?: unknown) {
  return {
    id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    ...(diffs === undefined ? {} : { summary: { diffs } }),
  }
}

export function fakeSyncSetReady(next: boolean) {
  setReady(next)
}

export function fakeSyncSetProjects(next: FakeProject[]) {
  setProjects(next)
}

export function resetFakeSync() {
  setReady(true)
  setProjects(DEFAULT_PROJECTS)
  setMessages({})
  syncCalls.length = 0
}
