import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("058_ReusablePairingLinks", (it) => {
  it.effect("keeps existing pairing links one-time when upgrading", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, scopes, subject, created_at, expires_at
        ) VALUES (
          'old-link', 'old-credential', 'one-time-token', '[]', 'one-time-token',
          '2026-10-05T00:00:00.000Z', '2026-10-05T00:05:00.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 58 });
      const rows = yield* sql<{ readonly credential: string; readonly reusable: number }>`
        SELECT credential, reusable FROM auth_pairing_links WHERE id = 'old-link'
      `;
      assert.deepStrictEqual(rows, [{ credential: "old-credential", reusable: 0 }]);
    }),
  );
});
