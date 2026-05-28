import { describe, it, expect } from 'vitest';
import { redactCommandPayloadForLog } from './handler';

describe('redactCommandPayloadForLog (#1211)', () => {
  it('replaces write_file content (the rendered pod YAML) with a size marker', () => {
    const yaml = 'env:\n- name: HERMES_TOKEN\n  value: super-secret\n'.padEnd(500, ' ');
    const out = redactCommandPayloadForLog({ path: '/svc.yml', content: yaml });
    expect(out.path).toBe('/svc.yml');
    expect(out.content).toBe(`<${yaml.length} chars redacted>`);
    expect(JSON.stringify(out)).not.toContain('super-secret');
  });

  it('masks secret-looking keys', () => {
    const out = redactCommandPayloadForLog({ PUSH_TOKEN: 'abc', api_key: 'k', name: 'svc' });
    expect(out.PUSH_TOKEN).toBe('***');
    expect(out.api_key).toBe('***');
    expect(out.name).toBe('svc');
  });

  it('leaves non-secret payloads intact', () => {
    const out = redactCommandPayloadForLog({ command: 'ls -la', timeout: 30 });
    expect(out).toEqual({ command: 'ls -la', timeout: 30 });
  });
});
