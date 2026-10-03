# Product usage data

This fork disables network telemetry in web, desktop, mobile, and the server.
PostHog analytics, OpenTelemetry exports, relay tracing, and browser trace uploads
remain disabled even when old settings or environment variables enable them.

Local diagnostic logs and resource monitoring remain available. Normal connections
to your server, coding providers, and requested services still use the network.
