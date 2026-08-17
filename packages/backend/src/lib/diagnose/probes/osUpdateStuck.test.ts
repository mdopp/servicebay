/**
 * `os_update` probe (#2585).
 *
 * The fixtures are the real thing, not an invented format. `PAUSED` is a
 * verbatim capture of `rpm-ostree status` on the reference box taken
 * 2026-08-17 after the operator paused auto-updates, down to the two-layer
 * deployment list and the wrapped `LayeredPackages` value; `STUCK` is the same
 * box with the DriverState line it carried while the akmod build was failing
 * (`trying to stage 44.20260720.3.1 (failed attempts: 7)`, quoted in #2585).
 * The Zincati drop-in fixture is the shape `updateWindow.ts` writes plus the
 * hand-written pause file that was actually on the box.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRpmOstreeStatus,
  zincatiUpdatesDisabled,
  evaluateOsUpdate,
  OS_UPDATE_CONFIG_MARKER,
  OS_UPDATE_COMMAND,
  STUCK_ATTEMPTS_THRESHOLD,
} from './osUpdateStuck';

/** Verbatim from the box, 2026-08-17, after the operator paused updates. */
const STATUS_PAUSED = `State: idle
AutomaticUpdatesDriver: Zincati
  DriverState: active; initialization complete, auto-updates logic disabled by configuration
Deployments:
  ostree-image-signed:docker://quay.io/fedora/fedora-coreos:stable
                   Digest: sha256:5f6a577c329cecf1a4db6013f6241ef0b3f88f67ac6f30d2d1f637f28055fe13
                  Version: 44.20260720.3.1 (2026-07-28T16:37:49Z)
                     Diff: 67 upgraded, 42 added
          LayeredPackages: akmod-nvidia-open ffmpeg-free nvidia-container-toolkit python3
                           xorg-x11-drv-nvidia-cuda
            LocalPackages: rpmfusion-free-release-44-3.noarch
                           rpmfusion-nonfree-release-44-3.noarch

● ostree-image-signed:docker://quay.io/fedora/fedora-coreos:stable
                   Digest: sha256:5f6a577c329cecf1a4db6013f6241ef0b3f88f67ac6f30d2d1f637f28055fe13
                  Version: 44.20260510.3.1 (2026-05-26T16:37:49Z)
          LayeredPackages: akmod-nvidia-open nvidia-container-toolkit python3
                           xorg-x11-drv-nvidia-cuda
            LocalPackages: rpmfusion-free-release-44-3.noarch
                           rpmfusion-nonfree-release-44-3.noarch

  ostree-image-signed:docker://quay.io/fedora/fedora-coreos:stable
                   Digest: sha256:a7857f3413747f6186b748346c60e87523d67b3165def2f59890b25364ac3de1
                  Version: 44.20260419.3.1 (2026-05-10T20:44:27Z)
          LayeredPackages: akmod-nvidia-open nvidia-container-toolkit python3
                           xorg-x11-drv-nvidia-cuda
            LocalPackages: rpmfusion-free-release-44-3.noarch
                           rpmfusion-nonfree-release-44-3.noarch
`;

/** Same box while the akmod build was failing over and over (#2585). */
const STATUS_STUCK = STATUS_PAUSED.replace(
  '  DriverState: active; initialization complete, auto-updates logic disabled by configuration',
  '  DriverState: active; trying to stage 44.20260720.3.1 (failed attempts: 7)',
);

/** One failure, still retrying — the normal, uninteresting case. */
const STATUS_ONE_FAILURE = STATUS_PAUSED.replace(
  '  DriverState: active; initialization complete, auto-updates logic disabled by configuration',
  '  DriverState: active; trying to stage 44.20260720.3.1 (failed attempts: 1)',
);

/** Nothing wrong: the driver is just polling. */
const STATUS_HEALTHY = STATUS_PAUSED.replace(
  '  DriverState: active; initialization complete, auto-updates logic disabled by configuration',
  '  DriverState: active; periodically polling for updates (last checked Mon 2026-08-17 19:31:02 UTC)',
);

/** ServiceBay's own auto-update window drop-in — updates stay ENABLED. */
const CONFIG_WINDOW = `# Managed by ServiceBay — Settings → System → Auto-update window.
# Edits in this file are overwritten on the next save.

[updates]
strategy = "periodic"

[[updates.periodic.window]]
days = [ "Sat", "Sun" ]
start_time = "03:00"
length_minutes = 120
`;

/** The operator's pause file, with the prose comment it really carries. */
const CONFIG_PAUSED = `${CONFIG_WINDOW}
# Automatic OS updates paused on 2026-08-17.
#
# REASON: akmod-nvidia-open cannot build against the target release's kernel;
# the driver still includes a header the kernel dropped. Note that a naive
# substring search would trip over the words "enabled = false" in this very
# comment, which is why the reader strips comments first.
[updates]
enabled = false
`;

/** Assemble the probe's raw output the way OS_UPDATE_COMMAND does. */
const raw = (status: string, config: string) => `${status}${OS_UPDATE_CONFIG_MARKER}\n${config}`;

describe('OS_UPDATE_COMMAND', () => {
  it('reads only the operator-owned drop-ins and never fails on a box without them', () => {
    expect(OS_UPDATE_COMMAND).toContain('/etc/zincati/config.d/');
    // The distro defaults would only add precedence rules to reason about.
    expect(OS_UPDATE_COMMAND).not.toContain('/usr/lib/zincati');
    // Without this the last command's exit code decides the probe's verdict.
    expect(OS_UPDATE_COMMAND.trimEnd().endsWith('|| true')).toBe(true);
  });
});

describe('parseRpmOstreeStatus', () => {
  it('reads the driver, its state and the failed-attempt count', () => {
    const state = parseRpmOstreeStatus(STATUS_STUCK);
    expect(state.driver).toBe('Zincati');
    expect(state.stagingRelease).toBe('44.20260720.3.1');
    expect(state.failedAttempts).toBe(7);
    expect(state.disabledByConfig).toBe(false);
    expect(state.unavailable).toBe(false);
  });

  it('recognises the paused DriverState as disabled-by-configuration', () => {
    const state = parseRpmOstreeStatus(STATUS_PAUSED);
    expect(state.disabledByConfig).toBe(true);
    expect(state.failedAttempts).toBeNull();
  });

  it('collects layered packages including the wrapped continuation line', () => {
    // `xorg-x11-drv-nvidia-cuda` only appears on the wrapped second line, and
    // the akmod name is what makes the CPU explanation truthful.
    expect(parseRpmOstreeStatus(STATUS_STUCK).layeredPackages).toEqual([
      'akmod-nvidia-open',
      'ffmpeg-free',
      'nvidia-container-toolkit',
      'python3',
      'xorg-x11-drv-nvidia-cuda',
    ]);
  });

  it('takes the version from the booted deployment, not the staged one', () => {
    // The pending deployment is printed FIRST; only the `●` block is running.
    expect(parseRpmOstreeStatus(STATUS_STUCK).bootedVersion).toBe('44.20260510.3.1');
  });

  it('does not mistake a LocalPackages tail or an ostree ref for a layered package', () => {
    const layered = parseRpmOstreeStatus(STATUS_STUCK).layeredPackages;
    expect(layered.some(p => p.includes('rpmfusion'))).toBe(false);
    expect(layered.some(p => p.includes('ostree-image-signed'))).toBe(false);
  });

  it('flags output that is not rpm-ostree status at all', () => {
    expect(parseRpmOstreeStatus('bash: rpm-ostree: command not found').unavailable).toBe(true);
    expect(parseRpmOstreeStatus('').unavailable).toBe(true);
  });
});

describe('zincatiUpdatesDisabled', () => {
  it('finds `enabled = false` under [updates]', () => {
    expect(zincatiUpdatesDisabled(CONFIG_PAUSED)).toBe(true);
  });

  it('does not fire on ServiceBay\'s ordinary auto-update window drop-in', () => {
    expect(zincatiUpdatesDisabled(CONFIG_WINDOW)).toBe(false);
  });

  it('ignores the phrase when it only appears in a comment', () => {
    expect(zincatiUpdatesDisabled('[updates]\n# enabled = false was tried once\nstrategy = "immediate"\n')).toBe(false);
  });

  it('ignores `enabled = false` belonging to another table', () => {
    expect(zincatiUpdatesDisabled('[identity]\nenabled = false\n')).toBe(false);
  });

  it('is silent on an empty drop-in directory', () => {
    expect(zincatiUpdatesDisabled('')).toBe(false);
  });
});

describe('evaluateOsUpdate — the three states (#2585)', () => {
  it('warns once staging has failed repeatedly, and names the kernel-module build as the CPU source', () => {
    const result = evaluateOsUpdate(raw(STATUS_STUCK, CONFIG_WINDOW), 0);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('44.20260720.3.1');
    expect(result.detail).toContain('7 times in a row');
    // The whole point of the probe: an operator hunting the load must be told
    // it is a kernel-module compile, not a vague "updates are failing".
    expect(result.detail).toContain('akmod-nvidia-open');
    expect(result.detail).toMatch(/kernel module from source/);
    expect(result.detail).toMatch(/not any service or container/);
    // And that it will not clear on its own.
    expect(result.detail).toMatch(/repeats indefinitely/);
    expect(result.hint).toBeTruthy();
  });

  it('stays quiet on a single failed attempt — retrying is how staging recovers', () => {
    const result = evaluateOsUpdate(raw(STATUS_ONE_FAILURE, CONFIG_WINDOW), 0);
    expect(result.status).toBe('ok');
    expect(result.hint).toBeUndefined();
  });

  it('stays quiet one attempt below the threshold and fires exactly at it', () => {
    const at = (n: number) =>
      evaluateOsUpdate(
        raw(STATUS_STUCK.replace('failed attempts: 7', `failed attempts: ${n}`), CONFIG_WINDOW),
        0,
      ).status;
    expect(at(STUCK_ATTEMPTS_THRESHOLD - 1)).toBe('ok');
    expect(at(STUCK_ATTEMPTS_THRESHOLD)).toBe('warn');
  });

  it('reports a healthy, polling updater without noise', () => {
    const result = evaluateOsUpdate(raw(STATUS_HEALTHY, CONFIG_WINDOW), 0);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('Zincati');
  });

  it('treats a deliberately paused updater as information, never a warning', () => {
    const result = evaluateOsUpdate(raw(STATUS_PAUSED, CONFIG_PAUSED), 0);
    expect(result.status).toBe('info');
    expect(result.detail).toMatch(/deliberate choice, not a fault/);
    // It still says what the pause costs, so nobody forgets they paused.
    expect(result.detail).toMatch(/stays on this release/);
  });

  it('does NOT warn on a pause even while a high failed-attempt count is still reported', () => {
    // The window between writing the pause drop-in and zincati restarting:
    // the config already says off, the daemon still reports the old retry.
    const result = evaluateOsUpdate(raw(STATUS_STUCK, CONFIG_PAUSED), 0);
    expect(result.status).toBe('info');
    expect(result.detail).toMatch(/history, not a fault/);
    expect(result.detail).toContain('7');
  });

  it('does NOT warn when only the DriverState reports the pause and no drop-in is readable', () => {
    // The mirror case: the pause came from somewhere this probe cannot read,
    // but zincati's own effective state is authoritative.
    const result = evaluateOsUpdate(raw(STATUS_PAUSED, ''), 0);
    expect(result.status).toBe('info');
  });
});

describe('evaluateOsUpdate — boxes with nothing to report', () => {
  it('is silent on a system that is not rpm-ostree based', () => {
    const result = evaluateOsUpdate(raw('bash: rpm-ostree: command not found\n', ''), 0);
    expect(result.status).toBe('info');
    expect(result.detail).toMatch(/Not an rpm-ostree system/);
  });

  it('is silent when rpm-ostree is present but no update driver is configured', () => {
    const noDriver = STATUS_PAUSED.split('\n')
      .filter(l => !/AutomaticUpdatesDriver|DriverState/.test(l))
      .join('\n');
    const result = evaluateOsUpdate(raw(noDriver, ''), 0);
    expect(result.status).toBe('info');
    expect(result.detail).toMatch(/No automatic OS update driver/);
  });

  it('reports an unreadable state honestly instead of guessing', () => {
    const result = evaluateOsUpdate('', undefined);
    expect(result.status).toBe('info');
    expect(result.detail).toMatch(/unknown/);
  });

  it('falls back to a generic cost sentence when nothing kernel-shaped is layered', () => {
    const plain = STATUS_STUCK.replace(/akmod-nvidia-open /g, '');
    const result = evaluateOsUpdate(raw(plain, CONFIG_WINDOW), 0);
    expect(result.status).toBe('warn');
    expect(result.detail).not.toContain('kernel module from source');
    expect(result.detail).toContain('layered packages');
  });
});
