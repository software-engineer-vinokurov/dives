# Deployment

Helm chart: `helm-charts/`. Deployed to the `dev-dives` namespace on the
`pumpking` k3s cluster — see `AGENTS.local.md` (git-ignored) for kubeconfig
path and namespace details.

## Scale-to-zero (KEDA)

`keda.enabled` (`helm-charts/values.yaml`, default `false`) turns on
scale-to-zero: the web app scales down to 0 replicas when idle and wakes back
up on the first incoming HTTP request. Requires the KEDA + KEDA HTTP Add-on
operators already installed cluster-wide (`keda` namespace) — see
`pumpking/changelog/2026-09-26-install-keda-http-add-on.md` for how those got
installed and why the HTTP Add-on (not just core KEDA) is required for
wake-on-request. Same pattern as `luglab`'s `docs/deployment.md`, adapted here.

This only scales the `dives` **Deployment** (the `app` + `suunto-sidecar`
containers together, when `suuntoSidecar.enabled`). The
`{{ .Release.Name }}-notification-worker` and `{{ .Release.Name
}}-padi-token-refresh` `CronJob`s are separate resources with their own
schedules — they are completely unaffected by the web Deployment's replica
count either way.

When enabled, `helm-charts/templates/keda.yaml` replaces the plain
`networking.k8s.io/v1 Ingress` with:

- A Traefik `IngressRoute` routing directly to the shared
  `keda-add-ons-http-interceptor-proxy` Service in the `keda` namespace
  (cross-namespace, requires `providers.kubernetesCRD.allowCrossNamespace`
  enabled on the cluster's Traefik — see `pumpking/manifests/traefik-helmchartconfig.yaml`).
  A plain core `Ingress` can't do this: `ExternalName` Service backends are
  blocked by Traefik's Kubernetes Ingress provider, and core `Ingress` has no
  cross-namespace service reference at all.
- A standalone cert-manager `Certificate` (cert-manager's ingress-shim only
  watches core `Ingress`/Gateway API, not Traefik's `IngressRoute` CRD, so the
  cert has to be requested explicitly instead of via the
  `cert-manager.io/cluster-issuer` annotation).
- An `InterceptorRoute` (`http.keda.sh/v1beta1`) + a core `ScaledObject`
  (`keda.sh/v1alpha1`, `external-push` trigger) — the `InterceptorRoute` alone
  only configures routing/metrics, the `ScaledObject` is what actually scales
  the Deployment.

The Deployment template omits `spec.replicas` entirely when
`keda.enabled: true` (rather than setting it to a fixed value), so `helm
upgrade` never fights KEDA over the live replica count — the standard
Helm+HPA/KEDA pattern.

### Cold-start latency note (suunto sidecar)

With `suuntoSidecar.enabled: true`, the pod has two containers, and Kubernetes
only marks the Pod `Ready` (routable) once **both** pass their readiness
probes. Verified live: first request after scale-to-zero returned in ~11.5s
(vs. ~12s for `luglab`, which has no sidecar) — the sidecar's own exec-based
readiness probe didn't add meaningfully to cold-start time in practice, but
it's a second container that has to come up before traffic is accepted.

## Live dive updates (WebSocket)

`wsSidecar.enabled` (`helm-charts/values.yaml`, default `true`, only takes
effect when `keda.enabled` is also `true`) adds a `ws-sidecar` container
(`scripts/ws-sidecar/server.mjs`) pushing a `dives_changed` event to every
open browser tab/device signed into the same account whenever that user's
`dives` rows change — e.g. a PADI/Suunto background sync completing while
`/dives` is open elsewhere, or the same account open on two devices.
`components/live-dive-updates.tsx` (mounted once, in `AppShell`, so every
authenticated page gets it) listens and calls `router.refresh()`.

**Change detection is polling, not push, on the DB side**: the sidecar
checks `max(dives.updated_at)` per connected user every
`wsSidecar.pollIntervalMs` (default 5s) rather than using Postgres
`LISTEN`/`NOTIFY`. Deliberate choice: no mutation code path (`createDive`,
`createDiveFromPadi`, `createDiveFromSuuntoImport`, `updateDive`,
`mergeSuuntoImportIntoDive`, ...) needs to remember to fire a notification —
missing one silently would be a much worse failure mode than up to 5s of
extra latency on a dive log (not a chat app). Only the `dives` table is
watched; `dive_sites`/`dive_bookmarks` changes don't trigger a refresh.

**Routed *through* the KEDA interceptor, not around it** — the key design
decision here. `helm-charts/templates/keda.yaml` adds a second
`InterceptorRoute` (`{{ .Release.Name }}-ws`, path `/ws`) alongside the main
one, using `scalingMetric.concurrency` (targetValue `1`) instead of
`requestRate`, and a second `external-push` trigger on the same
`ScaledObject`. A single still-open WebSocket connection alone keeps this
route's concurrency count ≥ 1, which keeps the pod scaled up for as long as
anyone has the app open — no separate keep-alive ping needed here, unlike
`luglab`'s `components/keep-alive-ping.tsx`. This relies on two things
confirmed via the KEDA HTTP Add-on's docs before committing to it:
`KEDA_HTTP_REQUEST_TIMEOUT` defaults to `0` (unlimited) cluster-wide, and the
interceptor's own graceful-shutdown draining explicitly tracks open
WebSocket connections as in-flight requests — so this isn't an unsupported
abuse of the mechanism.

Session auth for the WebSocket reuses the same `dives_session` cookie /
`user_sessions` table lookup as `lib/session.ts` — necessarily
**duplicated**, not imported, in `scripts/ws-sidecar/server.mjs`
(`SESSION_COOKIE_NAME` + `hashSessionToken`), since the standalone-output
Docker image runs plain `.mjs` scripts with no TS loader; keep the two in
sync if the hashing scheme or cookie name ever changes.

The `ws-sidecar` container binds `0.0.0.0` (all interfaces), unlike
`suunto-sidecar`'s `127.0.0.1`-only loopback: it's reached cross-pod via the
`{{ .Release.Name }}-ws-service` Service (routed to by the interceptor), not
just from the `app` container within the same pod.

### Healthcheck ping: not currently configured for `dives`

Unlike `luglab`, `dives`' live `dev-values.yaml` has `HEALTHCHECK_PING_URL`
commented out (healthchecks.io integration was skipped for this project — see
`dev-values.example.yaml`'s placeholder and `PROMPTLOG.md`). So the
scale-to-zero-vs-dead-man's-switch conflict `luglab` hit doesn't currently
apply here. If `HEALTHCHECK_PING_URL` is ever set for this project, revisit —
the same tradeoff would then apply: the ping goes quiet while scaled to 0,
tripping a false "down" alert during genuine idle periods.
