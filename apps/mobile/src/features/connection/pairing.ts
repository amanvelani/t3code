import { readHostedPairingRequest } from "@t3tools/shared/remote";
import * as Schema from "effect/Schema";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";

const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

function isIpLiteral(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    if (hostname.includes(":")) return true;

    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

export class PairingQrPayloadEmptyError extends Schema.TaggedError<PairingQrPayloadEmptyError>()(
  "PairingQrPayloadEmptyError",
  {},
) {
  override get message(): string {
    return m(msg("Scanned QR code did not contain a pairing URL."));
  }
}

export interface ParsedPairingUrl {
  readonly host: string;
  readonly code: string;
  readonly tunnelToken?: string;
}

export function buildPairingUrl(
  host: string,
  code: string,
  options?: { readonly tunnelToken?: string } | string | null,
): string {
  const h = host.trim();
  const c = code.trim();
  const explicitTunnelToken =
    typeof options === "string"
      ? options.trim()
      : options && typeof options === "object" && options.tunnelToken
        ? options.tunnelToken.trim()
        : undefined;

  if (!h) return "";

  try {
    const url = new URL(h.includes("://") ? h : `${isIpLiteral(h) ? "http" : "https"}://${h}`);
    const hashParams = new URLSearchParams(url.hash.slice(1));
    const existingTunnelToken = hashParams.get("tunnelToken")?.trim();
    const tunnelToken = explicitTunnelToken ?? existingTunnelToken;

    const params = new URLSearchParams();
    if (c) {
      params.set("token", c);
    }
    if (tunnelToken) {
      params.set("tunnelToken", tunnelToken);
    }
    url.hash = params.toString();
    return url.toString();
  } catch {
    const parts: string[] = [];
    if (c) parts.push(`token=${c}`);
    if (explicitTunnelToken) parts.push(`tunnelToken=${explicitTunnelToken}`);
    return parts.length > 0 ? `${h}#${parts.join("&")}` : h;
  }
}

export function parsePairingUrl(url: string): ParsedPairingUrl {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "" };

  try {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      if (trimmed.includes("#") || trimmed.includes("?")) {
        parsed = new URL(`https://${trimmed}`);
      } else {
        return { host: trimmed, code: "" };
      }
    }

    const hostedPairingRequest = readHostedPairingRequest(parsed);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host.replace(/\/$/, ""),
        code: hostedPairingRequest.token,
      };
    }

    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const hashToken = hashParams.get("token");
    const queryToken = parsed.searchParams.get("token");
    const code = hashToken || queryToken || "";
    const hashTunnelToken = hashParams.get("tunnelToken")?.trim();
    const tunnelToken = hashTunnelToken || undefined;

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return {
      host: parsed.toString().replace(/\/$/, ""),
      code,
      ...(tunnelToken ? { tunnelToken } : {}),
    };
  } catch {
    return { host: trimmed, code: "" };
  }
}

export function extractPairingUrlFromQrPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new PairingQrPayloadEmptyError({});
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "t3code:") {
      const pairingUrl = url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() ?? "";
      if (pairingUrl.length > 0) {
        return pairingUrl;
      }
    }
  } catch {}

  return trimmed;
}
