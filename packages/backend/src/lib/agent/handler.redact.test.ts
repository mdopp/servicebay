import { describe, it, expect } from 'vitest';
import { redactCommandPayloadForLog, redactForLog, redactStructuredLogLine } from './handler';

// Obvious placeholders — never a real credential in a committed fixture.
const FAKE_SECRET = 'PLACEHOLDER-NOT-A-REAL-SECRET';
const FAKE_QUADLET = `[Container]\nImage=ghcr.io/example/app:1\nEnvironment=SSO_CLIENT_SECRET=${FAKE_SECRET}\n`;

/** The exact line the agent emits for a file state sync. */
function syncPartialLine(): string {
  return JSON.stringify({
    event: 'SYNC_PARTIAL',
    payload: {
      files: {
        '/home/x/.config/containers/systemd/vaultwarden.kube': {
          path: '/home/x/.config/containers/systemd/vaultwarden.kube',
          content: FAKE_QUADLET,
          modified: 1,
        },
      },
    },
  });
}

describe('redactCommandPayloadForLog (#1211)', () => {
  it('replaces write_file content (the rendered pod YAML) with a size marker', () => {
    const yaml = `env:\n- name: HERMES_TOKEN\n  value: ${FAKE_SECRET}\n`.padEnd(500, ' ');
    const out = redactCommandPayloadForLog({ path: '/svc.yml', content: yaml });
    expect(out.path).toBe('/svc.yml');
    expect(out.content).toBe(`<${yaml.length} chars redacted>`);
    expect(JSON.stringify(out)).not.toContain(FAKE_SECRET);
  });

  it('masks secret-looking keys', () => {
    const out = redactCommandPayloadForLog({ PUSH_TOKEN: 'abc', api_key: 'k', name: 'svc' });
    expect(out.PUSH_TOKEN).toBe('***');
    expect(out.api_key).toBe('***');
    expect(out.name).toBe('svc');
  });

  it('leaves non-secret payloads intact', () => {
    const out = redactCommandPayloadForLog({ command: 'ls -la', timeout: 30 });
    expect(out).toEqual({ command: 'ls -la', timeout: 30 });
  });
});

describe('redactForLog walks the whole payload (#2603)', () => {
  it('redacts a content blob nested under files/<path>', () => {
    const out = redactForLog({ files: { '/a.kube': { path: '/a.kube', content: FAKE_QUADLET } } }) as {
      files: Record<string, { content: string }>;
    };
    expect(out.files['/a.kube'].content).toBe(`<${FAKE_QUADLET.length} chars redacted>`);
    expect(JSON.stringify(out)).not.toContain(FAKE_SECRET);
  });

  it('redacts inside arrays', () => {
    const out = redactForLog({ env: [{ name: 'A', API_KEY: 'k' }, { content: 'zz' }] }) as {
      env: [{ API_KEY: string }, { content: string }];
    };
    expect(out.env[0].API_KEY).toBe('***');
    expect(out.env[1].content).toBe('<2 chars redacted>');
  });

  it('terminates on a pathologically deep payload without leaking the leaf', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deep: any = {};
    let node = deep;
    for (let i = 0; i < 40; i++) { node.next = {}; node = node.next; }
    node.content = FAKE_SECRET;
    expect(JSON.stringify(redactForLog(deep))).not.toContain(FAKE_SECRET);
  });

  it('passes primitives and null through', () => {
    expect(redactForLog('hi')).toBe('hi');
    expect(redactForLog(null)).toBe(null);
    expect(redactForLog(7)).toBe(7);
  });
});

describe('redactStructuredLogLine — the journal-writing sink (#2603)', () => {
  it('never lets a SYNC_PARTIAL quadlet payload through verbatim', () => {
    const out = redactStructuredLogLine(syncPartialLine());
    expect(out).not.toBeNull();
    expect(out).not.toContain(FAKE_SECRET);
    expect(out).toContain('chars redacted');
  });

  it('keeps the line diagnostic — event and file paths survive', () => {
    const out = JSON.parse(redactStructuredLogLine(syncPartialLine()) as string);
    expect(out.event).toBe('SYNC_PARTIAL');
    expect(Object.keys(out.payload.files)).toEqual([
      '/home/x/.config/containers/systemd/vaultwarden.kube',
    ]);
  });

  it('returns null for non-structured lines so they fall through to the tagged path', () => {
    expect(redactStructuredLogLine('[INFO] hello')).toBeNull();
    expect(redactStructuredLogLine('')).toBeNull();
    expect(redactStructuredLogLine('{not json')).toBeNull();
  });
});
