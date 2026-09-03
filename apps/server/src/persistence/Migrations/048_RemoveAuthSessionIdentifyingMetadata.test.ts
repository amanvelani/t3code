import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_RemoveAuthSessionIdentifyingMetadata", (it) => {
  it.effect("scrubs identifying metadata from existing auth sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
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
          client_surface,
          client_app_version,
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
          'desktop',
          '1.0.0',
          '2026-05-29T00:00:00.000Z',
          '2026-05-29T01:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const rows = yield* sql<{
        readonly label: string | null;
        readonly ipAddress: string | null;
        readonly userAgent: string | null;
        readonly os: string | null;
        readonly browser: string | null;
        readonly surface: string | null;
        readonly appVersion: string | null;
      }>`
        SELECT
          client_label AS "label",
          client_ip_address AS "ipAddress",
          client_user_agent AS "userAgent",
          client_os AS "os",
          client_browser AS "browser",
          client_surface AS "surface",
          client_app_version AS "appVersion"
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
          surface: null,
          appVersion: null,
        },
      ]);
    }),
  );
});
