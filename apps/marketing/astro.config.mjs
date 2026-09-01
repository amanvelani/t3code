import { defineConfig } from "astro/config";

// The Astro CLI ships optional anonymous telemetry. Keep it disabled for every
// local and CI command that loads this project configuration.
process.env.ASTRO_TELEMETRY_DISABLED = "1";

export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
