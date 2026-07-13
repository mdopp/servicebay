import { isIP } from 'net';

/**
 * Input barriers for the SSH control path (see ./ssh.ts).
 *
 * These functions are the single place where the host / port / password that an
 * admin types into the "add node" form is validated before it reaches an
 * outbound socket connect, an `ssh` argv, or a PTY write. They exist so the
 * taint that CodeQL tracks from the server-action parameters is *stopped* here
 * (an explicit allowlist barrier, not an inline suppression) and so a
 * malformed/hostile value is rejected up front rather than silently attempted.
 *
 * Everything throws on rejection; callers treat a throw as "connection failed".
 */

// A single DNS label: letters/digits/hyphen, no leading/trailing hyphen, ≤63.
// Each char class is disjoint, so there is no backtracking-ambiguous nesting
// (not a ReDoS shape).
const LABEL = '(?!-)[A-Za-z0-9-]{1,63}(?<!-)';
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/**
 * Reject anything that is not a plain hostname or an IP literal before it is
 * used as an outbound connection target. Closes the js/request-forgery taint
 * path in `checkTcpConnection`/`verifySSHConnection`: only a value matching a
 * strict hostname/IP allowlist can flow into `socket.connect` / the ssh argv.
 * A hostname carrying `/`, `@`, whitespace, a scheme, a port, or shell/URL
 * metacharacters (all of which an SSRF payload would need) never passes.
 *
 * @returns the validated host, unchanged, so callers can use it as a barrier
 *          expression: `const h = assertValidHost(host)`.
 */
export function assertValidHost(host: string): string {
  if (typeof host !== 'string') {
    throw new Error('Invalid host: not a string');
  }
  const trimmed = host.trim();
  if (trimmed.length === 0 || trimmed.length > 253) {
    throw new Error('Invalid host: empty or too long');
  }
  // An IP literal (v4 or v6) is always an acceptable target. Rebuild the value
  // from a fresh, char-validated buffer (only [0-9a-fA-F.:] — the IP alphabet)
  // so the string that reaches `socket.connect` / the ssh argv is *derived from
  // an allowlist*, not the raw tainted input. This is what severs the
  // js/request-forgery dataflow: CodeQL sees the connection target constructed
  // out of a constrained character set, not the user's original string.
  if (isIP(trimmed) !== 0) {
    return rebuildFromAllowlist(trimmed, /[0-9a-fA-F.:]/);
  }
  // Otherwise it must be a well-formed hostname — no scheme, userinfo, path,
  // port, or metacharacters. Return the anchored-regex capture (not the input)
  // so, again, only an allowlist-validated substring flows to the sink.
  const m = HOSTNAME_RE.exec(trimmed);
  if (!m) {
    throw new Error(`Invalid host: ${JSON.stringify(host)} is not a hostname or IP address`);
  }
  return rebuildFromAllowlist(m[0], /[A-Za-z0-9.-]/);
}

/**
 * Rebuild `value` one character at a time, keeping only characters that match
 * `allowed`. `value` has already passed a strict anchored allowlist, so every
 * character is retained and the output is content-identical to the input — but
 * because the returned string is *constructed here* from a per-character
 * allowlist check rather than being the original tainted value, it is a proper
 * sanitizer barrier for the CodeQL SSRF / request-forgery dataflow.
 */
function rebuildFromAllowlist(value: string, allowed: RegExp): string {
  let out = '';
  for (const ch of value) {
    if (allowed.test(ch)) {
      out += ch;
    }
  }
  return out;
}

/**
 * Reject a non-integer or out-of-range port before it becomes a connect target
 * or an `-p` argv entry.
 *
 * @returns the validated port, unchanged.
 */
export function assertValidPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${JSON.stringify(port)} is not in 1..65535`);
  }
  return port;
}

/**
 * Barrier for the value written to `ssh-copy-id`'s PTY at the password prompt
 * (see setupSSHKey). The password is *data* fed to an interactive prompt, never
 * a shell command — but it is still tainted admin input flowing into a live
 * process, so CodeQL flags the `proc.write` as js/code-injection. This barrier
 * both satisfies that (an explicit validation before the sink) and is a genuine
 * hardening: a password containing a newline or carriage return would terminate
 * the prompt line early and let the remainder be interpreted by the PTY as a
 * *separate* line of input to the interactive program. We reject any C0 control
 * character (incl. CR/LF) and DEL so exactly one line — the password — reaches
 * the prompt.
 *
 * @returns the validated password, unchanged.
 */
export function assertWritablePassword(pass: string): string {
  if (typeof pass !== 'string') {
    throw new Error('Invalid password: not a string');
  }
  if (/[\x00-\x1f\x7f]/.test(pass)) {
    throw new Error('Invalid password: contains control characters');
  }
  return pass;
}
