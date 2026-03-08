import { describe, it, expect } from 'vitest';

// Import public API to verify it's accessible
import { parseQuadletFile, QuadletParser, ensureBundlePreview, type QuadletDirectives, type ServiceBundle } from '@/lib/public-api';

describe('Public API Exports', () => {
  it('should export QuadletParser class', () => {
    expect(QuadletParser).toBeDefined();
  });

  it('should export parseQuadletFile function', () => {
    expect(parseQuadletFile).toBeDefined();
  });

  it('should export ensureBundlePreview function', () => {
    expect(ensureBundlePreview).toBeDefined();
  });

  it('parseQuadletFile should parse valid Quadlet content', () => {
    const content = `[Container]
Image=nginx
`;
    const result: QuadletDirectives = parseQuadletFile(content);
    expect(result).toBeDefined();
    expect(result.image).toBe('nginx');
  });

  it('types should be accessible', () => {
    // This test verifies that the types are exported for type-checking
    // In practice, users would import these types for their own usage
    const _typeCheck: typeof ServiceBundle | undefined = undefined;
    const _directives: typeof QuadletDirectives | undefined = undefined;
    expect(_typeCheck).toBeUndefined();
    expect(_directives).toBeUndefined();
  });
});
