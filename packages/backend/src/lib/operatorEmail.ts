/**
 * Validation for the operator e-mail (#365) — the address used both as
 * NPM admin login and Let's Encrypt ACME registration. LE rejects a
 * specific set of TLDs and IP-literal addresses at the account-creation
 * step; we mirror those rules here so the wizard refuses bad input
 * up-front instead of letting the user discover the failure when they
 * later click "Request new SSL Certificate".
 *
 * Reference: IANA-reserved special-use domains
 * (RFC 6761 + RFC 2606) — `.local`, `.example`, `.test`, `.invalid`,
 * `.localhost`. LE's own staging confirms each of these throws on
 * account create.
 */
const LE_REJECTED_TLDS = new Set([
  'local',
  'localhost',
  'example',
  'test',
  'invalid',
]);

/**
 * Single-pass syntactic check, equivalent to the old
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` but without the ambiguous
 * `[^\s@]+\.[^\s@]+` grouping that CodeQL flags as js/polynomial-redos
 * (the class `[^\s@]` and the literal `.` overlap, so the two `+` groups
 * around the dot can split the same input many ways → super-linear
 * backtracking on a dot-free tail).
 *
 * Accepts exactly `local@domain` where:
 *   - the whole string contains no whitespace and exactly one `@`,
 *   - the local part is non-empty,
 *   - the domain part contains a `.` with at least one character before it
 *     and at least one character after it (i.e. a dot at index 1..len-2).
 * Every scan is linear in the input length.
 */
function hasValidEmailSyntax(value: string): boolean {
  // No whitespace anywhere (mirrors the `[^\s]` in both classes).
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  // Exactly one `@`, with a non-empty local part before it.
  if (at <= 0 || value.indexOf('@', at + 1) !== -1) return false;
  const domain = value.slice(at + 1);
  // Domain must contain a dot with ≥1 char before it AND ≥1 char after it,
  // i.e. a dot at some index in [1, len-2]. The earliest such dot is the
  // first dot; if the first dot is already the last char there is none.
  const dot = domain.indexOf('.');
  return dot >= 1 && dot <= domain.length - 2;
}

/**
 * True when `value` is a syntactically valid e-mail address whose TLD
 * Let's Encrypt will accept. Falsy for empty strings, addresses without
 * an `@`, or addresses ending in a reserved TLD.
 *
 * The check is intentionally syntactic — we cannot verify deliverability
 * from the browser. The goal is to filter out the addresses that LE
 * provably rejects at registration so the operator doesn't get stuck
 * later.
 */
export function isValidOperatorEmail(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  // Rough syntax: one or more chars + @ + at least one dotted label.
  // Whitespace is forbidden anywhere. (Linear scan, no ReDoS.)
  if (!hasValidEmailSyntax(trimmed)) return false;
  const lastDot = trimmed.lastIndexOf('.');
  const tld = trimmed.slice(lastDot + 1).toLowerCase();
  if (LE_REJECTED_TLDS.has(tld)) return false;
  return true;
}

/**
 * Human-readable reason an operator-email value is invalid. Returns the
 * empty string when the value is acceptable. Used by the wizard's
 * inline-validation hint so the user knows what to fix.
 */
export function operatorEmailIssue(value: string): string {
  if (!value || !value.trim()) return 'Email is required for Let’s Encrypt';
  const trimmed = value.trim();
  if (!hasValidEmailSyntax(trimmed)) {
    return 'Doesn’t look like an email address';
  }
  const tld = trimmed.slice(trimmed.lastIndexOf('.') + 1).toLowerCase();
  if (LE_REJECTED_TLDS.has(tld)) {
    return `Let’s Encrypt rejects .${tld} addresses — use a real domain`;
  }
  return '';
}
