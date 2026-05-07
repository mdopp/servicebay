/**
 * Default `[Service]` directives ServiceBay injects into every .kube unit
 * it writes. Pure string transforms — no I/O, no class state — so this
 * module can be imported from any kube-write path (ServiceManager,
 * unmanaged-bundle migration, discovery's service migration) without
 * pulling in dependencies.
 *
 * - TimeoutStartSec=600  Image pulls + first-run inits can be slow.
 * - Restart=on-failure   Restart on crash, but not on clean exit (oneshot
 *                        containers exit 0 legitimately).
 * - RestartSec=5         Initial backoff. Crash-looping containers used to
 *                        retry every ~50 ms, drowning the journal.
 * - RestartSteps=4 +     Geometric backoff from 5 s up to 5 min over 4
 *   RestartMaxDelaySec    steps: ≈ 5 s, 14 s, 39 s, 107 s, 300 s. After
 *   =300                  step 4 every retry waits 5 minutes.
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

/**
 * Inject the default systemd directives into a .kube unit. Idempotent
 * per-directive — won't duplicate any directive whose key the source
 * already sets explicitly. Safe to apply to user-edited .kube files.
 */
export function injectServiceDirectives(kubeContent: string): string {
  const directives = DEFAULT_SERVICE_DIRECTIVES.filter(d => {
    const key = d.split('=')[0];
    return !new RegExp(`^${key}=`, 'm').test(kubeContent);
  });
  if (directives.length === 0) return kubeContent;
  const block = directives.join('\n');
  if (kubeContent.includes('[Service]')) {
    return kubeContent.replace('[Service]', `[Service]\n${block}`);
  }
  return kubeContent + `\n[Service]\n${block}\n`;
}
