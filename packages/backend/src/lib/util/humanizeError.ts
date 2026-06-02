/**
 * Map errors to short, actionable UX messages.
 *
 * Two layers (#598):
 *   1. Typed-path: if the error is a `DomainError` subclass (`SSHError`,
 *      `AgentTimeoutError`, …), dispatch on `err.kind` — exhaustive
 *      switch, immune to upstream library wording changes.
 *   2. Regex fallback: for opaque errors from libraries we can't wrap
 *      cleanly. Same set of patterns as before; will narrow as new
 *      DomainError subclasses cover the failures these match today.
 *
 * Returns the original message verbatim when nothing matches — never hides
 * detail, only adds a hint when one applies.
 */

import { isDomainError, type DomainError, type SSHError } from './domainError';

export interface HumanizedError {
  /** Short title suitable for a toast headline. */
  title: string;
  /** One-line description with a next step, or the raw message if no rule matched. */
  detail: string;
}

/** Dispatch on the typed-error discriminator. Returns `null` to let
 *  the caller fall through to the regex matcher. */
function humanizeDomainError(err: DomainError): HumanizedError | null {
  switch (err.kind) {
    case 'ssh': {
      const e = err as SSHError;
      switch (e.reason) {
        case 'auth':
          return {
            title: 'SSH authentication failed',
            detail: `The node "${e.nodeName}" refused the SSH key. Generate or upload the key under Settings → Nodes → SSH.`,
          };
        case 'dns':
          return {
            title: 'Node not reachable',
            detail: `Cannot resolve hostname for "${e.nodeName}". Check the URI in nodes.json.`,
          };
        case 'refused':
          return {
            title: 'Node not reachable',
            detail: `Connection refused by "${e.nodeName}". Check if SSH server is running.`,
          };
        case 'timeout':
          return {
            title: 'Node not reachable',
            detail: `Connection timeout for "${e.nodeName}". Check network connectivity.`,
          };
        case 'other':
          return { title: 'SSH connection failed', detail: e.message };
        default:
          return null;
      }
    }
    case 'agent_timeout':
      return {
        title: 'Agent request timed out',
        detail: `The agent did not respond in time. Retry, or check the node's connectivity in Settings → Nodes.`,
      };
    default:
      return null;
  }
}

const NETWORK_RX = /(failed to fetch|network ?error|load failed|err_internet_disconnected|err_connection_refused|fetch failed)/i;
const TIMEOUT_RX = /(timeout|timed out|etimedout)/i;
const UNAUTHORIZED_RX = /\b(401|unauthorized|authentication required)\b/i;
const FORBIDDEN_RX = /\b(403|forbidden)\b/i;
const NOT_FOUND_RX = /\b(404|not found)\b/i;
const SERVER_RX = /\b(50\d|internal server error)\b/i;
const SSH_KEY_RX = /(no key|permission denied \(publickey\)|ssh key|host key verification)/i;
const AGENT_RX = /(agent not connected|agent disconnected|agent unreachable)/i;

/** Match an opaque error message against the known patterns. Returns null
 *  when nothing matches so the caller can fall back to the raw message. */
function humanizeMessagePattern(message: string): HumanizedError | null {
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
  return null;
}

export function humanizeError(err: unknown, fallbackTitle = 'Something went wrong'): HumanizedError {
  // Typed-error fast path (#598). Wording-independent.
  if (isDomainError(err)) {
    const typed = humanizeDomainError(err);
    if (typed) return typed;
  }

  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const message = raw.trim();

  if (!message) {
    return { title: fallbackTitle, detail: 'An unexpected error occurred. Try again or check the server logs.' };
  }

  return humanizeMessagePattern(message) ?? { title: fallbackTitle, detail: message };
}
