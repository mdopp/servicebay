/**
 * Typed domain error hierarchy (#598).
 *
 * The previous error UX flow was: low-level library throws a plain
 * `Error`, the message string bubbles up through layers, and
 * `humanizeError` matches it against a regex panel to pick a UX title.
 * When the upstream library tweaks its wording (ssh2, undici, podman),
 * the match silently fails and the UX degrades to "Something went
 * wrong" with the raw message.
 *
 * This module is the typed alternative: throw a `DomainError` subclass
 * at the boundary where the underlying cause is *known* (the SSH
 * connection error handler knows it's an SSH auth failure; the agent
 * handler knows it's a timeout). `humanizeError` then dispatches on
 * `err.kind` instead of regex-matching `err.message`.
 *
 * Scope (per issue): start with `SSHError` and `AgentTimeoutError`,
 * the two highest-volume regex matches today. Other classes can be
 * added incrementally as their boundaries surface failures.
 */

/** Base for the typed error hierarchy. Subclasses set a static `kind`
 *  discriminator so `humanizeError` can switch over it exhaustively. */
export abstract class DomainError extends Error {
  /** Discriminator. Each subclass overrides this. */
  abstract readonly kind: string;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = new.target.name;
  }
}

/** SSH connection / authentication failure raised at the
 *  `src/lib/ssh/pool.ts` boundary. Reason is the classified cause
 *  (`auth`, `dns`, `refused`, `timeout`, `other`) so the UI hint can
 *  point at the right fix without depending on ssh2's error wording. */
export class SSHError extends DomainError {
  readonly kind = 'ssh' as const;
  readonly reason: 'auth' | 'dns' | 'refused' | 'timeout' | 'other';
  readonly nodeName: string;
  constructor(args: {
    nodeName: string;
    reason: 'auth' | 'dns' | 'refused' | 'timeout' | 'other';
    message: string;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.reason = args.reason;
    this.nodeName = args.nodeName;
  }
}

/** Agent request didn't complete within the configured timeout.
 *  Raised at the `src/lib/agent/handler.ts:sendCommand` boundary. */
export class AgentTimeoutError extends DomainError {
  readonly kind = 'agent_timeout' as const;
  readonly action: string;
  readonly timeoutMs: number;
  constructor(args: { action: string; timeoutMs: number }) {
    super(`Agent request timeout (${args.action} after ${args.timeoutMs}ms)`);
    this.action = args.action;
    this.timeoutMs = args.timeoutMs;
  }
}

/** Type guard — true if `err` is one of our typed domain errors. */
export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
