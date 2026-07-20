import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Permission } from "@opencode-ai/schema/permission"
import { Timestamps } from "../database/schema.sql"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"
import type { PermissionSaved } from "./saved"

export const PermissionTable = sqliteTable(
  "permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    resource: text().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("permission_project_action_resource_idx").on(table.project_id, table.action, table.resource)],
)

export const PermissionRequestTable = sqliteTable("permission_request", {
  request_id: text().$type<Permission.ID>().primaryKey(),
  session_id: text()
    .$type<Permission.Request["sessionID"]>()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  request_fingerprint: text().$type<Permission.Fingerprint>().notNull(),
  request: text({ mode: "json" }).$type<Permission.Request>().notNull(),
  outcome: text().$type<Permission.Effect>().notNull(),
})

export const PermissionDecisionTable = sqliteTable(
  "permission_decision",
  {
    decision_id: text().$type<Permission.DecisionID>().primaryKey(),
    request_id: text().$type<Permission.ID>().notNull(),
    session_id: text()
      .$type<Permission.Request["sessionID"]>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    request_fingerprint: text().$type<Permission.Fingerprint>().notNull(),
    request: text({ mode: "json" }).$type<Permission.Request>().notNull(),
    decision: text().$type<Permission.Decision>().notNull(),
    message: text(),
    grant_scope: text({ mode: "json" }).$type<Permission.ProjectScope>(),
    grant_expires_at: integer(),
    resolved_request_ids: text({ mode: "json" }).$type<Permission.ID[]>().notNull(),
    committed_at: integer().notNull(),
  },
  (table) => [uniqueIndex("permission_decision_request_idx").on(table.request_id)],
)
