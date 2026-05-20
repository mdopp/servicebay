/**
 * Trace-ID wiring tests (#597).
 *
 * The logger's SQLite persistence path is server-side only — vitest's
 * jsdom env makes `isServer=false` so the on-disk round-trip can't be
 * exercised here. What this test pins is the *wiring*: when the
 * server registers a trace provider via setTraceProvider, the logger
 * calls it on every log emission. The DB-side INSERT shape, column
 * read, and ALTER TABLE migration are mechanical once the wiring
 * runs (see logger.ts:insertLog + queryLogs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, setTraceProvider } from '@/lib/logger';

describe('logger trace-provider wiring (#597)', () => {
  let originalLevel: ReturnType<typeof logger.getLogLevel>;
  let providerSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalLevel = logger.getLogLevel();
    logger.setLogLevel('debug');
    providerSpy = vi.fn();
    setTraceProvider(providerSpy as () => string | undefined);
  });

  afterEach(() => {
    logger.setLogLevel(originalLevel);
    setTraceProvider(() => undefined);
  });

  it('calls the registered traceProvider on every log emission', () => {
    providerSpy.mockReturnValue('test-trace-1');
    logger.info('wiring-test', 'first');
    logger.warn('wiring-test', 'second');
    logger.error('wiring-test', 'third');
    expect(providerSpy).toHaveBeenCalledTimes(3);
  });

  it('provider returning undefined is the no-trace path (background jobs)', () => {
    providerSpy.mockReturnValue(undefined);
    logger.info('wiring-undef', 'background-job');
    expect(providerSpy).toHaveBeenCalled();
  });

  it('LogFilter type accepts traceId (compile-time contract)', () => {
    // Pure type check — if queryLogs's LogFilter ever loses the
    // traceId option this fails to compile.
    const filter: import('@/lib/logger').LogFilter = {
      traceId: 'a1b2c3d4',
      limit: 50,
    };
    expect(filter.traceId).toBe('a1b2c3d4');
  });
});
