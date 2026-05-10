/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from '@/lib/config';
import { generateIosCalendarProfile, generateAudiobookshelfDeepLink, resolveSetupAsset } from './assets';

beforeEach(() => {
  (getConfig as any).mockReset();
});

describe('generateIosCalendarProfile', () => {
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
});
