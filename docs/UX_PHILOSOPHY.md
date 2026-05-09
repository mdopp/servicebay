# UX philosophy: self-heal first

ServiceBay's audience is family-homelab admins, often not IT experts,
often afraid of doing something wrong. Every feature should look after
itself wherever possible and, when human judgment is genuinely needed,
present **clearly-labelled choices with consequences** rather than raw
error messages.

This document codifies that. Every PR that adds a new error path, a new
checkbox, or a new "please retry" message should pass the principles
below before merge.

## The hierarchy

When something goes wrong, walk down this list. Stop at the first that
applies:

### 1. Heal silently when possible

If retry fixes it, retry. If a fixed sleep can become a readiness
probe, make it a probe. The user doesn't need to know there was a
problem.

Examples:
- **Auto-retry transient deploy failures.** Image-pull flakes,
  registry rate-limits, and NPM cold-start 502s are common and
  transient. Try N times with exponential backoff before declaring
  failure.
- **Replace fixed sleeps with readiness probes.** `sleep(8)` becomes
  *poll until `podman pod inspect <name>` reports `Running`*.
- **Tag first-boot errors as bootstrap.** A fresh agent emits a few
  errors during install-time (Python install race, RAID setup output
  on stderr) — those don't belong in the visible error counter.

### 2. Surface unavoidable input through diagnose probes with structured `actions[]`

When the system genuinely needs the human to choose, route it through
the **diagnose** UI. Each probe ships:

```ts
{
  id: 'npm_data_stale',
  label: 'Nginx Proxy Manager admin credentials',
  status: 'fail',
  detail: 'NPM is rejecting auto-generated credentials — likely stale data from a previous install.',
  actions: [
    {
      id: 'reset_volume',
      label: 'Reset NPM and reinstall',
      description: 'Wipes the proxy-host database and admin user, recreates from scratch.',
      destructive: true,
    },
    {
      id: 'use_existing',
      label: 'I know the existing NPM password',
      description: 'Enter the credentials NPM is actually using.',
    },
  ],
}
```

Multiple actions when several solutions exist. The user picks the path
that matches their comfort level — there isn't always one right answer.

Each action is a button. Clicking it executes the named effect on the
server. Destructive actions show a confirm-on-destructive guard.

**Anti-patterns that violate this rule:**
- "⚠️ Could not seed FileBrowser admin after 3 minutes. Run `podman exec
  file-share-filebrowser filebrowser users add <user> _ --perm.admin
  --database /database/filebrowser.db` once the pod is up." → Should be
  a probe with a "Re-run post-install" action.
- "Failed to install X" with no retry option → Should be a probe with
  "Retry deploy / Show logs / Skip this service".
- "NPM did not accept the wizard credentials. Please enter your NPM
  admin credentials below." → Should be a probe with both options
  (reset volume vs. enter existing creds), each with consequences.

### 3. Hide expert-only knobs

If less than 5% of users would meaningfully change a setting, give it
a sensible default and don't surface it. Asking is a footgun for the
other 95% — they have to evaluate a choice they can't evaluate.

Examples:
- **Auto-update channels (`stable | test | dev`)** — removed entirely.
  Stable is what everyone wants; the others were dev-team artefacts
  that never reached production users.
- **Anything that requires reading source to understand.** If the
  description has to mention "Quadlet" or "rpm-ostree" or "kube YAML
  annotation," it's expert-only.
- **Knobs whose default is fine forever.** `agent.processCleanup.maxAgeMinutes`,
  `gracefulShutdownTimeout`. Hide unless a user reports a problem the
  knob solves.

When unsure: ship without the knob. Adding one later is easy; removing
one is painful.

### 4. Default to safe

The non-IT-expert default has to *just work*. Decisions that require
information the user might not have should get a safe fallback, not a
required input.

- **Local-only mode is the default** when `PUBLIC_DOMAIN` is empty.
  Don't block the install on "you must enter a domain." Render a
  persistent "🏠 Local-only" badge; flip later when the user is ready.
- **Encrypted-at-rest credential persistence > "save now or lose
  forever".** The data already lives in container env / kube YAML; an
  encrypted manifest in `config.json` plus a clear "I saved these,
  wipe from server" action is strictly safer than a one-shot banner
  the user might miss.
- **Auto-retry > immediate fail** for any operation that talks to a
  recently-cold-started container, registry, or external API.

### 5. User-facing language, not infra language

Probe text and action labels are read by people who don't know what a
Quadlet is. Phrase fixes in user terms.

Bad: *"DELETE /var/lib/postgresql/data and restart the pod"*
Good: *"Reset Immich's database and start over (you'll lose any
photos you've uploaded — typically nothing on a fresh install)"*

Bad: *"systemctl --user restart vaultwarden.service"*
Good: *"Restart Vaultwarden"*

Bad: *"OIDC client_secret rotation requires Authelia config reload"*
Good: *"Generate a new SSO secret for this app (apps using SSO will
need to log in again once)"*

## Concrete checklist for new PRs

Before merging code that adds a new error path, ask yourself:

- [ ] Can this auto-heal? Have I tried at least one retry / readiness
  probe / fallback before surfacing?
- [ ] If user input is needed, am I surfacing it through a diagnose
  probe with `actions[]`, not a raw error message?
- [ ] Does each action have a description that says what will happen,
  including consequences (data loss, downtime, restart)?
- [ ] Are destructive actions marked `destructive: true` so the UI
  guards them with a confirm step?
- [ ] If I'm adding a checkbox / dropdown / config field — is it
  actually expert-only? Could a default + diagnose probe replace it?
- [ ] Does the user-facing text use service names ("Vaultwarden") and
  outcomes ("you'll lose uploaded photos"), not infra nouns
  ("Quadlet," "Pod," "PVC")?

## Where this gets enforced

- This document, linked from the repo root README + every relevant
  ServiceBay code-review checklist.
- Auto-memory entry in the project's Claude memory bank — future agent
  sessions auto-apply the principles without re-reading the doc.
- Tracking issue: **"Self-healing UX rollout"** on GitHub, where the
  per-task PRs that bring the existing surface into compliance are
  linked and checked off.

## Where this came from

The PRs landing in autumn 2026 against `chore/finalize-template-separation`
and the audit conversation that followed. The trigger was a fresh
install with broken pre-pull progress, NPM credential prompts that
pre-filled values that just failed, and a credentials banner shown
once in a log the user could close. The diagnosis was: "the system
should look after itself; when it can't, it should offer fixes — not
explain what's wrong."
