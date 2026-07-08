# It heals itself

[← back to FEATURES](../FEATURES.md)

ServiceBay's audience is family-homelab admins, not sysadmins. The design rule
(from [UX_PHILOSOPHY.md](../UX_PHILOSOPHY.md)) is **self-heal first**: recover
silently where possible, and only surface unavoidable input as a structured
action. Three failure classes that would normally mean a support ticket — or a
wiped install — recover on their own.

## Silent credential rekey

**What it does.** When the operator wipes the `secrets` group during a clean
install, ServiceBay's encryption key (and every `enc:v1:` ciphertext derived
from it) is gone, and freshly-generated admin passwords no longer match the
credentials already stored inside preserved service databases. Instead of
crash-looping, each service re-syncs its stored credential to the new password
*in place* — no lockout, no re-typing.

**Why it exists.** A generated secret ≠ the stored credential in a preserved DB
(LLDAP, NPM, Honcho's Postgres). Before the self-heal, reinstall-over-data meant
`invalid_client`, auth crash loops, or a locked-out admin UI.

**How you observe it.** It's invisible in the happy path — you log in with the
wizard's new password and it just works. The install log shows the rekey step
(e.g. `FORCE_RESET`, `ALTER ROLE`) when it fires.

### How it works

The authoritative, service-by-service coverage matrix is
[docs/CREDENTIAL_SELF_HEAL.md](../CREDENTIAL_SELF_HEAL.md). In short, the pattern
per service is:

- **LLDAP** — the installer injects `LLDAP_FORCE_LDAP_USER_PASS_RESET=true` when
  the admin password regenerates, so LLDAP resets its stored admin bcrypt to
  match `config.json` on next boot.
- **NPM** — `bootstrapNpmAdmin` re-rotates the admin via the NPM REST API using a
  previous-password fallback chain.
- **AdGuard** — the `AdGuardHome.yaml.mustache` re-renders with the new bcrypt on
  every deploy and overwrites the on-disk YAML.
- **Honcho (Postgres role)** — `templates/honcho/post-deploy.py` detects a
  preserved `pgdata` and re-keys the role over the container's trusted local
  socket (`ALTER ROLE honcho WITH PASSWORD …`).
- **Immich / Audiobookshelf (OIDC secret)** — post-deploy re-stamps the stored
  client secret via the admin API, falling back to a no-token DB re-stamp.

The decision rule for *when a new template needs an explicit self-heal entry* is
documented at the bottom of that same file.

## Its own crash leaves a readable trace

**What it does.** When `servicebay.service` itself exit-loops, the UI on `:5888`
goes dark — and the thing that would normally report the failure *is* the failing
container. So the signal is written **out-of-band, on the host**: a systemd
`ExecStopPost=` hook on the `servicebay.container` quadlet drops
`last-crash.json` into the data dir (exit code, service result, last journal
lines, timestamp, a named likely-cause). Once the container recovers, the backend
reads that file back and surfaces the last crash with a recovery hint.

**Why it exists.** The real incident: a root-owned `*.bak-verify*` stray broke the
`:Z` SELinux relabel → podman exit 126 → UI dark while every stack stayed up. The
operator got no UI, no probe, no signal (#2159).

**How you observe it.** After recovery, the last crash is surfaced in-band with its
likely cause. The file also survives the container being down, so an out-of-band
reader (sb-tui over SSH) can read the same breadcrumb.

### How it works

- Reader: `packages/backend/src/lib/health/crashBreadcrumb.ts` — `parseCrashBreadcrumb`
  and the `CRASH_BREADCRUMB_FILE` path in `DATA_DIR`. Best-effort: a missing or
  corrupt file degrades to `null`, never throws.
- Writer: the `ExecStopPost=` hook baked into the FCoS quadlet asset
  (`tools/sb/internal/build/assets/fedora-coreos.bu`).

## GPU survives every redeploy — no silent CPU fallback

**What it does.** A template opts into GPU passthrough via CDI (Container Device
Interface) behind a Mustache-gated `resources` block. Once the operator opts in,
a host without a CDI-registered NVIDIA GPU **fails fast at unit start** with a
clear error — it never silently falls back to CPU.

**Why it exists.** Silent CPU fallback is the worst failure mode for GPU work: the
box keeps running, transcoding/inference just gets slow, and the operator has no
signal that the GPU dropped out across a redeploy.

**How you observe it.** GPU-enabled services (Ollama, Immich ML, media transcoding)
either start with the GPU or fail loudly. There's no degraded-but-quiet state.

### How it works

The GPU passthrough contract and the "no silent fallback to CPU" guarantee are
documented in [TEMPLATE_AUTHORING.md → GPU passthrough (CDI)](../TEMPLATE_AUTHORING.md#gpu-passthrough-cdi).
The Quadlet generator passes `resources.limits.nvidia.com/gpu` through to podman,
which matches it against the host's CDI device registry.

## Related

- [UX_PHILOSOPHY.md](../UX_PHILOSOPHY.md) — the self-heal-first hierarchy.
- [Diagnose that fixes](diagnose.md) — the second tier: structured actions when a
  heal isn't possible.
