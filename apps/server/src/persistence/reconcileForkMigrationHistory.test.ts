import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const seedFork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  for (let id = 54; id >= 48; id--) {
    yield* sql`UPDATE effect_sql_migrations SET migration_id = ${id + 1} WHERE migration_id = ${id}`;
  }
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (48, 'RemoveAuthSessionIdentifyingMetadata')`;
});
it.effect("upgrades the released fork ledger to V2 without skipping schema changes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedFork;
    assert.deepStrictEqual(yield* runMigrations(), [
      [55, "OrchestrationV2"],
      [56, "RemoveRedundantProjectionIndexes"],
      [57, "RemoveAuthSessionIdentifyingMetadata"],
      [58, "ReusablePairingLinks"],
      [59, "ScheduledTaskWebhooks"],
      [60, "WebhookRelayDeliveries"],
      [61, "McpAppModelContext"],
    ]);
    const rows = yield* sql<{
      migration_id: number;
      name: string;
    }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
    assert.deepStrictEqual(
      rows.map((row) => [row.migration_id, row.name] as const),
      migrationManifest,
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.strictEqual(
      (yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_threads'`)
        .length,
      1,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
it.effect("rejects an unknown fork ledger without modifying it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedFork;
    yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownFork' WHERE migration_id = 55`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
