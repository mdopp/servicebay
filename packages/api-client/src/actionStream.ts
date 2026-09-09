// The service action-stream wire contract (#2942).
//
// `POST /api/services/[name]/action-stream` streams a systemd start / stop /
// restart as raw terminal text: pull progress, the systemctl invocation, then a
// `systemctl status` dump. That body is written to an xterm terminal, so it
// cannot be NDJSON end-to-end the way `POST /api/services` is.
//
// What it CAN carry — and what it never used to — is a machine-readable
// *terminal marker*: one final line, out of band from the terminal text, saying
// whether the action succeeded. Before this existed the client inferred success
// from the stream simply ending, so a `systemctl start` that failed rendered the
// green success card. The outcome is now transported, not guessed, and it uses
// the same `{ type: 'complete' } | { type: 'error' }` shape the NDJSON deploy
// stream already speaks (app/api/services/route.ts).
//
// The reader below is deliberately fail-closed: a stream that ends WITHOUT a
// marker is an error, never a success. That is the whole point of the unit — a
// truncated stream, a proxy timeout or a route that forgot to report must not
// read as "it worked".

/**
 * Every action the streamed-action surface drives. One source of truth: the
 * route's request schema and the modal's `action` prop both derive from it, and
 * the class gate (`tests/frontend/action_stream_outcome_gate.test.tsx`) iterates
 * it — so an action added here is covered without anyone remembering to add it
 * to a test's list.
 */
export const SERVICE_STREAM_ACTIONS = ['start', 'stop', 'restart'] as const;

export type ServiceStreamAction = (typeof SERVICE_STREAM_ACTIONS)[number];

export type ActionStreamResult =
  | { type: 'complete'; success: true }
  | { type: 'error'; message: string };

/**
 * Marker prefix. U+001E (RECORD SEPARATOR) is a control character no
 * systemctl/podman output emits, so the reader can split the marker out of the
 * terminal text without ever eating a legitimate line. The reader still
 * verifies the full prefix before treating a U+001E as a marker.
 */
export const ACTION_STREAM_MARKER = '\u001E__servicebay_action_result__:';

/** Serialize the terminal marker, including its closing newline. */
export function encodeActionStreamResult(result: ActionStreamResult): string {
  return `${ACTION_STREAM_MARKER}${JSON.stringify(result)}\n`;
}

function parseMarkerPayload(payload: string): ActionStreamResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { type?: unknown; message?: unknown };
  if (obj.type === 'complete') return { type: 'complete', success: true };
  if (obj.type === 'error') {
    return { type: 'error', message: typeof obj.message === 'string' ? obj.message : 'The action failed.' };
  }
  return null;
}

export const ACTION_STREAM_NO_MARKER_MESSAGE =
  'The action stream ended without reporting an outcome, so the result is unknown — treating it as a failure.';

export interface ActionStreamReader {
  /** Feed a decoded chunk; returns the text that should reach the terminal. */
  push(chunk: string): string;
  /** Flush any held-back partial marker and answer with the final outcome. */
  end(): ActionStreamResult;
}

/**
 * Streaming split of terminal text from the terminal marker. Chunk boundaries
 * are arbitrary, so a partial marker is held back rather than printed.
 */
export function createActionStreamReader(): ActionStreamReader {
  let held = '';
  let result: ActionStreamResult | null = null;

  return {
    push(chunk: string): string {
      let data = held + chunk;
      held = '';
      let out = '';

      while (data.length > 0) {
        const idx = data.indexOf(ACTION_STREAM_MARKER[0]);
        if (idx === -1) {
          out += data;
          break;
        }
        out += data.slice(0, idx);
        const rest = data.slice(idx);

        // A lone U+001E that cannot be our marker is ordinary output.
        const candidate = rest.slice(0, ACTION_STREAM_MARKER.length);
        if (!ACTION_STREAM_MARKER.startsWith(candidate)) {
          out += rest[0];
          data = rest.slice(1);
          continue;
        }
        // Prefix still incomplete — wait for more bytes.
        if (rest.length < ACTION_STREAM_MARKER.length) {
          held = rest;
          break;
        }
        const newline = rest.indexOf('\n');
        if (newline === -1) {
          held = rest;
          break;
        }
        result = parseMarkerPayload(rest.slice(ACTION_STREAM_MARKER.length, newline)) ?? result;
        data = rest.slice(newline + 1);
      }

      return out;
    },

    end(): ActionStreamResult {
      if (held.length > 0) {
        // A marker that never got its newline: try it anyway, then drop it.
        result = parseMarkerPayload(held.slice(ACTION_STREAM_MARKER.length)) ?? result;
        held = '';
      }
      return result ?? { type: 'error', message: ACTION_STREAM_NO_MARKER_MESSAGE };
    },
  };
}
