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

  it('parses the basicsync_install_qr setup-asset kind', () => {
    const raw = `---
setup_assets:
  - kind: "basicsync_install_qr"
    label: "Install BasicSync"
    description: "Scan to download the app."
---
`;
    const result = parseUserGuide(raw, 'file-share');
    expect(result!.frontmatter.setup_assets).toHaveLength(1);
    expect(result!.frontmatter.setup_assets?.[0]).toEqual({
      kind: 'basicsync_install_qr',
      label: 'Install BasicSync',
      description: 'Scan to download the app.',
    });
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

describe('parseUserGuide — action links (#1618)', () => {
  it('parses a top-level in_app primary_action (terminal deep-link)', () => {
    const raw = `---
primary_action:
  type: "in_app"
  label: "Open terminal"
  href: "/terminal?node=Local&container=claude-dev"
  icon: "bot"
---
body
`;
    const result = parseUserGuide(raw, 'claude-dev');
    expect(result).not.toBeNull();
    const pa = result!.frontmatter.primary_action;
    expect(pa).toEqual({
      type: 'in_app',
      label: 'Open terminal',
      href: '/terminal?node=Local&container=claude-dev',
      icon: 'bot',
      desktop_only: false, // in_app defaults to not desktop-only
    });
  });

  it('parses an external_scheme action and defaults desktop_only to true', () => {
    const raw = `---
actions:
  - type: "external_scheme"
    label: "Open in VS Code"
    href: "vscode://vscode-remote/ssh-remote+box/workspace"
---
body
`;
    const result = parseUserGuide(raw, 'claude-dev');
    expect(result!.frontmatter.actions).toEqual([
      {
        type: 'external_scheme',
        label: 'Open in VS Code',
        href: 'vscode://vscode-remote/ssh-remote+box/workspace',
        desktop_only: true,
      },
    ]);
  });

  it('honours an explicit desktop_only override', () => {
    const raw = `---
primary_action:
  type: "external_scheme"
  label: "Open in Zed"
  href: "zed://open"
  desktop_only: false
---
body
`;
    const result = parseUserGuide(raw, 'svc');
    expect(result!.frontmatter.primary_action?.desktop_only).toBe(false);
  });

  it('rejects an in_app href that is not root-relative (scheme / protocol-relative)', () => {
    const cases = [
      'https://evil.example/x',
      '//evil.example/x',
      'javascript:alert(1)',
      'terminal',
    ];
    for (const href of cases) {
      const raw = `---
primary_action:
  type: "in_app"
  label: "X"
  href: "${href}"
---
body
`;
      const result = parseUserGuide(raw, 'svc');
      expect(result!.frontmatter.primary_action).toBeUndefined();
    }
  });

  it('rejects an external_scheme href whose scheme is not allowlisted', () => {
    const cases = ['javascript://x', 'data://x', 'http://x', 'ftp://x'];
    for (const href of cases) {
      const raw = `---
primary_action:
  type: "external_scheme"
  label: "X"
  href: "${href}"
---
body
`;
      const result = parseUserGuide(raw, 'svc');
      expect(result!.frontmatter.primary_action).toBeUndefined();
    }
  });

  it('drops an action missing label or href, or with an unknown type', () => {
    const raw = `---
actions:
  - type: "in_app"
    href: "/terminal"
  - type: "in_app"
    label: "No href"
  - type: "bogus"
    label: "X"
    href: "/x"
  - type: "in_app"
    label: "Good"
    href: "/good"
---
body
`;
    const result = parseUserGuide(raw, 'svc');
    expect(result!.frontmatter.actions).toEqual([
      { type: 'in_app', label: 'Good', href: '/good', desktop_only: false },
    ]);
  });

  it('drops an unknown icon name but keeps the action', () => {
    const raw = `---
primary_action:
  type: "in_app"
  label: "Open terminal"
  href: "/terminal"
  icon: "not-a-real-icon"
---
body
`;
    const result = parseUserGuide(raw, 'svc');
    expect(result!.frontmatter.primary_action).toEqual({
      type: 'in_app',
      label: 'Open terminal',
      href: '/terminal',
      desktop_only: false,
    });
  });

  it('parses primary_action + actions inside a cards[] entry', () => {
    const raw = `---
cards:
  - subdomain_var: "CLAUDE_DEV_SUBDOMAIN"
    label: "Claude Dev"
    primary_action:
      type: "in_app"
      label: "Open terminal"
      href: "/terminal?container=claude-dev"
    actions:
      - type: "external_scheme"
        label: "Open in VS Code"
        href: "vscode://x"
---
body
`;
    const result = parseUserGuide(raw, 'claude-dev');
    const card = result!.frontmatter.cards?.[0];
    expect(card?.primary_action?.href).toBe('/terminal?container=claude-dev');
    expect(card?.actions?.[0]).toEqual({
      type: 'external_scheme',
      label: 'Open in VS Code',
      href: 'vscode://x',
      desktop_only: true,
    });
  });
});
