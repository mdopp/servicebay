/**
 * Copy text to clipboard with an HTTP fallback.
 *
 * navigator.clipboard.writeText is gated behind the secure-context spec,
 * which means it silently rejects on plain http://192.168.x.x origins.
 * That's exactly the deployment shape ServiceBay ships in by default, so
 * copy buttons would fail with no feedback for the operator.
 *
 * Fallback: a hidden textarea + document.execCommand('copy') still works in
 * plain-HTTP contexts. Deprecated but universally supported by the browsers
 * we care about — and the API isn't going anywhere imminently.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Modern path: only works in secure contexts (HTTPS or localhost).
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy
    }
  }
  // Legacy path: hidden textarea + execCommand('copy').
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  try {
    ta.select();
    const ok = document.execCommand('copy');
    return ok;
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
