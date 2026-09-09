/**
 * #2932 — the guard around `authSkipPaths`, and the nginx-shaped reader
 * that proves the guard worked.
 *
 * `authSkipPaths` entries are interpolated straight into an nginx
 * `location ^~ <entry> {` line (see `buildAuthSkipLocations` in
 * `./forwardAuth`). Before this module the only check was
 * `startsWith('/')`, which let two very different holes through:
 *
 * - **Host-wide bypass.** `authSkipPaths: ["/"]` renders
 *   `location ^~ / { auth_request off; … }`. `^~` beats NPM's own
 *   `location /`, so EVERY request to that host skips Authelia while still
 *   proxying upstream. The conf is valid nginx, `nginx_online` stays true,
 *   and `get_proxy_routes`/the UI still describe the host as SSO-gated.
 * - **Block escape.** An entry containing `}` (or `;`, a newline, `#`, a
 *   quote…) terminates the location block and appends arbitrary directives
 *   to the server block.
 *
 * The fix is two independent refusals — {@link validateAuthSkipPath} at the
 * MCP tool boundary (`create_proxy_route`) AND again inside
 * `buildAuthSkipLocations`, so a caller that goes around the tool (a
 * template's `variables.json`, a hand-edited config entry, a future writer)
 * still cannot render the entry.
 *
 * {@link analyzeForwardAuthConfig} + {@link resolveAuthForPath} are the
 * other half: a small nginx-location reader that answers "is this path
 * still gated in the RENDERED text?". The class gate asserts the invariant
 * on the output through it, and the `forward_auth_drift` diagnose probe
 * uses the same reader on the LIVE config so a host that has lost its
 * `auth_request` is reported instead of passing as green.
 */

/** Longest entry we will render. nginx has no hard limit; this is a sanity
 *  bound so a pathological entry can't bloat the conf. */
const MAX_PATH_LENGTH = 200;

/**
 * Characters allowed in a rendered location prefix. Deliberately an
 * ALLOW-list: everything that could change the meaning of the
 * `location ^~ <entry> {` line — `{` `}` `;` `#` `$` `"` `'` `\` `~` `*`
 * whitespace, control characters — is outside it, so a block escape is
 * impossible by construction rather than by enumerating attacks.
 */
const ALLOWED_PATH_CHARS = /^[A-Za-z0-9/._~@:+%-]+$/;

/** Verdict for one entry. `reason` is operator-facing — it says what was
 *  refused and why, never just "invalid". */
export type AuthSkipPathVerdict =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Split a location prefix into the path segments it actually constrains,
 * resolving `.` and `..`. An EMPTY result means the prefix constrains
 * nothing — i.e. it covers the whole host — which is the `"/"` bypass.
 *
 * `..` popping past the root also yields an empty list: `/a/../..` is
 * refused for the same reason rather than being silently rendered.
 */
export function normalizePrefixSegments(path: string): string[] {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

/**
 * Is this entry safe to render as an `auth_request off` location?
 *
 * Refuses, in order: a non-absolute entry, an over-long one, one carrying a
 * character that could escape or re-shape the location line, and one whose
 * prefix covers the whole host (the `"/"` case, and anything that
 * normalizes to it). Everything else is accepted verbatim — the returned
 * `path` is the trimmed entry, which is what callers must render.
 */
export function validateAuthSkipPath(entry: string): AuthSkipPathVerdict {
  const path = entry.trim();
  if (!path.startsWith('/')) {
    return { ok: false, reason: 'must be an absolute path beginning with "/"' };
  }
  if (path.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: `must be at most ${MAX_PATH_LENGTH} characters` };
  }
  if (!ALLOWED_PATH_CHARS.test(path)) {
    // Naming the class, not the offending byte: the entry is echoed by the
    // caller, and quoting the character invites copy-paste of the payload.
    return {
      ok: false,
      reason: 'may only contain letters, digits and "/._~@:+%-" — braces, semicolons, "$", quotes, "#", "*", backslashes and whitespace can terminate or re-shape the nginx location block',
    };
  }
  if (normalizePrefixSegments(path).length === 0) {
    return {
      ok: false,
      reason: 'covers the whole host, which would switch forward-auth off for every path (an "^~ /" location outranks the inherited auth_request). Name the specific prefixes that must stay public instead',
    };
  }
  return { ok: true, path };
}

/**
 * NPM owns `location ^~ /.well-known/acme-challenge/` on every host it
 * issues a certificate for. Emitting our own is a duplicate location and
 * nginx refuses the whole conf, so such an entry is DROPPED by the renderer
 * rather than refused at the boundary — it is redundant, not hostile.
 */
export function isNpmOwnedAcmePrefix(path: string): boolean {
  return path.startsWith('/.well-known/acme-challenge');
}

/** One `location` block found in a rendered config. */
interface ParsedLocation {
  /** `=`, `^~`, `~`, `~*`, or `''` for a plain prefix match. */
  modifier: string;
  /** The location's match target, verbatim (`/static/`, `@fallback`, …). */
  prefix: string;
  /** `off` / `on` / `inherit` — what the block does to `auth_request`. */
  auth: 'off' | 'on' | 'inherit';
}

/** What a rendered (or live) `advanced_config` says about forward-auth. */
export interface ForwardAuthAnalysis {
  /** Braces open and close cleanly — nothing escaped its block. */
  balanced: boolean;
  /** A server-level (depth 0) `auth_request /authelia;`. */
  serverAuthRequest: boolean;
  /**
   * Traces at SERVER level of ServiceBay's forward-auth snippet that survive
   * losing the `auth_request` directive — the `auth_request_set` Remote-*
   * captures and the `Remote-*` headers it forwards. Server level is the
   * whole point: a host that forward-auths only a few paths from INSIDE a
   * `location` (the #2278/#2281 session-mint block on the portal apex and
   * `www.`) never claimed host-wide gating, so it must not be read as a host
   * that lost it.
   */
  forwardAuthMachinery: boolean;
  locations: ParsedLocation[];
}

const LOCATION_HEADER = /location\s+(?:(=|\^~|~\*|~)\s*)?(\S+?)\s*\{/g;

/** Does `body` turn auth_request off, on, or leave it inherited? */
function blockAuth(body: string): ParsedLocation['auth'] {
  if (/auth_request\s+off\s*;/.test(body)) return 'off';
  if (/auth_request\s+\/\S+\s*;/.test(body)) return 'on';
  return 'inherit';
}

/** Read one `{`-balanced block starting at `open` (the index of `{`).
 *  Returns the body and the index just past the matching `}`; a truncated
 *  block returns `end: -1`. */
function readBlock(text: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return { body: text.slice(open + 1), end: -1 };
}

/** True when every `{` has its `}` and no `}` ever appears first. */
function bracesBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Parse an nginx `advanced_config` fragment far enough to answer the two
 * questions this issue is about: is the host still gated, and did anything
 * escape its block. Not a general nginx parser — it assumes the
 * ServiceBay-shaped snippet (server-level directives plus flat `location`
 * blocks) and degrades to "unbalanced" on anything it cannot close.
 */
export function analyzeForwardAuthConfig(config: string): ForwardAuthAnalysis {
  const text = config ?? '';
  const locations: ParsedLocation[] = [];
  // Blank out each location block as we consume it, so what remains is the
  // server-level scope and a depth-0 `auth_request` can't be confused with
  // one nested inside a block.
  let serverScope = '';
  let cursor = 0;
  LOCATION_HEADER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOCATION_HEADER.exec(text)) !== null) {
    const open = text.indexOf('{', m.index);
    if (open < 0) break;
    const { body, end } = readBlock(text, open);
    locations.push({ modifier: m[1] ?? '', prefix: m[2], auth: blockAuth(body) });
    serverScope += text.slice(cursor, m.index);
    if (end < 0) break;
    cursor = end;
    LOCATION_HEADER.lastIndex = end;
  }
  serverScope += text.slice(cursor);
  return {
    balanced: bracesBalanced(text),
    serverAuthRequest: /auth_request\s+\/authelia\s*;/.test(serverScope),
    forwardAuthMachinery:
      /auth_request_set\s+\$\w+\s+\$upstream_http_remote_/.test(serverScope)
      || /proxy_set_header\s+Remote-User\s/.test(serverScope),
    locations,
  };
}

/** Does `location` (as parsed) match the request URI `uri`? Only the
 *  match kinds ServiceBay renders are modelled; a regex location is
 *  reported as non-matching so it can never be mistaken for a bypass. */
function locationMatches(loc: ParsedLocation, uri: string): boolean {
  if (loc.modifier === '~' || loc.modifier === '~*') return false;
  if (!loc.prefix.startsWith('/')) return false; // named location (@fallback)
  if (loc.modifier === '=') return uri === loc.prefix;
  return uri.startsWith(loc.prefix);
}

/**
 * Is `uri` still behind forward-auth in this config? Models nginx's
 * ordering closely enough for the invariant: an exact (`=`) match wins
 * outright, otherwise the longest matching prefix wins, and a block with no
 * `auth_request` of its own inherits the server-level directive.
 */
export function resolveAuthForPath(analysis: ForwardAuthAnalysis, uri: string): boolean {
  const matches = analysis.locations.filter(loc => locationMatches(loc, uri));
  const exact = matches.find(loc => loc.modifier === '=');
  const winner = exact
    ?? matches.reduce<ParsedLocation | undefined>(
      (best, loc) => (best && best.prefix.length >= loc.prefix.length ? best : loc),
      undefined,
    );
  if (!winner || winner.auth === 'inherit') return analysis.serverAuthRequest;
  return winner.auth === 'on';
}

/**
 * The location prefixes that switch auth off for an entire host. Empty on a
 * healthy config; non-empty means the host reads as SSO-gated everywhere it
 * is described and is gated nowhere.
 */
export function hostWideBypasses(analysis: ForwardAuthAnalysis): string[] {
  return analysis.locations
    .filter(loc => loc.auth === 'off'
      && loc.modifier !== '='
      && loc.modifier !== '~'
      && loc.modifier !== '~*'
      && loc.prefix.startsWith('/')
      && normalizePrefixSegments(loc.prefix).length === 0)
    .map(loc => loc.prefix);
}
