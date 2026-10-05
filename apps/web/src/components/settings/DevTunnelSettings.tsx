import {
  AuthStandardClientScopes,
  type AuthPairingCredentialResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { createServerPairingCredential } from "~/environments/primary";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { setPairingTokenOnUrl } from "~/pairingUrl";
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
    try {
      const issued = await createServerPairingCredential({
        label: "Dev Tunnels",
        reusable: true,
        scopes: AuthStandardClientScopes,
      });
      onPairingLinkCreated(issued);
      setPairingUrl(
        setPairingTokenOnUrl(new URL("/pair", state.url), issued.credential).toString(),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a pairing link.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsRow
        title={searchableSetting("dev-tunnels").title}
        description={
          state?.url ??
          (state?.status === "starting"
            ? "Connecting…"
            : "Private HTTPS access from another browser. Install devtunnel and sign in on this server first.")
        }
        status={
          error || state?.error || query.error ? (
            <p className="text-xs text-destructive">{error ?? state?.error ?? query.error}</p>
          ) : undefined
        }
        control={
          <div className="flex items-center gap-2">
            {state?.status === "running" ? (
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void createLink()}>
                Create pairing link
              </Button>
            ) : state?.status === "failed" ? (
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void toggle(true)}>
                Retry
              </Button>
            ) : null}
            <Switch
              aria-label="Enable Dev Tunnels"
              checked={state?.enabled ?? false}
              disabled={busy || state === null}
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
              On the other device, open the tunnel address and sign in with the same Microsoft or
              GitHub account first. Then open this reusable link in that browser. It works for
              multiple devices for 30 days. Revoke it in Authorized clients when you no longer need
              it.
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
