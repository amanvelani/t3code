import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import RemoveAuthSessionIdentifyingMetadata from "./Migrations/057_RemoveAuthSessionIdentifyingMetadata.ts";
import ReusablePairingLinks from "./Migrations/058_ReusablePairingLinks.ts";

// Official builds omit the fork's 57/58. Recognize only a complete known
// upstream prefix, and apply the missing schema changes with the ledger move.
export const reconcileUpstreamMigrationHistory = Effect.fn("reconcileUpstreamMigrationHistory")(
  function* (manifest: ReadonlyArray<readonly [number, string]>) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return;
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations
          WHERE migration_id >= 55 ORDER BY migration_id
        `;
        if (!history.some((row) => row.migration_id === 57 && row.name === "ScheduledTaskWebhooks"))
          return;
        const names = new Map(manifest);
        if (
          !history.every(
            (row, index) =>
              row.migration_id === index + 55 &&
              names.get(row.migration_id >= 57 ? row.migration_id + 2 : row.migration_id) ===
                row.name,
          )
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade unexpected upstream migration history to this fork.",
          });
        }

        yield* RemoveAuthSessionIdentifyingMetadata;
        yield* ReusablePairingLinks;
        // Descending updates avoid primary-key collisions and retain original timestamps.
        for (const row of history.toReversed()) {
          if (row.migration_id < 57) continue;
          yield* sql`
            UPDATE effect_sql_migrations SET migration_id = ${row.migration_id + 2}
            WHERE migration_id = ${row.migration_id}
          `;
        }
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (57, 'RemoveAuthSessionIdentifyingMetadata'), (58, 'ReusablePairingLinks')
        `;
      }),
    );
  },
);
