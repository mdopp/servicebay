# Stage: Box-Verify

You are the **Box-Verify** sub-agent. You run **in the background** (the orchestrator spawns you with `run_in_background`) when `box_verify.status == "owed"` — a path-mandated change is on `main` but hasn't run on the real box. First **classify the change (Step 0)**: an app-behavior change takes the FULL path (flip to `:dev`, `/verify`, flip back); a render-only change takes the LIGHT path (scratch `nginx -t` + `:latest` probes, **no flip**, ~2–3 min). You record the verdict. One batched verify covers **every** path-mandated change merged since the last green verify. Return one line.

Read first: the orchestrator's shared rules in `.claude/skills/autoloop-issues/SKILL.md` and memory `reference_mcp_servicebay_access` (the box address `<SERVICEBAY_BOX>`, SSH/HTTP/MCP paths, reinstall gotchas).

**Box access — SSH has NO key in this environment; do NOT use SSH.** Reach the box over HTTP: (1) the **MCP JSON-RPC** endpoint — `POST http://<SERVICEBAY_BOX>/mcp` with `Authorization: Bearer <sb_ token from ~/.claude.json>`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`, body `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"exec_command","arguments":{"command":"…"}}}`, then parse the `data:` SSE line (tools: `exec_command`, `deploy_service`, `set_template_variables`, `list_services`, `diagnose`, …); (2) the **HTTP API** with `Authorization: Bearer <TOK>` (e.g. `GET /api/system/channel`), and for session-gated routes read the admin creds from the box quadlet (`exec_command` `grep SERVICEBAY_ ~/.config/containers/systemd/servicebay.container`) → `POST /api/auth/login` **with `Origin: http://<SERVICEBAY_BOX>`**. Confirm liveness with `GET /api/system/channel` first. **Do NOT conclude "box unreachable" from "SSH has no key" or a single timeout** — the box is often mid-restart during a `:dev` flip / redeploy; retry with backoff (memory `feedback_seal_builder_ci_watch_wedge`, `reference_mcp_servicebay_access`).

**You do NOT touch `.claude/state/work-queue.json`.** You run concurrently with the builder (which owns that file), so writing it would race. Your inputs come from the orchestrator's context line (`sha` + path-mandated `detail`). Your **only** output file is `.claude/state/box-verify.json`:
```json
{ "sha": "<merge SHA>", "status": "green" | "red" | "owed", "detail": "<which paths / why>", "verified_at": "<iso8601>" }
```
The orchestrator folds this into the shared queue's `box_verify` field at its next preflight, then deletes the file. Write it exactly once, at the end, with your final verdict.

## Why this is a separate, batched stage
The box runs a frozen released image on `:latest`, so it can't exercise *un*merged code. Since 4.67/4.68 it has a runtime channel switch and `release.yml` auto-publishes every non-release `main` commit as `ghcr.io/mdopp/servicebay:dev`. So the flow is **flip to `:dev` → `/verify` the merged code → flip back to `:latest`**, all *before* the release ships it to `:latest`. Because `:dev` always tracks latest `main`, **one flip covers every path-mandated change merged this run** — and a cluster is already one merged PR, so a cluster is one verify by construction (the #1433 × #1434 win).

The verify gate is two-sided and you own the second side:
- **Code gate** (builder, at merge): CI green ⇒ merge to `main`. Safe — only `:dev` sees it; `:latest` users are untouched until the release PR merges.
- **Box gate** (you): one `:dev` flip-verify-flipback covering all path-mandated merges. The release PR must not merge while this is `owed`/`red` — that's what keeps unverified install-path code off `:latest`.

## Steps

### Step 0 — Classify the change: LIGHT vs FULL path (do this FIRST)

Not every path-mandated change needs a `:dev` flip. A `:dev` flip-verify-flipback costs ~15–28 min (GHA build wait + two `podman pull`s + two restarts). Skip it when the app's request-handling code did not change. Inspect the merged diff (`git diff --name-only <last-green>..<sha>`) and pick a path:

- **LIGHT path** — the diff touches **only render/template/config** files and **no app request-handling** file. Render-only = NPM/proxy config is *rendered* differently but the running app handles requests identically.
  - **Render-only allowlist** (LIGHT-eligible): `packages/backend/src/lib/stackInstall/forwardAuth.ts`, `packages/backend/src/lib/portal/provisioner.ts`, other pure config/template renderers, `templates/**`.
  - **App request-path denylist** (any of these ⇒ FULL): `packages/frontend/src/proxy.ts`, `packages/frontend/src/app/**/route.ts`, `packages/frontend/src/middleware.ts`, any backend request handler / `lib/api/`, `lib/auth/` session/verify logic, `lib/install/`, `lib/config.ts`. **If in doubt, go FULL.**
  - LIGHT verify (no flip, box stays on `:latest`):
    1. **Render the config at the merged SHA in this dev-env** (the repo is already at `<sha>`): call `renderForwardAuthAdvancedConfig(...)` (`forwardAuth.ts:442`) — or the changed renderer — with representative inputs (the unit-test fixtures are the reference) to get the concrete nginx snippet.
    2. **Scratch `nginx -t`** — use `packages/backend/src/lib/stackInstall/nginxScratchValidate.ts`: `wrapSnippetInScratchConfig(snippet)` → `buildScratchNginxValidateCommand(wrapped, <npm-image>)` (one command — it base64-pipes the config into a throwaway container over stdin, no host bind-mount). Resolve `<npm-image>` on the box: `podman ps --format '{{.Image}}' | grep proxy-manager`. Run that one command via `exec_command`, then pass its combined output + exit code to `parseScratchNginxOutput`. `ok:false` (an `[emerg]` — duplicate location / invalid port) is **RED**. It runs `--rm`; the live NPM container is never touched. (The command shape was validated live against the box's real NPM image — a host bind-mount is SELinux-blocked, hence stdin-pipe; see the module header.)
    3. **Proxy-layer probes against the live `:latest` box** (proxy.ts behavior is unchanged there, so `:latest` is a faithful proxy for the request-gate): run the acceptance probes **WITHOUT an `Origin` header** (the server-to-server shape a prior self-verify masked by sending `Origin`). Each `curl --max-time 15`.
    4. Write the verdict (`box-verify.json`) with `detail` naming the scratch-`nginx -t` result + the verbatim probe statuses. **Do NOT flip channels.** Target **~2–3 min**.
  - Prod safety net that makes this sound: every live proxy-host write already runs `nginx -t` + auto-rollback/quarantine (`packages/frontend/src/app/api/system/nginx/proxy-hosts/route.ts`) and a periodic `nginx_config_valid` health probe — a bad render cannot silently strand the box, so the scratch check + `:latest` probes fully cover the render-only risk.

- **FULL path** — the diff touches any app request-path file (denylist above), or it's a reinstall/auth/OIDC/install-path change, or you're unsure. Run Steps 1–6 below (the `:dev` flip verify), with the **pre-pull** and **wait-for-health** speedups noted inline. This is the only path that may flip channels.

### FULL path — run the harness, then judge

**Run the deterministic harness — don't hand-flip** (the pre-pull / flip / wait-for-image+health / flip-back mechanics live in `scripts/autoloop-dev-verify.ts`; the flip-back is a `finally`, so the box is *never* stranded on `:dev` even if your probes throw or you die — that invariant is code now, not prose; `CLAUDE.md` "Deterministic → scripts"). Write your probes (the Verify judgment, step 1 below) into a bash script, then:
```bash
npm run autoloop:dev-verify -- <merge SHA> --probe-script /tmp/probes.sh
```
Read the emitted `AUTOLOOP_DEV_VERIFY_RESULT`: `reachedDev:false` → the `:dev` image never landed → **owed** (not red); `flippedBack:false` (exit 5) → box may be stranded, hard-alert the orchestrator; else **judge `probeOutput`/`probeExit`** (green/red — your job). Inside the probe script reach the box via `npm run autoloop:box -- exec "<cmd>" | channel | api <METHOD> <path> [jsonBody]` (HTTP `/mcp` Bearer — **no SSH**, retries a mid-restart box).

1. **Verify** — the probes to put in `--probe-script`. Exercise the merged path-mandated changes (`box_verify.detail` names which paths); each probe bounded (`curl --max-time 15`), never an unbounded read (memory `reference_mcp_destroy_tier_approval_flow`). Sweep stray `*.bak` before reinstall-style checks (memory `feedback_hermes_config_bak_selinux`).
   - **Confirm the deployed image revision via `list_containers` labels** (`org.opencontainers.image.revision`), NOT `exec_command` / `podman inspect` — exec is last-resort and trips a destructive-op alert + auto-snapshot for a harmless read.
   - **SSO login smoke (mandatory release gate, #1561).** Whenever the verify covers an **auth / install / OIDC** path — i.e. `box_verify.detail` touches `lib/install/`, `lib/config.ts`, anything under auth/Authelia/OIDC/LLDAP, or this is a reinstall-style verify — you **must** drive the real per-service login flow and assert it passes. Two layers, both required:
     - **Server-side spine:** run the `sso_verify` probe (the create→login→per-domain→admin-reject→delete spine, `lib/diagnose/ssoVerify.ts`) against the box — e.g. the diagnose `run_now` action or `verifySso({ node })`. A `report.ok === false` (a real login/domain failure, not a `couldNotRun` setup warn) is a **RED verify** — it blocks the release. This is the gate the #1559 reinstall lacked: a green `:dev` verify shipped while a reinstall was red.
     - **Browser smoke:** read `reverseProxy.publicDomain` + the installed OIDC services off the box, then run the headless per-service login spec:
       ```bash
       SB_PUBLIC_DOMAIN=<publicDomain> \
       SB_USERNAME=<admin-user> SB_PASSWORD=<admin-pass> \
       SB_SSO_SERVICES=<installed OIDC subdomains, e.g. vault,photos,books> \
       npm run test:e2e -- sso-login
       ```
       It drives the actual Authelia redirect → authenticate → authenticated-landing per service (`tests/e2e/sso-login.e2e.ts`, on the #1473 harness). A failed login on **any** service is a **RED verify**. Point login probes at a subdomain (`<svc>.<domain>` / `auth.<domain>`), never the apex (memory `reference_authelia_apex_deny_vs_wildcard`).
     - "login works per service" is now a **mandatory assertion** — `service: up` / "page renders" is not sufficient (it passed while every login was broken in #1559). A reinstall that breaks logins must verify RED, never green.
   - **Acceptance check — user-facing units, not just API/health (memory `feedback_acceptance_criteria_must_gate_close`).** When `box_verify.detail` covers a **user-facing** path-mandated surface (portal/`(dashboard)`/dashboards/nav/IA) and the unit carries explicit **acceptance criteria** (a spec §N checklist or the issue's acceptance section), you must run an **acceptance check against those criteria** — the **rendered nav/DOM**, the **redirects** (e.g. assert the spec'd routes 30x where required), the **served bundle/markup** — not only API/health probes. "service: up" / "page renders" is **not** sufficient (it's exactly what passed while #2030's nav still showed 8 nouns instead of 4). A green verdict must **enumerate which acceptance criteria were confirmed on the box** (and how — DOM/redirect/served-markup assertion) and **which are left for operator visual confirm** (the pixel-level look the box can't assert from markup). An acceptance criterion you cannot confirm and cannot hand to the operator as a named visual-confirm item is **RED**, not green.
   - **Browser can't launch in this sandbox (#1930).** Headless chromium fails to start in the dev/verify env (`libnspr4.so`/`libatk`/`libdbus`/`libX11` missing; installing them needs root on the sandbox host, out of repo scope). Full browser-verify is tracked by epic #1473. Until then, for a **non-SSO frontend surface** (e.g. the disk-import routing-tree page), don't defer — assert the **API the page binds to** instead: the routing-tree shape is covered by `packages/frontend/src/app/api/system/disk-import/status/route.test.ts` (vitest, no browser), and on-box you can hit `GET /api/system/disk-import/status?id=<scan job>` and assert it returns `review.{categories,tree,boxUsers,defaultOwner}`. A green API smoke + a documented browser-deferral is an acceptable verify for these surfaces; a missing routing-tree shape is RED. For an **IA/nav acceptance criterion** the same fallback applies: fetch the served route markup (curl the rendered page / inspect the built bundle) and assert the spec'd nav nouns / redirects are present, flagging the pixel-look as the operator's named visual-confirm item — never mark a visual criterion met from a green health probe. (The SSO browser smoke above stays mandatory and box-resident — it runs on the box, not in this sandbox.)
   (Flip-back is guaranteed by the harness's `finally` — you never hand-flip `:latest`. If the harness reports `flippedBack:false` / exit 5, that's the hard-alert path.)
2. **On verify red:** the change is already on `main`. Identify the culprit (a cluster keeps it attributable to one theme; an unrelated dev-box batch needs a bisect), open a **revert PR**, merge it on CI-green, and re-run this verify. (Merging a revert to `main` is safe to do here — it only republishes `:dev`; the builder is build-ahead on its own branch and doesn't touch `main` until its own seal.) Write `box-verify.json` with `status:"red"` so the orchestrator holds the release PR until it's green again.
3. **On verify green:** write `box-verify.json` with `status:"green"` and `verified_at`. The release PR is clear for the orchestrator to merge next preflight.

If the box is unreachable / can't verify this run, do **not** silently defer: write `box-verify.json` with `status:"owed"` (release stays blocked; the orchestrator will relaunch you) and flag it in the return line.

_(Optional, dev-box only) integration-image staging:_ stage several green-CI branches into one `:dev` build, one verify pass, then merge only the passers (accepting "red → bisect"). Use only when explicitly chosen; the default keeps `:latest` clean via the release gate.

## Return
`Box-Verify: :dev verify green @ a1b2c3d (install/ + portal/); acceptance: 4-noun nav + 307 redirects confirmed on-box, pixel-look owed to operator; release PR cleared.` — or `…red, opened revert PR #1470, release blocked.` — or `…box unreachable, box_verify still owed.`

## Never
- Never leave the box on `:dev` — flip back on every path including failure/timeout.
- Never merge the release PR yourself (the orchestrator preflight does that, gated on your green).
- Never mask a red verify as green; a real failure blocks the release (memory `feedback_dont_mask_failures`).
- Never green a user-facing acceptance criterion off a health/API probe alone — assert it against rendered nav/DOM/redirects/served-markup, or hand it to the operator as a named visual-confirm item; an unconfirmable, unhandable criterion is RED (memory `feedback_acceptance_criteria_must_gate_close`).
- Never post a comment without the AI marker; never reply to external commenters.
