import { expect, it, vi } from "vite-plus/test";
import { OtlpTracer } from "effect/unstable/observability";
import * as Layer from "effect/Layer";
import * as ClientTracer from "./clientTracer";
import { configureClientTracing } from "./clientTracing";

vi.mock("effect/unstable/observability", { spy: true });

vi.mock("../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: () =>
    "https://remote-server.example/api/observability/v1/traces",
}));
vi.mock("../environments/primary/httpLayer", () => ({ primaryEnvironmentHttpLayer: Layer.empty }));
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("~/branding", () => ({ APP_VERSION: "test" }));

it("does not create a browser exporter for default or explicit tracing configuration", async () => {
  await configureClientTracing();
  await configureClientTracing({ exportIntervalMs: 10 });
  expect(OtlpTracer.make).not.toHaveBeenCalled();
  expect(ClientTracer.hasDelegate()).toBe(false);
});
