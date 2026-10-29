import { Observe } from "expo-observe";

export const crashReportingAvailable = false;

export async function setCrashReportsEnabled(_enabled: boolean) {
  Observe.configure({ dispatchingEnabled: false });
}

void setCrashReportsEnabled(false);
