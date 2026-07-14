import { describe, it, expect } from 'vitest';
import {
  wrapSnippetInScratchConfig,
  buildScratchNginxValidateCommand,
  parseScratchNginxOutput,
  SCRATCH_CONF_PATH,
} from './nginxScratchValidate';

describe('wrapSnippetInScratchConfig', () => {
  it('wraps a location snippet in a self-contained, nginx-parseable harness', () => {
    const out = wrapSnippetInScratchConfig('location = /napi/pair { proxy_pass http://127.0.0.1:81; }');
    expect(out).toContain('events {}');
    expect(out).toContain('http {');
    expect(out).toContain('server {');
    expect(out).toContain('listen 8080;');
    expect(out).toContain('location = /napi/pair');
  });

  it('pins the standalone-run harness (user root; no default access/error log; /tmp temp paths)', () => {
    // These three were the exact fixes the live-box run surfaced — a bare
    // nginx -t setuid's to a missing `nginx` user and wants /var/cache|/var/log.
    const out = wrapSnippetInScratchConfig('location = /a { proxy_pass http://127.0.0.1:80; }');
    expect(out).toContain('user root;');
    expect(out).toContain('access_log off;');
    expect(out).toContain('error_log stderr;');
    expect(out).toContain('client_body_temp_path /tmp/sb-scratch-nginx/client;');
    expect(out).toContain('proxy_temp_path /tmp/sb-scratch-nginx/proxy;');
  });

  it('expands remaining {{KEY}} placeholders (with optional inner whitespace)', () => {
    const out = wrapSnippetInScratchConfig(
      'proxy_pass http://127.0.0.1:{{AUTHELIA_PORT}}/api/authz/auth-request; # {{ AUTHELIA_PORT }}',
    );
    expect(out).toContain('http://127.0.0.1:9091/api/authz/auth-request');
    expect(out).not.toContain('{{AUTHELIA_PORT}}');
    expect(out).not.toContain('{{ AUTHELIA_PORT }}');
  });

  it('honours a caller-supplied substitution map', () => {
    const out = wrapSnippetInScratchConfig('# {{PORT}}', { PORT: '4443' });
    expect(out).toContain('# 4443');
  });

  it('leaves unknown placeholders intact rather than blanking them', () => {
    const out = wrapSnippetInScratchConfig('# {{UNKNOWN_KEY}}');
    expect(out).toContain('{{UNKNOWN_KEY}}');
  });

  it('is pure — same input yields identical output', () => {
    const snippet = 'location = /a { proxy_pass http://127.0.0.1:80; }';
    expect(wrapSnippetInScratchConfig(snippet)).toBe(wrapSnippetInScratchConfig(snippet));
  });
});

describe('buildScratchNginxValidateCommand', () => {
  it('pipes the config via stdin into a --rm container off the NPM image (no host bind-mount)', () => {
    const wrapped = wrapSnippetInScratchConfig("location = /a { add_header X 'it\"s fine'; }");
    const cmd = buildScratchNginxValidateCommand(wrapped, 'docker.io/jc21/nginx-proxy-manager:latest');
    expect(cmd).toContain('podman run --rm -i --user root --entrypoint sh docker.io/jc21/nginx-proxy-manager:latest');
    expect(cmd).toContain(`base64 -d > ${SCRATCH_CONF_PATH}`);
    expect(cmd).toContain(`nginx -t -c ${SCRATCH_CONF_PATH}`);
    expect(cmd).toContain('2>&1');
    // No host bind-mount (the SELinux trap) and never targets the live NPM container.
    expect(cmd).not.toContain('-v ');
    expect(cmd).not.toContain('podman exec');
    // The config body is base64 — its raw quotes never reach the shell.
    expect(cmd).not.toContain('it"s fine');
    const b64 = cmd.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(wrapped);
  });

  it('honours a custom container conf path', () => {
    const cmd = buildScratchNginxValidateCommand('events {}', 'img', '/tmp/other.conf');
    expect(cmd).toContain('base64 -d > /tmp/other.conf');
    expect(cmd).toContain('nginx -t -c /tmp/other.conf');
  });
});

describe('parseScratchNginxOutput', () => {
  it('treats exit 0 as valid (the harmless pre-parse [alert] is ignored)', () => {
    const ok =
      'nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed\n' +
      'nginx: the configuration file /tmp/s.conf syntax is ok\n' +
      'nginx: configuration file /tmp/s.conf test is successful';
    expect(parseScratchNginxOutput(ok, 0)).toEqual({ ok: true });
  });

  it('flags a non-zero exit and extracts the [emerg] line (duplicate location — the real box output)', () => {
    const out =
      'nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed\n' +
      '2026/07/14 15:21:15 [emerg] 4#4: duplicate location "/napi/pair" in /tmp/s.conf:15\n' +
      'nginx: configuration file /tmp/s.conf test failed';
    const parsed = parseScratchNginxOutput(out, 1);
    expect(parsed.ok).toBe(false);
    expect(parsed.emergLine).toContain('duplicate location "/napi/pair"');
  });

  it('flags an invalid-port emerg (the classic empty-Authelia-port break)', () => {
    const parsed = parseScratchNginxOutput('nginx: [emerg] invalid port in upstream "127.0.0.1:"', 1);
    expect(parsed.ok).toBe(false);
    expect(parsed.emergLine).toContain('invalid port');
  });

  it('reds a non-zero exit even when no [emerg] line is captured', () => {
    expect(parseScratchNginxOutput('some other failure', 2)).toEqual({ ok: false, emergLine: undefined });
  });
});
