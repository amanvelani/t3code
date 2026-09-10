import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";

export const AZURE_DEVOPS_AVATAR_ROUTE_PREFIX = "/api/pull-requests/azure-avatars";
export const AZURE_DEVOPS_AVATAR_MAX_BYTES = 256 * 1024;

const API_VERSION = "7.1";
const ORGANIZATION_NAME = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/i;
const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESCRIPTOR = /^[a-z0-9._-]{1,512}$/i;

export interface AzureDevOpsAvatarIdentity {
  readonly kind: "id" | "descriptor";
  readonly value: string;
}

export interface AzureDevOpsAvatarRequest {
  readonly organization: string;
  readonly identity: AzureDevOpsAvatarIdentity;
}

export interface AzureDevOpsAvatarImage {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png";
}

export class AzureDevOpsAvatarError extends Schema.TaggedErrorClass<AzureDevOpsAvatarError>()(
  "AzureDevOpsAvatarError",
  {
    reason: Schema.Literals(["invalid-response", "too-large", "unsupported-content-type"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  get detail(): string {
    switch (this.reason) {
      case "too-large":
        return "The Azure DevOps avatar exceeded the response-size limit.";
      case "unsupported-content-type":
        return "Azure DevOps returned an unsupported avatar content type.";
      case "invalid-response":
        return "Azure DevOps returned an unreadable avatar response.";
    }
  }
}

export type AzureDevOpsAvatarServiceError =
  | AzureDevOpsCli.AzureDevOpsCliError
  | AzureDevOpsAvatarError;

export class AzureDevOpsAvatar extends Context.Service<
  AzureDevOpsAvatar,
  {
    readonly get: (
      input: AzureDevOpsAvatarRequest & { readonly cwd: string },
    ) => Effect.Effect<AzureDevOpsAvatarImage, AzureDevOpsAvatarServiceError>;
  }
>()("t3/pullRequest/AzureDevOpsAvatar") {}

const DescriptorResponse = Schema.Struct({ value: Schema.String });
const AvatarResponse = Schema.Struct({
  value: Schema.Union([Schema.String, Schema.Array(Schema.Int)]),
});
const decodeDescriptorResponse = decodeJsonResult(DescriptorResponse);
const decodeAvatarResponse = decodeJsonResult(AvatarResponse);

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function azureDevOpsOrganizationUrl(route: string, organization: string): string | null {
  if (!ORGANIZATION_NAME.test(organization)) return null;
  switch (route) {
    case "dev.azure.com":
      return `https://dev.azure.com/${organization}`;
    case "visualstudio.com":
      return `https://${organization}.visualstudio.com`;
    default:
      return null;
  }
}

/** Parses only the identity route T3 itself emits; no upstream URL is accepted from a client. */
export function parseAzureDevOpsAvatarPath(pathname: string): AzureDevOpsAvatarRequest | null {
  const prefix = `${AZURE_DEVOPS_AVATAR_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length !== 4) return null;
  const [route, encodedOrganization, kind, encodedIdentity] = parts;
  const organizationName = decodeSegment(encodedOrganization ?? "");
  const identityValue = decodeSegment(encodedIdentity ?? "");
  if (organizationName === null || identityValue === null) return null;
  const organization = azureDevOpsOrganizationUrl(route ?? "", organizationName);
  if (organization === null) return null;
  if (kind === "id" && STORAGE_KEY.test(identityValue)) {
    return { organization, identity: { kind, value: identityValue } };
  }
  if (kind === "descriptor" && DESCRIPTOR.test(identityValue)) {
    return { organization, identity: { kind, value: identityValue } };
  }
  return null;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function decodeAvatarBytes(value: string | ReadonlyArray<number>) {
  if (typeof value === "string") {
    // Base64 expands three bytes to four characters. Refuse oversized input before allocating
    // the decoded image as well as after it has been decoded.
    if (value.length > Math.ceil(AZURE_DEVOPS_AVATAR_MAX_BYTES / 3) * 4 + 4) {
      return Result.fail(new AzureDevOpsAvatarError({ reason: "too-large" }));
    }
    const decoded = Encoding.decodeBase64(value);
    if (!Result.isSuccess(decoded)) {
      return Result.fail(
        new AzureDevOpsAvatarError({ reason: "invalid-response", cause: decoded.failure }),
      );
    }
    return Result.succeed(decoded.success);
  }
  if (
    value.length > AZURE_DEVOPS_AVATAR_MAX_BYTES ||
    value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    return Result.fail(new AzureDevOpsAvatarError({ reason: "too-large" }));
  }
  return Result.succeed(Uint8Array.from(value));
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;
  const cache = new Map<string, AzureDevOpsAvatarImage>();

  const executeJson = (input: {
    readonly cwd: string;
    readonly organization: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    azure.execute({
      cwd: input.cwd,
      args: [
        "devops",
        "invoke",
        ...input.args,
        "--organization",
        input.organization,
        "--api-version",
        API_VERSION,
        "--only-show-errors",
        "--output",
        "json",
      ],
    });

  const get: AzureDevOpsAvatar["Service"]["get"] = Effect.fn("AzureDevOpsAvatar.get")(
    function* (input) {
      const cacheKey = `${input.organization}\0${input.identity.kind}\0${input.identity.value}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;

      let descriptor = input.identity.value;
      if (input.identity.kind === "id") {
        const descriptorOutput = yield* executeJson({
          cwd: input.cwd,
          organization: input.organization,
          args: [
            "--area",
            "graph",
            "--resource",
            "descriptors",
            "--route-parameters",
            `storageKey=${input.identity.value}`,
          ],
        });
        const decoded = decodeDescriptorResponse(descriptorOutput.stdout.trim());
        if (!Result.isSuccess(decoded) || !DESCRIPTOR.test(decoded.success.value)) {
          return yield* new AzureDevOpsAvatarError({
            reason: "invalid-response",
            ...(!Result.isSuccess(decoded) ? { cause: decoded.failure } : {}),
          });
        }
        descriptor = decoded.success.value;
      }

      const avatarOutput = yield* executeJson({
        cwd: input.cwd,
        organization: input.organization,
        args: [
          "--area",
          "graph",
          "--resource",
          "avatars",
          "--route-parameters",
          `subjectDescriptor=${descriptor}`,
          "--query-parameters",
          "size=small",
          "format=png",
        ],
      });
      const decoded = decodeAvatarResponse(avatarOutput.stdout.trim());
      if (!Result.isSuccess(decoded)) {
        return yield* new AzureDevOpsAvatarError({
          reason: "invalid-response",
          cause: decoded.failure,
        });
      }
      const bytes = decodeAvatarBytes(decoded.success.value);
      if (!Result.isSuccess(bytes)) return yield* bytes.failure;
      if (bytes.success.length > AZURE_DEVOPS_AVATAR_MAX_BYTES) {
        return yield* new AzureDevOpsAvatarError({ reason: "too-large" });
      }
      if (!isPng(bytes.success)) {
        return yield* new AzureDevOpsAvatarError({ reason: "unsupported-content-type" });
      }
      const image = { bytes: bytes.success, contentType: "image/png" } as const;
      cache.set(cacheKey, image);
      return image;
    },
  );

  return AzureDevOpsAvatar.of({ get });
});

export const layer = Layer.effect(AzureDevOpsAvatar, make);
