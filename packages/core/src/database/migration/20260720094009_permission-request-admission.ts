// north-star:alpha-owned — alpha 自有文件,住在上游包目录里。ADR-033 permission 内核接管的迁移。
// 这一行是 north-star 守卫的结构性谓词因子②(ADR-043);缺了它,对本文件的每一次修改都会被
// 当成上游改动而红。命名成 alpha-* 的文件不需要它。
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
