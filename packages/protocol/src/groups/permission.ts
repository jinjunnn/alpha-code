import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Permission } from "@opencode-ai/schema/permission"
import { PermissionSaved } from "@opencode-ai/schema/permission-saved"
import { Project } from "@opencode-ai/schema/project"
import { Session } from "@opencode-ai/schema/session"
import { ToolPolicyInventoryV1 } from "@opencode-ai/schema/alpha-tool-inventory"
import { ToolPolicyRecord, ToolPolicySelector } from "@opencode-ai/schema/alpha-tool-policy"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  PermissionNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

// REQ-131 / #1130:tool policy 面的写侧错误集。503 = 引擎没接线(standalone server);
// 409 = 策略文档待恢复(先 reset);500 = 落盘失败。三者都不是「静默成功」。
const toolPolicyWriteErrors = [ServiceUnavailableError, ConflictError, UnknownError] as const

export const makePermissionGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.permission")
    .add(
      HttpApiEndpoint.get("permission.request.list", "/api/permission/request", {
        query: LocationQuery,
        success: Location.response(Schema.Array(Permission.Request)),
      })
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.permission.request.list",
            summary: "List pending permission requests",
            description: "Retrieve pending permission requests for a location.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("permission.saved.list", "/api/permission/saved", {
        query: Schema.Struct({ projectID: Project.ID.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Schema.Array(PermissionSaved.Info) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.saved.list",
          summary: "List saved permissions",
          description: "Retrieve saved permissions, optionally filtered by project.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("permission.saved.remove", "/api/permission/saved/:id", {
        params: { id: PermissionSaved.ID },
        success: HttpApiSchema.NoContent,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.saved.remove",
          summary: "Remove saved permission",
          description: "Remove a saved permission by ID.",
        }),
      ),
    )
    // ── REQ-131 / #1130:tool policy 面(Settings「工具」节的唯一数据源与写口)──────────────
    // 挂在 location 中间件之前 ⇒ 与 permission.saved.list 同一 location 解析
    // (x-opencode-directory / location[directory]);策略文档按 (account, workspace) 分区,
    // 所以每个端点都是 per-location 的。引擎侧未接线 ⇒ 503(fail-closed),不返回空清单。
    .add(
      HttpApiEndpoint.get("permission.tool-policy.inventory", "/api/permission/tool-policy/inventory", {
        success: Schema.Struct({ data: ToolPolicyInventoryV1 }),
        error: ServiceUnavailableError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.tool-policy.inventory",
          summary: "List tool policy inventory",
          description:
            "Live tool inventory (builtin / plugin / host / MCP) with effective policy state for the location's engine instance.",
        }),
      ),
    )
    // payload 就是 `ToolPolicyRecord` 本体:service/tool 层 enabled 必须带 bindingDigest、class 层
    // 必须不带 —— 这条 §5 纪律由 schema 在 wire 上执行(400),不落盘、不进 quarantine。
    .add(
      HttpApiEndpoint.put("permission.tool-policy.record.set", "/api/permission/tool-policy/record", {
        payload: ToolPolicyRecord,
        success: HttpApiSchema.NoContent,
        error: toolPolicyWriteErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.tool-policy.record.set",
          summary: "Set tool policy record",
          description: "Write one user tool policy record (class / service / tool selector) for the location.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("permission.tool-policy.record.remove", "/api/permission/tool-policy/record/remove", {
        payload: Schema.Struct({ selector: ToolPolicySelector }),
        success: HttpApiSchema.NoContent,
        error: toolPolicyWriteErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.tool-policy.record.remove",
          summary: "Remove tool policy record",
          description: "Remove the user tool policy record for one selector so the tool inherits again.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("permission.tool-policy.reset", "/api/permission/tool-policy/reset", {
        success: Schema.Struct({ data: Schema.Struct({ backup: Schema.optional(Schema.String) }) }),
        error: ServiceUnavailableError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.permission.tool-policy.reset",
          summary: "Reset tool policy document",
          description:
            "Move the location's user tool policy document aside (a backup path is returned) so defaults apply again.",
        }),
      ),
    )
    // Effect applies group middleware only to endpoints already added; session endpoints use session placement below.
    .middleware(locationMiddleware)
    .add(
      HttpApiEndpoint.post("session.permission.create", "/api/session/:sessionID/permission", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Permission.ID.pipe(Schema.optional),
          action: Permission.Request.fields.action,
          resources: Permission.Request.fields.resources,
          save: Permission.Request.fields.save,
          metadata: Permission.Request.fields.metadata,
          source: Permission.Request.fields.source,
          agent: Agent.ID.pipe(Schema.optional),
        }),
        success: Schema.Struct({
          data: Schema.Union([
            Schema.Struct({
              status: Schema.Literal("evaluated"),
              id: Permission.ID,
              effect: Schema.Literals(["allow", "deny"]),
            }),
            Schema.Struct({ status: Schema.Literal("pending"), request: Permission.Request }),
            Schema.Struct({ status: Schema.Literal("decided"), receipt: Permission.DecisionReceipt }),
          ]),
        }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.create",
            summary: "Create permission request",
            description: "Evaluate and, when approval is required, create a permission request for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.list", "/api/session/:sessionID/permission", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(Permission.Request) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.list",
            summary: "List session permission requests",
            description: "Retrieve pending permission requests owned by a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.permission.get", "/api/session/:sessionID/permission/:requestID", {
        params: { sessionID: Session.ID, requestID: Permission.ID },
        success: Schema.Struct({ data: Permission.Request }),
        error: [SessionNotFoundError, PermissionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.get",
            summary: "Get permission request",
            description: "Retrieve a pending permission request owned by a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.permission.reply", "/api/session/:sessionID/permission/:requestID/reply", {
        params: { sessionID: Session.ID, requestID: Permission.ID },
        payload: Permission.DecisionCommand,
        success: Schema.Struct({ data: Permission.DecisionReceipt }),
        error: [ConflictError, SessionNotFoundError, PermissionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.permission.reply",
            summary: "Reply to pending permission request",
            description: "Atomically decide a permission request or return its exact persisted decision receipt.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "permissions", description: "Experimental permission routes." }))
