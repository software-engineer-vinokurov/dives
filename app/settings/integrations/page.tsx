import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { PadiConnectForm } from "@/components/padi-connect-form";
import { SuuntoConnectForm } from "@/components/suunto-connect-form";
import { GarminConnectForm } from "@/components/garmin-connect-form";
import { getGarminIntegrationStatus } from "@/lib/garmin/integrations";
import { countPendingGarminImports, getFirstPendingGarminImportId } from "@/lib/garmin/imports";
import { getPadiIntegrationStatus } from "@/lib/padi/integrations";
import { requireUser } from "@/lib/session";
import { getSuuntoIntegrationStatus } from "@/lib/suunto/integrations";
import { countPendingSuuntoImports, getFirstPendingSuuntoImportId } from "@/lib/suunto/imports";

export const metadata: Metadata = {
  title: "Integrations · Dives",
};

export default async function IntegrationsPage() {
  const user = await requireUser("/settings/integrations");
  const [padiStatus, suuntoStatus, pendingSuuntoImports, firstPendingSuuntoImportId, garminStatus, pendingGarminImports, firstPendingGarminImportId] = await Promise.all([
    getPadiIntegrationStatus(user.id),
    getSuuntoIntegrationStatus(user.id),
    countPendingSuuntoImports(user.id),
    getFirstPendingSuuntoImportId(user.id),
    getGarminIntegrationStatus(user.id),
    countPendingGarminImports(user.id),
    getFirstPendingGarminImportId(user.id),
  ]);

  return (
    <AppShell email={user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <Link
            href="/dashboard"
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Dashboard
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="text-sm text-muted-foreground">Connect other services to your logbook.</p>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-4 px-4">
            <h2 className="text-sm font-medium">PADI</h2>
            <PadiConnectForm
              status={
                padiStatus ? { status: padiStatus.status, connectedAt: padiStatus.connectedAt.toISOString() } : null
              }
            />
            <p className="text-xs text-muted-foreground">
              PADI sync imports new remote dives and flags linked recreational dives whose local
              copy differs from PADI. To replace a local linked dive with PADI’s version, delete the
              local dive and run Fetch PADI again.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-4 px-4">
            <h2 className="text-sm font-medium">Suunto</h2>
            <SuuntoConnectForm
              status={
                suuntoStatus
                  ? {
                      status: suuntoStatus.status,
                      connectedAt: suuntoStatus.connectedAt.toISOString(),
                      lastFetchAt: suuntoStatus.lastFetchAt?.toISOString() ?? null,
                    }
                  : null
              }
              pendingCount={pendingSuuntoImports}
              firstPendingImportId={firstPendingSuuntoImportId}
            />
            <p className="text-xs text-muted-foreground">
              Suunto fetch checks the latest workouts you choose, stages only dive workouts for
              review, and ignores workouts already staged or saved. To reimport a Suunto workout,
              delete the staged import or saved dive first, then fetch again.
            </p>
          </CardContent>
        </Card>


        <Card>
          <CardContent className="flex flex-col gap-4 px-4">
            <h2 className="text-sm font-medium">Garmin Connect</h2>
            <GarminConnectForm
              status={
                garminStatus
                  ? {
                      status: garminStatus.status,
                      connectedAt: garminStatus.connectedAt.toISOString(),
                      lastFetchAt: garminStatus.lastFetchAt?.toISOString() ?? null,
                    }
                  : null
              }
              pendingCount={pendingGarminImports}
              firstPendingImportId={firstPendingGarminImportId}
            />
            <p className="text-xs text-muted-foreground">
              Garmin sync imports raw FIT files directly from your Garmin Connect account, converting 
              Descent logs directly into your dive list. You will need to re-authenticate periodically.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
