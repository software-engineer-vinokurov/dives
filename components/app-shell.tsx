import Link from "next/link";
import { Waves } from "lucide-react";

import { FeedbackButton } from "@/components/feedback-button";
import { LiveDiveUpdates } from "@/components/live-dive-updates";
import { LogoutButton } from "@/components/logout-button";
import { ManageMenu } from "@/components/manage-menu";
import { ModeToggle } from "@/components/mode-toggle";
import { NavLink } from "@/components/nav-link";

/**
 * Chrome shared by every authenticated logbook screen: a compact header (brand, primary nav,
 * theme toggle, feedback, sign-out) over a centred content column.
 *
 * `relative z-10` on the wrapper is just a stacking context anchor: CausticOverlay renders at a
 * higher fixed z-25 so the light rays wash over page content (edit boxes, buttons, etc.) instead
 * of being hidden behind it. The overlay stays `pointer-events-none`, so it never blocks clicks;
 * it also sits below Radix portal content (dialogs/dropdowns/selects/tooltips, all z-50), so
 * popovers and menus still render above the rays.
 */
export function AppShell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative z-10 flex min-h-svh flex-col">
      <LiveDiveUpdates />
      <header className="border-b border-border/80 bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight no-underline"
          >
            <Waves className="size-4 text-muted-foreground" aria-hidden />
            Dives
          </Link>

          <nav aria-label="Main" className="flex items-center gap-1">
            <NavLink href="/dashboard">Dashboard</NavLink>
            <NavLink href="/dives">Logbook</NavLink>
            <ManageMenu />
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <span className="hidden text-xs text-muted-foreground sm:inline" title={email}>
              {email}
            </span>
            <ModeToggle />
            <FeedbackButton />
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
