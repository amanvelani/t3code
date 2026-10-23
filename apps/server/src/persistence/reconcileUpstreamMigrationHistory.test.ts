import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import ScheduledTaskWebhooks from "./Migrations/059_ScheduledTaskWebhooks.ts";
import WebhookRelayDeliveries from "./Migrations/060_WebhookRelayDeliveries.ts";
import McpAppModelContext from "./Migrations/061_McpAppModelContext.ts";
import ThreadSnapshotWindowIndexes from "./Migrations/062_ThreadSnapshotWindowIndexes.ts";
import PullRequestReviewGuides from "./Migrations/063_PullRequestReviewGuides.ts";
import ThreadFailureLookupIndex from "./Migrations/064_ThreadFailureLookupIndex.ts";
import DropUnusedV1Projections from "./Migrations/065_DropUnusedV1Projections.ts";
import CanonicalizeThreadPullRequestLinks from "./Migrations/066_CanonicalizeThreadPullRequestLinks.ts";
import CodexUsageNativeTurnIndex from "./Migrations/067_CodexUsageNativeTurnIndex.ts";
import RepairClientSettlementTimestamps from "./Migrations/068_RepairClientSettlementTimestamps.ts";
import WebhookDedupe from "./Migrations/069_WebhookDedupe.ts";
import ShellStopRequestIndex from "./Migrations/070_ShellStopRequestIndex.ts";

const officialMigrations = [
  [57, "ScheduledTaskWebhooks", ScheduledTaskWebhooks],
  [58, "WebhookRelayDeliveries", WebhookRelayDeliveries],
  [59, "McpAppModelContext", McpAppModelContext],
  [60, "ThreadSnapshotWindowIndexes", ThreadSnapshotWindowIndexes],
  [61, "PullRequestReviewGuides", PullRequestReviewGuides],
  [62, "ThreadFailureLookupIndex", ThreadFailureLookupIndex],
  [63, "DropUnusedV1Projections", DropUnusedV1Projections],
  [64, "CanonicalizeThreadPullRequestLinks", CanonicalizeThreadPullRequestLinks],
  [65, "CodexUsageNativeTurnIndex", CodexUsageNativeTurnIndex],
  [66, "RepairClientSettlementTimestamps", RepairClientSettlementTimestamps],
  [67, "WebhookDedupe", WebhookDedupe],
  [68, "ShellStopRequestIndex", ShellStopRequestIndex],
] as const;

const seedOfficial = Effect.fnUntraced(function* (through: number) {
  yield* runMigrations({ toMigrationInclusive: 56 });
  yield* Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        officialMigrations
          .filter(([id]) => id <= through)
          .map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
});

const seedContent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const timestamp = "2026-10-22T00:00:00.000Z";
  for (const [id, kind, payload] of [
    ["project", "project", { workspaceRoot: "C:\\work\\project", title: "Existing project" }],
    [
      "thread",
      "thread",
      { title: "Existing conversation", pullRequests: [], messages: ["Keep me"] },
    ],
  ] as const) {
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (${id}, ${kind}, ${id}, 0, ${`${kind}.created`}, ${timestamp},
        'user', ${JSON.stringify(payload)}, '{}', 2)
    `;
  }
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES ('thread', 'project', 'Existing conversation', 'codex', 'full-access', 'default',
      ${timestamp}, ${timestamp}, '{"pullRequests":[],"title":"Existing conversation"}')
  `;
  yield* sql`
    INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at,
      client_ip_address, client_os)
    VALUES ('existing-session', 'existing-user', '["orchestration:read"]', 'pairing', ${timestamp},
      '2099-01-01T00:00:00.000Z', '192.0.2.1', 'Windows')
  `;
});

const content = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    events: yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
    threads: yield* sql`SELECT * FROM orchestration_v2_projection_threads ORDER BY thread_id`,
    sessions:
      yield* sql`SELECT session_id, subject, scopes, method, issued_at, expires_at FROM auth_sessions`,
  };
});

it.effect("upgrades the reported fork ledger at 65 without losing existing content", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 65 });
    yield* seedContent;
    const before = yield* content;
    const ledger = yield* history;
    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationManifest.filter(([id]) => id > 65),
    );
    assert.deepStrictEqual(yield* content, before);
    assert.deepStrictEqual((yield* history).slice(0, 65), ledger);
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([57, 62, 65, 67, 68])(
  "upgrades official history through %s once and preserves content",
  (through) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedOfficial(through);
      yield* seedContent;
      const before = yield* content;
      const ledger = yield* sql<{ migration_id: number; name: string; created_at: string }>`
      SELECT * FROM effect_sql_migrations WHERE migration_id >= 57 ORDER BY migration_id
    `;
      yield* runMigrations();
      assert.deepStrictEqual(yield* content, before);
      const migrated = yield* sql<{ migration_id: number; name: string; created_at: string }>`
      SELECT * FROM effect_sql_migrations WHERE migration_id BETWEEN 59 AND ${through + 2}
      ORDER BY migration_id
    `;
      assert.deepStrictEqual(
        migrated,
        ledger.map((row) => ({ ...row, migration_id: row.migration_id + 2 })),
      );
      assert.deepStrictEqual(
        (yield* sql<{
          migration_id: number;
          name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`).map(
          (row) => [row.migration_id, row.name] as const,
        ),
        migrationManifest,
      );
      assert.deepStrictEqual(yield* sql`SELECT client_ip_address, client_os FROM auth_sessions`, [
        { client_ip_address: null, client_os: null },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT reusable FROM auth_pairing_links`, []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each(["unknown", "gap", "future"])(
  "rejects %s official history without changing schema or content",
  (kind) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedOfficial(65);
      yield* seedContent;
      if (kind === "unknown")
        yield* sql`UPDATE effect_sql_migrations SET name = 'Unknown' WHERE migration_id = 64`;
      if (kind === "gap") yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 60`;
      if (kind === "future")
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (69, 'UnknownFuture')`;
      const before = yield* content;
      const ledger = yield* history;
      const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;
      const exit = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "Cannot upgrade unexpected upstream migration history");
      assert.deepStrictEqual(yield* history, ledger);
      assert.deepStrictEqual(yield* content, before);
      assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, schema);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "rolls back privacy cleanup and ledger changes when the missing schema change fails",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedOfficial(65);
      yield* seedContent;
      yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN reusable INTEGER NOT NULL DEFAULT 0`;
      const ledger = yield* history;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, ledger);
      assert.deepStrictEqual(yield* sql`SELECT client_ip_address, client_os FROM auth_sessions`, [
        { client_ip_address: "192.0.2.1", client_os: "Windows" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
