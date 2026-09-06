/**
 * Where the soft-delete trash bucket lives, and how its paths reach a shell
 * (#2859, #2862).
 *
 * Two bugs met here and had to be fixed together:
 *
 *  - **#2859** — the trash path was built as `~/…` and then *single-quoted*
 *    into the command (`mkdir -p '~/.config/…'`). `sh` does not expand a tilde
 *    inside quotes, so every soft-delete since that shape shipped landed in a
 *    directory literally named `~` under the agent's cwd, invisible to
 *    list/restore/purge. Hence {@link shellPath}: **never** interpolate a `~`
 *    into a command — expand `$HOME` inside double quotes instead.
 *  - **#2862** — the obvious fix (put the trash where the path *said*) drops it
 *    at `.config/containers/systemd/.trash/`, which is **inside the Quadlet
 *    scan path**. The generator reads it, so deleted services come back as
 *    `.service` units with a `default.target.wants` link and would start on the
 *    next boot (12 phantom units measured on the box). The trash therefore
 *    lives in a **sibling** directory, {@link TRASH_DIR} — same filesystem, so
 *    the `mv` stays atomic, but out of the generator's reach.
 *
 * `systemd-trash/` is also the location the operator hand-repaired the box to,
 * so adopting it means the 43 entries already there are found, not moved again.
 * {@link buildTrashMigrationCommand} sweeps the two wrong places into it once.
 */

import { agentManager } from '../../agent/manager';
import { logger } from '../../logger';

/** Quadlet scan directory, relative to `$HOME`. The generator reads this — and
 *  every directory under it. */
const SYSTEMD_SCAN_DIR = '.config/containers/systemd';

/** Trash root, relative to `$HOME`. A SIBLING of the scan dir (#2862): same
 *  filesystem (atomic `mv`), outside the generator's reach. */
export const TRASH_DIR = '.config/containers/systemd-trash';

/** The two places trash wrongly ended up before this fix, swept into
 *  {@link TRASH_DIR} by {@link buildTrashMigrationCommand}:
 *  1. inside the scan path (`…/systemd/.trash`) — resurrects units (#2862);
 *  2. a directory literally named `~` under the agent's cwd (#2859). */
const LEGACY_TRASH_SOURCES = [
    `"$HOME/${SYSTEMD_SCAN_DIR}/.trash"`,
    `"./~/${SYSTEMD_SCAN_DIR}/.trash"`,
] as const;

/**
 * Render a path for a shell command. Relative paths are anchored at `$HOME`
 * **inside double quotes**, which expand; a literal `~` is never emitted,
 * because the quoting around it decides whether it means "home" or a directory
 * called `~` — and that ambiguity is exactly bug #2859.
 *
 * A `~/`-prefixed input is normalised rather than passed through, so a caller
 * that still holds a legacy path can't reintroduce the bug.
 */
export function shellPath(p: string): string {
    const stripped = p.startsWith('~/') ? p.slice(2) : p;
    return stripped.startsWith('/') ? `"${stripped}"` : `"$HOME/${stripped}"`;
}

/** One trash entry as a shell argument. `id` must already be `assertTrashId`-checked. */
export function trashEntryArg(id: string): string {
    return shellPath(`${TRASH_DIR}/${id}`);
}

/** Human-readable trash path for logs/UI. Never passed to a shell. */
export function trashDisplayPath(id?: string): string {
    return id ? `~/${TRASH_DIR}/${id}` : `~/${TRASH_DIR}`;
}

/** Marker the migration script carries, so a log/test can recognise it. */
const TRASH_MIGRATION_MARKER = 'SERVICEBAY_TRASH_MIGRATED';

/**
 * One idempotent sweep of the two legacy trash locations into {@link TRASH_DIR}.
 *
 * Idempotent by construction: a legacy directory that isn't there is skipped,
 * an entry whose name already exists at the destination is parked next to it
 * rather than overwriting (nothing is ever deleted), and the emptied legacy
 * directories are `rmdir`'d so the next run finds nothing to do. Prints
 * `SERVICEBAY_TRASH_MIGRATED=<n>` so the caller can log the count.
 */
export function buildTrashMigrationCommand(): string {
    return [
        `dest=${shellPath(TRASH_DIR)}`,
        'mkdir -p "$dest" || exit 0',
        'moved=0',
        `for src in ${LEGACY_TRASH_SOURCES.join(' ')}; do`,
        '  [ -d "$src" ] || continue',
        '  for entry in "$src"/*; do',
        '    [ -e "$entry" ] || continue',
        '    target="$dest/$(basename "$entry")"',
        '    [ -e "$target" ] && target="$target-dup$$"',
        '    mv -f "$entry" "$target" 2>/dev/null && moved=$((moved+1))',
        '  done',
        '  rmdir "$src" 2>/dev/null || true',
        'done',
        `rmdir -p "./~/${SYSTEMD_SCAN_DIR}" 2>/dev/null || true`,
        `echo "${TRASH_MIGRATION_MARKER}=$moved"`,
    ].join('\n');
}

/** Entries moved by one migration run, parsed out of the script's output. */
function parseTrashMigrationOutput(stdout: string): number {
    const m = new RegExp(`${TRASH_MIGRATION_MARKER}=(\\d+)`).exec(stdout ?? '');
    return m ? Number(m[1]) : 0;
}

/** Per-node memo: the sweep is one-time per process, not per listing. */
const migrated = new Map<string, Promise<number>>();

/** Test seam — forget the per-node memo. */
export function resetTrashMigrationMemo(): void {
    migrated.clear();
}

/**
 * Run the legacy-trash sweep once per node per process. Best-effort: an agent
 * that can't run it must not break a delete or a listing, so failures are
 * logged and the memo is dropped so the next call retries.
 */
export async function ensureTrashRootMigrated(nodeName: string): Promise<number> {
    const pending = migrated.get(nodeName);
    if (pending) return pending;
    const run = (async () => {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: buildTrashMigrationCommand() });
        const count = parseTrashMigrationOutput((res?.stdout ?? '') as string);
        if (count > 0) {
            logger.info(
                'ServiceManager',
                `Migrated ${count} trash entr${count === 1 ? 'y' : 'ies'} out of the Quadlet scan path into ${trashDisplayPath()} on ${nodeName} (#2862)`,
            );
        }
        return count;
    })().catch(e => {
        logger.warn('ServiceManager', `Trash migration sweep failed on ${nodeName}:`, e);
        migrated.delete(nodeName);
        return 0;
    });
    migrated.set(nodeName, run);
    return run;
}
