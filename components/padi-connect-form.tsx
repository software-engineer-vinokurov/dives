"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { connectPadiAction, disconnectPadiAction } from "@/app/actions/padi";
import { BackupPadiButton } from "@/components/backup-padi-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PadiConnectStatus = {
  status: "connected" | "needs_reconnect";
  connectedAt: string;
} | null;

// Both the connect form and the connected/disconnect view live in one client component so a
// successful connect/disconnect can flip straight to the other view via router.refresh() (which
// re-runs the server component and passes a fresh `status` prop down), without a full page reload.
export function PadiConnectForm({ status }: { status: PadiConnectStatus }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isPending, startTransition] = useTransition();
  // Lets an already-connected user re-enter credentials directly (e.g. after a password change,
  // or to rule out stale/bad creds) without first clicking Disconnect and losing the connected
  // state in between.
  const [showReconnectForm, setShowReconnectForm] = useState(false);

  function handleConnect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(async () => {
      const result = await connectPadiAction(username, password);

      if (result.ok) {
        setPassword("");
        setShowReconnectForm(false);
        toast.success("PADI connected.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleDisconnect() {
    startTransition(async () => {
      const result = await disconnectPadiAction();

      if (result.ok) {
        setUsername("");
        setPassword("");
        setShowReconnectForm(false);
        toast.success("PADI disconnected.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (status?.status === "connected" && !showReconnectForm) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Connected since {new Date(status.connectedAt).toLocaleDateString()}.
        </p>
        <div className="flex flex-wrap gap-2">
          <BackupPadiButton />
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => setShowReconnectForm(true)}
            className="w-fit"
          >
            Reconnect PADI
          </Button>
          <Button type="button" variant="outline" disabled={isPending} onClick={handleDisconnect} className="w-fit">
            {isPending ? <Loader2 className="animate-spin" /> : null}
            Disconnect PADI
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleConnect} className="flex flex-col gap-4">
      {status?.status === "needs_reconnect" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">
            Your PADI connection needs to be reconnected. Enter your PADI login again below.
          </p>
          <Button type="button" variant="outline" disabled={isPending} onClick={handleDisconnect} className="w-fit">
            {isPending ? <Loader2 className="animate-spin" /> : null}
            Forget saved PADI connection
          </Button>
        </div>
      ) : null}
      {status?.status === "connected" && showReconnectForm ? (
        <p className="text-sm text-muted-foreground">
          Re-enter your PADI login below.{" "}
          <button
            type="button"
            onClick={() => setShowReconnectForm(false)}
            className="underline underline-offset-2"
          >
            Cancel
          </button>
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="padi-username">PADI login</Label>
        <Input
          id="padi-username"
          name="username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="padi-password">PADI password</Label>
        <Input
          id="padi-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Your password is used once to sign in to PADI and is never stored.
      </p>
      <Button type="submit" disabled={isPending} className="w-fit">
        {isPending ? <Loader2 className="animate-spin" /> : null}
        {status ? "Reconnect PADI" : "Connect PADI"}
      </Button>
    </form>
  );
}
