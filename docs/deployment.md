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

### Healthcheck ping: not currently configured for `dives`

Unlike `luglab`, `dives`' live `dev-values.yaml` has `HEALTHCHECK_PING_URL`
commented out (healthchecks.io integration was skipped for this project — see
`dev-values.example.yaml`'s placeholder and `PROMPTLOG.md`). So the
scale-to-zero-vs-dead-man's-switch conflict `luglab` hit doesn't currently
apply here. If `HEALTHCHECK_PING_URL` is ever set for this project, revisit —
the same tradeoff would then apply: the ping goes quiet while scaled to 0,
tripping a false "down" alert during genuine idle periods.
