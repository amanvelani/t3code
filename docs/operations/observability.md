# Local diagnostics

> For maintainers. Using T3 Code? See [docs/user](../user/).

T3 Code does not export product analytics, traces, or metrics to a third-party
service. The server and desktop app may keep diagnostic data on the local
machine to support troubleshooting:

- human-readable logs go to the local process output;
- server spans are written to the local `server.trace.ndjson` file when local
  tracing is enabled;
- desktop diagnostics are written to the local desktop trace file;
- process and resource diagnostics stay in the environment and are available
  only through the authenticated diagnostics UI.

These local artifacts can contain operational details such as command names,
paths, identifiers, and error text. Treat them like other local application
logs. They are not sent to any analytics or remote observability endpoint by
this codebase.

## Local trace files

The server trace file is under the environment's logs directory:

- production or an explicitly configured home:
  `<home>/userdata/logs/server.trace.ndjson`;
- a linked worktree dev run:
  `<worktree>/.t3/userdata/logs/server.trace.ndjson`;
- an implicit dev run outside a linked worktree:
  `~/.t3/dev/logs/server.trace.ndjson`.

The desktop trace file is stored beside the desktop application's local state.
Provider event logs and terminal output logs are separate local artifacts.

## Inspecting diagnostics

Use the Diagnostics settings panel or inspect a trace file directly. For
example:

```sh
jq -c 'select(.type == "effect-span" and .exit._tag != "Success") | {
  name,
  durationMs,
  exit,
  attributes
}' /path/to/server.trace.ndjson
```

The authenticated diagnostics RPCs expose only the environment's own local
diagnostic data. No export URL or remote observability credential is supported
by the runtime configuration.
