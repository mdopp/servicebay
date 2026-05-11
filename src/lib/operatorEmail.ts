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
  // Whitespace is forbidden anywhere.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return false;
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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return 'Doesn’t look like an email address';
  }
  const tld = trimmed.slice(trimmed.lastIndexOf('.') + 1).toLowerCase();
  if (LE_REJECTED_TLDS.has(tld)) {
    return `Let’s Encrypt rejects .${tld} addresses — use a real domain`;
  }
  return '';
}
