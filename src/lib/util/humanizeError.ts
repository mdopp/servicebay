/**
 * Map common low-level error strings to short, actionable messages so the UI
 * doesn't surface raw `String(err)` (e.g. `TypeError: NetworkError`) to users.
 *
 * Returns the original message verbatim when nothing matches — never hides
 * detail, only adds a hint when one applies.
 */
export interface HumanizedError {
  /** Short title suitable for a toast headline. */
  title: string;
  /** One-line description with a next step, or the raw message if no rule matched. */
  detail: string;
}

const NETWORK_RX = /(failed to fetch|network ?error|load failed|err_internet_disconnected|err_connection_refused|fetch failed)/i;
const TIMEOUT_RX = /(timeout|timed out|etimedout)/i;
const UNAUTHORIZED_RX = /\b(401|unauthorized|authentication required)\b/i;
const FORBIDDEN_RX = /\b(403|forbidden)\b/i;
const NOT_FOUND_RX = /\b(404|not found)\b/i;
const SERVER_RX = /\b(50\d|internal server error)\b/i;
const SSH_KEY_RX = /(no key|permission denied \(publickey\)|ssh key|host key verification)/i;
const AGENT_RX = /(agent not connected|agent disconnected|agent unreachable)/i;

export function humanizeError(err: unknown, fallbackTitle = 'Something went wrong'): HumanizedError {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const message = raw.trim();

  if (!message) {
    return { title: fallbackTitle, detail: 'An unexpected error occurred. Try again or check the server logs.' };
  }

  if (UNAUTHORIZED_RX.test(message)) {
    return { title: 'Session expired', detail: 'Please sign in again to continue.' };
  }
  if (FORBIDDEN_RX.test(message)) {
    return { title: 'Permission denied', detail: 'Your account is not allowed to perform this action.' };
  }
  if (NOT_FOUND_RX.test(message)) {
    return { title: 'Not found', detail: 'The requested resource no longer exists. It may have been removed.' };
  }
  if (AGENT_RX.test(message)) {
    return {
      title: 'Node agent unreachable',
      detail: 'The agent on this node is not responding. Check Settings → Nodes and confirm SSH connectivity.',
    };
  }
  if (SSH_KEY_RX.test(message)) {
    return {
      title: 'SSH authentication failed',
      detail: 'The node refused the SSH key. Generate or upload the key under Settings → Nodes → SSH.',
    };
  }
  if (TIMEOUT_RX.test(message)) {
    return {
      title: 'Request timed out',
      detail: 'The server did not respond in time. Retry, or check the node’s connectivity.',
    };
  }
  if (NETWORK_RX.test(message)) {
    return {
      title: 'Network error',
      detail: 'Could not reach the ServiceBay server. Check your connection and reload.',
    };
  }
  if (SERVER_RX.test(message)) {
    return {
      title: 'Server error',
      detail: `${message}. The server logged a problem — check Settings → Logs for details.`,
    };
  }

  return { title: fallbackTitle, detail: message };
}
