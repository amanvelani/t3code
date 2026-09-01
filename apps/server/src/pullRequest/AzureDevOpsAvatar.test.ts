import { AuthOrchestrationReadScope, AuthSessionId } from "@t3tools/contracts";
import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AzureDevOpsCli from "../sourceControl/AzureDevOpsCli.ts";
import {
  AZURE_DEVOPS_AVATAR_MAX_BYTES,
  AzureDevOpsAvatar,
  layer as avatarLayer,
  parseAzureDevOpsAvatarPath,
} from "./AzureDevOpsAvatar.ts";
import * as AzureDevOpsAvatarHttp from "./AzureDevOpsAvatarHttp.ts";

const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();
const PNG_SIGNATURE_BASE64 = "iVBORw0KGgo=";

const layer = it.layer(
  avatarLayer.pipe(
    Layer.provide(
      Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
        execute: mockedExecute,
      }),
    ),
  ),
);

function output(value: unknown) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: JSON.stringify(value),
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

afterEach(() => mockedExecute.mockReset());

it("accepts only T3's Azure cloud identity routes", () => {
  expect(
    parseAzureDevOpsAvatarPath(
      "/api/pull-requests/azure-avatars/dev.azure.com/acme/id/58f7d683-15d7-4e38-a261-2d167c134bda",
    ),
  ).toEqual({
    organization: "https://dev.azure.com/acme",
    identity: { kind: "id", value: "58f7d683-15d7-4e38-a261-2d167c134bda" },
  });
  expect(
    parseAzureDevOpsAvatarPath(
      "/api/pull-requests/azure-avatars/visualstudio.com/msazure/descriptor/aad.ABC_def-123",
    ),
  ).toEqual({
    organization: "https://msazure.visualstudio.com",
    identity: { kind: "descriptor", value: "aad.ABC_def-123" },
  });
  expect(
    parseAzureDevOpsAvatarPath(
      "/api/pull-requests/azure-avatars/example.com/acme/descriptor/aad.person",
    ),
  ).toBeNull();
  expect(
    parseAzureDevOpsAvatarPath(
      "/api/pull-requests/azure-avatars/dev.azure.com/acme/id/https%3A%2F%2Fevil.test%2Fa",
    ),
  ).toBeNull();
});

it.effect("requires an authenticated orchestration reader before serving an avatar", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const get = vi.fn(() =>
        Effect.succeed({
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          contentType: "image/png" as const,
        }),
      );
      const app = yield* HttpRouter.toHttpEffect(
        AzureDevOpsAvatarHttp.layer.pipe(Layer.provide(Layer.mock(AzureDevOpsAvatar)({ get }))),
      );
      const request = HttpServerRequest.fromWeb(
        new Request(
          "https://environment.test/api/pull-requests/azure-avatars/dev.azure.com/acme/descriptor/aad.person",
        ),
      );
      const unauthorized = yield* app.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateHttpRequest: () =>
              Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
          }),
        ),
      );
      const authorized = yield* app.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateHttpRequest: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("session-1"),
                subject: "test-user",
                method: "browser-session-cookie",
                scopes: [AuthOrchestrationReadScope],
              }),
          }),
        ),
      );

      expect(unauthorized.status).toBe(401);
      expect(authorized.status).toBe(200);
      expect(authorized.headers["content-type"]).toBe("image/png");
      expect(get).toHaveBeenCalledTimes(1);
    }),
  ),
);

layer("AzureDevOpsAvatar.layer", (it) => {
  it.effect("resolves an identity, fetches a PNG with Azure auth, and caches success", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output({ value: "aad.person" })))
        .mockReturnValueOnce(Effect.succeed(output({ value: PNG_SIGNATURE_BASE64 })));
      const avatars = yield* AzureDevOpsAvatar;
      const request = {
        cwd: "/w",
        organization: "https://dev.azure.com/acme",
        identity: {
          kind: "id" as const,
          value: "58f7d683-15d7-4e38-a261-2d167c134bda",
        },
      };

      const first = yield* avatars.get(request);
      const second = yield* avatars.get(request);

      expect([...first.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(second).toBe(first);
      expect(mockedExecute).toHaveBeenCalledTimes(2);
      expect(mockedExecute.mock.calls[0]?.[0].args).toEqual([
        "devops",
        "invoke",
        "--area",
        "graph",
        "--resource",
        "descriptors",
        "--route-parameters",
        "storageKey=58f7d683-15d7-4e38-a261-2d167c134bda",
        "--organization",
        "https://dev.azure.com/acme",
        "--api-version",
        "7.1",
        "--only-show-errors",
        "--output",
        "json",
      ]);
      expect(mockedExecute.mock.calls[1]?.[0].args).toContain("subjectDescriptor=aad.person");
    }),
  );

  it.effect("rejects oversized and non-PNG avatar responses without caching them", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output({ value: "A".repeat(Math.ceil(AZURE_DEVOPS_AVATAR_MAX_BYTES / 3) * 4 + 8) }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output({ value: "aGVsbG8=" })));
      const avatars = yield* AzureDevOpsAvatar;
      const oversized = yield* Effect.flip(
        avatars.get({
          cwd: "/w",
          organization: "https://dev.azure.com/acme",
          identity: { kind: "descriptor", value: "aad.too-large" },
        }),
      );
      const wrongType = yield* Effect.flip(
        avatars.get({
          cwd: "/w",
          organization: "https://dev.azure.com/acme",
          identity: { kind: "descriptor", value: "aad.not-png" },
        }),
      );

      assert.strictEqual(oversized._tag, "AzureDevOpsAvatarError");
      if (oversized._tag === "AzureDevOpsAvatarError")
        assert.strictEqual(oversized.reason, "too-large");
      assert.strictEqual(wrongType._tag, "AzureDevOpsAvatarError");
      if (wrongType._tag === "AzureDevOpsAvatarError") {
        assert.strictEqual(wrongType.reason, "unsupported-content-type");
      }
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );
});
