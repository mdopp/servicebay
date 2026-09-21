/**
 * Making a path readable by OTHER containers, in one place (#2996, #3016).
 *
 * On a SELinux box every container carries its own MCS category pair, and
 * everything it creates inherits it:
 *
 *     unconfined_u:object_r:container_file_t:s0:c1022,c1023
 *                                             ^^^^^^^^^^^ these
 *
 * A different container mounting that path is denied. The asymmetry is what
 * makes it expensive: from the writer every read succeeds — it is the one
 * process whose categories match — while from the reader the path is simply
 * empty. It reads exactly like a broken mount, and every obvious next move
 * (rewrite the hostPath, change the path, redeploy) leaves it broken.
 *
 * `chcon -l s0` drops the categories, which is right for a path whose PURPOSE
 * is to be mounted by something else — a delivered kit, a shared asset — and
 * wrong as a blanket habit: the categories are real isolation between services
 * sharing a host root. Relabel the specific path, never the data root.
 *
 * ## Why this is a module and not a function in one caller
 *
 * #2996 put this logic in `write_file`, and its own comment said out loud that
 * it was "the same hand fix the agent-kit checkout needs after every restart".
 * The connection was seen; the call was not made, and the catalog delivery went
 * on locking pi out four times in one morning (#3016). A second copy would have
 * drifted from the first, so there is one, and the two callers differ only in
 * how they run a command — the MCP tool through the node's agent, the delivery
 * locally at boot, before an agent connection can be assumed.
 *
 * ## It reports what is on disk
 *
 * The label is always read BACK after the relabel. A `chcon` that exits 0
 * without changing anything is precisely the shape that would otherwise be
 * reported as success, and reporting the label we asked for rather than the one
 * on disk is the same false success `ownershipSet: true` already was.
 */

/** Run one argv on the target and report its outcome; never throws. */
export type Run = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ShareResult {
  /** The label actually on disk after the attempt; null when the box has none. */
  label: string | null;
  /** Set when there is nothing to do (no SELinux) — not a failure. */
  labelNote?: string;
  /** Set when categories survived: what that means for the consumer, and the fix. */
  labelWarning?: string;
  /** Did every verified path end up without MCS categories? */
  shared: boolean;
}

/**
 * The categories in an SELinux label, if it has any: `…:s0:c1022,c1023` → the
 * `c…` part. This substring is the whole difference between a path another
 * container can read and one it cannot, so it is parsed in one place and
 * tested directly.
 */
export function mcsCategories(label: string): string | null {
  const m = /:(c\d+(?:[,.]c?\d+)*)\s*$/.exec(label.trim());
  return m ? m[1] : null;
}

export interface ShareOptions {
  run: Run;
  /** The path to relabel. */
  path: string;
  /** Relabel the whole tree (`chcon -R`). */
  recursive?: boolean;
  /**
   * Paths to read the label back from. Defaults to `path` alone.
   *
   * For a TREE, the root is not proof: a recursive relabel that half-worked
   * leaves a shared root over categorised children, which is exactly the state
   * a reader trips on. Pass the places a consumer actually mounts.
   */
  verify?: string[];
  /** For the message: what an operator would run by hand. */
  handFix?: string;
}

/**
 * The labels actually on these paths, skipping the ones the box has nothing to
 * say about. A path that cannot be stat-ed, or whose label reads `?`, carries
 * no information — it must never be read as "shared" and never as "stamped".
 */
async function readLabels(run: Run, paths: string[]): Promise<{ path: string; label: string }[]> {
  const out: { path: string; label: string }[] = [];
  for (const p of paths) {
    const read = await run(['stat', '-c', '%C', '--', p]);
    if (read.code !== 0) continue;
    const label = (read.stdout ?? '').trim();
    if (label && label !== '?') out.push({ path: p, label });
  }
  return out;
}

export async function shareWithOtherContainers(opts: ShareOptions): Promise<ShareResult> {
  const { run, path: target, recursive = false } = opts;
  const verify = opts.verify?.length ? opts.verify : [target];
  const handFix = opts.handFix ?? `chcon ${recursive ? '-R ' : ''}-l s0 ${target}`;

  const relabel = await run(['chcon', ...(recursive ? ['-R'] : []), '-l', 's0', '--', target]);
  const labels = await readLabels(run, verify);

  if (labels.length === 0) {
    return {
      label: null,
      shared: true,
      labelNote: 'This node reports no SELinux label, so there are no MCS categories to strip and any container '
        + 'mounting this path can read it.',
    };
  }

  const rootLabel = labels[0].label;
  const offenders = labels.filter(l => mcsCategories(l.label) !== null);
  if (offenders.length === 0) return { label: rootLabel, shared: true };

  // The categories survived somewhere. Say what that means for the CONSUMER,
  // because "it was written" is the part that already looked fine.
  const where = offenders.map(o => `${o.path} (${mcsCategories(o.label)})`).join(', ');
  const why = relabel.code === 0
    ? 'chcon reported success but the label did not change'
    : `chcon failed: ${(relabel.stderr ?? '').trim() || `exit ${relabel.code}`}`;
  return {
    label: rootLabel,
    shared: false,
    labelWarning: `Still carries SELinux MCS categories: ${where}. A DIFFERENT container mounting this path will be `
      + `denied — this process can still read it, which is what makes it easy to miss. ${why}. `
      + `An operator can fix it on the box with \`${handFix}\`.`,
  };
}
