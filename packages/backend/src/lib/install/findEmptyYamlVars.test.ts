import { describe, it, expect } from 'vitest';
import { findEmptyYamlVars } from './runner';

describe('findEmptyYamlVars (#1318)', () => {
  it('flags a direct {{VAR}} with no value in the view', () => {
    const yaml = 'image: myapp:{{IMAGE_TAG}}';
    expect(findEmptyYamlVars(yaml, { IMAGE_TAG: '' })).toEqual(['IMAGE_TAG']);
  });

  it('flags a direct ref absent from the view entirely', () => {
    expect(findEmptyYamlVars('port: {{APP_PORT}}', {})).toEqual(['APP_PORT']);
  });

  it('does not flag a direct ref that has a value', () => {
    expect(findEmptyYamlVars('port: {{APP_PORT}}', { APP_PORT: '8080' })).toEqual([]);
  });

  it('flags an empty triple-stache {{{VAR}}}', () => {
    expect(findEmptyYamlVars('x: {{{RAW}}}', { RAW: '' })).toEqual(['RAW']);
  });

  it('does NOT flag a var used only as a Mustache section (optional conditional)', () => {
    const yaml = [
      '{{#ZWAVE_DEVICE}}',
      '  devices:',
      '    - {{ZWAVE_DEVICE}}',
      '{{/ZWAVE_DEVICE}}',
    ].join('\n');
    // ZWAVE_DEVICE is section-guarded — empty is legitimate (no zwave stick).
    expect(findEmptyYamlVars(yaml, { ZWAVE_DEVICE: '' })).toEqual([]);
  });

  it('only reports each missing var once and ignores filled ones', () => {
    const yaml = 'a: {{ONE}}\nb: {{ONE}}\nc: {{TWO}}\nd: {{THREE}}';
    const out = findEmptyYamlVars(yaml, { ONE: '', TWO: 'set', THREE: '' }).sort();
    expect(out).toEqual(['ONE', 'THREE']);
  });

  it('treats whitespace inside the braces the same', () => {
    expect(findEmptyYamlVars('x: {{  SPACED  }}', { SPACED: '' })).toEqual(['SPACED']);
  });
});
