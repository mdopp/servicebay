import { describe, it, expect } from 'vitest';
import { parseTemplateTier, isInfrastructureTier } from './templateTier';

describe('parseTemplateTier', () => {
  it('extracts infrastructure when annotated', () => {
    const yaml =
      '  annotations:\n    servicebay.tier: "infrastructure"\n    servicebay.ports: "80/tcp"\n';
    expect(parseTemplateTier(yaml)).toBe('infrastructure');
  });

  it('extracts feature when annotated explicitly', () => {
    expect(parseTemplateTier('  annotations:\n    servicebay.tier: feature\n')).toBe('feature');
  });

  it("defaults to 'feature' when annotation is missing", () => {
    const yaml = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: foo\n';
    expect(parseTemplateTier(yaml)).toBe('feature');
  });

  it("defaults to 'feature' for unrecognized values", () => {
    expect(parseTemplateTier('  annotations:\n    servicebay.tier: "wat"\n')).toBe('feature');
  });

  it('handles single quotes', () => {
    expect(parseTemplateTier("  annotations:\n    servicebay.tier: 'infrastructure'\n")).toBe('infrastructure');
  });

  it('does not match similarly-named keys', () => {
    expect(parseTemplateTier('  annotations:\n    servicebay-tier: "infrastructure"\n')).toBe('feature');
  });
});

describe('isInfrastructureTier', () => {
  it('returns true for infrastructure', () => {
    expect(isInfrastructureTier('infrastructure')).toBe(true);
  });
  it('returns false for feature', () => {
    expect(isInfrastructureTier('feature')).toBe(false);
  });
});
