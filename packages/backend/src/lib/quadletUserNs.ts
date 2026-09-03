/**
 * Boot migration (#2788): keep `servicebay.container`'s user-namespace
 * mapping in step with the uid the ServiceBay **image** declares.
 *
 * Why this exists — the ordering hazard behind #2749. `servicebay.container`
 * is written once, by Ignition, at install time
 * (`tools/sb/internal/build/assets/fedora-coreos.bu`); on an existing box
 * nothing on the host ever rewrites it. Under rootless podman the container's
 * uid 0 maps to the host user that drives the quadlet (`core`, uid 1000), which
 * is why the image ships `USER root` today: the podman socket (0660 core),
 * `/app/data` (core-owned bind) and `/app/data/ssh/id_rsa` (0600 core) are all
 * reachable only through that mapping. The moment the image declares a
 * non-root user the mapping has to move with it — `UserNS=keep-id:uid=N,gid=N`
 * puts container uid N back onto host `core` — and neither half can ship
 * without the other: a non-root image on a mapping-less quadlet lands in the
 * subuid range and loses podman + `/app/data` + the ssh key; a remapped quadlet
 * under a still-root image loses exactly the same three things.
 *
 * So the mapping is **derived, not hard-coded**: this module reads the user the
 * image declares and writes the quadlet to match, in both directions.
 *
 *   - image runs as root (today)  → no `UserNS=` line. If a previous non-root
 *     image left one behind, it is **removed** — that is what makes a rollback
 *     (`:dev` → `:latest`, a release revert) safe rather than a brick.
 *   - image declares uid N ≠ 0    → `UserNS=keep-id:uid=N,gid=M`.
 *
 * On today's still-root box this is a **no-op**: nothing is inspected into a
 * change, nothing is written, the file is not touched.
 *
 * Idempotent by construction (ADR 0012's reconciler guardrails): it computes
 * the desired file, compares it to the file on disk, and writes only on a real
 * diff — which it logs. Two runs in a row make one write at most.
 *
 * Run from two places (`server.ts` boot path, `servicebayChannel.ts` after the
 * pull) so the quadlet is corrected while the *old*, still-privileged container
 * is the one doing the correcting — see `reconcileServicebayQuadletUserNs`.
 */
import type { Executor } from './interfaces';
import { logger } from './logger';
import { shellQuoteAll } from './util/shellQuote';

const TAG = 'quadlet-userns';

/** Read side only — `read_file` expands `~` on the HOST (agent `os.path.expanduser`). */
const QUADLET_PATH = '~/.config/containers/systemd/servicebay.container';

/**
 * Shell required: the quadlet lives under the *host* user's `$HOME`, which only
 * the host shell can expand, and the replacement must be atomic — a truncated
 * write here would leave the box with no ServiceBay unit at all. tmp + `mv` on
 * the same filesystem is that atomicity. The `.tmp` suffix keeps the staging
 * file invisible to quadlet's generator, which only reads `*.container`.
 *
 * The script is a FIXED string; the only variable (the file content) is passed
 * as a positional (`$1`) and never interpolated — same shape as
 * `servicebayChannel.SWAP_TAG_SH`.
 */
const WRITE_QUADLET_SH =
  'q="$HOME/.config/containers/systemd/servicebay.container"; printf %s "$1" > "$q.sb-userns.tmp" && mv -f "$q.sb-userns.tmp" "$q"';

export interface ImageUser {
  uid: number;
  gid: number;
}

type UserNsOutcome =
  /** No quadlet on this host, or not a shape we recognise — nothing to do. */
  | 'no-quadlet'
  /** The image could not be inspected; the quadlet is left exactly as it is. */
  | 'unreadable-image'
  /** Image runs as root and the quadlet carries no mapping — today's no-op. */
  | 'root-noop'
  /** Image runs as root and a stale mapping from a non-root image was removed. */
  | 'root-cleared'
  /** The quadlet already carries the right mapping (the idempotent re-run). */
  | 'already-current'
  /** A non-root mapping was written. */
  | 'updated';

export interface UserNsResult {
  outcome: UserNsOutcome;
  detail: string;
}

/** `Image=` off the quadlet — the reference we inspect the declared user from. */
export function parseQuadletImage(quadlet: string): string | null {
  const m = quadlet.match(/^[ \t]*Image=[ \t]*(\S+)[ \t]*$/m);
  return m ? m[1] : null;
}

export type DeclaredUser = { kind: 'root' } | { kind: 'numeric'; user: ImageUser } | { kind: 'named' };

/**
 * `{{.Config.User}}` → what the image declares. Empty, `root` and `0` all mean
 * "runs as uid 0"; `1001` / `1001:1001` are usable as-is; anything else names a
 * user that only the image can resolve to a number (see `parseIdOutput`).
 */
export function parseDeclaredUser(spec: string): DeclaredUser {
  const s = spec.trim();
  if (s === '' || s === 'root' || s === 'root:root') return { kind: 'root' };
  const [u, g] = s.split(':');
  if (!/^\d+$/.test(u)) return { kind: 'named' };
  const uid = Number(u);
  if (uid === 0) return { kind: 'root' };
  const gid = g !== undefined && /^\d+$/.test(g) ? Number(g) : uid;
  return { kind: 'numeric', user: { uid, gid } };
}

/** `uid=1001(nextjs) gid=1001(nodejs) groups=…` → the numbers. */
export function parseIdOutput(out: string): ImageUser | null {
  const uid = out.match(/\buid=(\d+)/);
  if (!uid) return null;
  const gid = out.match(/\bgid=(\d+)/);
  return { uid: Number(uid[1]), gid: gid ? Number(gid[1]) : Number(uid[1]) };
}

/** The mapping that puts container uid N back onto the host user driving the quadlet. */
function userNsValue(user: ImageUser): string {
  return `keep-id:uid=${user.uid},gid=${user.gid}`;
}

function containerSectionBounds(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex(l => l.trim() === '[Container]');
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Pure core: the quadlet text this box *should* have, or `null` when the file on
 * disk already says it (the idempotent case — nothing is written).
 *
 * `user === null` means "the image runs as root": the managed `UserNS=` line is
 * removed if present, and a file that never had one comes back `null`.
 */
export function renderQuadletUserNs(content: string, user: ImageUser | null): string | null {
  const lines = content.split('\n');
  const bounds = containerSectionBounds(lines);
  if (!bounds) return null;
  const existing = lines.findIndex((l, i) => i > bounds.start && i < bounds.end && /^\s*UserNS\s*=/.test(l));

  if (user === null) {
    if (existing === -1) return null;
    const next = [...lines];
    next.splice(existing, 1);
    return next.join('\n');
  }

  const indent = /^(\s*)/.exec(lines[bounds.start])?.[1] ?? '';
  const desired = `${indent}UserNS=${userNsValue(user)}`;
  if (existing !== -1) {
    if (lines[existing].trimEnd() === desired.trimEnd()) return null;
    const next = [...lines];
    next[existing] = desired;
    return next.join('\n');
  }
  // Insert after ContainerName= when it is there (keeps the identity keys
  // together), otherwise straight after the section header.
  const anchor = lines.findIndex((l, i) => i > bounds.start && i < bounds.end && /^\s*ContainerName\s*=/.test(l));
  const at = anchor === -1 ? bounds.start + 1 : anchor + 1;
  const next = [...lines];
  next.splice(at, 0, desired);
  return next.join('\n');
}

/**
 * The uid/gid the image declares, resolved to numbers.
 *   - `null`      → root (uid 0).
 *   - `undefined` → could not be determined; the caller must leave the quadlet
 *                   alone rather than guess (a wrong mapping bricks the box).
 */
async function readDeclaredImageUser(executor: Executor, image: string): Promise<ImageUser | null | undefined> {
  const inspect = await executor.execSafe(['podman', 'image', 'inspect', image, '--format', '{{.Config.User}}'], {
    check: false,
    timeoutMs: 30_000,
  });
  if (inspect.code !== 0) return undefined;
  const declared = parseDeclaredUser(inspect.stdout);
  if (declared.kind === 'root') return null;
  if (declared.kind === 'numeric') return declared.user;
  // A NAME (`USER nextjs`) only exists inside the image's own /etc/passwd, so
  // the host cannot map it — ask the image. `--entrypoint id` overrides the
  // server entrypoint, so this is a sub-second run of a local image.
  const id = await executor.execSafe(['podman', 'run', '--rm', '--entrypoint', 'id', image], {
    check: false,
    timeoutMs: 60_000,
  });
  if (id.code !== 0) return undefined;
  const ids = parseIdOutput(id.stdout);
  if (!ids) return undefined;
  return ids.uid === 0 ? null : ids;
}

/**
 * Reconcile `servicebay.container`'s `UserNS=` against the user its image
 * declares. Idempotent, diff-first, and never fatal — every outcome is a
 * logged status, because the caller is either the boot path or the channel
 * swap and neither may be taken down by this.
 *
 * Called from `server.ts` at boot **and** from `setServicebayChannel` right
 * after the new image is pulled: the swap path is the one that matters, since
 * there the *old* (still root-mapped, still privileged) container is what
 * inspects the freshly pulled image and fixes the quadlet before the recreate
 * starts the new one.
 */
export async function reconcileServicebayQuadletUserNs(executor: Executor): Promise<UserNsResult> {
  let content: string;
  try {
    content = await executor.readFile(QUADLET_PATH);
  } catch {
    return skipped('no-quadlet', `${QUADLET_PATH} is not readable on this host`);
  }
  const image = parseQuadletImage(content);
  if (!image || !containerSectionBounds(content.split('\n'))) {
    return skipped('no-quadlet', 'quadlet has no [Container] section with an Image=');
  }

  let user: ImageUser | null | undefined;
  try {
    user = await readDeclaredImageUser(executor, image);
  } catch (e) {
    user = undefined;
    logger.warn(TAG, `inspect of ${image} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (user === undefined) {
    return skipped('unreadable-image', `could not read the declared user of ${image}; quadlet left untouched`);
  }

  const next = renderQuadletUserNs(content, user);
  if (next === null) {
    const outcome: UserNsOutcome = user === null ? 'root-noop' : 'already-current';
    logger.debug(TAG, `${image} declares ${describe(user)}; quadlet already matches (${outcome})`);
    return { outcome, detail: `${image} declares ${describe(user)}` };
  }

  // Diff-first + visible (ADR 0012): say what is changing before changing it.
  logger.info(TAG, `${image} declares ${describe(user)} — rewriting UserNS= in servicebay.container`);
  await executor.exec(shellQuoteAll(['sh', '-c', WRITE_QUADLET_SH, 'sh', next]));
  try {
    await executor.execSafe(['systemctl', '--user', 'daemon-reload']);
  } catch (e) {
    logger.warn(TAG, `daemon-reload after the quadlet rewrite failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const outcome: UserNsOutcome = user === null ? 'root-cleared' : 'updated';
  return { outcome, detail: `${image} declares ${describe(user)}` };
}

function describe(user: ImageUser | null): string {
  return user === null ? 'root' : `uid ${user.uid}/gid ${user.gid}`;
}

function skipped(outcome: UserNsOutcome, detail: string): UserNsResult {
  logger.debug(TAG, `skipped: ${detail}`);
  return { outcome, detail };
}
