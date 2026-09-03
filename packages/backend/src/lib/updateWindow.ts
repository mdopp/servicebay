/**
 * Host-side I/O for the unified update window. Two entry points:
 *
 *   - `applyUpdateWindow(executor, window)` — operator-driven path,
 *     called from PUT /api/system/update-window. Renders the chosen
 *     window onto whichever update sources `applyTo` opts in to, and
 *     keeps the others in their default state. When `enabled: false`
 *     it falls through to the lock path so every source is held.
 *
 *   - `applyLocks(executor)` — boot-time safety net, called from
 *     server.ts when `config.updateWindow` is undefined or disabled.
 *     Writes the "don't auto-update anything" state. This is what
 *     stops the foot-gun where Fedora CoreOS auto-updates mid-install,
 *     reboots, and re-images itself from the still-inserted USB stick.
 *
 * Both paths use the same low-level helpers, are idempotent (re-running
 * them is a no-op when on-disk state already matches), and tolerate a
 * missing executor / network blip — they log + bail rather than
 * crashing the route or the server boot path.
 */
import type { Executor } from './interfaces';
import type { AppConfig } from './config';
import { logger } from './logger';

const ZINCATI_DIR = '/etc/zincati/config.d';
const ZINCATI_PATH = `${ZINCATI_DIR}/55-servicebay-window.toml`;
const ZINCATI_LOCK_PATH = `${ZINCATI_DIR}/55-servicebay-lock.toml`;
const ZINCATI_TMP = '/tmp/55-servicebay-zincati.toml';

/**
 * The podman auto-update timer is driven at the **user** (rootless) level,
 * because that is the only level ServiceBay's containers exist at: every
 * service is a Quadlet under `~/.config/containers/systemd/` (`dirs.ts:
 * getLocalSystemdDir`) driven by `systemctl --user` (`serviceLifecycle.ts`),
 * and `install/runner.ts` stamps `AutoUpdate=registry` into those user
 * `.kube` units. The root systemd manager only ever sees root-owned
 * containers, of which ServiceBay creates none — so a system-scope
 * `podman-auto-update.timer` had nothing to act on and the `AutoUpdate=`
 * label was never evaluated (#2515).
 *
 * The drop-in therefore has to land in the *user* unit search path, so the
 * same manager that loads `podman-auto-update.timer` loads our override.
 */
const PODMAN_TIMER_UNIT = 'podman-auto-update.timer';
const PODMAN_USER_TIMER_DROPIN = `~/.config/systemd/user/${PODMAN_TIMER_UNIT}.d/55-servicebay-window.conf`;

/**
 * Where ServiceBay *used* to write the drop-in, back when it drove the
 * system-scope timer. Kept only so both paths can clean it up — see
 * `retireSystemPodmanTimer`. Never written to again.
 */
const LEGACY_SYSTEM_TIMER_DROPIN = `/etc/systemd/system/${PODMAN_TIMER_UNIT}.d/55-servicebay-window.conf`;

/**
 * A `systemctl --user` invocation needs the user bus. The agent process is
 * launched with `XDG_RUNTIME_DIR` exported (`agent/handler.ts`), but the
 * value is re-derived here so a locally-spawned or re-parented executor is
 * never left without a bus address. Lingering is provisioned for the host
 * user in `fedora-coreos.bu`, so the user manager is up without a login.
 */
/** Shell required: `${VAR:-default}` and `$(id -u)` are shell expansions,
 *  and the leading `export …;` is a shell statement. */
function userSystemctl(args: string): string {
  return `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; systemctl --user ${args}`;
}

type Window = NonNullable<AppConfig['updateWindow']>;

/**
 * `OnCalendar=` accepts a comma-separated weekday list followed by the
 * date+time pattern. Same day codes Zincati uses (3-letter Mon..Sun),
 * which matches the operator's selection one-to-one.
 */
function systemdOnCalendar(window: Window): string {
  return `${window.days.join(',')} *-*-* ${window.startTime}:00 UTC`;
}

function renderZincatiToml(window: Window): string {
  return `# Managed by ServiceBay — Settings → System → Auto-update window.
# Edits in this file are overwritten on the next save.

[updates]
strategy = "periodic"

[[updates.periodic.window]]
days = [ ${window.days.map(d => `"${d}"`).join(', ')} ]
start_time = "${window.startTime}"
length_minutes = ${window.lengthMinutes}
`;
}

function renderPodmanTimerDropin(window: Window): string {
  // The drop-in REPLACES the unit's OnCalendar list because the
  // [Timer] header in a drop-in *appends* by default. We explicitly
  // zero the prior list with an empty `OnCalendar=` line, then set
  // ours. Without the zero, the default daily fire still applies and
  // the window is effectively ignored.
  return `# Managed by ServiceBay — Settings → System → Auto-update window.
[Timer]
OnCalendar=
OnCalendar=${systemdOnCalendar(window)}
Persistent=true
`;
}

const ZINCATI_LOCK_TOML = `# Managed by ServiceBay — auto-updates locked until you choose a
# window in Settings → System → Auto-update window. Removing this
# file by hand will re-enable Zincati's default \`immediate\` strategy.

[updates]
enabled = false
`;

/** Run a best-effort host command; a failure is logged, never fatal. Takes a
 *  thunk so each caller picks execSafe (argv) or exec (real shell need). */
async function execIgnoringFailure(run: () => Promise<unknown>, tag: string): Promise<void> {
  try {
    await run();
  } catch (e) {
    logger.warn('updateWindow', `${tag} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function writeRoot(executor: Executor, tmpPath: string, finalPath: string, content: string): Promise<void> {
  // Two-step: agent writes /tmp (its own user can do that), then
  // sudo `install` copies it into a root-owned location atomically.
  // The intermediate file is harmless (regenerated each save).
  await executor.writeFile(tmpPath, content);
  const dir = finalPath.slice(0, finalPath.lastIndexOf('/'));
  await executor.execSafe(['mkdir', '-p', dir], { sudo: true });
  await executor.execSafe(['install', '-m', '0644', '-o', 'root', '-g', 'root', tmpPath, finalPath], { sudo: true });
}

async function writeZincatiWindow(executor: Executor, window: Window): Promise<void> {
  await execIgnoringFailure(() => executor.execSafe(['rm', '-f', ZINCATI_LOCK_PATH], { sudo: true }), 'rm zincati lock');
  await writeRoot(executor, ZINCATI_TMP, ZINCATI_PATH, renderZincatiToml(window));
  await execIgnoringFailure(() => executor.execSafe(['systemctl', 'restart', 'zincati'], { sudo: true }), 'restart zincati');
}

async function writeZincatiLock(executor: Executor): Promise<void> {
  // Remove the window drop-in (if any) so the lock isn't fighting it,
  // then write `[updates] enabled = false`. Zincati merges both files
  // alphabetically and uses the later value — `55-servicebay-lock`
  // sorts after `55-servicebay-window`, but we delete the window
  // file anyway to keep the diagnostic state obvious.
  await execIgnoringFailure(() => executor.execSafe(['rm', '-f', ZINCATI_PATH], { sudo: true }), 'rm zincati window');
  await writeRoot(executor, ZINCATI_TMP, ZINCATI_LOCK_PATH, ZINCATI_LOCK_TOML);
  await execIgnoringFailure(() => executor.execSafe(['systemctl', 'restart', 'zincati'], { sudo: true }), 'restart zincati');
}

/**
 * One-shot migration, run from BOTH podman paths so it self-heals whichever
 * way the operator flips the switch: undo the system-scope state older
 * ServiceBay versions left behind (our drop-in, the enablement, the mask)
 * and hand the unit back to its distro default (`preset: disabled`).
 *
 * ServiceBay does not manage root-owned containers, so it has no business
 * owning a root-scope timer — leaving it enabled "just in case" would keep a
 * second, invisible schedule for the same operator switch.
 */
async function retireSystemPodmanTimer(executor: Executor): Promise<void> {
  await execIgnoringFailure(() => executor.execSafe(['rm', '-f', LEGACY_SYSTEM_TIMER_DROPIN], { sudo: true }), 'rm legacy system dropin');
  await execIgnoringFailure(() => executor.execSafe(['systemctl', 'unmask', PODMAN_TIMER_UNIT], { sudo: true }), 'unmask legacy system timer');
  await execIgnoringFailure(() => executor.execSafe(['systemctl', 'daemon-reload'], { sudo: true }), 'system daemon-reload');
  await execIgnoringFailure(() => executor.execSafe(['systemctl', 'disable', '--now', PODMAN_TIMER_UNIT], { sudo: true }), 'disable legacy system timer');
}

async function writePodmanTimerWindow(executor: Executor, window: Window): Promise<void> {
  // User-owned path — no sudo, no /tmp staging. `write_file` expands `~`
  // and creates the `.d` directory, so the drop-in lands directly in the
  // user unit search path.
  await executor.writeFile(PODMAN_USER_TIMER_DROPIN, renderPodmanTimerDropin(window));
  await execIgnoringFailure(() => executor.exec(userSystemctl('daemon-reload')), 'user daemon-reload');
  await execIgnoringFailure(() => executor.exec(userSystemctl(`unmask ${PODMAN_TIMER_UNIT}`)), 'unmask user podman timer');
  await execIgnoringFailure(() => executor.exec(userSystemctl(`enable --now ${PODMAN_TIMER_UNIT}`)), 'enable user podman timer');
  await retireSystemPodmanTimer(executor);
}

async function lockPodmanTimer(executor: Executor): Promise<void> {
  // Mask is the cleanest "this timer is intentionally off" state —
  // it can't be started by accident, only an explicit unmask brings
  // it back. We also remove our drop-in so a future operator who
  // unmasks manually doesn't get our schedule by surprise.
  //
  // This MUST act at the same level `writePodmanTimerWindow` enables at
  // (user), or switching the window off would leave the rootless timer
  // running on our schedule with nothing left to turn it off (#2515).
  // Shell required: PODMAN_USER_TIMER_DROPIN is a `~`-relative path the host
  // shell expands (write_file expands it too, see writePodmanTimerWindow).
  await execIgnoringFailure(() => executor.exec('rm -f ' + PODMAN_USER_TIMER_DROPIN), 'rm user podman dropin');
  await execIgnoringFailure(() => executor.exec(userSystemctl('daemon-reload')), 'user daemon-reload');
  await execIgnoringFailure(() => executor.exec(userSystemctl(`disable --now ${PODMAN_TIMER_UNIT}`)), 'stop user podman timer');
  await execIgnoringFailure(() => executor.exec(userSystemctl(`mask ${PODMAN_TIMER_UNIT}`)), 'mask user podman timer');
  await retireSystemPodmanTimer(executor);
}

/**
 * Apply the operator's chosen window to whichever sources `applyTo`
 * opts in to. Sources that are opted out get the lock applied (so the
 * operator can't accidentally leave one stream firing freely while
 * they tighten the others). When `enabled: false` everything locks.
 */
export async function applyUpdateWindow(executor: Executor, window: Window): Promise<void> {
  if (!window.enabled) {
    await applyLocks(executor);
    return;
  }
  if (window.applyTo.os) {
    await writeZincatiWindow(executor, window);
  } else {
    await writeZincatiLock(executor);
  }
  if (window.applyTo.containers) {
    await writePodmanTimerWindow(executor, window);
  } else {
    await lockPodmanTimer(executor);
  }
}

/**
 * Boot-time / opt-out safety net: lock every auto-update source so a
 * surprise reboot can't fire while the operator is still installing
 * or making up their mind. Idempotent.
 */
export async function applyLocks(executor: Executor): Promise<void> {
  await writeZincatiLock(executor);
  await lockPodmanTimer(executor);
}
