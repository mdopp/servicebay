import * as os from 'os';
import * as path from 'path';
import { SSH_DIR } from '@/lib/dirs';

/**
 * Traversal barrier for the SSH-identity path (CodeQL js/path-injection on the
 * node create/edit routes). `identity` is a request-supplied parameter that
 * reaches `fs.existsSync` (and the stored node) after only a tilde expansion,
 * so an absolute or `../`-laden value could point the box's SSH auth at any
 * file on disk. Legitimate keys live under the managed `SSH_DIR`
 * (`DATA_DIR/ssh`, the UI default `/app/data/ssh/id_rsa`) or the agent user's
 * own `~/.ssh`; nothing else is a valid key location.
 *
 * We tilde-expand, resolve, and require the result to sit inside one of those
 * allowed roots. On any escape we return `null` (fail closed) so the caller
 * rejects the request rather than touching an arbitrary path. The value that
 * flows onward to `fs`/`addNode`/`updateNode` is re-derived from the barrier
 * output, so CodeQL sees the taint severed by an explicit sanitizer.
 *
 * Lives in `lib/` rather than in a route because BOTH the create route
 * (`POST /api/system/nodes`) and the edit route
 * (`PATCH /api/system/nodes/[name]`) must apply it — one copy, one behaviour.
 */
export function resolveSafeIdentity(identity: string): string | null {
  if (typeof identity !== 'string' || identity.length === 0 || identity.includes('\0')) {
    return null;
  }
  const expanded = identity.replace(/^~(?=$|\/|\\)/, os.homedir());
  const resolved = path.resolve(expanded);
  const allowedRoots = [path.resolve(SSH_DIR), path.resolve(os.homedir(), '.ssh')];
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      // Re-derive the in-root path from the sanitised remainder so the value
      // reaching fs is built from the barrier output, not the raw taint.
      const inner = path.relative(root, resolved);
      return inner ? path.join(root, inner) : root;
    }
  }
  return null;
}
