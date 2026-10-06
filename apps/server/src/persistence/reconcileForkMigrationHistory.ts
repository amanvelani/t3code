import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

// The released fork inserted a privacy migration at 48, shifting upstream 48–54.
// Normalize only that known ledger so the V2 migration at 55 is not skipped.
export const reconcileForkMigrationHistory = Effect.fn("reconcileForkMigrationHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
        if (tables.length === 0) return;
        const rows = yield* sql<{
          migration_id: number;
          name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 48 ORDER BY migration_id`;
        if (rows[0]?.migration_id !== 48 || rows[0].name !== "RemoveAuthSessionIdentifyingMetadata")
          return;
        const names = [
          "ProjectionThreadBranchPullRequest",
          "ProjectionThreadsActiveOrderKey",
          "ProjectionThreadPullRequests",
          "ProjectionThreadMessageContext",
          "ProjectionThreadTitleState",
          "PullRequestFilesViewed",
          "ProjectionThreadsAutoSettleDisabledAt",
        ];
        if (
          rows
            .slice(1)
            .some((row, index) => row.migration_id !== index + 49 || row.name !== names[index])
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot normalize unexpected fork migration history.",
          });
        }
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 48`;
        for (const row of rows.slice(1)) {
          yield* sql`UPDATE effect_sql_migrations SET migration_id = ${row.migration_id - 1} WHERE migration_id = ${row.migration_id}`;
        }
      }),
    );
  },
);
