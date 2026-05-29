import { describe, it, expect } from 'vitest';
import {
  isoBuildCommand,
  installWatchCommand,
  parseInstallSettings,
  resolveBoxTarget,
  DEFAULT_SB_PORT,
} from './actions';

describe('command builders', () => {
  it('isoBuildCommand hands off to the native Go launcher build subcommand', () => {
    const cmd = isoBuildCommand('/repo');
    expect(cmd.cmd).toBe('go');
    expect(cmd.args).toEqual(['run', '/repo/tools/sb-tui', 'build']);
  });

  it('installWatchCommand hands off to the native Go launcher watch subcommand', () => {
    const cmd = installWatchCommand('/repo');
    expect(cmd.cmd).toBe('go');
    expect(cmd.args).toEqual(['run', '/repo/tools/sb-tui', 'watch']);
  });
});

describe('parseInstallSettings', () => {
  it('pulls STATIC_IP + SERVICEBAY_PORT out of the env file', () => {
    const text = 'FOO=bar\nSTATIC_IP=192.168.178.100\nSERVICEBAY_PORT=5888\n';
    expect(parseInstallSettings(text)).toEqual({ host: '192.168.178.100', port: '5888' });
  });

  it('returns undefined for absent keys', () => {
    expect(parseInstallSettings('NOTHING=here')).toEqual({ host: undefined, port: undefined });
  });
});

describe('resolveBoxTarget', () => {
  it('prefers SB_HOST/SB_PORT env over settings', () => {
    const t = resolveBoxTarget({ host: '10.0.0.1', port: '1000' }, { SB_HOST: '10.0.0.9', SB_PORT: '9999' });
    expect(t).toEqual({ host: '10.0.0.9', port: '9999' });
  });

  it('falls back to settings, then the default port', () => {
    expect(resolveBoxTarget({ host: '10.0.0.1' }, {})).toEqual({ host: '10.0.0.1', port: DEFAULT_SB_PORT });
  });

  it('host is empty when neither env nor settings provide one', () => {
    expect(resolveBoxTarget({}, {}).host).toBe('');
  });
});
