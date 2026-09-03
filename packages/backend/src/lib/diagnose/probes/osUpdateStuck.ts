/**
 * `os_update` probe (#2585) — is the box's automatic OS update retrying a
 * staging step it can never complete?
 *
 * ## Why this needs a probe at all
 *
 * On Fedora CoreOS, Zincati stages OS updates on a fixed retry interval. When
 * the box has **layered packages** (`rpm-ostree status` → `LayeredPackages:`),
 * every staging attempt re-runs those packages' `%post` scripts inside the new
 * deployment. An `akmod-*` package's `%post` *builds a kernel module from
 * source*, which is a multi-minute, near-full-core compile.
 *
 * If that build cannot succeed against the target release's kernel — an NVIDIA
 * driver including a header the kernel dropped, say — the attempt fails, the
 * retry timer fires, and the compile starts over. Forever. On the reference box
 * this ran from 2026-08-14 to 2026-08-17: an attempt every ~6 minutes, ~7
 * minutes of `cc1` at ~75 % CPU each, 457 attempts, no update ever installed.
 *
 * The reason it needs *ServiceBay* to say something is the shape of the
 * symptom. The operator sees "the box is slow", opens ServiceBay, and looks at
 * the **services** — where there is nothing wrong, because nothing here is a
 * service. Every other signal points away from the cause: no container is
 * misbehaving, no unit is failed (the retry is Zincati working as designed),
 * disk is fine, and the version string still reads like a normal release. So
 * the probe's job is not "updates are failing" — it is naming the CPU burn and
 * saying which layer it comes from.
 *
 * ## Three states, and why a pause is not a fault
 *
 * `rpm-ostree status` reports Zincati's own state machine verbatim, so all
 * three states are one cheap read:
 *
 *   * stuck   — `DriverState: active; trying to stage <release> (failed attempts: N)`
 *   * paused  — `DriverState: active; …, auto-updates logic disabled by configuration`
 *   * healthy — `DriverState: active; periodically polling for updates …`
 *
 * The paused state matters as much as the stuck one. Pausing auto-updates is a
 * **supported ServiceBay action** — `updateWindow.ts` writes exactly
 * `[updates] enabled = false` into `/etc/zincati/config.d/55-servicebay-lock.toml`
 * when the operator locks updates from Settings → System — and an operator who
 * pauses updates to stop a broken kernel-module build has *resolved* the
 * problem this probe exists to report. A probe that then went red would be
 * punishing the fix. So a paused updater is reported as information, never as a
 * warning, no matter what attempt count is still lying around in the state
 * string.
 *
 * The pause is detected two ways, deliberately: Zincati's own DriverState text
 * (authoritative — it reflects the *effective* config), plus a direct read of
 * the `/etc/zincati/config.d` drop-ins (covers the window where the file is
 * written but `systemctl restart zincati` has not landed yet, so the daemon is
 * still reporting the old "trying to stage" string).
 *
 * Detection is read-only — one `rpm-ostree status` plus a `cat` of the drop-in
 * directory. The parse and the verdict are pure functions, so all three states
 * are unit-testable from fixtures without a host.
 */

export const PROBE_ID = 'os_update';
export const PROBE_LABEL = 'OS updates';

/** Separates the `rpm-ostree status` output from the Zincati drop-ins. */
export const OS_UPDATE_CONFIG_MARKER = '---zincati-config---';

/**
 * One read: the updater's live state, then the operator-owned Zincati
 * drop-ins. Only `/etc/zincati/config.d` is read — `/usr/lib/zincati/config.d`
 * holds the distro defaults, which cannot express an operator's intent and
 * would only add precedence rules to reason about.
 */
export const OS_UPDATE_COMMAND =
  'rpm-ostree status 2>&1; ' +
  `echo "${OS_UPDATE_CONFIG_MARKER}"; ` +
  // `|| true` so a box with no drop-in directory (the glob then expands to
  // itself and `cat` exits 1) still reports exit 0. Whether this is an
  // rpm-ostree box at all is decided by the parse, not by an exit code the
  // last command in the pipeline happens to own.
  'cat /etc/zincati/config.d/*.toml 2>/dev/null || true';

/**
 * How many consecutive failed staging attempts before this is a warning.
 *
 * **One failure is normal and must not fire.** Staging pulls an ostree commit
 * and re-runs layered `%post` scripts; a network blip, a busy mirror or a
 * transient rpm-md read all produce a single failure that the next retry
 * clears, and warning on that would make the probe noise on every healthy box.
 * Two is still plausibly the same transient condition being retried too soon.
 *
 * At **three consecutive failures on the same release** the transient
 * explanation is spent: the same deterministic step has now failed three times
 * in a row against the same target. Three is also where the cost becomes the
 * operator's problem rather than a curiosity — on the reference box each
 * attempt was ~7 minutes of compile at ~75 % CPU, so three attempts is already
 * ~20 minutes of unexplained near-full load, which is roughly when someone
 * starts looking for it.
 *
 * The ceiling matters too: Zincati's counter resets (a daemon restart, a new
 * target release), and the live box showed `failed attempts: 7` in DriverState
 * while the journal held 457 failures over three days. The count is therefore a
 * *floor*, not a total — a threshold up in the tens would simply never fire.
 */
export const STUCK_ATTEMPTS_THRESHOLD = 3;

type OsUpdateProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

/** What Zincati is doing right now, as parsed from `rpm-ostree status`. */
export interface OsUpdateState {
  /** `AutomaticUpdatesDriver: <name>`, or null when no driver is configured. */
  driver: string | null;
  /** The raw `DriverState:` text, or null when absent. */
  driverState: string | null;
  /** Release the driver is trying to stage, when it says so. */
  stagingRelease: string | null;
  /** `failed attempts: N` from the DriverState, or null when not reported. */
  failedAttempts: number | null;
  /** Zincati itself reports auto-updates off (the effective state). */
  disabledByConfig: boolean;
  /** Every layered package name found in the status output, de-duplicated. */
  layeredPackages: string[];
  /** Version of the currently-booted deployment (the `●` block). */
  bootedVersion: string | null;
  /** True when the output does not look like `rpm-ostree status` at all. */
  unavailable: boolean;
}

/** `DriverState: active; trying to stage 44.20260720.3.1 (failed attempts: 7)` */
const STAGING_RELEASE = /trying to stage\s+(\S+)/i;
const FAILED_ATTEMPTS = /failed attempts:\s*(\d+)/i;
/** Zincati's wording when `[updates] enabled = false` is in effect. */
const DISABLED_BY_CONFIG = /auto-?updates?\s+logic\s+disabled\s+by\s+configuration/i;

/** A `Key: value` line. Top-level fields (`State`, `AutomaticUpdatesDriver`)
 *  sit at column 0 while per-deployment fields are indented, so leading
 *  whitespace is optional. The required space *after* the colon is what keeps
 *  `ostree-image-signed:docker://…` (a deployment header) from being read as
 *  a key. */
const KEY_LINE = /^\s*([A-Za-z][A-Za-z0-9 -]*):[ \t]+(.*)$/;
/** A wrapped continuation of a package list: bare package tokens only, so a
 *  line carrying a colon (a key, a URL, an ostree ref) never qualifies. */
const PACKAGE_CONTINUATION = /^\s+[A-Za-z0-9][A-Za-z0-9._+-]*(\s+[A-Za-z0-9][A-Za-z0-9._+-]*)*\s*$/;
/** Package-list fields whose value can wrap onto following indented lines.
 *  Only the layered sets feed the "what does staging rebuild" explanation;
 *  `LocalPackages` is tracked purely so its wrapped tail isn't mistaken for
 *  the start of a new deployment block. */
const WRAPPED_LISTS: Record<string, { layered: boolean }> = {
  LayeredPackages: { layered: true },
  RequestedLayeredPackages: { layered: true },
  LocalPackages: { layered: false },
  RequestedLocalPackages: { layered: false },
};

/**
 * Parse `rpm-ostree status` (the human-readable form — `--json` is not
 * available on every rpm-ostree the fleet runs, and the driver state we need
 * is printed here regardless). Tolerant by design: an unrecognised line is
 * skipped rather than throwing, because the layout varies with rpm-ostree
 * version and a parse hiccup must never take down the diagnose run.
 */
export function parseRpmOstreeStatus(raw: string): OsUpdateState {
  const lines = (raw ?? '').split('\n');
  const state: OsUpdateState = {
    driver: null,
    driverState: null,
    stagingRelease: null,
    failedAttempts: null,
    disabledByConfig: false,
    layeredPackages: [],
    bootedVersion: null,
    unavailable: true,
  };

  const layered = new Set<string>();
  // Non-null while the previous key line opened a package list whose value may
  // wrap onto the following indented lines; the flag says whether those
  // wrapped tokens are layered packages we want to collect.
  let wrappedList: { layered: boolean } | null = null;
  // True while we're inside the `●`-marked (currently booted) deployment.
  let inBooted = false;

  for (const line of lines) {
    if (line.trim() === '') {
      wrappedList = null;
      continue;
    }
    if (/^\s*●/.test(line)) {
      // The booted-deployment marker starts a new block.
      inBooted = true;
      wrappedList = null;
      continue;
    }
    const key = KEY_LINE.exec(line);
    if (key) {
      const name = key[1].trim();
      const value = key[2].trim();
      wrappedList = WRAPPED_LISTS[name] ?? null;
      if (wrappedList?.layered) {
        for (const pkg of value.split(/\s+/).filter(Boolean)) layered.add(pkg);
      } else if (name === 'AutomaticUpdatesDriver') {
        state.driver = value;
        state.unavailable = false;
      } else if (name === 'DriverState') {
        state.driverState = value;
        state.unavailable = false;
      } else if (name === 'State') {
        state.unavailable = false;
      } else if (name === 'Version') {
        state.unavailable = false;
        // `44.20260510.3.1 (2026-05-26T16:37:49Z)` — keep the release id only.
        if (inBooted && state.bootedVersion === null) state.bootedVersion = value.split(/\s+/)[0] ?? null;
      }
      continue;
    }
    if (wrappedList && PACKAGE_CONTINUATION.test(line)) {
      if (wrappedList.layered) {
        for (const pkg of line.trim().split(/\s+/).filter(Boolean)) layered.add(pkg);
      }
      continue;
    }
    // Anything else that is neither a key nor a wrapped tail is a deployment
    // header (`  ostree-image-signed:docker://…`) or the `Deployments:` banner
    // — either way the previous block, booted or not, has ended.
    wrappedList = null;
    inBooted = false;
  }

  if (state.driverState) {
    state.stagingRelease = STAGING_RELEASE.exec(state.driverState)?.[1] ?? null;
    const attempts = FAILED_ATTEMPTS.exec(state.driverState)?.[1];
    state.failedAttempts = attempts === undefined ? null : Number.parseInt(attempts, 10);
    state.disabledByConfig = DISABLED_BY_CONFIG.test(state.driverState);
  }
  state.layeredPackages = [...layered].sort();
  return state;
}

/**
 * Does any Zincati drop-in turn auto-updates off? A minimal TOML read: track
 * the current table header and look for `enabled = false` under `[updates]`.
 * Comments are stripped first — the pause file on the reference box carries a
 * long prose comment explaining *why*, and a naive substring match on it would
 * be both wrong and unstable.
 */
export function zincatiUpdatesDisabled(configText: string): boolean {
  let table = '';
  for (const rawLine of (configText ?? '').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const header = /^\[+\s*([^\]]+?)\s*\]+$/.exec(line);
    if (header) {
      table = header[1];
      continue;
    }
    if (table !== 'updates') continue;
    if (/^enabled\s*=\s*false\b/i.test(line)) return true;
  }
  return false;
}

export interface OsUpdateProbeResult {
  status: OsUpdateProbeStatus;
  detail: string;
  hint?: string;
}

/** Layered packages whose `%post` compiles a kernel module — the reason a
 *  failing staging retry costs a full core for minutes instead of seconds. */
function kernelModulePackages(layered: string[]): string[] {
  return layered.filter(p => /^(akmod|kmod)-/.test(p));
}

/** The cost sentence — what the retry loop is actually spending, named
 *  concretely enough that an operator hunting "why is the CPU pegged"
 *  recognises it. */
function costExplanation(layered: string[]): string {
  const kmods = kernelModulePackages(layered);
  if (kmods.length > 0) {
    return (
      `Each attempt re-runs the layered packages' install scripts, and ${kmods.join(', ')} ` +
      'builds a kernel module from source — a multi-minute compile that saturates a CPU core. ' +
      'That compile, not any service or container, is what the load is.'
    );
  }
  if (layered.length > 0) {
    return (
      `Each attempt re-runs the install scripts of the layered packages (${layered.join(', ')}) ` +
      'against the new deployment, so the work is repeated in full every time.'
    );
  }
  return 'Each attempt repeats the whole staging step from the start.';
}

const STUCK_HINT =
  'Find out what is failing with `sudo journalctl -u zincati -b | grep -i "failed to stage"` and, for the ' +
  'underlying error, `sudo rpm-ostree upgrade --preview` or the last `rpm-ostree` transaction in ' +
  '`journalctl -u rpm-ostreed`. A layered kernel-module package that cannot build against the target ' +
  "release's kernel is the usual cause, and it will not fix itself — the retry repeats the same build. " +
  'Two ways out, both operator decisions ServiceBay does not take for you: remove or replace the layered ' +
  'package (`sudo rpm-ostree uninstall <package>`) so staging can finish, or stop the retries until the ' +
  'package catches up — Settings → System → Auto-update window can lock auto-updates, which writes ' +
  '`[updates] enabled = false` for Zincati. Pausing stops the CPU burn but leaves the box on its current ' +
  'OS release, so it is a hold, not a fix.';

/**
 * Pure verdict over the probe's raw output. `execCode` is the exit code of
 * the read itself, so an unreadable box is reported honestly instead of being
 * mistaken for "no updater configured".
 */
export function evaluateOsUpdate(raw: string, execCode: number | undefined): OsUpdateProbeResult {
  if (execCode !== 0) {
    return {
      status: 'info',
      detail: 'Could not read the OS update state (`rpm-ostree status` did not run), so it is unknown.',
    };
  }

  const markerAt = (raw ?? '').indexOf(OS_UPDATE_CONFIG_MARKER);
  const statusText = markerAt === -1 ? (raw ?? '') : raw.slice(0, markerAt);
  const configText = markerAt === -1 ? '' : raw.slice(markerAt + OS_UPDATE_CONFIG_MARKER.length);

  const state = parseRpmOstreeStatus(statusText);
  if (state.unavailable) {
    // Not an rpm-ostree box (a package-based distro, a container dev box).
    // Silence, not a warning — there is no staging loop to be stuck in.
    return {
      status: 'info',
      detail: 'Not an rpm-ostree system — no automatic OS update staging to watch.',
    };
  }

  const on = state.bootedVersion ? ` The box is running ${state.bootedVersion}.` : '';
  const attempts = state.failedAttempts;

  // Paused FIRST, before any attempt count is considered. A deliberate pause
  // is a normal, ServiceBay-supported condition — see the module header.
  if (state.disabledByConfig || zincatiUpdatesDisabled(configText)) {
    const leftover =
      attempts !== null && attempts > 0
        ? ` The last staging run had failed ${attempts} time(s) before the pause; that is history, not a fault.`
        : '';
    return {
      status: 'info',
      detail:
        'Automatic OS updates are switched off by configuration — a deliberate choice, not a fault.' +
        `${on}${leftover} The box stays on this release until updates are switched back on.`,
      hint:
        'Re-enable them in Settings → System → Auto-update window, or by removing the ' +
        '`[updates] enabled = false` drop-in under /etc/zincati/config.d and restarting zincati.',
    };
  }

  if (!state.driver) {
    return {
      status: 'info',
      detail: `No automatic OS update driver is configured on this box.${on}`,
    };
  }

  if (attempts !== null && attempts >= STUCK_ATTEMPTS_THRESHOLD) {
    const target = state.stagingRelease ? ` ${state.stagingRelease}` : ' the next OS release';
    return {
      status: 'warn',
      detail:
        `Automatic OS updates are stuck: staging${target} has failed ${attempts} times in a row and is ` +
        `still being retried.${on} ${costExplanation(state.layeredPackages)} ` +
        'The retry runs on a timer and the failure is deterministic, so this repeats indefinitely — the ' +
        'box neither updates nor stops trying.',
      hint: STUCK_HINT,
    };
  }

  if (attempts !== null && attempts > 0) {
    // Below the threshold: a retry in progress is how staging is supposed to
    // recover from a blip. Report it, don't warn about it.
    return {
      status: 'ok',
      detail:
        `Automatic OS updates are staging${state.stagingRelease ? ` ${state.stagingRelease}` : ''} after ` +
        `${attempts} failed attempt(s) — still within the normal retry range.${on}`,
    };
  }

  return {
    status: 'ok',
    detail: `Automatic OS updates are active via ${state.driver}: ${state.driverState ?? 'running'}.${on}`,
  };
}
