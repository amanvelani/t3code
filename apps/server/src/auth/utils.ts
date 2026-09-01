import * as NodeCrypto from "node:crypto";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

const SESSION_COOKIE_NAME = "t3_session";

/**
 * Cookies are scoped by host but *not* by port, so any two servers that can be
 * live on one hostname at once need separate names — otherwise the second
 * clobbers the first's session and both sides see "Invalid session token
 * signature" until someone clears cookies by hand.
 *
 * Remote web servers use their persisted environment identity and omit the
 * port, so the name survives state-directory moves and public port changes.
 *
 * Desktop scans upward from 3773 for a free port and binds
 *   127.0.0.1, so a second instance lands on a different port and the same host.
 */
export function resolveSessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly port: number;
  readonly host: string | undefined;
  readonly instanceKey: string;
  readonly environmentId: string;
  readonly development: boolean;
}): string {
  if (input.mode === "desktop") {
    return `${SESSION_COOKIE_NAME}_${input.port}`;
  }

  const instanceHash = NodeCrypto.createHash("sha256")
    .update(
      !input.development && isRemoteReachableHost(input.host)
        ? input.environmentId
        : input.instanceKey,
    )
    .digest("hex")
    .slice(0, 12);

  if (!input.development && isRemoteReachableHost(input.host)) {
    return `${SESSION_COOKIE_NAME}_${instanceHash}`;
  }

  // Cookies are scoped by host, not port. Loopback development servers need an
  // instance-specific name or parallel agents overwrite each other's session,
  // and a server that later reuses the port receives a token signed elsewhere.
  return `${SESSION_COOKIE_NAME}_${input.port}_${instanceHash}`;
}

export function resolveLegacySessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly host: string | undefined;
  readonly development: boolean;
}): string | undefined {
  return input.mode === "web" && !input.development && isRemoteReachableHost(input.host)
    ? SESSION_COOKIE_NAME
    : undefined;
}

export function isRemoteReachableHost(host: string | undefined): boolean {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return true;
  }
  if (!host || host.length === 0) {
    return false;
  }
  return !(
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

export function base64UrlEncode(input: string | Uint8Array): string {
  return typeof input === "string"
    ? Encoding.encodeBase64Url(new TextEncoder().encode(input))
    : Encoding.encodeBase64Url(input);
}

export function base64UrlDecodeUtf8(input: string): string {
  return Result.getOrThrow(Encoding.decodeBase64UrlString(input));
}

export function signPayload(payload: string, secret: Uint8Array): string {
  return NodeCrypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}
