import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260720094009_permission-request-admission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_request\` (
          \`request_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`request_fingerprint\` text NOT NULL,
          \`request\` text NOT NULL,
          \`outcome\` text NOT NULL,
          CONSTRAINT \`fk_permission_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
