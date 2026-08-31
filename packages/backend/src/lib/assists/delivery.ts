/**
 * Assist-catalog DELIVERY (#2701).
 *
 * The catalog used to be baked into the container image (`COPY /app/assists`).
 * That made a catalog entry an *image artifact*: a `docs(assists):` commit
 * produced no release, so nine merged entries sat on `main` and were
 * unreachable from every running box until an unrelated `feat`/`fix` happened
 * to cut a version. Commit type and delivery path disagreed, and both looked
 * internally consistent.
 *
 * The operator's decision (#2701, 30.08.2026): **the catalog is read at
 * runtime, not baked into the image.** `docs:` is then the correct commit type
 * and a catalog contribution takes effect without a release.
 *
 * ## Exactly ONE source
 *
 * The condition the decision hangs on is that afterwards there is exactly one
 * source. A catalog that stayed in the image *and* got layered over from disk
 * would be two sources, one of which ages — and an assist that reads
 * differently in the image than on disk is worse than a missing one, because it
 * answers, and answers wrongly. So:
 *
 *   - `assists/` is **no longer copied into the image** (see `Dockerfile`).
 *     `process.cwd()/assists` is not a catalog source any more; the repo
 *     checkout is the *authoring* location, never a runtime one.
 *   - The single runtime home is `catalogDir()`: the `assists/` directory of a
 *     shallow, sparse git checkout of the repo under
 *     `DATA_DIR/assist-catalog/checkout`, refreshed by `syncAssistCatalog()`.
 *   - `ASSIST_CATALOG_DIR` overrides that with an operator/dev-supplied
 *     directory (a source checkout in `npm run dev`, a temp dir in tests). It
 *     REPLACES the delivered dir — it never layers over it, so setting it still
 *     leaves exactly one source.
 *   - `DATA_DIR/local-assists/` stays, but it is **not a delivery path**: it
 *     only ever holds what an admin approved through the assist editor, plus
 *     the additive namespaced `landed/` dir. See `catalog.ts` for how an
 *     override announces itself so it cannot age quietly.
 *
 * ## A failed delivery is EMPTY and LOUD, never stale and quiet
 *
 * `resolveCatalogDir()` is the gate every read goes through. It refuses to
 * serve when delivery has never succeeded, and it refuses to keep serving a
 * checkout whose last successful sync is older than `catalogMaxAgeMs()`
 * (default 24h — 24 consecutive hourly failures). In both cases the caller gets
 * an `AssistCatalogUnavailableError` naming the cause, the last error and the
 * age; `list_assists` / `get_assist` surface that text instead of an empty list
 * or a "no assist found with id …". A reader therefore sees a catalog that says
 * it is broken, never one that quietly answers from last month's tree.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'util';
import { DATA_DIR } from '@/lib/dirs';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);
const TAG = 'assists:delivery';

/**
 * Never let git prompt for credentials in an unattended server (same reasoning
 * as `registry.ts`: an interactive prompt turns a clean failure into a hang).
 */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

/** Public, no auth needed — the repo the catalog is authored in. */
export const catalogRepoUrl = (): string =>
  process.env.ASSIST_CATALOG_REPO_URL?.trim() || 'https://github.com/mdopp/servicebay.git';

export const catalogRepoRef = (): string => process.env.ASSIST_CATALOG_REF?.trim() || 'main';

const ROOT_DIR = () => path.join(DATA_DIR, 'assist-catalog');
const CHECKOUT_DIR = () => path.join(ROOT_DIR(), 'checkout');
const STATE_FILE = () => path.join(ROOT_DIR(), 'delivery.json');

/** Directory inside the checkout that holds the catalog markdown. */
const CATALOG_SUBDIR = 'assists';

const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * How old the last SUCCESSFUL delivery may be before reads start failing.
 * Past this the catalog goes dark on purpose: a box that has not reached the
 * repo for a day is serving a tree nobody can vouch for, and the whole point of
 * #2701 is that such a state is visible rather than silent.
 */
export function catalogMaxAgeMs(): number {
  const raw = Number(process.env.ASSIST_CATALOG_MAX_AGE_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_HOURS;
  return hours * 60 * 60 * 1000;
}

export function catalogSyncIntervalMs(): number {
  const raw = Number(process.env.ASSIST_CATALOG_SYNC_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SYNC_INTERVAL_MS;
}

/**
 * An externally supplied catalog directory. Set by `npm run dev` (the repo
 * checkout's own `assists/`) and by tests. It REPLACES the git-delivered dir —
 * when it is set there is no sync and no freshness clock, because the operator
 * has taken delivery into their own hands and said where the one source is.
 */
export function externalCatalogDir(): string | null {
  return process.env.ASSIST_CATALOG_DIR?.trim() || null;
}

/** The one runtime directory the catalog is read from. */
export function catalogDir(): string {
  return externalCatalogDir() ?? path.join(CHECKOUT_DIR(), CATALOG_SUBDIR);
}

export interface AssistDeliveryState {
  /** ISO timestamp of the last attempt, successful or not. */
  lastAttemptAt: string | null;
  /** ISO timestamp of the last attempt that actually landed a tree. */
  lastSuccessAt: string | null;
  /** Commit the delivered tree is at. */
  sha: string | null;
  /** How many `*.md` entries the delivered tree carried at that point. */
  entryCount: number | null;
  /** Message of the most recent failure; cleared on success. */
  lastError: string | null;
}

const EMPTY_STATE: AssistDeliveryState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  sha: null,
  entryCount: null,
  lastError: null,
};

/**
 * Raised by `resolveCatalogDir()` when the catalog cannot be served. Its message
 * is the LOUD half of the #2701 contract — it names why delivery is not usable,
 * so a caller can never mistake it for "there are no assists".
 */
export class AssistCatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistCatalogUnavailableError';
  }
}

export async function readDeliveryState(): Promise<AssistDeliveryState> {
  try {
    const raw = await fs.readFile(STATE_FILE(), 'utf-8');
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<AssistDeliveryState>) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function writeDeliveryState(state: AssistDeliveryState): Promise<void> {
  try {
    await fs.mkdir(ROOT_DIR(), { recursive: true });
    await fs.writeFile(STATE_FILE(), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (e) {
    logger.error(TAG, `Could not persist assist-delivery state: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Count the `*.md` entries in a delivered tree. A tree with none is a failed delivery. */
async function countEntries(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.')).length;
}

async function hasGitCheckout(dir: string): Promise<boolean> {
  return fs
    .access(path.join(dir, '.git'))
    .then(() => true)
    .catch(() => false);
}

async function cloneCatalog(dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  const url = catalogRepoUrl();
  try {
    await execFileAsync(
      'git',
      ['clone', '--depth', '1', '--branch', catalogRepoRef(), '--filter=blob:none', '--sparse', url, dest],
      { env: GIT_ENV },
    );
    await execFileAsync('git', ['sparse-checkout', 'set', CATALOG_SUBDIR], { cwd: dest });
  } catch {
    // A git too old for partial clone / sparse checkout still delivers the tree.
    await fs.rm(dest, { recursive: true, force: true });
    await execFileAsync('git', ['clone', '--depth', '1', '--branch', catalogRepoRef(), url, dest], { env: GIT_ENV });
  }
}

async function refreshCatalog(dest: string): Promise<void> {
  const ref = catalogRepoRef();
  // Shallow clones cannot reliably `git pull`, and `origin/<ref>` stays pinned
  // at clone time on a shallow fetch (#1836) — reset to FETCH_HEAD, which is
  // exactly what was just fetched.
  await execFileAsync('git', ['fetch', '--depth', '1', 'origin', ref], { cwd: dest, env: GIT_ENV });
  await execFileAsync('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: dest, env: GIT_ENV });
}

export interface AssistSyncResult {
  status: 'synced' | 'failed' | 'external';
  dir: string;
  sha?: string | null;
  entryCount?: number | null;
  error?: string;
}

/**
 * Pull the repo's `assists/` tree onto the disk. Idempotent; safe to call at
 * boot, on a timer, and by hand. A failure is recorded (and logged at ERROR) but
 * never thrown — the READ path is where a broken delivery becomes visible, and
 * it becomes visible as a refusal, not as a short list.
 */
export async function syncAssistCatalog(): Promise<AssistSyncResult> {
  const external = externalCatalogDir();
  if (external) {
    logger.debug(TAG, `ASSIST_CATALOG_DIR is set (${external}) — skipping git delivery.`);
    return { status: 'external', dir: external };
  }

  const dest = CHECKOUT_DIR();
  const dir = catalogDir();
  const now = new Date().toISOString();
  const previous = await readDeliveryState();

  try {
    await fs.mkdir(ROOT_DIR(), { recursive: true });
    if (await hasGitCheckout(dest)) {
      try {
        await refreshCatalog(dest);
      } catch (e) {
        logger.warn(TAG, `Refresh failed (${e instanceof Error ? e.message : String(e)}); re-cloning.`);
        await cloneCatalog(dest);
      }
    } else {
      await cloneCatalog(dest);
    }

    const entryCount = await countEntries(dir);
    if (entryCount === 0) {
      // A checkout that carries no entries is a DELIVERY failure, not an empty
      // catalog — treating it as the latter is how a broken path reads as
      // "there is nothing to say".
      throw new Error(`the delivered tree at ${dir} carries no assist entries`);
    }

    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dest, env: GIT_ENV });
    const sha = stdout.trim();
    await writeDeliveryState({ lastAttemptAt: now, lastSuccessAt: now, sha, entryCount, lastError: null });
    logger.info(TAG, `Assist catalog delivered: ${entryCount} entries at ${sha.slice(0, 8)} (${catalogRepoUrl()}#${catalogRepoRef()}).`);
    return { status: 'synced', dir, sha, entryCount };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await writeDeliveryState({ ...previous, lastAttemptAt: now, lastError: error });
    logger.error(
      TAG,
      `Assist catalog delivery FAILED (${error}). The catalog is served only while the last successful ` +
      `delivery (${previous.lastSuccessAt ?? 'never'}) is inside the freshness window; after that every read ` +
      'reports the failure rather than serving a stale tree (#2701).',
    );
    return { status: 'failed', dir, error };
  }
}

/**
 * Boot delivery, with a short backoff.
 *
 * Observed on the box while building #2701: an anonymous `git` fetch of a public
 * GitHub repo is refused intermittently ("could not read Username" — GitHub's
 * shape for a transient 401), three attempts in a row, then succeeds. With only
 * the hourly timer behind it, a boot that lands in such a window leaves the box
 * catalog-less — correctly and loudly, but for an hour. A couple of retries turn
 * that into a couple of minutes without weakening the contract: a delivery that
 * really is broken still fails, and still fails loudly.
 */
export async function deliverAssistCatalogAtBoot(
  // Injected so the retry policy is testable without a network or a real clock.
  sync: () => Promise<AssistSyncResult> = syncAssistCatalog,
): Promise<AssistSyncResult> {
  const backoffMs = [0, 15_000, 60_000];
  let last: AssistSyncResult = { status: 'failed', dir: catalogDir(), error: 'not attempted' };
  for (const delay of backoffMs) {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    last = await sync();
    if (last.status !== 'failed') return last;
  }
  return last;
}

/** Human-readable age, for the refusal message. */
function ageText(sinceIso: string): string {
  const ms = Date.now() - Date.parse(sinceIso);
  if (!Number.isFinite(ms)) return 'unknown';
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The single gate every catalog read passes. Returns the one directory to read
 * from, or throws `AssistCatalogUnavailableError` with a message that says what
 * broke — the "empty and loud" half of the #2701 contract.
 */
export async function resolveCatalogDir(): Promise<string> {
  const external = externalCatalogDir();
  if (external) return external;

  const state = await readDeliveryState();
  const dir = catalogDir();

  if (!state.lastSuccessAt) {
    throw new AssistCatalogUnavailableError(
      'The assist catalog has never been delivered to this box, so there is nothing to read. ' +
      `It is pulled at runtime from ${catalogRepoUrl()}#${catalogRepoRef()} into ${dir} (#2701) — it is NOT in the image. ` +
      `Last delivery attempt: ${state.lastAttemptAt ?? 'none'}${state.lastError ? `; last error: ${state.lastError}` : ''}. ` +
      'Fix the delivery (network/git reachability) — this is an outage, not an empty catalog.',
    );
  }

  const age = Date.now() - Date.parse(state.lastSuccessAt);
  if (Number.isFinite(age) && age > catalogMaxAgeMs()) {
    throw new AssistCatalogUnavailableError(
      `The assist catalog on this box is ${ageText(state.lastSuccessAt)} old (last successful delivery ${state.lastSuccessAt}, ` +
      `commit ${state.sha ?? 'unknown'}) and is no longer served. Delivery pulls ${catalogRepoUrl()}#${catalogRepoRef()} into ${dir} (#2701); ` +
      `last error: ${state.lastError ?? 'none recorded'}. Refusing to answer from a tree that may have aged out — ` +
      'a wrong assist is worse than a missing one.',
    );
  }

  return dir;
}

/** Delivery status for operators/diagnostics — never throws. */
export async function assistDeliveryStatus(): Promise<AssistDeliveryState & { dir: string; external: boolean }> {
  const state = await readDeliveryState();
  return { ...state, dir: catalogDir(), external: externalCatalogDir() !== null };
}
