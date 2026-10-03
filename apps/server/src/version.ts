import packageJson from "../package.json" with { type: "json" };

declare const __T3CODE_BUILD_VERSION__: string | undefined;

export function resolveServerVersion(
  buildVersion: string | undefined,
  packageVersion: string,
): string {
  return buildVersion?.trim() || packageVersion.trim() || "0.0.0";
}

export const serverVersion = resolveServerVersion(
  typeof __T3CODE_BUILD_VERSION__ === "undefined" ? undefined : __T3CODE_BUILD_VERSION__,
  packageJson.version,
);
