/**
 * Driver for the journal-shape test (#2667). NOT a test itself — it is spawned
 * by `tests/backend/logger_journal_shape.test.ts` as a real child process whose
 * stdout is a **pipe**, i.e. `process.stdout.isTTY === undefined`, exactly like
 * ServiceBay under systemd.
 *
 * That is the whole point: asserting on the formatter with a flag would leave
 * the real emission path unguarded, which is how #2650 shipped green while the
 * running server was blind. Here the bytes on the wire are what gets asserted.
 *
 * Everything between the START and END sentinels is the logger's own output.
 */

import { logger } from '../../../packages/backend/src/lib/logger';
import { logger as clientLogger } from '../../../packages/backend/src/lib/logger-client';

/** A container-inspect-shaped payload — the OCI-label blob named in #2667. */
const INSPECT = {
  Id: 'e3b0c44298fc1c149afbf4c8996fb924',
  Config: {
    Labels: {
      'org.opencontainers.image.title': 'jellyfin',
      'org.opencontainers.image.description': 'line one\nline two\nline three\n',
      'io.servicebay.service': 'media',
    },
  },
  Mounts: [{ Source: '/srv/media', Destination: '/media' }],
};

// Sentinels on BOTH streams: systemd puts stdout and stderr into the same
// journal, and warn/error go to stderr, so each stream is sliced by its own.
console.log('---SB-START---');
console.error('---SB-START---');

logger.info('Agent:Local', 'Executing shell command: podman inspect media-jellyfin');

// A message that itself carries embedded AND trailing newlines — the shape
// journald turned into a prefixed entry plus a run of empty ones.
logger.info('Agent:Local', 'SYNC_PARTIAL payload:\n\n{"event":"sync"}\n\n\n');

// An object argument: Node's console would inspect this across many lines.
logger.warn('manager', 'inspect result', INSPECT);

// An Error argument: its stack is multi-line by construction.
logger.error('Server', 'Failed to inspect service', new Error('boom\nsecond line of the message'));

// The SSR path — the client logger lands in the same journald pipe.
clientLogger.info('Portal', 'ssr payload', INSPECT);
clientLogger.error('Portal', 'ssr failure', new Error('ssr boom'));

console.log('---SB-END---');
console.error('---SB-END---');
