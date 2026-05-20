/**
 * Tiny adapter so the server-side install runner can emit progress
 * over the same Socket.IO server the rest of the app already uses.
 *
 * server.ts calls `setIo(io)` after constructing the Socket.IO server;
 * runner.ts calls `emitJobUpdate` / `emitJobLog`. Decoupling lets the
 * runner stay testable (no socket dependency) and avoids a circular
 * import (server.ts -> runner.ts -> server.ts).
 *
 * Events:
 *   - `install:update` — payload: full JobState (clients render from this)
 *   - `install:log`    — payload: { jobId, line }
 *
 * If the io server hasn't been registered yet (e.g. during tests or
 * before server boot completes), emits are silently dropped — the
 * jobStore is the source of truth, so a missed event just means the
 * client has to catch up via GET /api/install/status. No data loss.
 */
import type { Server as IoServer } from 'socket.io';
import type { JobState } from './jobStore';

let io: IoServer | null = null;

export function setIo(server: IoServer): void {
  io = server;
}

export function emitJobUpdate(state: JobState): void {
  io?.emit('install:update', state);
}

export function emitJobLog(jobId: string, line: string): void {
  io?.emit('install:log', { jobId, line });
}
