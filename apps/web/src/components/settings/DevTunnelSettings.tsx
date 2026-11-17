import {
  AuthStandardClientScopes,
  type AuthPairingCredentialResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { authEnvironment } from "~/state/auth";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogPopup,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function DevTunnelSettings({
  environmentId,
  onPairingLinkCreated,
}: {
  environmentId: EnvironmentId;
  onPairingLinkCreated: (issued: AuthPairingCredentialResult) => void;
}) {
  const query = useEnvironmentQuery(serverEnvironment.devTunnel({ environmentId, input: {} }));
  const setEnabled = useAtomCommand(serverEnvironment.setDevTunnelEnabled, {
    reportFailure: false,
  });
  const createPairingCredential = useAtomCommand(authEnvironment.createPairingCredential, {
    reportFailure: false,
  });
  const issueToken = useAtomCommand(serverEnvironment.issueDevTunnelToken, {
    reportFailure: false,
  });
  const canEdit = useAtomValue(serverEnvironment.setDevTunnelEnabled.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "pairing link" });
  const state = query.data;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    const result = await setEnabled({ environmentId, input: { enabled } });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not configure Dev Tunnels.");
    }
    setBusy(false);
  };

  const createLink = async () => {
    if (state?.status !== "running" || !state.url) return;
    setBusy(true);
    setError(null);
    const connectToken = await issueToken({ environmentId, input: {} });
    if (connectToken._tag === "Failure") {
      const failure = squashAtomCommandFailure(connectToken);
      setError(failure instanceof Error ? failure.message : "Could not issue tunnel access.");
      setBusy(false);
      return;
    }
    try {
      const result = await createPairingCredential({
        environmentId,
        input: {
          label: "Dev Tunnels",
          reusable: true,
          scopes: AuthStandardClientScopes,
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not create a pairing link.");
      } else {
        const issued = result.value;
        onPairingLinkCreated(issued);
        const url = setPairingTokenOnUrl(new URL("/pair", state.url), issued.credential);
        const fragment = new URLSearchParams(url.hash.slice(1));
        fragment.set("tunnelToken", connectToken.value.token);
        url.hash = fragment.toString();
        setPairingUrl(url.toString());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a pairing link.");
    }
    setBusy(false);
  };

  return (
    <>
      <SettingsRow
        title={searchableSetting("dev-tunnels").title}
        description={
          state?.url ??
          (state?.status === "starting"
            ? "Connecting…"
            : "Private access from T3 Code apps and browsers. Install devtunnel and sign in on this server first.")
        }
        status={
          error || state?.error || query.error ? (
            <p className="text-xs text-destructive">{error ?? state?.error ?? query.error}</p>
          ) : undefined
        }
        control={
          <div className="flex items-center gap-2">
            {state?.status === "running" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !canEdit}
                onClick={() => void createLink()}
              >
                Create pairing link
              </Button>
            ) : state?.status === "failed" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !canEdit}
                onClick={() => void toggle(true)}
              >
                Retry
              </Button>
            ) : null}
            <Switch
              aria-label="Enable Dev Tunnels"
              checked={state?.enabled ?? false}
              disabled={busy || !canEdit || state === null}
              onCheckedChange={(enabled) => void toggle(enabled)}
            />
          </div>
        }
      />
      <Dialog
        open={pairingUrl !== null}
        onOpenChange={(open) => {
          if (!open) setPairingUrl(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Dev Tunnels pairing link</DialogTitle>
            <DialogDescription>
              Paste this link into Add environment in the T3 Code app. Native tunnel access expires
              after about a day; use Renew tunnel access if needed. For browser access, sign in to
              the tunnel with the owning Microsoft or GitHub account first. Revoke the pairing link
              in Authorized clients when you no longer need it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Textarea
              aria-label="Dev Tunnels pairing link"
              readOnly
              value={pairingUrl ?? ""}
              rows={4}
              onFocus={(event) => event.currentTarget.select()}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPairingUrl(null)}>
              Done
            </Button>
            <Button
              onClick={() => {
                if (pairingUrl) copyToClipboard(pairingUrl, undefined);
              }}
            >
              {isCopied ? "Copied" : "Copy link"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
