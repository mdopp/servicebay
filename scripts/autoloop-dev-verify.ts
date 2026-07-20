/**
 * `:dev` flip-verify-flipback harness for box-verify (#2306 slice 3).
 *
 * The FULL box-verify path — pre-pull `:dev`, wait for the image, flip, run the
 * probes, **flip back to `:latest`** — is deterministic *except* the probes
 * (what to assert is LLM judgment). The load-bearing invariant is "never leave
 * the box stranded on `:dev`". In prose that's an advisory rule a stage agent
 * can skip on an error path; here it is a `finally` — **structural**. The agent
 * supplies its probes as a script; the harness guarantees the flip-back even if
 * the probes throw, hang, or the agent dies (CLAUDE.md "Deterministic → scripts;
 * LLMs coordinate + evaluate").
 *
 *   tsx scripts/autoloop-dev-verify.ts <sha> --probe-script <path> [--image-timeout 900]
 *
 * The probe script runs while the box is on `:dev @ <sha>`; its stdout/stderr +
 * exit code are captured and returned. Emits one machine-readable last line:
 *   AUTOLOOP_DEV_VERIFY_RESULT {"reachedDev":true,"probeExit":0,"flippedBack":true,"channel":"latest","probeOutput":"…"}
 *
 * Exit 0 = harness ran and flipped back (READ probeExit/probeOutput to judge
 * green/red — that's the LLM's job); exit 2 = harness setup failure (never
 * reached :dev) but ALWAYS attempted flip-back; exit 5 = flip-back FAILED (box
 * may be stranded on :dev — hard alert, orchestrator recovers).
 */

import { execFileSync } from 'node:child_process';
import { getChannel, setChannel, waitHealth, mcpExec } from './autoloop-box';

/**
 * Does the running image's OCI revision label identify `sha`?
 *
 * The label (`org.opencontainers.image.revision`) is the **full 40-char git
 * SHA** baked into the image at build time. The harness usually knows the
 * **short** SHA, so we prefix-match: the label must START WITH the expected sha
 * (short or full). This is *not* a substring test — the earlier bug compared
 * the image TAG (`ghcr.io/mdopp/servicebay:dev`, which never contains a SHA),
 * so `:dev` alone must NOT count as a match. Exported for unit tests.
 */
export function revisionMatchesSha(revisionLabel: string, sha: string): boolean {
  const label = revisionLabel.trim().toLowerCase();
  const want = sha.trim().toLowerCase();
  // A git SHA is hex; guard against a tag string (e.g. "…:dev" or "dev")
  // sneaking through as a match. An empty want would prefix-match anything.
  if (!want || !/^[0-9a-f]{7,40}$/.test(want)) return false;
  if (!/^[0-9a-f]{7,40}$/.test(label)) return false;
  return label.startsWith(want);
}

/** The OCI revision label (full git SHA) of the running `servicebay` container,
 *  or '' if it can't be read. This is the SHA baked into the image, NOT the tag
 *  (`{{.Config.Image}}` returns the tag name, which never carries a SHA). */
async function runningRevision(): Promise<string> {
  try {
    const { stdout } = await mcpExec(
      'podman inspect --format \'{{index .Config.Labels "org.opencontainers.image.revision"}}\' servicebay 2>/dev/null | tail -1',
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Poll the box's running-image revision label until it matches `sha`, bounded.
 *  Returns true once the `:dev` image built from this SHA is live. */
async function waitForDevImage(sha: string, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const revision = await runningRevision();
    if (revisionMatchesSha(revision, sha)) return true;
    await new Promise(r => setTimeout(r, 20000));
  }
  return false;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sha = argv.find(a => !a.startsWith('--'));
  const probeScript = argv[argv.indexOf('--probe-script') + 1];
  const imageTimeout = argv.includes('--image-timeout') ? Number(argv[argv.indexOf('--image-timeout') + 1]) : 900;
  if (!sha || !probeScript || probeScript.startsWith('--')) {
    console.error('usage: autoloop-dev-verify.ts <sha> --probe-script <path> [--image-timeout 900]');
    process.exit(2);
  }

  const emit = (o: Record<string, unknown>) => console.log(`AUTOLOOP_DEV_VERIFY_RESULT ${JSON.stringify(o)}`);

  // Confirm the box is up before touching the channel.
  if (!(await waitHealth(120))) {
    emit({ reachedDev: false, flippedBack: false, detail: 'box not reachable before flip' });
    process.exit(2);
  }

  // Pre-pull :dev in the background so the flip is a cache-hit (survives the
  // exec caps — memory feedback_box_update_slow_pull_timeout).
  await mcpExec('systemd-run --user --unit=sb-prepull-dev --quiet podman pull ghcr.io/mdopp/servicebay:dev || true').catch(() => {});

  let reachedDev = false;
  let probeExit = -1;
  let probeOutput = '';
  try {
    // Flip to :dev and wait for the SHA's image to be live + healthy.
    await setChannel('dev');
    await waitHealth(180);
    reachedDev = await waitForDevImage(sha, imageTimeout);
    if (reachedDev) await waitHealth(180);
    if (!reachedDev) {
      probeOutput = `expected :dev image with revision ${sha} did not appear within ${imageTimeout}s (image build likely stuck)`;
    } else {
      // Run the agent-supplied probes against the box on :dev.
      try {
        probeOutput = execFileSync('bash', [probeScript], { encoding: 'utf8', timeout: 15 * 60 * 1000 });
        probeExit = 0;
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
        probeExit = typeof err.status === 'number' ? err.status : 1;
        probeOutput = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
      }
    }
  } finally {
    // STRUCTURAL INVARIANT: always flip back to :latest, whatever happened above.
    let channel: string | null = null;
    for (let i = 0; i < 3; i++) {
      try {
        await setChannel('latest');
        await waitHealth(180);
        channel = await getChannel();
        if (channel === 'latest') break;
      } catch {
        /* retry */
      }
    }
    const flippedBack = channel === 'latest';
    emit({ reachedDev, probeExit, flippedBack, channel, probeOutput: probeOutput.slice(0, 4000) });
    if (!flippedBack) process.exit(5); // box may be stranded on :dev — hard alert
    if (!reachedDev) process.exit(2);
    process.exit(0);
  }
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('autoloop-dev-verify.ts') || invoked.endsWith('autoloop-dev-verify.js')) {
  main().catch(e => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
