<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Instructions for AI Agents

1. Add every prompt you get from the user into the PROMPTLOG.md, starting a new `##` header with date, time and short title. Append to the file.

2. Keep the `docs/` files updated when you change the code.

3. For UI components use shadcn/ui + Tailwind + Radix/Base UI primitives, use shadcn mcp.

4. Use WebKit for Playwright browser automation.

5. When adding interactions that require server calls, make sure that buttons have visible status like spinner and are disabled for the duration of the call,
   so the user can't make multiple clicks on it. Also when the call is completed use sonner to inform the user of the results.

6. Don't leave unused code, check `pnpm lint:unused`.

7. `helm-charts/templates/pvc.yaml` is an example PVC template, disabled by default
   (`persistentVolume.enabled: false` in `values.yaml`). If a project needs a PVC,
   enable it via values and set `persistentVolume.size`/`volumeName`. The underlying
   PersistentVolume must be created using the `pumpking` MCP server
   (`mcp__pumpking__add-pv`) — do not create PVs by hand.

8. Use `*@aleksandr.vin` addresses for any email fields (admin/contact/pgadmin/etc).
   Prefer a bare address (`admin@aleksandr.vin`) unless the project needs to be
   distinguishable, in which case use a dotted prefix scoped to the project name
   (`contact.dives@aleksandr.vin`). Do not use `@example.com` placeholders or
   `admin@<project>.aleksandr.vin` subdomain-style addresses for real deployments.
   Manual QA/staging accounts follow the `test*@aleksandr.vin` convention
   (`lib/users.ts`'s `isTestUserEmail`) and are excluded from signup notifications
   and their running count.

9. Split Helm values by stage-specificity: `helm-charts/values.yaml` should only
   hold values that are good defaults for *any* pumpking stage. Anything that is
   specific to the `dev` stage deployment (dev DB hosts, dev ingress issuer,
   dev-only secrets, etc.) belongs in `dev-values.yaml` (or the equivalent
   `<stage>-values.yaml`), not in `values.yaml`.

10. Every dive/dive-site row is owned by exactly one user. Every read and every
    write must be filtered by the session's `user_id` — never trust an id from
    the URL or a form on its own. Cross-user access must return not-found/
    forbidden, never the data.

11. This repo is mirrored to a public GitHub repo — every commit becomes
    world-readable, and history is not something a later force-push can
    quietly clean up once it's mirrored. Before each commit, check the diff
    (not just the final file state) for secrets: API keys, tokens, passwords,
    connection strings with embedded credentials, private keys. Pay particular
    attention to `PROMPTLOG.md` — per rule 1 it logs every raw user prompt
    verbatim, so a credential pasted into a prompt gets committed exactly like
    any other text — and to newly hardcoded internal infra details (IPs,
    internal hostnames, registry usernames) that shouldn't ship alongside the
    real thing. See "Local, machine-specific instruction files" below for
    where real secrets/deployment-specific values belong instead. If a check
    turns up something questionable, stop and ask the user rather than
    committing and redacting later.

## Project identity

This repo was scaffolded from the upstream 21daylabs Next.js template.
Everything carrying that template's own identity — its project slug, its
`*_ADMIN_EMAIL`-style env-var prefix, and its hardcoded email sender name —
has been renamed to `dives` / `DIVES_*` / `Dives`.

**A clean checkout must contain none of those upstream identity strings.** If
you copy any further file across from that template, grep the tree
case-insensitively for each of them (the exact literals are listed in the
scaffolding plan under `.omc/plans/`, which is workspace-local and not
committed) and fix every hit before committing, excluding `node_modules`,
`.git` and `.next`. Leaving any
in place would make container names, Helm release names, ingress hosts and
telemetry service names collide with the template's own deployment, and would
ship backup emails branded as somebody else's product.

The template's BOM-lifecycle features (nexar/catfooder checkers, BOM upload
console, plans calculator, ToS-acceptance gate and its append-only audit
table, marketing/legal pages) were deliberately **not** ported. In particular
there is no `tos_acceptance` table and no ToS gate in `lib/session.ts` — do not
re-add `hasAcceptedTosVersion` or an `/accept-terms` redirect; every
authenticated page would 500 against a table that doesn't exist.

## Gitea issue workflow

Agents doing work in this repo must track that work with a Gitea issue:

- Before starting non-trivial work, ask the user whether an issue already
  exists for the task. Don't assume — always ask first.
- If no issue exists, create one with `tea` cli. Write a clear
  description of the task; if a spec or implementation plan was produced
  while scoping the work, attach or paste it into the issue body (or a
  follow-up comment).
- Reference the issue number in every commit made for that work (e.g.
  `Fixes #42` or `Refs #42` in the commit message).
- When the work is done, do **not** close the issue or change its status
  yourself.
  Leave it open and ask the user to review the work and close (or
  re-triage) the issue themselves.

## Local, machine-specific instruction files

`.gitignore` already excludes two kinds of local file, and that set should
keep growing rather than committing real secrets or machine-specific paths:

- **Freeform operational notes — `AGENTS.local.md`.** No fixed schema; holds
  prose context (kubeconfig paths, pumpking project/stage names, healthcheck
  IDs, etc.) that agents need to operate on *this* deployment but that would
  be meaningless or wrong for anyone else's checkout. See step 2 under
  "Deploying and creating new projects on pumpking" for what goes in it.
- **Structured per-deployment config — `<name>.yaml` + `<name>.example.yaml`
  (e.g. `dev-values.yaml` / `dev-values.example.yaml`).** Used when the real
  file has a fixed schema (Helm values, env files) that's worth documenting
  for the next person/agent. Git-ignore the real file once it holds a real
  secret; keep a same-shaped `.example.` counterpart checked in with
  placeholder values so the required keys stay discoverable. `.env` /
  `.env.example` follows the same pattern.

CI (`.gitea/workflows/ci.yml`) deploys using the `DEV_VALUES_YAML` Gitea
Actions secret (the whole `dev-values.yaml`, base64-encoded), not the local
git-ignored file directly — editing the local file alone has no effect on
CI deploys. After changing `dev-values.yaml`, run `just
update-dev-values-secret` to push the update (base64-encodes the current
file and sets the secret via `tea actions secrets set --stdin
DEV_VALUES_YAML`). Skipping this step means the next push-to-main silently
redeploys with the old values, reverting whatever the local file's change
was meant to do.

General rule for any new local file an agent creates: if it contains a real
secret, credential, absolute machine path, or other value specific to one
deployment or one developer's machine, it must not be committed. Add it to
`.gitignore`. If its structure is worth documenting for future agents, also
commit an `.example`/placeholder counterpart with the same keys; if it's
freeform notes, fold instructions for recreating it into `AGENTS.md` (as this
file does for `AGENTS.local.md`) instead.

## Deploying and creating new projects on pumpking

The default pumpking stage is `dev` unless the user says otherwise.

To stand up this project on pumpking:

1. Create the project with `mcp__pumpking__add-new-project`. That single call
   also declares the project's databases via its `databases` parameter —
   there is no separate `add-project-db` tool.
2. Pumpking returns a kubeconfig path for the new project/cluster context. Save
   it into a git-ignored `AGENTS.local.md` file at the repo root (create the
   file if it doesn't exist yet, and add `@AGENTS.local.md` to `CLAUDE.md` so
   it's loaded automatically, same as `AGENTS.md` is). This file is where
   agents persist project-specific operational details (kubeconfig path,
   pumpking project/stage name, healthchecks project id, etc.) needed to
   perform future deployments and manage the project without re-asking the
   user. Never commit this file or put secrets that belong in Kubernetes
   Secrets/`appSecrets` into it — just enough metadata to locate and operate
   on the project.
3. Create a healthchecks project and a healthcheck ping URL via
   `mcp__pumpking__create-healthcheck-project` and
   `mcp__pumpking__create-healthcheck-check` (use
   `mcp__pumpking__configure-healthcheck-check` to tune interval/schedule).
   Wire the resulting ping URL into `HEALTHCHECK_PING_URL` in the appropriate
   stage values file per point 9 above.
4. Email integration is required for dive backup emails: `email_host_user`
   goes in `env` (currently `zulu@aleksandr.vin`) and `email_host_password`
   in `appSecrets`.

**pumpking MCP tools commit locally but never push.** After any
`add-new-project`/`add-user` call, stop and explicitly ask the user to review
the diff and push it themselves — the reconciler has provisioned nothing until
that push happens. No manual `kubectl` steps.
