/**
 * Console-sink formatting shared by the server logger (`logger.ts`) and the
 * client-safe one (`logger-client.ts`).
 *
 * It lives in its own module for the same reason `logger-client.ts` exists at
 * all (#905): the client bundle must never reach `logger.ts`'s server-only
 * `require('fs')`. These helpers are pure — no Node built-ins, no imports — so
 * both loggers can share one implementation, and one test suite pins it.
 *
 * Why it exists: ServiceBay runs as a systemd unit, so its stdout is a journald
 * pipe, not a terminal. It wrote ~48% of its lines with ANSI escapes nobody
 * ever renders, and — worse for tooling — the escapes came BEFORE the
 * timestamp, which is what blinded the #2603 leak probe. Removing them is
 * verified on the box: 440 escape-carrying lines -> 0 over the same 82-second
 * window after start (#2667).
 *
 * Two claims from #2667 did NOT survive that measurement, and are recorded
 * here so nobody re-derives them:
 *  - The ~48% *blank* lines are not ours and are not a defect. Podman's
 *    journald log driver stores the line terminator inside MESSAGE, so every
 *    entry ends with a newline and `journalctl -o cat` — which adds its own —
 *    prints a blank line after each one. radicale and mosquitto on the same box
 *    show the identical shape. Count entries, not `-o cat` lines.
 *  - This sink is not where the journal volume is. Same window, before vs.
 *    after: 923,741 -> 927,991 bytes, 530 -> 549 entries. The volume is the
 *    *payloads* (a full container-inspect JSON with all OCI labels, logged on
 *    every sync), not their decoration. #2676 cut those at their emitter: the
 *    state sync now logs what a sync covered, not the state itself
 *    (`agent/v4/agent.py::_summarize_state_for_log` and its backend twin
 *    `agent/handler.ts::summarizeStateForLog`). It belongs there, not here,
 *    for the reason spelled out on `renderLogArg` below.
 *
 * Next.js SSR runs inside that same process, so the client logger's output
 * reaches the same journal and needs the same treatment.
 */

/**
 * Render one `console.*` extra argument to a string, ourselves.
 *
 * We must not hand objects to `console.*` any more: Node inspects them across
 * many lines, and journald starts a new entry at every newline — so one log
 * call became a run of entries that no longer carried the tag or level, and a
 * `grep` for either lost the rest of the payload (#2667). Errors keep their
 * stack — it is the whole value of the argument; `toSingleJournalLine`
 * flattens it, nothing is dropped.
 *
 * Deliberately NOT truncated. The size cap for the one payload class that is
 * actually huge — quadlet/unit bodies — belongs at the redactor, where
 * `<N chars redacted>` already applies it (#2603). Clipping a second time at
 * this sink would leave a half-JSON line that
 * `scripts/check-journal-redaction.ts` can no longer parse, silently blinding
 * that leak probe. One log call, one entry, no lost bytes.
 */
export function renderLogArg(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value !== 'object') return String(value);
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (v !== null && typeof v === 'object') {
          if (seen.has(v as object)) return '[Circular]';
          seen.add(v as object);
        }
        return typeof v === 'bigint' ? `${v}n` : v;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/**
 * Flatten a rendered console line so ONE log call produces exactly ONE journal
 * entry (#2667).
 *
 * journald splits on newlines, so a multi-line payload (container-inspect JSON
 * with OCI labels, a `SYNC_PARTIAL` state sync, an Error stack) arrived as one
 * prefixed entry followed by a run of unprefixed ones — searchable by neither
 * tag nor level. Trailing and embedded blank lines are dropped, and a real line
 * break is kept visible as the literal two characters `\n` — the ASCII,
 * greppable representation `JSON.stringify` already uses, so nothing is lost.
 *
 * This does NOT remove the blank line `journalctl -o cat` shows after every
 * entry: that terminator lives in MESSAGE, put there by podman's log driver,
 * and every service on the box has it. See the module header.
 */
export function toSingleJournalLine(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .filter(line => line !== '')
    .join('\\n');
}

/**
 * Decide whether an emission may carry ANSI colour (#2667).
 *
 * Order matters: `NO_COLOR` (https://no-color.org — set and non-empty, whatever
 * the value) wins over everything, then `FORCE_COLOR` (the escape hatch that
 * makes the coloured path reachable from a pipe, e.g. a test), and otherwise
 * the honest question: is stdout an interactive terminal? Interactive use keeps
 * its colours; a journald/CI pipe gets none.
 *
 * Read per emission rather than cached at module load, so a process that only
 * learns its environment later — and a test — sees the current answer. Both
 * arguments are injectable purely so the decision is testable without a pty.
 */
export function shouldColorize(
  stream?: { isTTY?: boolean } | null,
  env?: Record<string, string | undefined>,
): boolean {
  const e = env ?? (typeof process !== 'undefined' ? process.env : undefined) ?? {};
  if (typeof e.NO_COLOR === 'string' && e.NO_COLOR !== '') return false;
  if (typeof e.FORCE_COLOR === 'string' && e.FORCE_COLOR !== '' && e.FORCE_COLOR !== '0') return true;
  const s = stream ?? (typeof process !== 'undefined' ? process.stdout : undefined);
  return s?.isTTY === true;
}
