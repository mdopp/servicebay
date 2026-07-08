# Diagnostics that fix, not just report

[← back to FEATURES](../FEATURES.md)

When a heal isn't automatic, ServiceBay doesn't hand the operator a stack trace.
Each diagnosis is a **probe** that returns a status *and* a typed `actions[]`
array — structured, one-click remediations the operator can run without SSH.

## What it does

There are **26 diagnose probes**
(`packages/backend/src/lib/diagnose/probes/*.ts`). Each returns
`status / detail / hint? / actions[]`, and surfaces as a synthetic row in the
Health Checks tab alongside scheduled checks, with a four-way
`ok / warn / fail / unknown` status. The action machinery is identical in
Settings, the Health dashboard, and the install wizard.

Coverage spans the failure areas a family homelab actually hits:

| Area | Probes |
|---|---|
| **SSO** | `ssoVerify`, `oidcProviderReachable` |
| **TLS certs** | `certExpiry`, `certRequestFailure` |
| **DNS** | `routerDnsNotPointing`, `domainResolvesToBox`, `domainExternalReachability`, `domainUnreachable` |
| **Proxy** | `danglingProxy`, `proxyRouteMissing`, `nginxOnlineFailed` |
| **Runtime** | `crashLoop`, `failedUnits`, `podsAndEngine`, `disk`, `installHandlerFailed`, `postDeployFailed` |
| **Services** | `npmDataStale`, `adguardRewritesMissing`, `lanIpChanged`, `nasBackupReachable`, `haAutomationIntegrity`, `mediaLibraryAccess`, `hermesChat`, … |

## Why it exists

Raw error messages anchor a non-expert operator on jargon they can't act on.
Structured actions ("Restart auth", "Renew now", "Delete route") give them a path
forward. SSO in particular is the most common post-install failure vector, so it
is re-verified automatically after any auth install rather than waiting for the
operator to discover broken login by trying to sign in.

## How you use / observe it

- Probes appear in the **Health → Checks** tab as rows with a **Self-Repair**
  (wrench) popup. Click it to see the probe's actions.
- An action is a labelled button; a destructive one confirms first, and
  data-loss recovery is always routed through the Reset wizard rather than a
  one-click nuke.
- Actions can carry inline inputs (e.g. an email for a cert request), so the
  operator supplies only the genuinely-unavoidable value.

## How it works

- **Probe shape & registration.** Every probe registers via
  `registerProbeAction(probeId, action, handler)`. Types live in
  `packages/backend/src/lib/diagnose/actions.ts`:
  - `ProbeAction` — `{ id, label, description, destructive?, inputs? }`
  - `ProbeActionInput` — `{ name, label, type, placeholder?, hint?, required? }`
  - `ProbeActionResult` — `{ ok, message, details?, refresh? }`
- **Auto-run SSO verify.** `packages/backend/src/lib/install/runner.ts` triggers
  `verifySso` after any auth install; the result is stored
  (`ssoVerifyStore.ts`) and read by the `ssoVerify` probe.
- **Safety cascade.** Read-only / restart-only actions are fine on a card; any
  action with data-loss risk points at the Reset wizard instead — see
  [UX_DECISIONS.md → "Diagnose probes ship with safety-cascading actions"](../UX_DECISIONS.md).
- **Surfacing.** Probe rows are injected into the standard checks list at boot
  (`packages/backend/src/lib/health/init.ts`); the diagnose aggregator joins the
  latest result per check into one view.

## Related

- [UX_DECISIONS.md](../UX_DECISIONS.md) — the Health-Checks-tab merge and the
  safety-cascade convention.
- [It heals itself](self-heal.md) — the first tier that runs before a probe ever
  surfaces.
- [Extensibility](extensibility.md) — a diagnose probe is one of the three
  documented first-PR extension points ([CONTRIBUTING.md](../CONTRIBUTING.md)).
