import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureLanAccessList, lanCidrFromIp, LAN_ACCESS_LIST_NAME, listAccessLists } from './accessLists';

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NPM = 'http://npm';
const TOKEN = 'tok';
type Recorded = { url: string; init: RequestInit };
const calls: Recorded[] = [];

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }));
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => { calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('lanCidrFromIp', () => {
  it('derives the /24 and rejects non-IPv4 input', () => {
    expect(lanCidrFromIp('192.168.178.100')).toBe('192.168.178.0/24');
    expect(lanCidrFromIp('fe80::1')).toBeNull();
    expect(lanCidrFromIp('box.local')).toBeNull();
  });
});

describe('listAccessLists', () => {
  it('passes expand=clients through verbatim', async () => {
    stub(() => json([]));
    await listAccessLists(NPM, TOKEN, { expand: ['clients'] });
    expect(calls[0].url).toBe(`${NPM}/api/nginx/access-lists?expand=clients`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('ensureLanAccessList', () => {
  it('reuses the existing list by name without creating a duplicate', async () => {
    stub(() => json([{ id: 3, name: 'other' }, { id: 5, name: LAN_ACCESS_LIST_NAME, clients: [] }]));
    expect(await ensureLanAccessList(NPM, TOKEN, '192.168.1.10')).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('GET');
  });

  it('creates allow-LAN / allow-localhost / deny-all in that order when missing', async () => {
    stub((_url, init) => (init.method === 'POST' ? json({ id: 11 }, 201) : json([])));
    expect(await ensureLanAccessList(NPM, TOKEN, '192.168.1.10')).toBe(11);
    const post = calls.find(c => c.init.method === 'POST');
    expect(post?.url).toBe(`${NPM}/api/nginx/access-lists`);
    expect(JSON.parse(post!.init.body as string)).toEqual({
      name: LAN_ACCESS_LIST_NAME,
      satisfy_any: false,
      pass_auth: false,
      items: [],
      clients: [
        { address: '192.168.1.0/24', directive: 'allow' },
        { address: '127.0.0.1', directive: 'allow' },
        { address: 'all', directive: 'deny' },
      ],
    });
  });

  it('still tries to create when the lookup fails, and answers null when NPM rejects the create', async () => {
    stub((_url, init) => (init.method === 'POST' ? new Response('bad', { status: 400 }) : new Response('', { status: 500 })));
    expect(await ensureLanAccessList(NPM, TOKEN, '192.168.1.10')).toBeNull();
    expect(calls.map(c => c.init.method)).toEqual(['GET', 'POST']);
  });

  it('answers null without touching NPM when no /24 can be derived', async () => {
    stub(() => json([]));
    expect(await ensureLanAccessList(NPM, TOKEN, 'not-an-ip')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
