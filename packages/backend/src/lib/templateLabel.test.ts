import { describe, it, expect } from 'vitest';
import { parseTemplateLabel } from './templateLabel';

describe('parseTemplateLabel', () => {
  it('extracts a double-quoted label', () => {
    const yaml =
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: foo\n' +
      '  annotations:\n' +
      '    servicebay.label: "Foo (Bar)"\n' +
      '    servicebay.ports: "80/tcp"\n';
    expect(parseTemplateLabel(yaml)).toBe('Foo (Bar)');
  });

  it('extracts a single-quoted label', () => {
    const yaml = "  annotations:\n    servicebay.label: 'My Service'\n";
    expect(parseTemplateLabel(yaml)).toBe('My Service');
  });

  it('extracts a bare (unquoted) label', () => {
    const yaml = '  annotations:\n    servicebay.label: Something Plain\n';
    expect(parseTemplateLabel(yaml)).toBe('Something Plain');
  });

  it('returns undefined when the annotation is missing', () => {
    const yaml = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: foo\n';
    expect(parseTemplateLabel(yaml)).toBeUndefined();
  });

  it('returns undefined for an empty quoted label', () => {
    const yaml = '  annotations:\n    servicebay.label: ""\n';
    expect(parseTemplateLabel(yaml)).toBeUndefined();
  });

  it('does not match a similarly-named key without the dot', () => {
    const yaml = '  annotations:\n    servicebay-label: "wrong key"\n';
    expect(parseTemplateLabel(yaml)).toBeUndefined();
  });
});
