// Alpha's canonical route contract. The manifest owns route identity, parameter shape,
// location encoding, and the single leaf/redirect composition seam. Router/provider/layout
// ownership remains upstream; production route composition is derived in a later slice.

import type { SurfaceId } from "./alpha-surfaces"

export const ROUTE_MANIFEST_VERSION = 1

export type RouteParameterCodec = "component" | "directory"

export type RoutePathSegment =
  | { kind: "literal"; value: string }
  | { kind: "parameter"; name: string; codec: RouteParameterCodec }

export interface RouteQueryParameter {
  name: string
  codec: "component"
  required: boolean
}

export type RouteComposition =
  | { kind: "surface"; surface: SurfaceId | "settings" | "dialog" | "recovery" }
  | { kind: "redirect"; routeId: string }

export interface RouteManifestEntry {
  id: string
  version: number
  location:
    | {
        kind: "path"
        path: readonly RoutePathSegment[]
        query: readonly RouteQueryParameter[]
      }
    | { kind: "system"; params: readonly [] }
  composition: RouteComposition
}

export const ROUTE_MANIFEST = {
  version: ROUTE_MANIFEST_VERSION,
  routes: [
    {
      id: "home",
      version: 1,
      location: { kind: "path", path: [], query: [] },
      composition: { kind: "surface", surface: "home" },
    },
    {
      id: "directory",
      version: 1,
      location: {
        kind: "path",
        path: [{ kind: "parameter", name: "directory", codec: "directory" }],
        query: [],
      },
      composition: { kind: "redirect", routeId: "session-admission" },
    },
    {
      id: "session-admission",
      version: 1,
      location: {
        kind: "path",
        path: [
          { kind: "parameter", name: "directory", codec: "directory" },
          { kind: "literal", value: "session" },
        ],
        query: [{ name: "prompt", codec: "component", required: false }],
      },
      composition: { kind: "redirect", routeId: "new-session" },
    },
    {
      id: "new-session",
      version: 1,
      location: {
        kind: "path",
        path: [{ kind: "literal", value: "new-session" }],
        query: [
          { name: "draftId", codec: "component", required: true },
          { name: "prompt", codec: "component", required: false },
        ],
      },
      composition: { kind: "surface", surface: "newSession" },
    },
    {
      id: "session",
      version: 1,
      location: {
        kind: "path",
        path: [
          { kind: "parameter", name: "directory", codec: "directory" },
          { kind: "literal", value: "session" },
          { kind: "parameter", name: "sessionId", codec: "component" },
        ],
        query: [],
      },
      composition: { kind: "surface", surface: "session" },
    },
    {
      id: "settings",
      version: 1,
      location: { kind: "system", params: [] },
      composition: { kind: "surface", surface: "settings" },
    },
    {
      id: "dialog",
      version: 1,
      location: { kind: "system", params: [] },
      composition: { kind: "surface", surface: "dialog" },
    },
    {
      id: "recovery",
      version: 1,
      location: { kind: "system", params: [] },
      composition: { kind: "surface", surface: "recovery" },
    },
  ],
} as const satisfies { version: number; routes: readonly RouteManifestEntry[] }

export type RouteId = (typeof ROUTE_MANIFEST.routes)[number]["id"]

export interface RouteIdentity {
  manifestVersion: typeof ROUTE_MANIFEST_VERSION
  routeId: RouteId
  routeVersion: number
}

export type RouteErrorCode =
  | "corrupt-deep-link"
  | "invalid-directory"
  | "missing-param"
  | "unknown-route"
  | "unsupported-manifest-version"
  | "unsupported-route-version"

export interface RouteError {
  code: RouteErrorCode
  routeId?: string
  param?: string
  receivedVersion?: number
}

type IdentifiedRoute<T extends RouteId> = {
  identity: RouteIdentity & { routeId: T }
}

export type ResolvedRoute =
  | ({ kind: "home" } & IdentifiedRoute<"home">)
  | ({ kind: "directory"; directory: string; slug: string } & IdentifiedRoute<"directory">)
  | ({
      kind: "session"
      directory: string
      slug: string
      id?: undefined
      prompt?: string
    } & IdentifiedRoute<"session-admission">)
  | ({ kind: "newSession"; draftId: string; prompt?: string } & IdentifiedRoute<"new-session">)
  | ({ kind: "session"; directory: string; slug: string; id: string } & IdentifiedRoute<"session">)
  | ({ kind: "settings" } & IdentifiedRoute<"settings">)
  | ({ kind: "dialog" } & IdentifiedRoute<"dialog">)
  | ({ kind: "recovery" } & IdentifiedRoute<"recovery">)

export type RouteFailure = { kind: "recovery"; error: RouteError } & IdentifiedRoute<"recovery">
export type Route = ResolvedRoute | RouteFailure

export interface RouteReference {
  manifestVersion: number
  routeVersion: number
  routeId: string
  params?: Readonly<Record<string, unknown>>
}

export type RouteNavigation =
  | { ok: true; identity: RouteIdentity; route: ResolvedRoute; href?: string }
  | { ok: false; identity: RouteIdentity & { routeId: "recovery" }; route: RouteFailure; error: RouteError }

type DefinedRoute = (typeof ROUTE_MANIFEST.routes)[number]

const ROUTE_DEFINITIONS: readonly DefinedRoute[] = ROUTE_MANIFEST.routes

// ---------- Directory codec ----------

export function encodeDirectory(directory: string): string {
  const bytes = new TextEncoder().encode(directory)
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/** Reject malformed, non-canonical, or non-UTF-8 directory slugs. */
export function decodeDirectory(slug: string): string | undefined {
  if (!isDirectorySlug(slug) || slug.length % 4 === 1) return undefined
  try {
    const padding = "=".repeat((4 - (slug.length % 4)) % 4)
    const binary = atob(slug.replace(/-/g, "+").replace(/_/g, "/") + padding)
    const directory = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    )
    if (encodeDirectory(directory) !== slug) return undefined
    return directory
  } catch {
    return undefined
  }
}

export function isDirectorySlug(slug: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(slug)
}

// ---------- Parse / href from the shared location schema ----------

export function parseRoute(pathname: string, search?: string): Route {
  const queryIndex = pathname.indexOf("?")
  const path = queryIndex === -1 ? pathname : pathname.slice(0, queryIndex)
  const query = search ?? (queryIndex === -1 ? "" : pathname.slice(queryIndex + 1))
  const segments = splitPath(path)
  if (!segments) return recovery({ code: "corrupt-deep-link" })

  const candidates = ROUTE_DEFINITIONS.filter((entry) => entry.location.kind === "path").map((entry) => ({
    entry,
    matched: matchPath(entry, segments),
  }))
  const matched = candidates.find((candidate) => candidate.matched.kind === "match")
  if (matched?.matched.kind === "match") {
    const decoded = decodeQuery(matched.entry, query)
    if (!decoded.ok) return recovery({ ...decoded.error, routeId: matched.entry.id })
    return routeFromParams(matched.entry.id, { ...matched.matched.params, ...decoded.params })
  }

  const corrupt = candidates.find((candidate) => candidate.matched.kind === "corrupt")
  if (corrupt) return recovery({ code: "corrupt-deep-link", routeId: corrupt.entry.id })
  const invalidDirectory = candidates.find((candidate) => candidate.matched.kind === "invalid-directory")
  if (invalidDirectory)
    return recovery({ code: "invalid-directory", routeId: invalidDirectory.entry.id, param: "directory" })
  return recovery({ code: "unknown-route" })
}

/** Resolve a persisted/transported route identity without trusting its version or parameters. */
export function resolveNavigation(reference: unknown): RouteNavigation {
  if (!isRecord(reference)) return failedNavigation({ code: "corrupt-deep-link" })
  if (typeof reference.manifestVersion !== "number")
    return failedNavigation({ code: "missing-param", param: "manifestVersion" })
  if (reference.manifestVersion !== ROUTE_MANIFEST_VERSION)
    return failedNavigation({ code: "unsupported-manifest-version", receivedVersion: reference.manifestVersion })
  if (typeof reference.routeId !== "string") return failedNavigation({ code: "missing-param", param: "routeId" })

  const entry = ROUTE_DEFINITIONS.find((candidate) => candidate.id === reference.routeId)
  if (!entry) return failedNavigation({ code: "unknown-route", routeId: reference.routeId })
  if (typeof reference.routeVersion !== "number")
    return failedNavigation({ code: "missing-param", routeId: entry.id, param: "routeVersion" })
  if (reference.routeVersion !== entry.version)
    return failedNavigation({
      code: "unsupported-route-version",
      routeId: entry.id,
      receivedVersion: reference.routeVersion,
    })

  const params = reference.params ?? {}
  if (!isRecord(params)) return failedNavigation({ code: "corrupt-deep-link", routeId: entry.id })
  const encoded = encodeLocation(entry, params)
  if (!encoded.ok) return failedNavigation({ ...encoded.error, routeId: entry.id })
  return {
    ok: true,
    identity: identityFor(entry),
    route: routeFromParams(entry.id, encoded.params),
    ...(encoded.href === undefined ? {} : { href: encoded.href }),
  }
}

export function routeIdentity(route: Route): RouteIdentity {
  return route.identity
}

function referenceFor(routeId: RouteId, params: Readonly<Record<string, unknown>> = {}): RouteReference {
  const entry = ROUTE_DEFINITIONS.find((candidate) => candidate.id === routeId)!
  return {
    manifestVersion: ROUTE_MANIFEST_VERSION,
    routeVersion: entry.version,
    routeId,
    params,
  }
}

export const navFor = {
  route: resolveNavigation,
  home: () => resolveNavigation(referenceFor("home")),
  directory: (directory: string) => resolveNavigation(referenceFor("directory", { directory })),
  sessionAdmission: (directory: string, prompt?: string) =>
    resolveNavigation(referenceFor("session-admission", { directory, prompt })),
  directorySession: (directory: string, prompt?: string) =>
    resolveNavigation(referenceFor("session-admission", { directory, prompt })),
  newSession: (draftId: string, prompt?: string) => resolveNavigation(referenceFor("new-session", { draftId, prompt })),
  session: (directory: string, sessionId: string) =>
    resolveNavigation(referenceFor("session", { directory, sessionId })),
  settings: () => resolveNavigation(referenceFor("settings")),
  dialog: () => resolveNavigation(referenceFor("dialog")),
  recovery: () => resolveNavigation(referenceFor("recovery")),
} as const

export class RouteManifestError extends Error {
  readonly detail: RouteError

  constructor(detail: RouteError) {
    super(
      ["route-manifest", detail.code, detail.routeId, detail.param, detail.receivedVersion]
        .filter((part) => part !== undefined)
        .join(":"),
    )
    this.name = "RouteManifestError"
    this.detail = detail
  }
}

export const hrefFor = {
  home: () => requireHref(navFor.home()),
  directory: (directory: string) => requireHref(navFor.directory(directory)),
  sessionAdmission: (directory: string, prompt?: string) => requireHref(navFor.sessionAdmission(directory, prompt)),
  directorySession: (directory: string, prompt?: string) => requireHref(navFor.sessionAdmission(directory, prompt)),
  session: (directory: string, sessionId: string) => requireHref(navFor.session(directory, sessionId)),
  newSession: (draftId: string, prompt?: string) => requireHref(navFor.newSession(draftId, prompt)),
} as const

function splitPath(pathname: string): string[] | undefined {
  if (pathname === "/") return []
  if (!pathname.startsWith("/") || pathname.endsWith("/") || pathname.includes("//") || pathname.includes("#"))
    return undefined
  return pathname.slice(1).split("/")
}

type PathMatch =
  | { kind: "match"; params: Record<string, string> }
  | { kind: "miss" }
  | { kind: "invalid-directory" }
  | { kind: "corrupt" }

function matchPath(entry: RouteManifestEntry, segments: string[]): PathMatch {
  if (entry.location.kind !== "path" || entry.location.path.length !== segments.length) return { kind: "miss" }
  if (entry.location.path.some((part, index) => part.kind === "literal" && part.value !== segments[index]))
    return { kind: "miss" }

  const decoded = entry.location.path.flatMap((part, index) => {
    if (part.kind === "literal") return []
    return [{ part, value: decodeParameter(part.codec, segments[index]) }]
  })
  const failed = decoded.find((field) => field.value === undefined || field.value.length === 0)
  if (failed?.part.codec === "directory") return { kind: "invalid-directory" }
  if (failed) return { kind: "corrupt" }
  return { kind: "match", params: Object.fromEntries(decoded.map((field) => [field.part.name, field.value!])) }
}

type QueryDecode = { ok: true; params: Record<string, string | undefined> } | { ok: false; error: RouteError }

function decodeQuery(entry: RouteManifestEntry, search: string): QueryDecode {
  if (entry.location.kind !== "path") return { ok: true, params: {} }
  const schema = entry.location.query
  const query = search.startsWith("?") ? search.slice(1) : search
  if (query.includes("#")) return { ok: false, error: { code: "corrupt-deep-link" } }
  const encodedFields = query.length === 0 ? [] : query.split("&")
  if (encodedFields.some((field) => field.length === 0)) return { ok: false, error: { code: "corrupt-deep-link" } }

  const decodedFields = encodedFields.map((field) => {
    const equals = field.indexOf("=")
    return {
      name: decodeComponent(equals === -1 ? field : field.slice(0, equals)),
      value: decodeComponent(equals === -1 ? "" : field.slice(equals + 1)),
    }
  })
  if (decodedFields.some((field) => field.name === undefined || field.value === undefined))
    return { ok: false, error: { code: "corrupt-deep-link" } }

  const names = decodedFields.map((field) => field.name!)
  if (new Set(names).size !== names.length) return { ok: false, error: { code: "corrupt-deep-link" } }
  const unknown = decodedFields.find((field) => !schema.some((candidate) => candidate.name === field.name))
  if (unknown) return { ok: false, error: { code: "corrupt-deep-link", param: unknown.name } }

  const params = Object.fromEntries(decodedFields.map((field) => [field.name!, field.value!]))

  const missing = schema.find((field) => field.required && !params[field.name])
  if (missing) return { ok: false, error: { code: "missing-param", param: missing.name } }
  return { ok: true, params }
}

type LocationEncode =
  | { ok: true; href?: string; params: Record<string, string | undefined> }
  | { ok: false; error: RouteError }

function encodeLocation(entry: RouteManifestEntry, input: Readonly<Record<string, unknown>>): LocationEncode {
  const fields =
    entry.location.kind === "path"
      ? [...entry.location.path.filter((field) => field.kind === "parameter"), ...entry.location.query]
      : entry.location.params
  const known = new Set(fields.map((field) => field.name))
  const unknown = Object.keys(input).find((name) => !known.has(name))
  if (unknown) return { ok: false, error: { code: "corrupt-deep-link", param: unknown } }

  const decoded = fields.map((field) => {
    const value = input[field.name]
    const required = "required" in field ? field.required : true
    if (value === undefined || (required && value === "")) return { field, required, value: undefined }
    return { field, required, value }
  })
  const missing = decoded.find((field) => field.required && field.value === undefined)
  if (missing) return { ok: false, error: { code: "missing-param", param: missing.field.name } }
  const corrupt = decoded.find((field) => field.value !== undefined && typeof field.value !== "string")
  if (corrupt) return { ok: false, error: { code: "corrupt-deep-link", param: corrupt.field.name } }
  const params = Object.fromEntries(
    decoded.map((field) => [field.field.name, typeof field.value === "string" ? field.value : undefined]),
  )

  if (entry.location.kind === "system") return { ok: true, params }
  const path = entry.location.path
    .map((segment) =>
      segment.kind === "literal" ? segment.value : encodeParameter(segment.codec, params[segment.name]!),
    )
    .join("/")
  const query = entry.location.query
    .filter((field) => params[field.name] !== undefined)
    .map((field) => `${encodeURIComponent(field.name)}=${encodeParameter(field.codec, params[field.name]!)}`)
    .join("&")
  return { ok: true, href: `/${path}${query.length === 0 ? "" : `?${query}`}`, params }
}

function encodeParameter(codec: RouteParameterCodec, value: string): string {
  if (codec === "directory") return encodeDirectory(value)
  return encodeURIComponent(value)
}

function decodeParameter(codec: RouteParameterCodec, value: string): string | undefined {
  if (codec === "directory") return decodeDirectory(value)
  return decodeComponent(value)
}

function decodeComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "))
  } catch {
    return undefined
  }
}

function routeFromParams(routeId: RouteId, params: Readonly<Record<string, string | undefined>>): ResolvedRoute {
  const entry = ROUTE_DEFINITIONS.find((candidate) => candidate.id === routeId)!
  const identity = identityFor(entry)
  if (routeId === "home") return { kind: "home", identity: { ...identity, routeId } }
  if (routeId === "directory") {
    const directory = params.directory!
    return { kind: "directory", identity: { ...identity, routeId }, directory, slug: encodeDirectory(directory) }
  }
  if (routeId === "session-admission") {
    const directory = params.directory!
    return {
      kind: "session",
      identity: { ...identity, routeId },
      directory,
      slug: encodeDirectory(directory),
      ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
    }
  }
  if (routeId === "new-session") {
    return {
      kind: "newSession",
      identity: { ...identity, routeId },
      draftId: params.draftId!,
      ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
    }
  }
  if (routeId === "session") {
    const directory = params.directory!
    return {
      kind: "session",
      identity: { ...identity, routeId },
      directory,
      slug: encodeDirectory(directory),
      id: params.sessionId!,
    }
  }
  if (routeId === "settings") return { kind: "settings", identity: { ...identity, routeId } }
  if (routeId === "dialog") return { kind: "dialog", identity: { ...identity, routeId } }
  if (routeId === "recovery") return { kind: "recovery", identity: { ...identity, routeId } }
  return assertNever(routeId)
}

function identityFor(entry: DefinedRoute): RouteIdentity {
  return {
    manifestVersion: ROUTE_MANIFEST_VERSION,
    routeId: entry.id,
    routeVersion: entry.version,
  }
}

function recovery(error: RouteError): RouteFailure {
  const entry = ROUTE_DEFINITIONS.find((candidate) => candidate.id === "recovery")!
  return { kind: "recovery", identity: { ...identityFor(entry), routeId: "recovery" }, error }
}

function failedNavigation(error: RouteError): RouteNavigation {
  const route = recovery(error)
  return { ok: false, identity: route.identity, route, error }
}

function requireHref(result: RouteNavigation): string {
  if (!result.ok) throw new RouteManifestError(result.error)
  if (result.href === undefined)
    throw new RouteManifestError({ code: "corrupt-deep-link", routeId: result.identity.routeId })
  return result.href
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNever(value: never): never {
  throw new RouteManifestError({ code: "unknown-route", routeId: value })
}
