/**
 * claude-dev + pi (#2803) — the operator decision, encoded.
 *
 * The decision (issuecomment-5552979870) has three parts, and each one is a
 * thing that can silently stop being true later:
 *
 *   1. pi extends the EXISTING claude-dev template — same container, same
 *      /workspace, same LDAP group. `@earendil-works/pi-coding-agent` is in the
 *      image, `pi-web-ui` is a second service on its own port (≠ 8787, which
 *      solaris holds) behind nginx + Authelia on a second subdomain, with the
 *      websocket origin whitelisted and NO `PI_WEB_TOKEN` — Authelia is the gate.
 *   2. The model source is ONLY `local-qwen`, an OpenAI-compatible provider at
 *      `host.containers.internal:18080/v1` in pi's models.json. No cloud secret
 *      of any kind ships in this template.
 *   3. `start-claude` / Remote Control are untouched; pi is additive.
 *
 * The runtime behaviour of the entrypoint (what pi-web-ui is actually launched
 * with) is asserted by tests/templates/claude_dev_entrypoint_test.sh. This file
 * covers the model seeder's merge semantics and the declarative wiring —
 * template.yml, variables.json, the Dockerfile and the image workflow.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'claude-dev');
const SEEDER = path.join(TEMPLATE_DIR, 'pi', 'seed-models.mjs');

const read = (p: string) => fs.readFileSync(p, 'utf-8');
const templateYml = () => read(path.join(TEMPLATE_DIR, 'template.yml'));
const variables = () => JSON.parse(read(path.join(TEMPLATE_DIR, 'variables.json')));
const dockerfile = () => read(path.join(TEMPLATE_DIR, 'Dockerfile'));
const entrypoint = () => read(path.join(TEMPLATE_DIR, 'docker-entrypoint.sh'));

// ─── 1. pi extends claude-dev; the web UI sits behind Authelia ──────────────

describe('#2803 (1): pi extends claude-dev rather than forking a second template', () => {
  it('ships no separate pi-dev template', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'templates', 'pi-dev'))).toBe(false);
  });

  it('installs both pi and its web UI into the claude-dev image', () => {
    const df = dockerfile();
    expect(df).toContain('@earendil-works/pi-coding-agent');
    expect(df).toContain('pi-web-ui');
  });

  it('rebuilds :latest when the pi assets change, so a merge actually reaches the box', () => {
    const wf = read(path.join(REPO_ROOT, '.github', 'workflows', 'claude-dev-image.yml'));
    // The Dockerfile + entrypoint triggers already exist; the seeder lives in
    // its own directory and would otherwise change in the repo while the box
    // kept running the old image.
    expect(wf).toContain("templates/claude-dev/pi/**");
    expect(wf).toContain('templates/claude-dev/Dockerfile');
  });

  it('publishes the pi port on the host loopback only, so nginx is the sole way in', () => {
    const yml = templateYml();
    const block = yml.slice(yml.indexOf('containerPort: {{CLAUDE_DEV_PI_PORT}}'));
    expect(block).toMatch(/containerPort: \{\{CLAUDE_DEV_PI_PORT\}\}\s*\n\s*hostPort: \{\{CLAUDE_DEV_PI_PORT\}\}\s*\n\s*hostIP: 127\.0\.0\.1/);
    expect(yml).toContain('{{CLAUDE_DEV_PI_PORT}}/tcp');
  });

  it('gets its own subdomain, gated by the same Authelia forward-auth as the config UI', () => {
    const v = variables();
    const sub = v.CLAUDE_DEV_PI_SUBDOMAIN;
    expect(sub?.type).toBe('subdomain');
    expect(sub.proxyPort).toBe('CLAUDE_DEV_PI_PORT');
    expect(sub.loopbackOnly).toBe(true);
    expect(sub.proxyConfig.advanced_config).toBe('__authelia_forward_auth__');
    // Without this the page loads and the chat reconnects forever: pi-web-ui
    // speaks websockets and NPM does not upgrade unless told to.
    expect(sub.proxyConfig.allow_websocket_upgrade).toBe(true);
    // A second subdomain NEXT TO the config UI's, not instead of it.
    expect(v.CLAUDE_DEV_CONFIG_SUBDOMAIN?.type).toBe('subdomain');
    expect(sub.default).not.toBe(v.CLAUDE_DEV_CONFIG_SUBDOMAIN.default);
  });

  it('uses a port the operator can choose, and never pi-web-ui\'s own 8787 (solaris holds it)', () => {
    const v = variables();
    expect(v.CLAUDE_DEV_PI_PORT?.type).toBe('text');
    expect(v.CLAUDE_DEV_PI_PORT.default).not.toBe('8787');
    // …and it must not collide with the ports this same pod already publishes.
    const ports = [
      v.CLAUDE_DEV_SSH_PORT.default,
      v.CLAUDE_DEV_CONFIG_PORT.default,
      v.CLAUDE_DEV_PI_PORT.default,
    ];
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('reuses the SSH/config-UI LDAP group rather than inventing a second one', () => {
    expect(Object.keys(variables())).toContain('CLAUDE_DEV_LDAP_GROUP');
    expect(entrypoint()).toMatch(/start_pi_web_ui\(\)[\s\S]*CLAUDE_DEV_LDAP_GROUP/);
  });

  it('sets no PI_WEB_TOKEN anywhere — Authelia is the gate, not a second password', () => {
    // The pod must not carry one (the prose comment explaining WHY is fine —
    // an `env:` entry named PI_WEB_TOKEN is not)…
    expect(templateYml()).not.toMatch(/name:\s*PI_WEB_TOKEN/);
    expect(Object.keys(variables()).some(k => k.includes('PI_WEB_TOKEN'))).toBe(false);
    // …and the entrypoint drops it explicitly, so the property is structural
    // rather than a matter of the pod happening not to pass one.
    expect(entrypoint()).toContain('-u PI_WEB_TOKEN');
  });

  it('whitelists exactly the proxied subdomain as the websocket origin', () => {
    expect(templateYml()).toContain(
      'value: "https://{{CLAUDE_DEV_PI_SUBDOMAIN}}.{{PUBLIC_DOMAIN}}"',
    );
    expect(entrypoint()).toContain('PI_WEB_ALLOW_ORIGINS="$4"');
  });
});

// ─── 2. one model source: local-qwen, no cloud secrets ─────────────────────

describe('#2803 (2): the only model source is the box\'s own local-qwen', () => {
  it('defaults the endpoint to host.containers.internal:18080/v1 (ADR 0007)', () => {
    const def = variables().CLAUDE_DEV_PI_MODEL_BASE_URL?.default;
    expect(def).toBe('http://host.containers.internal:18080/v1');
    // Never the pod's own loopback and never a LAN address — an isolated pod
    // cannot reach the host's LAN IP at all under rootless podman.
    expect(def).not.toMatch(/localhost|127\.0\.0\.1|\{\{LAN_IP\}\}/);
  });

  it('declares no cloud provider credential of any kind', () => {
    const names = Object.keys(variables());
    for (const forbidden of [
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'OPENAI_API_KEY',
      'PI_OAUTH_TOKEN',
    ]) {
      expect(names, `${forbidden} must not ship in this template (#2803 decision 2)`)
        .not.toContain(forbidden);
    }
    // …and none reaches the container through the pod either.
    const yml = templateYml();
    for (const forbidden of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) {
      expect(yml).not.toContain(forbidden);
    }
  });

  it('ships the seeder in the image, not on the writable volume', () => {
    expect(dockerfile()).toContain('COPY pi /usr/local/lib/claude-dev-pi');
    expect(entrypoint()).toContain('PI_SEED_MODELS=/usr/local/lib/claude-dev-pi/seed-models.mjs');
  });
});

describe('#2803 (2): the models.json seeder', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mod: any;
  beforeAll(async () => {
    mod = await import(/* @vite-ignore */ SEEDER);
  });

  const BASE = 'http://host.containers.internal:18080/v1';

  it('writes local-qwen as an OpenAI-compatible provider at the configured endpoint', () => {
    const { config } = mod.mergeLocalQwenProvider(null, { baseUrl: BASE, modelIds: ['qwen'] });
    const p = config.providers['local-qwen'];
    expect(p.baseUrl).toBe(BASE);
    expect(p.api).toBe('openai-completions');
    expect(p.models).toEqual([{ id: 'qwen' }]);
    // llama-server style servers reject the `developer` role / reasoning_effort.
    expect(p.compat).toEqual({ supportsDeveloperRole: false, supportsReasoningEffort: false });
  });

  it('MERGES — a provider the operator added through pi-web-ui survives a restart', () => {
    const existing = {
      providers: {
        'my-own': { baseUrl: 'http://example.test/v1', api: 'openai-completions', models: [{ id: 'x' }] },
      },
      somethingElse: 42,
    };
    const { config, preserved } = mod.mergeLocalQwenProvider(existing, {
      baseUrl: BASE,
      modelIds: ['qwen'],
    });
    expect(config.providers['my-own']).toEqual(existing.providers['my-own']);
    expect(config.somethingElse).toBe(42);
    expect(preserved).toEqual(['my-own']);
  });

  it('re-points an existing local-qwen entry at the configured endpoint (idempotent)', () => {
    const first = mod.mergeLocalQwenProvider(null, { baseUrl: 'http://old.test/v1', modelIds: ['qwen'] });
    const second = mod.mergeLocalQwenProvider(first.config, { baseUrl: BASE, modelIds: ['qwen'] });
    const third = mod.mergeLocalQwenProvider(second.config, { baseUrl: BASE, modelIds: ['qwen'] });
    expect(second.config.providers['local-qwen'].baseUrl).toBe(BASE);
    expect(third.config).toEqual(second.config);
  });

  it('never blanks a working model list when the server could not be asked', () => {
    const { config } = mod.mergeLocalQwenProvider(null, { baseUrl: BASE, modelIds: ['qwen'] });
    const again = mod.mergeLocalQwenProvider(config, { baseUrl: BASE, modelIds: [] });
    expect(again.config.providers['local-qwen'].models).toEqual([{ id: 'qwen' }]);
  });

  it('survives a corrupt or absent models.json instead of throwing the boot over', () => {
    const { config } = mod.mergeLocalQwenProvider('not an object' as unknown as null, {
      baseUrl: BASE,
      modelIds: [],
    });
    expect(config.providers['local-qwen'].baseUrl).toBe(BASE);
  });

  it('discovers model ids from the server rather than guessing one', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'qwen3-coder' }, { id: 'qwen3-4b' }, { nope: true }] }),
    });
    await expect(mod.discoverModelIds(BASE, { fetchImpl })).resolves.toEqual([
      'qwen3-coder',
      'qwen3-4b',
    ]);
  });

  it('treats an unreachable model server as "no ids", not as a boot failure', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    await expect(mod.discoverModelIds(BASE, { fetchImpl })).resolves.toEqual([]);
  });
});

// ─── 3. pi is additive ─────────────────────────────────────────────────────

describe('#2803 (3): the Claude side is untouched', () => {
  it('still installs the Claude Code CLI and ships start-claude', () => {
    expect(dockerfile()).toContain('@anthropic-ai/claude-code');
    expect(dockerfile()).toContain('COPY start-claude.sh /usr/local/bin/start-claude');
    expect(fs.existsSync(path.join(TEMPLATE_DIR, 'start-claude.sh'))).toBe(true);
  });

  it('still autostarts a Claude session per checkout with Remote Control', () => {
    expect(entrypoint()).toContain('autostart_claude');
    expect(read(path.join(TEMPLATE_DIR, 'start-claude.sh'))).toContain('--remote-control');
  });

  it('keeps the SSH port published on every interface — pi did not narrow it', () => {
    const yml = templateYml();
    const ssh = yml.slice(yml.indexOf('containerPort: {{CLAUDE_DEV_SSH_PORT}}'));
    expect(ssh.split('\n').slice(0, 3).join('\n')).not.toContain('hostIP');
  });
});

// ─── the schema hop this change owes ───────────────────────────────────────

describe('#2803: schema-version 4 with a CHANGELOG section and a v3-to-v4 migration', () => {
  it('bumps the schema version', () => {
    expect(templateYml()).toContain('servicebay.schema-version: "4"');
  });

  it('has a CHANGELOG section the re-deploy dialog can show', () => {
    const changelog = read(path.join(TEMPLATE_DIR, 'CHANGELOG.md'));
    expect(changelog).toMatch(/^## v4$/m);
    expect(changelog.indexOf('## v4')).toBeLessThan(changelog.indexOf('## v3'));
  });

  it('keeps the migration chain unbroken', () => {
    const mig = path.join(TEMPLATE_DIR, 'migrations', 'v3-to-v4.py');
    expect(fs.existsSync(mig)).toBe(true);
    // Informational only: nothing on /workspace moves, and it must never be
    // able to fail an operator's re-deploy.
    expect(read(mig)).toContain('return 0');
  });
});
