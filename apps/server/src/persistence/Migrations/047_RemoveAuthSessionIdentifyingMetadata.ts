import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Remove identifying connection metadata collected by prior server versions.
 * Keep the columns for migration compatibility, but do not retain their values.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE auth_sessions
    SET
      client_ip_address = NULL,
      client_user_agent = NULL,
      client_os = NULL,
      client_browser = NULL,
      client_surface = NULL,
      client_app_version = NULL
  `;
});
