import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260720085655_permission-decision-receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_decision\` (
          \`decision_id\` text PRIMARY KEY,
          \`request_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`request_fingerprint\` text NOT NULL,
          \`request\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`message\` text,
          \`grant_scope\` text,
          \`grant_expires_at\` integer,
          \`resolved_request_ids\` text NOT NULL,
          \`committed_at\` integer NOT NULL,
          CONSTRAINT \`fk_permission_decision_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_decision_request_idx\` ON \`permission_decision\` (\`request_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
