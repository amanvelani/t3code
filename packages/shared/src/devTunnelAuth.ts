const CALLBACK_SCHEMES = new Set(["t3code:", "t3code-dev:", "t3code-preview:"]);
const STATE_PATTERN = /^[\w-]{32,128}$/;

function tunnelOrigin(value: string): string | null {
  const url = URL.parse(value);
  return url?.protocol === "https:" &&
    url.hostname.endsWith(".devtunnels.ms") &&
    !url.port &&
    !url.username &&
    !url.password
    ? url.origin
    : null;
}

function callbackAddress(value: string): string | null {
  const url = URL.parse(value);
  return url &&
    CALLBACK_SCHEMES.has(url.protocol) &&
    url.host === "dev-tunnel-auth" &&
    (url.pathname === "" || url.pathname === "/") &&
    !url.search &&
    !url.hash
    ? `${url.protocol}//${url.host}`
    : null;
}

export function buildDevTunnelAuthUrl(input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly state: string;
  readonly callbackUrl: string;
}): string {
  const origin = tunnelOrigin(input.httpBaseUrl);
  const callback = callbackAddress(input.callbackUrl);
  if (!origin || !callback || !STATE_PATTERN.test(input.state) || !input.credential) {
    throw new Error("Invalid Dev Tunnel authentication request.");
  }
  const url = new URL("/auth/dev-tunnel", origin);
  // Fragments stay out of relay requests, server logs, and referrer headers.
  url.hash = new URLSearchParams({
    credential: input.credential,
    state: input.state,
    callback,
  }).toString();
  return url.toString();
}

export function readDevTunnelAuthCallback(
  value: string,
  pending: {
    readonly httpBaseUrl: string;
    readonly state: string;
    readonly callbackUrl: string;
  },
): string | null {
  const url = URL.parse(value);
  if (!url || url.search || url.username || url.password) return null;
  const address = new URL(url);
  address.hash = "";
  if (
    callbackAddress(address.toString()) !== callbackAddress(pending.callbackUrl) ||
    !callbackAddress(pending.callbackUrl) ||
    !STATE_PATTERN.test(pending.state)
  )
    return null;
  const params = new URLSearchParams(url.hash.slice(1));
  const origin = tunnelOrigin(pending.httpBaseUrl);
  const token = params.get("tunnelToken");
  return origin &&
    params.get("origin") === origin &&
    params.get("state") === pending.state &&
    token &&
    token.length <= 16_384 &&
    !/[\s\r\n]/.test(token)
    ? token
    : null;
}
