# Product usage data

This fork disables network telemetry in web, desktop, mobile, and the server.
PostHog analytics, OpenTelemetry exports, relay tracing, and browser trace uploads
remain disabled even when old settings or environment variables enable them.
OpenTelemetry endpoint checks are also disabled and do not send network requests.

Local diagnostic logs and resource monitoring remain available. Normal connections
to your server, coding providers, and requested services still use the network.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the T3 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product events and relay diagnostics. The telemetry opt-out does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.
