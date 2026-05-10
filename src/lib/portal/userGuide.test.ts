import { describe, it, expect } from 'vitest';
import { parseUserGuide } from './userGuide';

describe('parseUserGuide', () => {
  it('returns null for empty input', () => {
    expect(parseUserGuide(null, 'x')).toBeNull();
    expect(parseUserGuide('', 'x')).toBeNull();
    expect(parseUserGuide('   \n  ', 'x')).toBeNull();
  });

  it('extracts icon, tagline, and mobile_apps', () => {
    const raw = `---
icon: "📷"
tagline: "Auto-backup your photos."
mobile_apps:
  - name: "Immich for iOS"
    url: "https://apps.apple.com/app/immich/id1"
  - name: "Immich for Android"
    url: "https://play.google.com/store/apps/details?id=app.immich"
---

# Getting started

Step 1.
`;
    const result = parseUserGuide(raw, 'immich');
    expect(result).not.toBeNull();
    expect(result!.frontmatter.icon).toBe('📷');
    expect(result!.frontmatter.tagline).toBe('Auto-backup your photos.');
    expect(result!.frontmatter.mobile_apps).toHaveLength(2);
    expect(result!.frontmatter.mobile_apps?.[0].name).toBe('Immich for iOS');
    expect(result!.body.trim()).toMatch(/^# Getting started/);
  });

  it('rejects non-http(s) URLs in mobile_apps', () => {
    const raw = `---
mobile_apps:
  - name: "Evil"
    url: "javascript:alert(1)"
  - name: "Real"
    url: "https://example.com"
---

body
`;
    const result = parseUserGuide(raw, 'evil');
    expect(result!.frontmatter.mobile_apps).toHaveLength(1);
    expect(result!.frontmatter.mobile_apps?.[0].name).toBe('Real');
  });

  it('tolerates missing frontmatter (returns body only)', () => {
    const raw = `# Just a title

Body with no frontmatter.
`;
    const result = parseUserGuide(raw, 'plain');
    expect(result).not.toBeNull();
    expect(result!.frontmatter).toEqual({});
    expect(result!.body).toContain('Just a title');
  });

  it('drops malformed mobile_apps entries silently', () => {
    const raw = `---
mobile_apps:
  - name: "Missing url"
  - url: "https://example.com"
  - "not an object"
  - name: "Real"
    url: "https://real.example"
---
`;
    const result = parseUserGuide(raw, 'mixed');
    expect(result!.frontmatter.mobile_apps).toEqual([{ name: 'Real', url: 'https://real.example' }]);
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
