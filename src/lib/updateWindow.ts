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

const PODMAN_TIMER_DROPIN = '/etc/systemd/system/podman-auto-update.timer.d/55-servicebay-window.conf';
const PODMAN_TIMER_TMP = '/tmp/55-servicebay-podman-timer.conf';

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

async function execIgnoringFailure(executor: Executor, cmd: string, tag: string): Promise<void> {
  try {
    await executor.exec(cmd);
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
  await executor.exec(`sudo mkdir -p ${dir}`);
  await executor.exec(`sudo install -m 0644 -o root -g root ${tmpPath} ${finalPath}`);
}

async function writeZincatiWindow(executor: Executor, window: Window): Promise<void> {
  await execIgnoringFailure(executor, `sudo rm -f ${ZINCATI_LOCK_PATH}`, 'rm zincati lock');
  await writeRoot(executor, ZINCATI_TMP, ZINCATI_PATH, renderZincatiToml(window));
  await execIgnoringFailure(executor, 'sudo systemctl restart zincati', 'restart zincati');
}

async function writeZincatiLock(executor: Executor): Promise<void> {
  // Remove the window drop-in (if any) so the lock isn't fighting it,
  // then write `[updates] enabled = false`. Zincati merges both files
  // alphabetically and uses the later value — `55-servicebay-lock`
  // sorts after `55-servicebay-window`, but we delete the window
  // file anyway to keep the diagnostic state obvious.
  await execIgnoringFailure(executor, `sudo rm -f ${ZINCATI_PATH}`, 'rm zincati window');
  await writeRoot(executor, ZINCATI_TMP, ZINCATI_LOCK_PATH, ZINCATI_LOCK_TOML);
  await execIgnoringFailure(executor, 'sudo systemctl restart zincati', 'restart zincati');
}

async function writePodmanTimerWindow(executor: Executor, window: Window): Promise<void> {
  await writeRoot(executor, PODMAN_TIMER_TMP, PODMAN_TIMER_DROPIN, renderPodmanTimerDropin(window));
  await execIgnoringFailure(executor, 'sudo systemctl daemon-reload', 'daemon-reload');
  await execIgnoringFailure(executor, 'sudo systemctl unmask podman-auto-update.timer', 'unmask podman timer');
  await execIgnoringFailure(executor, 'sudo systemctl enable --now podman-auto-update.timer', 'enable podman timer');
}

async function lockPodmanTimer(executor: Executor): Promise<void> {
  // Mask is the cleanest "this timer is intentionally off" state —
  // it can't be started by accident, only an explicit unmask brings
  // it back. We also remove our drop-in so a future operator who
  // unmasks manually doesn't get our schedule by surprise.
  await execIgnoringFailure(executor, `sudo rm -f ${PODMAN_TIMER_DROPIN}`, 'rm podman dropin');
  await execIgnoringFailure(executor, 'sudo systemctl daemon-reload', 'daemon-reload');
  await execIgnoringFailure(executor, 'sudo systemctl disable --now podman-auto-update.timer', 'stop podman timer');
  await execIgnoringFailure(executor, 'sudo systemctl mask podman-auto-update.timer', 'mask podman timer');
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
