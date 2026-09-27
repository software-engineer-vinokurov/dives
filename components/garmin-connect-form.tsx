"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  connectGarminAction,
  disconnectGarminAction,
  fetchGarminActivitiesAction,
} from "@/app/actions/garmin";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type GarminConnectStatus = {
  status: "connected" | "needs_reconnect";
  connectedAt: string;
  lastFetchAt: string | null;
} | null;

export function GarminConnectForm({
  status,
  pendingCount,
  firstPendingImportId,
}: {
  status: GarminConnectStatus;
  pendingCount: number;
  firstPendingImportId: number | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [daysBack, setDaysBack] = useState("10");
  const [fetchMode, setFetchMode] = useState<"days" | "all">("days");
  const [showReconnectForm, setShowReconnectForm] = useState(false);
  const [fetchOpen, setFetchOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConnect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    startTransition(async () => {
      const result = await connectGarminAction(email, password);
      if (result.ok) {
        setPassword("");
        setShowReconnectForm(false);
        toast.success("Garmin connected.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleDisconnect() {
    startTransition(async () => {
      const result = await disconnectGarminAction();
      if (result.ok) {
        setEmail("");
        setPassword("");
        setShowReconnectForm(false);
        toast.success("Garmin disconnected.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleFetch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const count = Number(daysBack);
    if (fetchMode === "days" && !Number.isFinite(count)) return;

    startTransition(async () => {
      try {
        const result =
          fetchMode === "all"
            ? await fetchGarminActivitiesAction({ mode: "all" })
            : await fetchGarminActivitiesAction({ mode: "days", daysBack: count });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }

        if (result.remaining) {
          toast.success(`Staged ${result.staged} so far — click Fetch activities again to continue.`);
        } else {
          const skipped = result.alreadySaved + result.alreadyStaged + result.skippedNonDives + result.failedExports;
          toast.success(
            `Checked ${result.checked} activities from the selected time window: staged ${result.staged}${skipped ? `, skipped ${skipped}` : ""}.`,
          );
        }
        setFetchOpen(false);
        router.refresh();
        if (result.nextImportId !== null) {
          router.push(`/settings/integrations/garmin/imports/${result.nextImportId}`);
        }
      } catch {
        // An all-time fetch can run for minutes, so a dropped connection (or a server action that
        // rejects outright) is realistic enough to deserve a toast instead of an error boundary.
        toast.error("Garmin import is temporarily unavailable. Please try again later.");
      }
    });
  }

  if (status?.status === "connected" && !showReconnectForm) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Connected since {new Date(status.connectedAt).toLocaleDateString()}.
          {status.lastFetchAt ? ` Last fetched ${new Date(status.lastFetchAt).toLocaleString()}.` : ""}
        </p>
        {pendingCount > 0 ? (
          <div className="flex flex-col gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
            <p>
              {pendingCount} staged {pendingCount === 1 ? "dive is" : "dives are"} waiting for review.
            </p>
            {firstPendingImportId !== null ? (
              <Link
                href={`/settings/integrations/garmin/imports/${firstPendingImportId}`}
                className="w-fit rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground no-underline hover:bg-primary/90"
              >
                Review staged dives
              </Link>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Dialog open={fetchOpen} onOpenChange={(open) => !isPending && setFetchOpen(open)}>
            <DialogTrigger asChild>
              <Button type="button" disabled={isPending} className="w-fit">
                Fetch Garmin activities
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={handleFetch} className="flex flex-col gap-4">
                <DialogHeader>
                  <DialogTitle>Fetch Garmin activities</DialogTitle>
                  <DialogDescription>
                    Check a recent window or your whole Garmin history. Dive activities that are
                    already staged or saved are ignored.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-1.5">
                  <Label>Time range</Label>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    value={fetchMode}
                    onValueChange={(value) => value && setFetchMode(value as "days" | "all")}
                    disabled={isPending}
                  >
                    <ToggleGroupItem value="days">Recent days</ToggleGroupItem>
                    <ToggleGroupItem value="all">All time</ToggleGroupItem>
                  </ToggleGroup>
                </div>
                {fetchMode === "days" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="garmin-limit">Recent days to check</Label>
                    <Input
                      id="garmin-limit"
                      name="limit"
                      type="number"
                      min={1}
                      max={365}
                      value={daysBack}
                      onChange={(event) => setDaysBack(event.target.value)}
                      required
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Fetches every dive workout in your Garmin history. This can take a while — for a
                    large history you may need to click Fetch activities more than once; each run picks
                    up where the last one stopped.
                  </p>
                )}
                <DialogFooter>
                  <Button
                    type="submit"
                    disabled={
                      isPending || (fetchMode === "days" && (Number(daysBack) < 1 || Number(daysBack) > 365))
                    }
                  >
                    {isPending ? <Loader2 className="animate-spin" /> : null}
                    Fetch activities
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => setShowReconnectForm(true)}
            className="w-fit"
          >
            Reconnect Garmin
          </Button>
          <Button type="button" variant="outline" disabled={isPending} onClick={handleDisconnect} className="w-fit">
            {isPending ? <Loader2 className="animate-spin" /> : null}
            Disconnect Garmin
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleConnect} className="flex flex-col gap-4">
      {status?.status === "needs_reconnect" ? (
        <p className="text-sm text-destructive">
          Your Garmin session expired. Enter your Garmin App login again below.
        </p>
      ) : null}
      {status?.status === "connected" && showReconnectForm ? (
        <p className="text-sm text-muted-foreground">
          Re-enter your Garmin App login below. {" "}
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
        <Label htmlFor="garmin-email">Garmin email</Label>
        <Input
          id="garmin-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="garmin-password">Garmin password</Label>
        <Input
          id="garmin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Your password is sent to garminol once via stdin to create a reusable session, and is never stored.
      </p>
      <Button type="submit" disabled={isPending} className="w-fit">
        {isPending ? <Loader2 className="animate-spin" /> : null}
        {status ? "Reconnect Garmin" : "Connect Garmin"}
      </Button>
    </form>
  );
}
