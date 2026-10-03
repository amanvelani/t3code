# Product analytics

This fork disables network telemetry through the shared
[telemetry policy](../../packages/shared/src/telemetryPolicy.ts). Saved opt-ins,
bootstrap collectors, and environment variables cannot override it. Keep the policy
at exporter boundaries: analytics, server/desktop OTLP endpoint resolution, relay
tracing across clients, and web trace uploads. Local diagnostic files remain enabled.

Upstream exporter mechanics retain separate tests; privacy regression tests must run
with the real policy and verify that configured collectors receive no requests.
