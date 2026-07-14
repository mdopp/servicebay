/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(),
}));
const mockAgent = { sendCommand: vi.fn() };
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn(() => Promise.resolve(mockAgent)) },
}));

import { getConfig } from '@/lib/config';
import { generateIosCalendarProfile, generateAudiobookshelfDeepLink, fetchSyncthingDeviceId, resolveSetupAsset } from './assets';

beforeEach(() => {
  (getConfig as any).mockReset();
  mockAgent.sendCommand.mockReset();
});

describe('generateIosCalendarProfile', () => {
  it('uses the operator-customized subdomain from reverseProxy.hosts when present', async () => {
    // Operator chose `agenda` instead of the template default `caldav` —
    // proxy-host entry reflects what got deployed; profile must follow.
    (getConfig as any).mockResolvedValue({
      reverseProxy: {
        lanDomain: 'home.arpa',
        hosts: [{
          domain: 'agenda.home.arpa',
          service: 'radicale',
          forwardPort: 5232,
          created: true,
        }],
      },
    });
    const xml = await generateIosCalendarProfile('radicale');
    expect(xml).not.toBeNull();
    expect(xml!).toMatch(/<key>CalDAVHostName<\/key>\s*<string>agenda\.home\.arpa<\/string>/);
    expect(xml!).not.toMatch(/caldav\.home\.arpa/);
  });

  it('skips uncreated proxy-host entries and falls back to template default', async () => {
    // entry exists but failed to create → fallback to default subdomain.
    (getConfig as any).mockResolvedValue({
      reverseProxy: {
        lanDomain: 'home.arpa',
        hosts: [{
          domain: 'broken.home.arpa',
          service: 'radicale',
          forwardPort: 5232,
          created: false,
        }],
      },
    });
    const xml = await generateIosCalendarProfile('radicale');
    expect(xml).not.toBeNull();
    expect(xml!).toMatch(/caldav\.home\.arpa/);
  });

  it('produces a well-formed mobileconfig with CalDAV + CardDAV payloads', async () => {
    (getConfig as any).mockResolvedValue({
      reverseProxy: { lanDomain: 'home.arpa' },
    });
    const xml = await generateIosCalendarProfile('radicale');
    expect(xml).not.toBeNull();
    // Has both payload types
    expect(xml!).toMatch(/<string>com\.apple\.caldav\.account<\/string>/);
    expect(xml!).toMatch(/<string>com\.apple\.carddav\.account<\/string>/);
    // Embeds the right hostname
    expect(xml!).toMatch(/<key>CalDAVHostName<\/key>\s*<string>caldav\.home\.arpa<\/string>/);
    expect(xml!).toMatch(/<key>CardDAVHostName<\/key>\s*<string>caldav\.home\.arpa<\/string>/);
    // LAN mode → SSL false
    expect(xml!).toMatch(/<key>CalDAVUseSSL<\/key>\s*<false\/>/);
  });

  it('uses https in public mode', async () => {
    (getConfig as any).mockResolvedValue({
      reverseProxy: { publicDomain: 'example.com' },
    });
    const xml = await generateIosCalendarProfile('radicale');
    expect(xml).not.toBeNull();
    expect(xml!).toMatch(/<key>CalDAVUseSSL<\/key>\s*<true\/>/);
    expect(xml!).toMatch(/caldav\.example\.com/);
  });

  it('returns null when service has no subdomain variable', async () => {
    (getConfig as any).mockResolvedValue({
      reverseProxy: { lanDomain: 'home.arpa' },
    });
    // 'nonexistent' template → no variables.json → no subdomain → null
    const xml = await generateIosCalendarProfile('nonexistent');
    expect(xml).toBeNull();
  });
});

describe('generateAudiobookshelfDeepLink', () => {
  it('builds an abs:// URL in LAN mode (ssl=false)', async () => {
    (getConfig as any).mockResolvedValue({
      reverseProxy: { lanDomain: 'home.arpa' },
    });
    const link = await generateAudiobookshelfDeepLink('media');
    expect(link).toMatch(/^abs:\/\//);
    expect(link).toMatch(/ssl=false$/);
  });

  it('builds an abs:// URL in public mode (ssl=true)', async () => {
    (getConfig as any).mockResolvedValue({
      reverseProxy: { publicDomain: 'example.com' },
    });
    const link = await generateAudiobookshelfDeepLink('media');
    expect(link).toMatch(/example\.com/);
    expect(link).toMatch(/ssl=true$/);
  });
});

describe('fetchSyncthingDeviceId', () => {
  const VALID = 'ABCDEFG-HIJKLMN-OPQRSTU-VWXYZ23-4567ABC-DEFGHIJ-KLMNOPQ';

  it('returns the device id when podman exec succeeds', async () => {
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: `${VALID}\n` });
    const id = await fetchSyncthingDeviceId('Local');
    expect(id).toBe(VALID);
  });

  it('returns null when the container is not running (non-zero exit)', async () => {
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no such container' });
    const id = await fetchSyncthingDeviceId('Local');
    expect(id).toBeNull();
  });

  it('rejects malformed device-id output (defends against noisy stdout)', async () => {
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: 'WARNING: foo\n' });
    const id = await fetchSyncthingDeviceId('Local');
    expect(id).toBeNull();
  });

  it('returns null when the agent throws', async () => {
    mockAgent.sendCommand.mockRejectedValueOnce(new Error('agent down'));
    const id = await fetchSyncthingDeviceId('Local');
    expect(id).toBeNull();
  });
});

describe('resolveSetupAsset', () => {
  it('routes ios_calendar_profile to the XML generator', async () => {
    (getConfig as any).mockResolvedValue({ reverseProxy: { lanDomain: 'home.arpa' } });
    const out = await resolveSetupAsset('ios_calendar_profile', 'radicale');
    expect(out?.kind).toBe('ios_calendar_profile');
    expect(out?.data).toMatch(/<\?xml/);
  });

  it('routes audiobookshelf_deeplink to the URL generator', async () => {
    (getConfig as any).mockResolvedValue({ reverseProxy: { lanDomain: 'home.arpa' } });
    const out = await resolveSetupAsset('audiobookshelf_deeplink', 'media');
    expect(out?.kind).toBe('audiobookshelf_deeplink');
    expect(out?.data).toMatch(/^abs:\/\//);
  });

  it('routes syncthing_qr to the device-id fetcher', async () => {
    const VALID = 'ABCDEFG-HIJKLMN-OPQRSTU-VWXYZ23-4567ABC-DEFGHIJ-KLMNOPQ';
    mockAgent.sendCommand.mockResolvedValueOnce({ code: 0, stdout: VALID });
    const out = await resolveSetupAsset('syncthing_qr', 'file-share');
    expect(out?.kind).toBe('syncthing_qr');
    expect(out?.data).toBe(VALID);
  });

  it('returns null for basicsync_install_qr (rendered client-side, no server artifact)', async () => {
    const out = await resolveSetupAsset('basicsync_install_qr', 'file-share');
    expect(out).toBeNull();
  });

  it('echoes the frontmatter url for pwa_install (service-agnostic, no server artifact)', async () => {
    const out = await resolveSetupAsset('pwa_install', 'any-service', undefined, 'https://home.example.com');
    expect(out).toEqual({ kind: 'pwa_install', data: 'https://home.example.com' });
  });

  it('echoes the release url for apk_download', async () => {
    const url = 'https://github.com/owner/repo/releases/latest/download/app.apk';
    const out = await resolveSetupAsset('apk_download', 'any-service', undefined, url);
    expect(out).toEqual({ kind: 'apk_download', data: url });
  });

  it('returns null for a url-driven kind with a missing or unsafe url', async () => {
    expect(await resolveSetupAsset('pwa_install', 'svc')).toBeNull();
    expect(await resolveSetupAsset('apk_download', 'svc', undefined, 'javascript:alert(1)')).toBeNull();
    expect(await resolveSetupAsset('pwa_install', 'svc', undefined, '//evil.example/x')).toBeNull();
  });
});
