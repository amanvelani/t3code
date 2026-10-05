import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN reusable INTEGER NOT NULL DEFAULT 0 CHECK (reusable IN (0, 1))`;
});
