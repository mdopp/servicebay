/**
 * The HOST half of the user-namespace reconcile (#2808, after the #2805 outage).
 *
 * `quadletUserNs.ts` reconciles `servicebay.container`'s `UserNS=` line from
 * *inside* the app, on two call sites: `server.ts` (30 s after boot) and
 * `servicebayChannel.ts` (before a channel swap). Neither is on the delivery
 * path that actually broke the box. `podman-auto-update.timer` runs on the
 * host, pulls `:latest` and restarts `servicebay.service` with no pre-swap hook
 * at all — so 5.28.0's `USER nextjs` came up on a mapping-less quadlet, landed
 * in `core`'s subuid range, and lost the podman socket, `/app/data` and the
 * agent's ssh key in one go. The app cannot fix that from inside, by
 * construction: the container that would run the reconciler is the broken one.
 *
 * So the reconcile has to exist a second time, **on the host, before podman
 * starts the container** — as an `ExecStartPre=` on the quadlet itself, next to
 * `servicebay-relabel-selfheal.sh`. Then every route is covered: the
 * auto-update timer, a channel swap, a boot, a manual `systemctl restart`.
 *
 * This module owns two things:
 *
 *   1. `USERNS_SELFHEAL_SCRIPT` — the script text, which is also the copy
 *      Ignition writes on a fresh box (`fedora-coreos.bu`). The two are asserted
 *      byte-identical by `tests/backend/dockerfile_runtime_user.test.ts`, so the
 *      host half cannot drift into two behaviours.
 *   2. `installQuadletUserNsHostHook` — delivery to boxes that are ALREADY
 *      installed. Ignition runs once, at install time, and nothing on the host
 *      ever rewrites the quadlet afterwards; every field box therefore needs the
 *      script and the `ExecStartPre=` line pushed to it from the running app via
 *      the agent — the same shape `updateWindow.ts` uses for the timer drop-in.
 *
 * **Ordering constraint for the re-land** (the reason `Dockerfile` still says
 * `USER root`): this half must be ON the box before an image that declares a
 * non-root user arrives. Delivery happens from the running app, so the release
 * that ships this module must be *older* than the release that flips `USER` —
 * exactly the #2788 → #2789 ordering. Flipping both in one release reproduces
 * #2805 verbatim, because the box running the previous version has no script
 * yet when the timer pulls the new image.
 */
import type { Executor } from './interfaces';
import { logger } from './logger';
import { QUADLET_PATH, WRITE_QUADLET_SH } from './quadletUserNs';
import { shellQuoteAll } from './util/shellQuote';

const TAG = 'quadlet-userns-hook';

/** Host path of the self-heal script. Root-owned, mode 0755, like its siblings. */
export const USERNS_SELFHEAL_PATH = '/usr/local/bin/servicebay-userns-selfheal.sh';

/** Agent-writable staging path — `/usr/local/bin` needs sudo, `/tmp` does not. */
const USERNS_SELFHEAL_TMP = '/tmp/servicebay-userns-selfheal.sh';

/**
 * Wired WITHOUT a leading `-`. The script exits non-zero on exactly one path —
 * "I just rewrote the quadlet, the argv systemd baked for this start job is
 * stale" — and that failure is the mechanism: it aborts the mapping-less start
 * so `Restart=always` brings the unit back on the regenerated unit file. A
 * leading `-` would swallow it and reproduce #2805.
 */
export const USERNS_SELFHEAL_EXEC_START_PRE = `ExecStartPre=/bin/bash ${USERNS_SELFHEAL_PATH}`;

/**
 * The host-side twin of `reconcileServicebayQuadletUserNs`, in bash.
 *
 * Kept deliberately close to the TS reconciler's algorithm — read `Image=` off
 * the quadlet, ask the image what user it declares, resolve a NAME by running
 * `id` inside the image, write `UserNS=keep-id:uid=N,gid=M` or remove the line
 * for a root image — because the two must never disagree about a box.
 *
 * Everything is fail-open except the one deliberate exit 1: an unreadable
 * quadlet, an image that cannot be inspected, a rewrite that did not converge,
 * all exit 0 and leave the box exactly as they found it. The script must never
 * be the reason ServiceBay stays down.
 */
export const USERNS_SELFHEAL_SCRIPT = `#!/bin/bash
# ServiceBay UserNS self-heal (#2808). Runs on the HOST, as the user that owns
# the quadlet, BEFORE podman starts the container — so it covers EVERY delivery
# route, including podman-auto-update.timer, which has no in-app hook and is
# the route that took the box down in #2805.
#
# Host-side twin of packages/backend/src/lib/quadletUserNs.ts: read the user the
# image declares and make servicebay.container's UserNS= line agree. Root image
# -> no line at all; uid N -> keep-id:uid=N,gid=M.
#
# The subtlety: quadlet is a systemd GENERATOR, so the podman argv for the start
# job that is running us was baked at the last daemon-reload. Rewriting the
# quadlet here cannot change it. So when — and only when — the file actually
# changed, this reloads the generator and then exits NON-ZERO on purpose: the
# stale, mapping-less start is aborted and Restart=always (RestartSec=5) brings
# the unit straight back on the regenerated one. That is why the unit wires this
# WITHOUT a leading '-'. Every other path exits 0.
#
# No 'set -e': a single failing probe must leave the box exactly as it was.

Q="$HOME/.config/containers/systemd/servicebay.container"
[ -f "$Q" ] || exit 0

IMG="$(sed -n 's/^[[:space:]]*Image=[[:space:]]*\\([^[:space:]][^[:space:]]*\\).*$/\\1/p' "$Q" | head -n1)"
[ -n "$IMG" ] || exit 0

# The image must already be on disk (podman-auto-update pulls before it
# restarts). If it is not, we cannot know the uid — leave the quadlet alone.
if ! SPEC="$(podman image inspect "$IMG" --format '{{.Config.User}}' 2>/dev/null)"; then
    exit 0
fi
SPEC="$(printf %s "$SPEC" | tr -d '[:space:]')"

UID_WANT=""
GID_WANT=""
case "$SPEC" in
    ''|root|root:root|0|0:0)
        # Runs as uid 0 -> the mapping must be ABSENT. This is what makes a
        # rollback to a root image self-healing rather than a brick.
        ;;
    *)
        UID_WANT="$(printf %s "$SPEC" | cut -d: -f1)"
        GID_WANT="$(printf %s "$SPEC" | cut -s -d: -f2)"
        case "$UID_WANT" in
            ''|*[!0-9]*)
                # A NAME (USER nextjs) exists only in the image's own
                # /etc/passwd, so only the image can resolve it. --entrypoint id
                # overrides the server entrypoint: a sub-second run of a local
                # image, no network, no port bind.
                UID_WANT="$(podman run --rm --entrypoint id "$IMG" -u 2>/dev/null)" || exit 0
                GID_WANT="$(podman run --rm --entrypoint id "$IMG" -g 2>/dev/null)" || exit 0
                ;;
        esac
        case "$UID_WANT" in ''|*[!0-9]*) exit 0 ;; esac
        case "$GID_WANT" in ''|*[!0-9]*) GID_WANT="$UID_WANT" ;; esac
        [ "$UID_WANT" = "0" ] && UID_WANT=""
        ;;
esac

WANT=""
if [ -n "$UID_WANT" ]; then
    WANT="UserNS=keep-id:uid=$UID_WANT,gid=$GID_WANT"
fi

HAVE="$(grep -m1 -E '^[[:space:]]*UserNS[[:space:]]*=' "$Q" 2>/dev/null | tr -d '[:space:]')"
WANT_CMP="$(printf %s "$WANT" | tr -d '[:space:]')"
# Already correct (the overwhelmingly common case, every restart): exit 0 and
# let the start proceed. This guard is also what stops the exit-1 path below
# from ever becoming a restart loop.
[ "$HAVE" = "$WANT_CMP" ] && exit 0

TMP="$Q.sb-userns.tmp"
awk -v want="$WANT" '
    /^[ \\t]*UserNS[ \\t]*=/ { if (want != "" && !done) { print want; done = 1 } next }
    { print }
    /^[ \\t]*ContainerName[ \\t]*=/ { if (want != "" && !done) { print want; done = 1 } }
' "$Q" > "$TMP" 2>/dev/null || { rm -f "$TMP"; exit 0; }
[ -s "$TMP" ] || { rm -f "$TMP"; exit 0; }

# Convergence check BEFORE the swap: if the rewrite did not actually produce the
# state we want (no [Container] anchor to insert after, an unexpected shape),
# throw it away rather than restart into the same decision forever.
NEW="$(grep -m1 -E '^[[:space:]]*UserNS[[:space:]]*=' "$TMP" 2>/dev/null | tr -d '[:space:]')"
[ "$NEW" = "$WANT_CMP" ] || { rm -f "$TMP"; exit 0; }

# Atomic: a truncated write here would leave the box with no ServiceBay unit.
mv -f "$TMP" "$Q" || { rm -f "$TMP"; exit 0; }
systemctl --user daemon-reload || true

echo "servicebay-userns-selfheal: $IMG needs '$WANT' - quadlet rewritten, aborting this stale start so Restart= picks up the regenerated unit" >&2
exit 1
`;

type HookOutcome =
  /** No quadlet on this host — nothing to wire the hook into. */
  | 'no-quadlet'
  /** Script and `ExecStartPre=` were both already in place (the normal re-run). */
  | 'already-current'
  /** The script and/or the quadlet line were installed. */
  | 'installed'
  /** Something on the host refused; the box is left exactly as it was. */
  | 'failed';

export interface HostHookResult {
  outcome: HookOutcome;
  detail: string;
}

/**
 * Pure core: the quadlet text that carries the self-heal `ExecStartPre=`, or
 * `null` when it is already there (nothing to write) or the file has no
 * `[Service]` section to put it in.
 *
 * The line goes FIRST in `[Service]`, ahead of the relabel self-heal: a wrong
 * uid mapping makes every later step meaningless.
 */
export function renderQuadletSelfhealHook(content: string): string | null {
  const lines = content.split('\n');
  if (lines.some(l => l.includes(USERNS_SELFHEAL_PATH))) return null;
  const at = lines.findIndex(l => l.trim() === '[Service]');
  if (at === -1) return null;
  const next = [...lines];
  next.splice(at + 1, 0, USERNS_SELFHEAL_EXEC_START_PRE);
  return next.join('\n');
}

/** Already-installed boxes only: Ignition wrote the script on fresh ones. */
async function installScript(executor: Executor): Promise<boolean> {
  try {
    const onDisk = await executor.readFile(USERNS_SELFHEAL_PATH);
    if (onDisk === USERNS_SELFHEAL_SCRIPT) return false;
  } catch {
    // Not there yet — the expected state on every box installed before #2808.
  }
  await executor.writeFile(USERNS_SELFHEAL_TMP, USERNS_SELFHEAL_SCRIPT);
  await executor.execSafe(['mkdir', '-p', '/usr/local/bin'], { sudo: true });
  await executor.execSafe(
    ['install', '-m', '0755', '-o', 'root', '-g', 'root', USERNS_SELFHEAL_TMP, USERNS_SELFHEAL_PATH],
    { sudo: true },
  );
  return true;
}

/**
 * Put the host half on this box: the self-heal script in `/usr/local/bin` and
 * the `ExecStartPre=` that runs it in `servicebay.container`.
 *
 * Idempotent and diff-first (ADR 0012): both halves are compared to what is on
 * disk and written only on a real difference, which is logged. Never fatal —
 * the caller is the boot path, and a box that cannot take the hook must still
 * come up (it keeps the in-app reconcile it has always had).
 */
export async function installQuadletUserNsHostHook(executor: Executor): Promise<HostHookResult> {
  let quadlet: string;
  try {
    quadlet = await executor.readFile(QUADLET_PATH);
  } catch {
    return { outcome: 'no-quadlet', detail: `${QUADLET_PATH} is not readable on this host` };
  }

  try {
    const wroteScript = await installScript(executor);
    const nextQuadlet = renderQuadletSelfhealHook(quadlet);
    if (nextQuadlet !== null) {
      logger.info(TAG, `wiring ${USERNS_SELFHEAL_EXEC_START_PRE} into servicebay.container`);
      await executor.exec(shellQuoteAll(['sh', '-c', WRITE_QUADLET_SH, 'sh', nextQuadlet]));
      await executor.execSafe(['systemctl', '--user', 'daemon-reload'], { check: false });
    }
    if (!wroteScript && nextQuadlet === null) {
      return { outcome: 'already-current', detail: 'script and ExecStartPre= already in place' };
    }
    return {
      outcome: 'installed',
      detail: `${wroteScript ? 'script' : 'script unchanged'}, ${nextQuadlet === null ? 'ExecStartPre= unchanged' : 'ExecStartPre= added'}`,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logger.warn(TAG, `could not install the host-side UserNS self-heal: ${detail}`);
    return { outcome: 'failed', detail };
  }
}
