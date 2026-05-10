/**
 * Default systemd directives ServiceBay injects into every .kube unit
 * it writes. Pure string transforms — no I/O, no class state — so this
 * module can be imported from any kube-write path (ServiceManager,
 * unmanaged-bundle migration, discovery's service migration) without
 * pulling in dependencies.
 *
 * [Service] directives:
 * - TimeoutStartSec=600  Image pulls + first-run inits can be slow.
 * - Restart=on-failure   Restart on crash, but not on clean exit (oneshot
 *                        containers exit 0 legitimately).
 * - RestartSec=5         Initial backoff. Crash-looping containers used to
 *                        retry every ~50 ms, drowning the journal.
 * - RestartSteps=4 +     Geometric backoff from 5 s up to 5 min over 4
 *   RestartMaxDelaySec    steps: ≈ 5 s, 14 s, 39 s, 107 s, 300 s. After
 *   =300                  step 4 every retry waits 5 minutes.
 *
 * [Unit] directives:
 * - StartLimitIntervalSec=0  Disables systemd's "5 fails in 10 s = give
 *                             up" guard. A fast-failing image pull
 *                             (~2 s before crash) hits the burst limit
 *                             before our backoff has had a chance to
 *                             expand, and systemd marks the unit
 *                             start-limit-hit and stops retrying —
 *                             exactly the symptom that bit nginx on
 *                             the post-3.4.2 reinstall. 0 = no limit.
 *                             Must live in [Unit]; systemd silently
 *                             ignores it under [Service].
 *
 * Requires systemd ≥ 254 (RestartSteps + RestartMaxDelaySec).
 * FCoS ships systemd 258, well past that.
 */
const DEFAULT_SERVICE_DIRECTIVES: readonly string[] = [
  'TimeoutStartSec=600',
  'Restart=on-failure',
  'RestartSec=5',
  'RestartSteps=4',
  'RestartMaxDelaySec=300',
];

const DEFAULT_UNIT_DIRECTIVES: readonly string[] = [
  'StartLimitIntervalSec=0',
];

function injectIntoSection(
  kubeContent: string,
  section: '[Service]' | '[Unit]',
  directives: readonly string[],
): string {
  const missing = directives.filter(d => {
    const key = d.split('=')[0];
    return !new RegExp(`^${key}=`, 'm').test(kubeContent);
  });
  if (missing.length === 0) return kubeContent;
  const block = missing.join('\n');
  if (kubeContent.includes(section)) {
    return kubeContent.replace(section, `${section}\n${block}`);
  }
  return kubeContent + `\n${section}\n${block}\n`;
}

/**
 * Inject the default systemd directives into a .kube unit. Idempotent
 * per-directive — won't duplicate any directive whose key the source
 * already sets explicitly. Safe to apply to user-edited .kube files.
 */
export function injectServiceDirectives(kubeContent: string): string {
  let out = injectIntoSection(kubeContent, '[Service]', DEFAULT_SERVICE_DIRECTIVES);
  out = injectIntoSection(out, '[Unit]', DEFAULT_UNIT_DIRECTIVES);
  return out;
}
