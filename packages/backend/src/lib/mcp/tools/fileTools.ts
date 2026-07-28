/**
 * Read-oriented file / disk MCP tools (#1872, #2384 extraction).
 *
 * These replace ad-hoc `exec_command` calls (cat/ls/find/du) with typed,
 * path-jailed handlers. None is in DESTRUCTIVE_TOOLS, so calling them never
 * fires snapshotBeforeMutation (no servicebay-full-*-auto.tar.gz).
 * read_file/write_file/list_dir are jailed to JAIL_ROOT (/mnt/data) lexically
 * AND confirmed server-side with realpath (catches a symlink that points out of
 * the jail). disk_usage reuses the disk probe's single du source.
 */
import { z } from 'zod';
import { AgentExecutor } from '@/lib/agent/executor';
import { largestDirsUnderDataDir } from '@/lib/diagnose/probes/disk';
import { jailPath, realPathInJail, JAIL_ROOT } from '../pathJail';
import { redactLogText } from '../redact';
import { nodeParam, resolveNode, textResult, errorResult, type ToolRegistration } from './context';

/**
 * Confirm a jailed path's REAL path (after symlink resolution on the box)
 * is still inside JAIL_ROOT. Returns an error message string if it
 * escapes, else null. Shared by read_file + list_dir (#1872) so the
 * symlink-escape guard lives in one place.
 */
async function assertRealpathInJail(
  exec: AgentExecutor,
  jailedPath: string,
  reqPath: string,
): Promise<string | null> {
  // Resolve BOTH the target and the jail root on the box. On Fedora CoreOS
  // JAIL_ROOT (/mnt/data) is itself a symlink to /var/mnt/data, so the
  // target resolves to /var/mnt/data/… and must be compared against the
  // *resolved* root, not the literal string (else every legit path is
  // wrongly rejected — #1872 2nd box-verify RED).
  const [real, rootReal] = await Promise.all([
    exec.execSafe(['realpath', '-m', '--', jailedPath]),
    exec.execSafe(['realpath', '-m', '--', JAIL_ROOT]),
  ]);
  if (realPathInJail(real.stdout ?? '', rootReal.stdout ?? '')) return null;
  return `Path escapes the allowed root ${JAIL_ROOT}: "${reqPath}" resolves (via symlink) to "${(real.stdout ?? '').trim()}".`;
}

/**
 * Stat a jailed file and confirm it is a regular file within `limit`
 * bytes (rejects device nodes, dirs, and oversized blobs before we slurp
 * them through the agent). Returns an error message string, else null.
 */
async function assertReadableRegularFile(
  exec: AgentExecutor,
  jailedPath: string,
  reqPath: string,
  limit: number,
): Promise<string | null> {
  const stat = await exec.execSafe(['stat', '-Lc', '%F %s', '--', jailedPath]);
  if (stat.code !== 0) {
    return `Cannot stat "${reqPath}": ${(stat.stderr ?? '').trim() || `exit ${stat.code}`}`;
  }
  const [kind, sizeStr] = (stat.stdout ?? '').trim().split(/\s+/);
  if (kind !== 'regular' && kind !== 'regular_empty_file') {
    return `Refusing to read "${reqPath}": not a regular file (${kind}).`;
  }
  const size = Number(sizeStr);
  if (Number.isFinite(size) && size > limit) {
    return `File "${reqPath}" is ${size} bytes, over the ${limit}-byte cap. Raise maxBytes or use exec_command.`;
  }
  return null;
}

// A register function is a flat LIST of tool declarations, not a unit of logic:
// its length just counts how many tools the group holds. The rule stays ON for the
// handlers inside it, which is where real logic (and real length) would show up.
// eslint-disable-next-line max-lines-per-function
export function registerFileTools({ server }: ToolRegistration) {
  server.tool(
    'read_file',
    `Read a UTF-8 text file on a node, jailed to ${JAIL_ROOT} (service data dirs live here). Use this instead of \`exec_command cat …\`. The path is resolved and rejected if it escapes the jail (\`..\`, an absolute path outside it, or a symlink pointing out). Returns the file content (size-capped). For binary or huge files use exec_command deliberately.`,
    {
      path: z.string().min(1).describe(`File path; relative paths are anchored at ${JAIL_ROOT}. Must resolve inside ${JAIL_ROOT}.`),
      maxBytes: z.number().int().min(1).max(5_000_000).optional().describe('Max bytes to read (default 1 MiB). Larger files are rejected — narrow with exec_command if you truly need them.'),
      node: nodeParam,
    },
    async ({ path: reqPath, maxBytes, node }) => {
      const jailed = jailPath(reqPath);
      if (!jailed.ok) return errorResult(jailed.error);
      const limit = maxBytes ?? 1_048_576;
      const nodeName = await resolveNode(node);
      try {
        const exec = new AgentExecutor(nodeName);
        // Symlink-escape guard, then regular-file/size guard. Lexical
        // jailPath() can't see a symlink that points out of the jail;
        // `realpath -m` resolves it on the box. argv form — no shell parsing.
        const escape = await assertRealpathInJail(exec, jailed.path, reqPath);
        if (escape) return errorResult(escape);
        const bad = await assertReadableRegularFile(exec, jailed.path, reqPath, limit);
        if (bad) return errorResult(bad);
        const content = await exec.readFile(jailed.path);
        return textResult({ path: jailed.path, bytes: content.length, content: redactLogText(content) });
      } catch (err) {
        return errorResult(`Error reading file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // #2142 — jailed write_file. Symmetric with read_file (same JAIL_ROOT +
  // realpath escape guard), but WRITING: it creates the parent directory,
  // writes the content, and sets core:core ownership so the file is owned by
  // the box's service user (not root) — matching what the install runner
  // produces. Mutating (scope=mutate), so it rides the allowMutations gate;
  // NOT in DESTRUCTIVE_TOOLS (writing a data-dir file is additive, not a
  // data-losing wipe — no pre-mutation snapshot). The escape guard runs on the
  // PARENT dir (`realpath -m` on the file's own path resolves fine even when
  // the file doesn't exist yet, and rejects a parent symlink pointing out).
  server.tool(
    'write_file',
    `Write a UTF-8 text file on a node, jailed to ${JAIL_ROOT} (service data dirs live here). Use this instead of base64-piping content through \`exec_command\`. Creates the parent directory if missing and sets core:core ownership. The path is resolved and rejected if it escapes the jail (\`..\`, an absolute path outside it, or a symlink pointing out).`,
    {
      path: z.string().min(1).describe(`File path; relative paths are anchored at ${JAIL_ROOT}. Must resolve inside ${JAIL_ROOT}.`),
      content: z.string().describe('Full UTF-8 file content to write (overwrites any existing file).'),
      node: nodeParam,
    },
    async ({ path: reqPath, content, node }) => {
      const jailed = jailPath(reqPath);
      if (!jailed.ok) return errorResult(jailed.error);
      const nodeName = await resolveNode(node);
      try {
        const exec = new AgentExecutor(nodeName);
        // Symlink-escape guard on the target itself. `realpath -m` resolves
        // even a not-yet-existing file (it resolves the existing prefix),
        // so a parent symlink that points out of the jail is still caught.
        const escape = await assertRealpathInJail(exec, jailed.path, reqPath);
        if (escape) return errorResult(escape);
        // Parent-dir create (idempotent). Derive the parent lexically from the
        // already-jailed absolute path.
        const parent = jailed.path.slice(0, jailed.path.lastIndexOf('/')) || JAIL_ROOT;
        const mk = await exec.execSafe(['mkdir', '-p', '--', parent], { sudo: true });
        if (mk.code !== 0) {
          return errorResult(`Could not create parent directory "${parent}": ${(mk.stderr ?? '').trim() || `exit ${mk.code}`}`);
        }
        // Write the content via the agent's write_file (handles the transfer),
        // then set core:core ownership so the box's service user owns it.
        await exec.writeFile(jailed.path, content);
        const chown = await exec.execSafe(['chown', 'core:core', '--', jailed.path], { sudo: true });
        const ownershipSet = chown.code === 0;
        return textResult({
          path: jailed.path,
          bytes: Buffer.byteLength(content, 'utf8'),
          ownershipSet,
          ...(ownershipSet ? {} : { ownershipWarning: `File written but chown core:core failed: ${(chown.stderr ?? '').trim() || `exit ${chown.code}`}` }),
        });
      } catch (err) {
        return errorResult(`Error writing file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'list_dir',
    `List the entries of a directory on a node, jailed to ${JAIL_ROOT}. Use this instead of \`exec_command ls/find/wc -l\`. Each entry has name, type (file|dir|symlink|other), size (bytes) and mtime (Unix seconds). The path is rejected if it escapes the jail.`,
    {
      path: z.string().min(1).optional().describe(`Directory path; relative paths are anchored at ${JAIL_ROOT}. Defaults to ${JAIL_ROOT}.`),
      node: nodeParam,
    },
    async ({ path: reqPath, node }) => {
      const jailed = jailPath(reqPath ?? JAIL_ROOT);
      if (!jailed.ok) return errorResult(jailed.error);
      const nodeName = await resolveNode(node);
      try {
        const exec = new AgentExecutor(nodeName);
        const escape = await assertRealpathInJail(exec, jailed.path, reqPath ?? JAIL_ROOT);
        if (escape) return errorResult(escape);
        // `find -maxdepth 1` lists the dir's immediate children, one per line
        // with tab-separated type/size/mtime/name fields.
        const res = await exec.execSafe([
          'find', jailed.path, '-maxdepth', '1', '-mindepth', '1',
          '-printf', '%y\t%s\t%T@\t%f\n',
        ]);
        if (res.code !== 0) {
          return errorResult(`Cannot list "${jailed.path}": ${(res.stderr ?? '').trim() || `exit ${res.code}`}`);
        }
        const typeMap: Record<string, string> = { f: 'file', d: 'dir', l: 'symlink' };
        const entries = (res.stdout ?? '')
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [y, size, mtime, ...rest] = line.split('\t');
            return {
              name: rest.join('\t'),
              type: typeMap[y] ?? 'other',
              size: Number(size),
              mtime: Math.floor(Number(mtime)),
            };
          });
        return textResult({ path: jailed.path, count: entries.length, entries });
      } catch (err) {
        return errorResult(`Error listing directory: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'disk_usage',
    `Show the largest directories under ${JAIL_ROOT} (top-N by size). Use this instead of \`exec_command du\`. Reuses the same measurement as the disk diagnose probe's "show largest directories" action — there is one du implementation. Returns the raw \`du\` breakdown (size + path per line) and a parsed list.`,
    {
      top: z.number().int().min(1).max(50).optional().describe('How many directories to return (default 10).'),
      node: nodeParam,
    },
    async ({ top, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const breakdown = await largestDirsUnderDataDir(nodeName, top ?? 10);
        const entries = breakdown
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [size, ...rest] = line.split('\t');
            return { size: size?.trim() ?? '', path: rest.join('\t').trim() };
          });
        return textResult({ root: JAIL_ROOT, breakdown, entries });
      } catch (err) {
        return errorResult(`Error measuring disk usage: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
