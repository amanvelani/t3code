import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

it.effect.each([false, true])(
  "scrubs identifying metadata with missing connection columns %s",
  (missingConnectionColumns) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      if (missingConnectionColumns) {
        yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_surface`;
        yield* sql`ALTER TABLE auth_sessions DROP COLUMN client_app_version`;
      }
      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          revoked_at
        )
        VALUES (
          'session-legacy-metadata',
          'desktop',
          '[]',
          'browser-session-cookie',
          'my laptop',
          '192.0.2.1',
          'ExampleBrowser/1.0',
          'desktop',
          'ExampleOS',
          'ExampleBrowser',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z',
          NULL
        )
      `;

      if (!missingConnectionColumns) {
        yield* sql`UPDATE auth_sessions SET client_surface = 'desktop', client_app_version = '1.0.0'`;
      }

      yield* runMigrations({ toMigrationInclusive: 57 });

      const rows = yield* sql<{
        readonly label: string | null;
        readonly ipAddress: string | null;
        readonly userAgent: string | null;
        readonly os: string | null;
        readonly browser: string | null;
      }>`
        SELECT
          client_label AS "label",
          client_ip_address AS "ipAddress",
          client_user_agent AS "userAgent",
          client_os AS "os",
          client_browser AS "browser"
        FROM auth_sessions
        WHERE session_id = 'session-legacy-metadata'
      `;

      assert.deepStrictEqual(rows, [
        {
          label: "my laptop",
          ipAddress: null,
          userAgent: null,
          os: null,
          browser: null,
        },
      ]);
      if (missingConnectionColumns) {
        const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
        assert.notInclude(
          columns.map((column) => column.name),
          "client_surface",
        );
        assert.notInclude(
          columns.map((column) => column.name),
          "client_app_version",
        );
      } else {
        assert.deepStrictEqual(
          yield* sql`SELECT client_surface, client_app_version FROM auth_sessions`,
          [{ client_surface: null, client_app_version: null }],
        );
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
