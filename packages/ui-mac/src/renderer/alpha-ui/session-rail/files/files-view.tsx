/**
 * REQ-125 C3-files — presentational layer for the files panel (approved frame:
 * docs/design/current/session-workspace/design.html §文件面板). Context-free: everything
 * arrives through the FilesPanelState, so the real Solid mount tests drive it with fake IO.
 */

import { For, Show, type Accessor } from "solid-js"
import { t } from "../../../i18n"
import type { FileChangeKind, TreeEntry } from "./files-core"
import type { FilesPanelState, SearchState } from "./files-state"

function FileIcon() {
  return (
    <svg class="a-srf-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg class="a-srf-icon a-srf-icon--dir" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7l2-3h5l2 3h7v11H3z" />
    </svg>
  )
}

function badgeLabel(kind: FileChangeKind) {
  if (kind === "added") return t("alpha.session.filesBadgeAdded")
  if (kind === "deleted") return t("alpha.session.filesBadgeDeleted")
  return t("alpha.session.filesBadgeModified")
}

function ChangeBadge(props: { kind: FileChangeKind }) {
  return (
    <span class="a-srf-badge" data-kind={props.kind}>
      {badgeLabel(props.kind)}
    </span>
  )
}

function EmptyState(props: { title: string; detail: string }) {
  return (
    <div class="a-srf-empty">
      <span class="a-srf-empty-icon" aria-hidden="true">
        <FolderIcon />
      </span>
      <b>{props.title}</b>
      <p>{props.detail}</p>
    </div>
  )
}

function LoadingRow() {
  return (
    <div class="a-srf-loading" role="status">
      {t("alpha.session.filesLoading")}
    </div>
  )
}

function DirError(props: { state: FilesPanelState; path: string }) {
  return (
    <div class="a-srf-error" role="alert">
      <span>{t("alpha.session.filesLoadFailed")}</span>
      <button type="button" class="a-srf-retry" onClick={() => props.state.retryDir(props.path)}>
        {t("alpha.session.filesRetry")}
      </button>
    </div>
  )
}

function FileRow(props: { state: FilesPanelState; entry: TreeEntry }) {
  const kind = () => props.state.badge(props.entry.path)
  const isSelected = () => props.state.selected() === props.entry.path
  return (
    <button
      type="button"
      class="a-srf-row"
      classList={{
        "a-srf-row--selected": isSelected(),
        "a-srf-row--ignored": props.entry.ignored,
      }}
      role="treeitem"
      aria-selected={isSelected()}
      data-alpha-srf-file={props.entry.path}
      title={kind() ? t("alpha.session.filesOpenInReview") : undefined}
      onClick={() => props.state.activateFile(props.entry.path)}
    >
      <span class="a-srf-caret-spacer" aria-hidden="true" />
      <FileIcon />
      <span class="a-srf-name">{props.entry.name}</span>
      <Show when={kind()}>{(resolved) => <ChangeBadge kind={resolved()} />}</Show>
    </button>
  )
}

function DirRow(props: { state: FilesPanelState; entry: TreeEntry }) {
  const dir = () => props.state.dirState(props.entry.path)
  const expanded = () => dir()?.expanded === true
  return (
    <>
      <button
        type="button"
        class="a-srf-row a-srf-row--dir"
        classList={{ "a-srf-row--open": expanded() }}
        role="treeitem"
        aria-expanded={expanded()}
        data-alpha-srf-dir={props.entry.path}
        onClick={() => props.state.toggleDir(props.entry.path)}
      >
        <svg class="a-srf-caret" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
        <FolderIcon />
        <span class="a-srf-name">{props.entry.name}</span>
      </button>
      <Show when={expanded()}>
        <div class="a-srf-indent" role="group">
          <Show when={!dir()?.error} fallback={<DirError state={props.state} path={props.entry.path} />}>
            <Show when={dir()?.entries} fallback={<LoadingRow />}>
              <TreeLevel state={props.state} path={props.entry.path} />
            </Show>
          </Show>
        </div>
      </Show>
    </>
  )
}

function TreeLevel(props: { state: FilesPanelState; path: string }) {
  const entries = () => props.state.dirState(props.path)?.entries ?? []
  return (
    <>
      <For each={entries()}>
        {(entry) =>
          entry.type === "directory" ? (
            <DirRow state={props.state} entry={entry} />
          ) : (
            <FileRow state={props.state} entry={entry} />
          )
        }
      </For>
      <Show when={props.state.dirState(props.path)?.truncated}>
        {(info) => (
          <div class="a-srf-truncated" role="note" data-alpha-srf-truncated={props.path}>
            {t("alpha.session.filesTruncated", { shown: String(info().shown), total: String(info().total) })}
          </div>
        )}
      </Show>
    </>
  )
}

function WorkspaceTree(props: { state: FilesPanelState }) {
  const root = () => props.state.dirState("")
  return (
    <section class="a-srf-tree-section" data-alpha-srf-tree aria-label={t("alpha.session.filesWorkspace")}>
      <div class="a-srf-label">{t("alpha.session.filesWorkspace")}</div>
      <Show when={!root()?.error} fallback={<DirError state={props.state} path="" />}>
        <Show when={root()?.entries} fallback={<LoadingRow />}>
          {(entries) => (
            <Show
              when={entries().length > 0 || props.state.dirState("")?.truncated}
              fallback={
                <EmptyState title={t("alpha.session.filesEmptyTitle")} detail={t("alpha.session.filesEmptyDetail")} />
              }
            >
              <div class="a-srf-tree" role="tree" aria-label={t("alpha.session.filesWorkspace")}>
                <TreeLevel state={props.state} path="" />
              </div>
            </Show>
          )}
        </Show>
      </Show>
    </section>
  )
}

function OpenedGroup(props: { state: FilesPanelState }) {
  return (
    <Show when={props.state.opened().length > 0}>
      <section class="a-srf-section" data-alpha-srf-opened aria-label={t("alpha.session.filesOpened")}>
        <div class="a-srf-label">{t("alpha.session.filesOpened")}</div>
        <For each={props.state.opened()}>
          {(row) => (
            <div
              class="a-srf-opentab"
              classList={{ "a-srf-opentab--on": row.active }}
              data-alpha-srf-opentab={row.path}
            >
              <button
                type="button"
                class="a-srf-opentab-main"
                aria-current={row.active ? "true" : undefined}
                onClick={() => props.state.selectOpened(row.tab)}
              >
                <FileIcon />
                <span class="a-srf-name">{row.name}</span>
              </button>
              <button
                type="button"
                class="a-srf-opentab-close"
                aria-label={t("alpha.session.filesCloseTab", { name: row.name })}
                onClick={() => props.state.closeOpened(row.tab)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          )}
        </For>
      </section>
    </Show>
  )
}

function SearchResults(props: { state: FilesPanelState; search: Accessor<SearchState> }) {
  return (
    <section class="a-srf-section a-srf-results" data-alpha-srf-results aria-label={t("alpha.session.filesResults")}>
      <div class="a-srf-label">{t("alpha.session.filesResults")}</div>
      <Show when={!props.search().loading} fallback={<LoadingRow />}>
        <Show
          when={props.search().failed !== true}
          fallback={
            <div class="a-srf-error" role="alert">
              <span>{t("alpha.session.filesLoadFailed")}</span>
            </div>
          }
        >
          <Show
            when={props.search().rows.length > 0}
            fallback={
              <EmptyState title={t("alpha.session.filesNoMatches")} detail={t("alpha.session.filesNoMatchesDetail")} />
            }
          >
            <For each={props.search().rows}>
              {(path) => (
                <button
                  type="button"
                  class="a-srf-row a-srf-row--result"
                  classList={{ "a-srf-row--selected": props.state.selected() === path }}
                  data-alpha-srf-file={path}
                  onClick={() => props.state.activateFile(path)}
                >
                  <FileIcon />
                  <span class="a-srf-name">{path}</span>
                  <Show when={props.state.badge(path)}>{(resolved) => <ChangeBadge kind={resolved()} />}</Show>
                </button>
              )}
            </For>
          </Show>
        </Show>
      </Show>
    </section>
  )
}

export function SessionRailFilesView(props: { state: FilesPanelState }) {
  return (
    <div class="a-srf-root" data-alpha-session-rail-files>
      <div class="a-srf-search">
        <svg class="a-srf-search-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <input
          type="text"
          value={props.state.filter()}
          placeholder={t("alpha.session.filesFilter")}
          aria-label={t("alpha.session.filesFilter")}
          onInput={(event) => props.state.setFilter(event.currentTarget.value)}
        />
      </div>
      <div class="a-srf-scroll">
        <Show
          when={props.state.searchState()}
          fallback={
            <>
              <OpenedGroup state={props.state} />
              <WorkspaceTree state={props.state} />
            </>
          }
        >
          {(search) => <SearchResults state={props.state} search={search} />}
        </Show>
      </div>
    </div>
  )
}
