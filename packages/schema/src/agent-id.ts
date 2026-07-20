import { Schema } from "effect"

export const AgentID = Schema.String.pipe(Schema.brand("AgentV2.ID"))
export type AgentID = typeof AgentID.Type
