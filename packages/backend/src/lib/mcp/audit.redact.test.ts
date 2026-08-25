/**
 * MCP audit-log redaction (#2624).
 *
 * `write_file`'s args are `{path, content, node}` and `content` is the full
 * body of whatever the agent wrote under /mnt/data — routinely a service
 * `.env` or config. The old redactor was a flat, exact-name denylist over the
 * TOP LEVEL of `args`, listing `kubeContent`/`yamlContent` but not `content`,
 * so those bytes were persisted verbatim in `DATA_DIR/mcp-audit.log` forever.
 * Fourth instance of #1211's class (#2603 agent sink, #2616 journal history).
 *
 * These tests pin both halves of the fix: the bytes go, and the EVENT stays —
 * tool, caller, outcome, `path` and a size marker all survive, because an
 * audit log that can't tell you which file was written has traded one
 * blindness for another.
 *
 * Every fixture value below is an obvious placeholder, never a real
 * credential.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

beforeEach(async () => {
  vi.resetModules();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-audit-redact-'));
});
afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const load = () => import('./audit');

/** Distinctive placeholder — if it survives into a log line, the redaction
 *  leaked. Not a real credential. */
const PLACEHOLDER = 'PLACEHOLDER-NOT-A-REAL-SECRET-9f1c';

describe('write_file args — the reported instance (#2624)', () => {
  it('masks the file body but keeps the path, the node and the size', async () => {
    const { redactArgs } = await load();
    const content = `DB_PASSWORD=${PLACEHOLDER}\nAPI_URL=https://example.invalid\n`;
    const out = redactArgs({ path: '/mnt/data/stacks/demo/.env', content, node: 'box' });

    expect(out).toEqual({
      path: '/mnt/data/stacks/demo/.env',
      content: `<${content.length} chars redacted>`,
      node: 'box',
    });
    expect(JSON.stringify(out)).not.toContain(PLACEHOLDER);
  });

  it('does not reach the on-disk audit log in plaintext', async () => {
    const { recordAudit } = await load();
    await recordAudit({
      ts: new Date().toISOString(),
      tool: 'write_file',
      caller: 'agent',
      outcome: 'ok',
      durationMs: 3,
      args: { path: '/mnt/data/stacks/demo/.env', content: `TOKEN=${PLACEHOLDER}`, node: 'box' },
    });

    const raw = await fsp.readFile(path.join(dataDir, 'mcp-audit.log'), 'utf-8');
    expect(raw).not.toContain(PLACEHOLDER);
    // The event is still fully legible to an operator.
    expect(raw).toContain('write_file');
    expect(raw).toContain('/mnt/data/stacks/demo/.env');
    expect(raw).toContain('chars redacted');
  });

  it('is recorded even when the write was blocked, still without the body', async () => {
    const { recordAudit, readRecentAudit } = await load();
    await recordAudit({
      ts: new Date().toISOString(),
      tool: 'write_file',
      caller: 'agent',
      outcome: 'blocked',
      durationMs: 0,
      args: { path: '/mnt/data/x/.env', content: PLACEHOLDER, node: 'box' },
      errorMessage: 'mutations disabled',
    });
    const [entry] = await readRecentAudit(1);
    expect(entry.outcome).toBe('blocked');
    expect(entry.args?.content).toBe(`<${PLACEHOLDER.length} chars redacted>`);
    expect(entry.args?.path).toBe('/mnt/data/x/.env');
  });
});

describe('sibling tools that pass a body-shaped arg through recordAudit', () => {
  it('masks deploy_service extraFiles[].content — nested, which the old top-level pass missed', async () => {
    const { redactArgs } = await load();
    const body = `jwt_secret: ${PLACEHOLDER}\n`;
    const out = redactArgs({
      name: 'auth',
      kubeContent: `env:\n  - name: X\n    value: ${PLACEHOLDER}\n`,
      extraFiles: [
        { path: '/mnt/data/stacks/auth/authelia-config/configuration.yml', content: body },
      ],
    });

    expect(JSON.stringify(out)).not.toContain(PLACEHOLDER);
    const files = out?.extraFiles as { path: string; content: string }[];
    expect(files[0].path).toBe('/mnt/data/stacks/auth/authelia-config/configuration.yml');
    expect(files[0].content).toBe(`<${body.length} chars redacted>`);
    // The service name — the thing that says WHAT was deployed — survives.
    expect(out?.name).toBe('auth');
  });

  it('masks update_service_yaml podSpecContent — the newer alias the denylist never learned', async () => {
    const { redactArgs } = await load();
    const spec = `spec:\n  containers:\n    - env: [{name: SSO_CLIENT_SECRET, value: ${PLACEHOLDER}}]\n`;
    const out = redactArgs({ service: 'media', podSpecContent: spec });
    expect(out?.podSpecContent).toBe(`<${spec.length} chars redacted>`);
    expect(out?.service).toBe('media');
  });

  it('masks install_template variables by key name, keeping the non-secret ones legible', async () => {
    const { redactArgs } = await load();
    const out = redactArgs({
      id: 'tor',
      variables: { SUBDOMAIN_TOR: 'tor', ADMIN_PASSWORD: PLACEHOLDER, OIDC_CLIENT_SECRET: PLACEHOLDER },
    });
    expect(out?.variables).toEqual({
      SUBDOMAIN_TOR: 'tor',
      ADMIN_PASSWORD: '[redacted]',
      OIDC_CLIENT_SECRET: '[redacted]',
    });
    expect(out?.id).toBe('tor');
  });

  it('masks add_proxy_route advancedConfig — raw nginx directives can carry auth', async () => {
    const { redactArgs } = await load();
    const cfg = `auth_basic_user_file /etc/nginx/${PLACEHOLDER};`;
    const out = redactArgs({ domain: 'demo.example.invalid', advancedConfig: cfg });
    expect(out?.advancedConfig).toBe(`<${cfg.length} chars redacted>`);
    expect(out?.domain).toBe('demo.example.invalid');
  });

  it('masks create_assist body', async () => {
    const { redactArgs } = await load();
    const out = redactArgs({ id: 'howto', title: 'How to', body: `token: ${PLACEHOLDER}` });
    expect(String(out?.body)).toMatch(/^<\d+ chars redacted>$/);
    expect(out?.title).toBe('How to');
  });
});

describe('exec-shaped args stay legible but lose inline credentials', () => {
  it('masks a credential inside exec_command.command instead of logging it verbatim', async () => {
    const { redactArgs } = await load();
    const out = redactArgs({ command: `mysql --password ${PLACEHOLDER} -e 'select 1'` });
    expect(out?.command).not.toContain(PLACEHOLDER);
    // The command itself is the forensic value — it must still be readable.
    expect(String(out?.command)).toContain('mysql --password');
    expect(String(out?.command)).toContain("select 1");
  });

  it('still truncates a long command to a head plus a count', async () => {
    const { redactArgs } = await load();
    const out = redactArgs({ command: 'x'.repeat(500) });
    expect(String(out?.command)).toMatch(/^x{200}…\(\+300 chars\)$/);
  });

  it('masks a credential inside container_exec argv', async () => {
    const { redactArgs } = await load();
    const out = redactArgs({ container: 'demo', args: ['curl', '-H', `Bearer ${PLACEHOLDER}`] });
    expect(JSON.stringify(out?.args)).not.toContain(PLACEHOLDER);
    expect((out?.args as string[])[0]).toBe('curl');
  });
});

describe('the redactor walks to any depth and keeps everything else intact', () => {
  it('masks a body buried several levels down', async () => {
    const { redactArgs } = await load();
    const out = redactArgs({ a: { b: { c: [{ content: PLACEHOLDER, path: '/mnt/data/deep' }] } } });
    expect(JSON.stringify(out)).not.toContain(PLACEHOLDER);
    expect(JSON.stringify(out)).toContain('/mnt/data/deep');
  });

  it('caps a pathologically deep payload instead of recursing forever', async () => {
    const { redactArgs } = await load();
    let nested: Record<string, unknown> = { content: PLACEHOLDER };
    for (let i = 0; i < 40; i++) nested = { next: nested };
    const out = redactArgs(nested);
    expect(JSON.stringify(out)).toContain('max depth');
    expect(JSON.stringify(out)).not.toContain(PLACEHOLDER);
  });

  it('keeps cookie masked — the one legacy key the shared word matcher does not reach', async () => {
    const { redactArgs } = await load();
    expect(redactArgs({ cookie: PLACEHOLDER })).toEqual({ cookie: '[redacted]' });
  });

  it('leaves ordinary arguments untouched', async () => {
    const { redactArgs } = await load();
    const args = { service: 'media', node: 'box', force: true, limit: 20, tail: null };
    expect(redactArgs(args)).toEqual(args);
  });

  it('returns undefined when there are no args', async () => {
    const { redactArgs } = await load();
    expect(redactArgs(undefined)).toBeUndefined();
  });
});
