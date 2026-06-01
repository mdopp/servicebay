import { describe, it, expect } from 'vitest';
import { parseUserGuide } from './userGuide';

describe('parseUserGuide', () => {
  it('returns null for empty input', () => {
    expect(parseUserGuide(null, 'x')).toBeNull();
    expect(parseUserGuide('', 'x')).toBeNull();
    expect(parseUserGuide('   \n  ', 'x')).toBeNull();
  });

  it('extracts icon and tagline', () => {
    const raw = `---
icon: "📷"
tagline: "Auto-backup your photos."
---

# Getting started
`;
    const result = parseUserGuide(raw, 'immich');
    expect(result).not.toBeNull();
    expect(result!.frontmatter.icon).toBe('📷');
    expect(result!.frontmatter.tagline).toBe('Auto-backup your photos.');
    expect(result!.body.trim()).toMatch(/^# Getting started/);
  });

  it('parses recommended_apps with platforms + note', () => {
    const raw = `---
recommended_apps:
  - name: "Obsidian"
    url: "https://obsidian.md"
    platforms: ["desktop", "ios", "android"]
    note: "Notes app; pair with Syncthing for live sync."
  - name: "VLC"
    url: "https://www.videolan.org/"
    platforms: ["desktop", "android"]
---

body
`;
    const result = parseUserGuide(raw, 'file-share');
    expect(result!.frontmatter.recommended_apps).toHaveLength(2);
    expect(result!.frontmatter.recommended_apps?.[0]).toEqual({
      name: 'Obsidian',
      url: 'https://obsidian.md',
      platforms: ['desktop', 'ios', 'android'],
      note: 'Notes app; pair with Syncthing for live sync.',
    });
    expect(result!.frontmatter.recommended_apps?.[1].note).toBeUndefined();
  });

  it('drops unknown platform values silently', () => {
    const raw = `---
recommended_apps:
  - name: "X"
    url: "https://x.example"
    platforms: ["desktop", "smartwatch", "ios"]
---
`;
    const result = parseUserGuide(raw, 'x');
    expect(result!.frontmatter.recommended_apps?.[0].platforms).toEqual(['desktop', 'ios']);
  });

  it('rejects non-http(s) URLs in recommended_apps', () => {
    const raw = `---
recommended_apps:
  - name: "Evil"
    url: "javascript:alert(1)"
  - name: "Real"
    url: "https://example.com"
---
`;
    const result = parseUserGuide(raw, 'evil');
    expect(result!.frontmatter.recommended_apps).toHaveLength(1);
    expect(result!.frontmatter.recommended_apps?.[0].name).toBe('Real');
  });

  it('accepts same-origin root-relative URLs but rejects protocol-relative ones', () => {
    const raw = `---
recommended_apps:
  - name: "Dynamic download"
    url: "/api/system/downloads/basicsync?abi=arm64-v8a"
  - name: "Off-origin"
    url: "//evil.example/x"
---
`;
    const result = parseUserGuide(raw, 'rel');
    expect(result!.frontmatter.recommended_apps).toHaveLength(1);
    expect(result!.frontmatter.recommended_apps?.[0].url).toBe('/api/system/downloads/basicsync?abi=arm64-v8a');
  });

  it('lifts legacy mobile_apps into recommended_apps with inferred platforms', () => {
    const raw = `---
mobile_apps:
  - name: "Immich for iOS"
    url: "https://apps.apple.com/app/immich/id1"
  - name: "Immich for Android"
    url: "https://play.google.com/store/apps/details?id=app.immich"
---
`;
    const result = parseUserGuide(raw, 'legacy');
    const apps = result!.frontmatter.recommended_apps;
    expect(apps).toHaveLength(2);
    expect(apps?.[0].platforms).toEqual(['ios']);
    expect(apps?.[1].platforms).toEqual(['android']);
  });

  it('prefers recommended_apps over mobile_apps when both are present', () => {
    const raw = `---
recommended_apps:
  - name: "New"
    url: "https://new.example"
mobile_apps:
  - name: "Old"
    url: "https://apps.apple.com/old"
---
`;
    const result = parseUserGuide(raw, 'mixed');
    expect(result!.frontmatter.recommended_apps).toHaveLength(1);
    expect(result!.frontmatter.recommended_apps?.[0].name).toBe('New');
  });

  it('tolerates missing frontmatter (returns body only)', () => {
    const raw = `# Just a title\n\nbody\n`;
    const result = parseUserGuide(raw, 'plain');
    expect(result).not.toBeNull();
    expect(result!.frontmatter).toEqual({});
    expect(result!.body).toContain('Just a title');
  });

  it('parses setup_assets with whitelisted kinds', () => {
    const raw = `---
setup_assets:
  - kind: "ios_calendar_profile"
    label: "Add to iPhone"
    description: "Two-tap install."
  - kind: "audiobookshelf_deeplink"
  - kind: "unknown_kind"
---
`;
    const result = parseUserGuide(raw, 'mixed');
    expect(result!.frontmatter.setup_assets).toHaveLength(2);
    expect(result!.frontmatter.setup_assets?.[0]).toEqual({
      kind: 'ios_calendar_profile',
      label: 'Add to iPhone',
      description: 'Two-tap install.',
    });
    expect(result!.frontmatter.setup_assets?.[1].kind).toBe('audiobookshelf_deeplink');
  });

  it('drops setup_assets entries with non-string kind', () => {
    const raw = `---
setup_assets:
  - kind: 42
  - kind: "ios_calendar_profile"
---
`;
    const result = parseUserGuide(raw, 'x');
    expect(result!.frontmatter.setup_assets).toHaveLength(1);
  });

  it('parses lucide_icon when in the allowlist', () => {
    const raw = `---
lucide_icon: "camera"
tagline: "..."
---
`;
    const result = parseUserGuide(raw, 'immich');
    expect(result!.frontmatter.lucide_icon).toBe('camera');
  });

  it('drops lucide_icon values not in the allowlist', () => {
    const raw = `---
lucide_icon: "<script>"
---
`;
    const result = parseUserGuide(raw, 'evil');
    expect(result!.frontmatter.lucide_icon).toBeUndefined();
  });

  it('parses manual_pairing with title, command, and optional why', () => {
    const raw = `---
manual_pairing:
  - title: "Pair the Signal account"
    command: "podman exec -it hermes signal-cli link -n HermesAgent"
    why: "Scan the QR shown in the terminal with Signal on your phone."
  - title: "No-why step"
    command: "podman exec -it hermes do-thing"
---
`;
    const result = parseUserGuide(raw, 'hermes');
    expect(result!.frontmatter.manual_pairing).toHaveLength(2);
    expect(result!.frontmatter.manual_pairing?.[0]).toEqual({
      title: 'Pair the Signal account',
      command: 'podman exec -it hermes signal-cli link -n HermesAgent',
      why: 'Scan the QR shown in the terminal with Signal on your phone.',
    });
    expect(result!.frontmatter.manual_pairing?.[1].why).toBeUndefined();
  });

  it('drops manual_pairing entries missing title or command', () => {
    const raw = `---
manual_pairing:
  - title: "Has no command"
  - command: "has-no-title"
  - title: "   "
    command: "blank-title"
  - title: "Valid"
    command: "podman exec -it x link"
---
`;
    const result = parseUserGuide(raw, 'x');
    expect(result!.frontmatter.manual_pairing).toHaveLength(1);
    expect(result!.frontmatter.manual_pairing?.[0].title).toBe('Valid');
  });

  it('parses per-card manual_pairing', () => {
    const raw = `---
cards:
  - subdomain_var: "HERMES_SUBDOMAIN"
    manual_pairing:
      - title: "Pair Signal"
        command: "podman exec -it hermes signal-cli link"
---
`;
    const result = parseUserGuide(raw, 'hermes');
    expect(result!.frontmatter.cards?.[0].manual_pairing).toHaveLength(1);
    expect(result!.frontmatter.cards?.[0].manual_pairing?.[0].command).toBe('podman exec -it hermes signal-cli link');
  });

  it('returns null on YAML parse error', () => {
    const raw = `---
icon: "📷
tagline: unclosed quote
---

body
`;
    const result = parseUserGuide(raw, 'broken');
    expect(result).toBeNull();
  });
});
