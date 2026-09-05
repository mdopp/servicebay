/**
 * #2833 — the `Environment=SERVICEBAY_PASSWORD=<value>` journal leak, per
 * emitter.
 *
 * The operator measured 10 unredacted `Environment=SERVICEBAY_PASSWORD=` lines
 * from the `servicebay` unit across five events (2026-09-04 01:38/01:39,
 * 2026-09-05 12:24/13:24/13:25 UTC) and **zero** redacted `content` fields in
 * the same window — so #2603's structured-payload redaction was never on this
 * path. The body travels as a shell ARGUMENT instead:
 *
 *   sh -c '<WRITE_QUADLET_SH>' sh '<the whole servicebay.container file>'
 *
 * written by `quadletUserNs.ts` (boot + channel swap) and
 * `quadletUserNsHostHook.ts` (boot), and echoed into the journal twice over:
 * once by the host agent, which logs its command payloads verbatim
 * (`agent/v4/agent.py`: `Received command: … Payload: {json.dumps(...)}`; its
 * `_redact_for_log` masks the key `content` and secret-NAMED keys, and
 * `command` is neither), and once by `CommandError`'s
 * `Command failed: <command>` message when that write fails, which `server.ts`
 * and `servicebayChannel.ts` log as a warning.
 *
 * These tests drive each of those emitters with a SYNTHETIC unit body and
 * assert that what reaches `console.*` — the journal, on the box — carries the
 * `<N chars redacted>` marker and not the value. The mask itself lives at the
 * sink (`lib/log-format.ts`, one funnel both loggers pass through); its own
 * unit tests are in `packages/backend/src/lib/log-format.test.ts`.
 *
 * Every "secret" here is the literal `PLACEHOLDER-NOT-A-REAL-SECRET`
 * (CLAUDE.md, secret hygiene): no value from any live box belongs in a
 * committed fixture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger';
import { reconcileServicebayQuadletUserNs, QUADLET_PATH } from '@/lib/quadletUserNs';
import { installQuadletUserNsHostHook, USERNS_SELFHEAL_PATH } from '@/lib/quadletUserNsHostHook';
import type { Executor } from '@/lib/interfaces';

const FAKE_SECRET = 'PLACEHOLDER-NOT-A-REAL-SECRET';

/** Modelled on the box's own `servicebay.container`, minus every real value. */
const QUADLET = [
  '[Unit]',
  'Description=ServiceBay Rootless Management Interface',
  '',
  '[Container]',
  'ContainerName=servicebay',
  'Image=ghcr.io/mdopp/servicebay:latest',
  `Environment=SERVICEBAY_PASSWORD=${FAKE_SECRET}`,
  'Environment=NODE_ENV=production',
  '',
  '[Service]',
  'Restart=always',
  '',
  '[Install]',
  'WantedBy=default.target',
].join('\n');

/** What `agent/executor.ts` throws when the quadlet write fails: the WHOLE
 *  command, untruncated, in the message. */
function commandFailed(command: string): Error {
  return new Error(`Command failed: ${command}\nmv: cannot move '/tmp/q.sb-userns.tmp': Permission denied`);
}

/** An Executor that answers just enough for the two reconcilers, and blows up
 *  on the quadlet write — the failure path that puts the body in a log line. */
function fakeExecutor(overrides: Partial<Executor> = {}): Executor {
  const base = {
    exec: vi.fn(async (command: string) => {
      throw commandFailed(command);
    }),
    execSafe: vi.fn(async (argv: string[]) => {
      // `podman image inspect … {{.Config.User}}` → a non-root image, so the
      // reconciler has a real diff to write.
      if (argv[0] === 'podman' && argv[1] === 'image') return { stdout: '1001:1001', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    }),
    readFile: vi.fn(async (path: string) => {
      if (path === QUADLET_PATH) return QUADLET;
      throw new Error(`ENOENT: ${path}`);
    }),
    writeFile: vi.fn(async () => {}),
  };
  return { ...base, ...overrides } as unknown as Executor;
}

/** Everything the logger handed to `console.*` during one test, joined. */
type ConsoleSpy = { mock: { calls: unknown[][] }; mockRestore: () => void };
function journal(spies: ConsoleSpy[]): string {
  return spies.flatMap(s => s.mock.calls.map(call => call.join(' '))).join('\n');
}

describe('#2833 — no emitter can put an Environment= secret in the journal', () => {
  let level: ReturnType<typeof logger.getLogLevel>;
  let spies: ConsoleSpy[];

  beforeEach(() => {
    level = logger.getLogLevel();
    logger.setLogLevel('debug');
    spies = (['debug', 'info', 'warn', 'error'] as const).map(m =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    spies.forEach(s => s.mockRestore());
    logger.setLogLevel(level);
  });

  it('emitter: quadletUserNs — the boot/channel-swap reconciler write', async () => {
    const executor = fakeExecutor();
    // The reconciler does not catch this; `server.ts` and
    // `servicebayChannel.ts` do, and log `err.message` — so does this.
    await expect(reconcileServicebayQuadletUserNs(executor)).rejects.toThrow(/Command failed/);
    await reconcileServicebayQuadletUserNs(executor).catch((err: Error) => {
      logger.warn('Server', `servicebay.container UserNS reconcile failed: ${err.message}`);
    });
    const out = journal(spies);
    expect(out).toContain('UserNS reconcile failed');
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).toContain(`Environment=SERVICEBAY_PASSWORD=<${FAKE_SECRET.length} chars redacted>`);
  });

  it('emitter: quadletUserNsHostHook — logs the failure itself AND returns it', async () => {
    const executor = fakeExecutor({
      readFile: vi.fn(async (path: string) => {
        if (path === QUADLET_PATH) return QUADLET;
        if (path === USERNS_SELFHEAL_PATH) throw new Error('ENOENT');
        throw new Error(`ENOENT: ${path}`);
      }) as Executor['readFile'],
    });
    const res = await installQuadletUserNsHostHook(executor);
    expect(res.outcome).toBe('failed');
    // …and `server.ts` logs the returned detail as a second journal line.
    logger.info('Server', `servicebay.container UserNS host hook: ${res.outcome} (${res.detail})`);
    const out = journal(spies);
    expect(out).toContain('could not install the host-side UserNS self-heal');
    expect(out).toContain('UserNS host hook: failed');
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).toContain(`Environment=SERVICEBAY_PASSWORD=<${FAKE_SECRET.length} chars redacted>`);
  });

  it('emitter: the agent relay — `Received command: exec (… Payload: …)`', () => {
    // What `agent/handler.ts` re-emits after stripping the agent's `[INFO]`
    // prefix: one JSON-escaped string carrying the whole quadlet.
    const payload = JSON.stringify({ command: `sh -c 'q="$HOME/…"; printf %s "$1" > …' sh '${QUADLET}'` });
    logger.info('Agent:Local', `Received command: exec (ID: dzaqse, Payload: ${payload})`);
    const out = journal(spies);
    expect(out).toContain('Received command: exec');
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).toContain(`Environment=SERVICEBAY_PASSWORD=<${FAKE_SECRET.length} chars redacted>`);
  });

  it('emitter: servicebayChannel — the pre-swap reconcile error line', async () => {
    // `setServicebayChannel` wraps the same reconciler in its own try/catch and
    // logs `e.message`; the message is the same CommandError body.
    const executor = fakeExecutor();
    await reconcileServicebayQuadletUserNs(executor).catch((e: Error) => {
      logger.error('channel', `UserNS reconcile before the swap failed: ${e.message}`);
    });
    const out = journal(spies);
    expect(out).toContain('UserNS reconcile before the swap failed');
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).toContain(`Environment=SERVICEBAY_PASSWORD=<${FAKE_SECRET.length} chars redacted>`);
  });

  it('the non-secret half of the same body still reads — this is a mask, not a drop', () => {
    logger.info('Server', `wrote quadlet:\n${QUADLET}`);
    const out = journal(spies);
    expect(out).toContain('Environment=NODE_ENV=production');
    expect(out).toContain('Image=ghcr.io/mdopp/servicebay:latest');
  });
});
