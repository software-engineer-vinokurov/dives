"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { fetchGarminActivitiesAction } from "@/app/actions/garmin";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";

export type GarminFetchStatus = "not_connected" | "needs_reconnect" | "connected";

export function FetchGarminButton({ status }: { status: GarminFetchStatus }) {
  const router = useRouter();
  const [daysBack, setDaysBack] = useState("10");
  const [fetchMode, setFetchMode] = useState<"days" | "all">("days");
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (status !== "connected") {
    return (
      <Link href="/settings/integrations" className={cn(buttonVariants({ variant: "outline" }), "no-underline")}>
        <RefreshCw />
        {status === "needs_reconnect" ? "Reconnect Garmin" : "Connect Garmin"}
      </Link>
    );
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
          if (result.reason !== "in_progress") router.refresh();
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
        setOpen(false);
        router.refresh();
        if (result.nextImportId !== null) {
          router.push(`/settings/integrations/garmin/imports/${result.nextImportId}`);
        }
      } catch {
        toast.error("Garmin import is temporarily unavailable. Please try again later.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isPending && setOpen(nextOpen)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={isPending}>
          {isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Fetch Garmin
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleFetch} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Fetch Garmin activities</DialogTitle>
            <DialogDescription>
              Check a recent window or your whole Garmin history. Dive activities that are already staged or saved are
              ignored.
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
              <Label htmlFor="dashboard-garmin-days">Recent days to check</Label>
              <Input
                id="dashboard-garmin-days"
                name="days"
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
              Fetches every dive activity in your Garmin history. This can take a while — for a large history you may
              need to click Fetch activities more than once; each run picks up where the last one stopped.
            </p>
          )}
          <DialogFooter>
            <Button
              type="submit"
              disabled={isPending || (fetchMode === "days" && (Number(daysBack) < 1 || Number(daysBack) > 365))}
            >
              {isPending ? <Loader2 className="animate-spin" /> : null}
              Fetch activities
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
