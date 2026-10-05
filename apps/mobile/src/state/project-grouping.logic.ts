import type { ProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { DEFAULT_CLIENT_SETTINGS, type SidebarProjectGroupingMode } from "@t3tools/contracts";

import type { Preferences } from "../persistence/mobile-preferences";

export const DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS: ProjectGroupingSettings = {
  sidebarProjectGroupingMode: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode,
  sidebarProjectGroupingOverrides: {},
};

export function resolveMobileProjectGroupingSettings(
  preferences: Preferences,
): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode:
      preferences.projectGroupingMode ??
      (preferences.projectGroupingEnabled === true
        ? "repository"
        : preferences.projectGroupingEnabled === false
          ? "separate"
          : DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS.sidebarProjectGroupingMode),
    sidebarProjectGroupingOverrides: {},
  };
}

/**
 * Dual-writes the legacy boolean for one release so an OTA rollback to an
 * older mobile bundle preserves the user's grouping choice.
 */
export function mobileProjectGroupingModePatch(
  mode: SidebarProjectGroupingMode,
): Partial<Preferences> {
  return {
    projectGroupingMode: mode,
    projectGroupingEnabled: mode !== "separate",
  };
}
