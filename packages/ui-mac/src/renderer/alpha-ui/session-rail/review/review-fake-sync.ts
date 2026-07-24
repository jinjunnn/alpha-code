// REQ-125 C2 — test-only fake of the `useServerSync` typed channel.
// The component cases install it via `mock.module("@opencode-ai/app", …)` so the
// real data container (`SessionRailReviewPanel`) runs against a controllable,
// keyed store with the same shape as the upstream channel: `session_diff`
// keyed by sessionID, an idempotent `session.diff` loader, `ready`, and the
// global project list.
import { createSignal } from "solid-js"

export interface FakeProject {
  worktree: string
  vcs?: string
}

const DEFAULT_PROJECTS: FakeProject[] = [{ worktree: "/tmp/workspace", vcs: "git" }]

const [ready, setReady] = createSignal(true)
const [projects, setProjects] = createSignal<FakeProject[]>(DEFAULT_PROJECTS)
const [sessionDiffs, setSessionDiffs] = createSignal<Record<string, unknown>>({})
const diffCalls: string[] = []

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
      get session_diff() {
        return sessionDiffs()
      },
    },
    diff(sessionID: string) {
      diffCalls.push(sessionID)
      return Promise.resolve()
    },
  },
})

/** Drop-in for the real `useServerSync` export: returns an accessor to the channel. */
export function useServerSync() {
  return sync
}

export function fakeSyncDiffCalls(): readonly string[] {
  return diffCalls
}

/** Simulate a load result (or a live event) landing in the keyed store. */
export function fakeSyncSetSessionDiff(sessionID: string, value: unknown) {
  setSessionDiffs((current) => ({ ...current, [sessionID]: value }))
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
  setSessionDiffs({})
  diffCalls.length = 0
}
