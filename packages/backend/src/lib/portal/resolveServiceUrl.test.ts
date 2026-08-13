import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '@/lib/config';

/**
 * #2544 — `resolveServiceUrl` discriminates a multi-subdomain template's
 * proxy hosts by `forwardPort`, resolved from the subdomain variable's
 * `proxyPort` reference.
 *
 * That lookup was `templateSettings[ref] ?? variables[ref].default`, with a
 * comment claiming operator-customised ports "land in templateSettings".
 * Untrue since #2531: a port changed in Configure is recorded in
 * `config.installedVariables`. So the lookup produced the template DEFAULT
 * port, no proxy host matched, and the card fell back to a guessed URL —
 * the Home-Assistant-opens-zwave bug this discriminator was added to fix,
 * back again for any operator who changed the port.
 */
const readTemplateFile = vi.fn();

vi.mock('@/lib/config', () => ({ getConfig: vi.fn(async () => ({})) }));
vi.mock('@/lib/mode', () => ({
  getActiveDomain: () => 'home.arpa',
  getMode: () => 'lan',
}));
vi.mock('@/lib/registry', () => ({
  getTemplateUserGuide: vi.fn(async () => null),
  readTemplateFile: (name: string, file: string) => readTemplateFile(name, file),
}));
vi.mock('@/lib/services/ServiceManager', () => ({ ServiceManager: { listServices: vi.fn() } }));
vi.mock('@/lib/store/repository', () => ({ getServices: vi.fn(() => []) }));
vi.mock('@/lib/health/store', () => ({ HealthStore: { getLastResult: vi.fn(() => null) } }));

import { resolveServiceUrl } from './services';

/** A `file-share`-shaped template: two subdomains in one pod, so the
 *  proxy-host match can only be made on forwardPort. */
const VARIABLES = {
  FILEBROWSER_SUBDOMAIN: { type: 'subdomain', default: 'files', proxyPort: 'FILEBROWSER_PORT' },
  FILEBROWSER_PORT: { type: 'text', default: '13378' },
  SYNCTHING_SUBDOMAIN: { type: 'subdomain', default: 'sync', proxyPort: '8096' },
};

/** Both hosts carry `service: file-share` — `buildProxyHosts` writes the
 *  template name on every host in the template, so only the port
 *  discriminates. */
const HOSTS = [
  { created: true, forwardPort: 8096, domain: 'sync.example.com', service: 'file-share' },
  { created: true, forwardPort: 9999, domain: 'files.example.com', service: 'file-share' },
];

const cfg = (over: Record<string, unknown> = {}): AppConfig =>
  ({ reverseProxy: { hosts: HOSTS }, templateSettings: {}, installedVariables: [], ...over }) as unknown as AppConfig;

describe('resolveServiceUrl proxyPort resolution (#2544)', () => {
  beforeEach(() => {
    readTemplateFile.mockReset().mockImplementation(async (_name: string, file: string) =>
      file === 'variables.json' ? JSON.stringify(VARIABLES) : null,
    );
  });

  it('matches the proxy host for the port the OPERATOR set', async () => {
    const config = cfg({ installedVariables: [{ varName: 'FILEBROWSER_PORT', value: '9999' }] });
    expect(await resolveServiceUrl(config, 'file-share', 'FILEBROWSER_SUBDOMAIN')).toBe('http://files.example.com');
  });

  it('lets a global Template Setting outrank the operator-set port', async () => {
    const config = cfg({
      templateSettings: { FILEBROWSER_PORT: '8096' },
      installedVariables: [{ varName: 'FILEBROWSER_PORT', value: '9999' }],
    });
    // 8096 wins → matches the OTHER host, proving precedence is honoured
    // rather than the operator value simply always winning.
    expect(await resolveServiceUrl(config, 'file-share', 'FILEBROWSER_SUBDOMAIN')).toBe('http://sync.example.com');
  });

  it('still resolves a literal proxyPort and the template default', async () => {
    expect(await resolveServiceUrl(cfg(), 'file-share', 'SYNCTHING_SUBDOMAIN')).toBe('http://sync.example.com');
    // FILEBROWSER_PORT default 13378 matches no host → documented fallback URL.
    expect(await resolveServiceUrl(cfg(), 'file-share', 'FILEBROWSER_SUBDOMAIN')).toBe('http://files.home.arpa');
  });
});
