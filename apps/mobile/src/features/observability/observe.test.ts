import { expect, it, vi } from "vite-plus/test";

const configure = vi.fn();
vi.mock("expo-observe", () => ({ Observe: { configure } }));

it("keeps crash report dispatch disabled even when enabled is requested", async () => {
  const { crashReportingAvailable, setCrashReportsEnabled } = await import("./observe");
  await setCrashReportsEnabled(true);
  expect(crashReportingAvailable).toBe(false);
  expect(configure).toHaveBeenCalledWith({ dispatchingEnabled: false });
  expect(configure).not.toHaveBeenCalledWith({ dispatchingEnabled: true });
});
