import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Remove identifying connection metadata retained by prior server versions.
 * Keep the columns for migration compatibility, but do not retain their values.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Some V1 installs used migration 41 for local schema instead of connection metadata.
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  yield* sql`UPDATE auth_sessions SET ${sql.update({
    client_ip_address: null,
    client_user_agent: null,
    client_os: null,
    client_browser: null,
    ...(columns.some((column) => column.name === "client_surface") ? { client_surface: null } : {}),
    ...(columns.some((column) => column.name === "client_app_version")
      ? { client_app_version: null }
      : {}),
  })}`;
});
