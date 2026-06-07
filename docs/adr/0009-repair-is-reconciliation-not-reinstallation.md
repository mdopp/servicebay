# ADR 0009 — Repair is reconciliation, not reinstallation — with hard guardrails against a reconciler hell

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** operator (mdopp)
- **Related:** [ADR 0001](0001-authentication-via-authelia-sso-or-lldap.md), [ADR 0006](0006-authelia-apex-deny-vs-wildcard.md), [CREDENTIAL_SELF_HEAL.md](../CREDENTIAL_SELF_HEAL.md), #1717, #1724

## Context

During maintenance, **every repair turned out to be a full stack reinstall/redeploy.**
OIDC-client drift, an OIDC client-secret mismatch, dropped Authelia clients — each was "fixed"
by `sb stacks install --stacks cloud|home`. The reconcile logic (register OIDC clients,
reconcile credentials, render config) lives **only in the deploy / post-deploy path**, so the
only available tool is the sledgehammer.

That is an **anti-pattern**, and it bit us live (2026-06-05/06):
- A `basic` redeploy **wiped every other stack's Authelia OIDC client** (#1724) → full SSO
  outage.
- A `home` redeploy **crash-restarted Authelia** because it raced LLDAP at startup.
- A re-registration **generated a fresh client secret** instead of reusing the persisted one →
  the drift it was meant to fix.

So "reinstall to repair" is heavy, disruptive, **and itself a fault source.**

**But** the naive cure — a fabric of continuous auto-reconcile loops — risks a *new* hell:
reconcilers that fight human edits ("who keeps changing my config?"), **silent** auto-fixes
that mask the real bug, collapsed debuggability ("a reconciler did it, somewhere, sometime"),
and non-idempotent reconcilers that *create* the drift they chase (we saw exactly that).

## Decision

1. **A reinstall/redeploy must NEVER be the required fix for config / credential /
   registration drift.**
2. **First make the redeploy path itself safe + idempotent.** It is the existing, well-trodden
   path; if it can't break things, "heavy but harmless" is acceptable. This comes *before* any
   new reconciler. (Concretely: #1724 render Authelia clients from the installed-templates
   source-of-truth; an LLDAP-readiness gate before Authelia starts; reuse-not-regenerate
   secrets on re-registration.)
3. **Then**, only where a targeted repair is genuinely needed, **extract the existing reconcile
   step as a standalone, on-demand operation** — surfaced as a **diagnose heal-`action`** — not
   as a side effect of redeploy.
4. **Reconciler guardrails (non-negotiable):**
   - **Idempotent — reconcile, never regenerate.** A reconciler reads the persisted/desired
     value; it does not mint a new secret/id on each run.
   - **Diff-first and always logged/visible.** Compute desired → show/log the diff → apply.
     **Never silent.** A repeating fix must surface that something keeps breaking it, not hide
     it (see [feedback: don't mask failures]).
   - **Explicitly triggered** (human or diagnose-action) to start — **not** autonomous timer
     loops. Automation of a given reconciler is added only after it has proven safe in
     explicit-trigger mode.
   - **One source of truth per reconciler. Small, single-purpose, tested.**
5. **No general controller fabric / autonomous desired-state engine.** This is a handful of
   surgical, explicitly-invoked reconcilers — deliberately *not* a Kubernetes-style controller
   plane.

## Consequences

- The work **starts with "make redeploy safe"**, not with building reconcilers — that alone
  removes most of the pain with no new abstraction.
- A *few* targeted reconcile-as-diagnose-actions follow, each obeying the guardrails above.
- Self-healing stays **debuggable and maintainable**; the controller-hell is avoided by
  construction (the guardrails are the point of this ADR, not the reconcilers).
- #1717 (ABS secret drift) and #1724 (client wipe) are the first instances; both are better
  served by a safe redeploy + an extractable reconcile than by more reinstalls.
