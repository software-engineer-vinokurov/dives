"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const RECONNECT_DELAY_MS = 3000;

/**
 * Opens a WebSocket to the ws-sidecar (routed through the KEDA HTTP Add-on
 * interceptor via a dedicated /ws InterceptorRoute -- see
 * helm-charts/templates/keda.yaml) and calls router.refresh() whenever the
 * signed-in user's dives change on another connection (e.g. a PADI/Suunto
 * background sync completing, or the same account open in another browser).
 * Session auth happens sidecar-side via the same session cookie, sent
 * automatically on the upgrade request -- nothing to pass here.
 *
 * Silently gives up on auth failure/repeated errors rather than surfacing
 * anything to the user: this is a nice-to-have live-refresh, not a feature
 * whose absence should be visible or alarming.
 */
export function LiveDiveUpdates() {
  const router = useRouter();

  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data?.type === "dives_changed") router.refresh();
        } catch {
          // Ignore malformed frames -- a missed refresh isn't worth surfacing.
        }
      });

      socket.addEventListener("close", () => {
        if (stopped) return;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [router]);

  return null;
}
