/**
 * `agent-cli/release-check.mjs` — the repo half of #2995.
 *
 * What is worth pinning here is not that it calls `gh`, but the two judgements
 * it makes on a session's behalf:
 *
 *  1. **`permissions` read without a YAML parser.** The kit carries no
 *     dependency by contract, so this is regexes — and regexes are exactly
 *     where a false verdict hides. `write-all` and a bare `contents: write`
 *     must both satisfy read (write implies read in GitHub's model), or the
 *     tool raises an alarm on a workflow that works, which is worse than
 *     silence.
 *  2. **Exit codes that mean different things.** A session scripting on `$?`
 *     must be able to tell "no workflow at all" from "permissions missing"
 *     from "the run failed" — collapsing them is the ambiguity this whole
 *     ticket is about.
 *
 * The file must also keep the kit's shape: `node:` builtins only, no build, no
 * `--token` flag, no credential ever assembled here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TOOL = path.resolve(__dirname, '..', '..', 'agent-cli', 'release-check.mjs');
const src = fs.readFileSync(TOOL, 'utf8');

const { readPermissions, looksLikeImageBuild, EXIT } = await import(TOOL) as {
  readPermissions: (t: string) => { contentsRead: boolean; packagesWrite: boolean; declared: boolean };
  looksLikeImageBuild: (t: string) => boolean;
  EXIT: Record<string, number>;
};

describe('it keeps the agent kit\'s shape', () => {
  it('runs on plain node — no build, no dependency outside node:', () => {
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec.startsWith('node:')).toBe(true);
  });

  it('never assembles a credential, and offers no flag that would carry one', () => {
    // Everything goes through `gh`, which reads its own stored credential
    // inside its own process. Nothing here can reach /proc/<pid>/cmdline.
    expect(src).not.toMatch(/--token/);
    expect(src).not.toMatch(/Authorization:\s*`?Bearer/);
    expect(src).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
  });

  it('says why it is not a `servicebay` verb, so nobody "fixes" that later', () => {
    expect(src).toContain('ADR 0017');
    expect(src).toContain('agent_cli_mutation_gate');
  });
});

describe('readPermissions — a false alarm is worse than silence', () => {
  const wrap = (perms: string) => `name: build\non:\n  push:\n${perms}jobs:\n  build:\n    runs-on: ubuntu-latest\n`;

  it('accepts the pair the create-service recipe ships', () => {
    const r = readPermissions(wrap('permissions:\n  contents: read\n  packages: write\n'));
    expect(r).toMatchObject({ contentsRead: true, packagesWrite: true, declared: true });
  });

  it('treats `contents: write` as satisfying read — write implies read', () => {
    const r = readPermissions(wrap('permissions:\n  contents: write\n  packages: write\n'));
    expect(r.contentsRead).toBe(true);
  });

  it('treats `permissions: write-all` as satisfying both', () => {
    const r = readPermissions(wrap('permissions: write-all\n'));
    expect(r).toMatchObject({ contentsRead: true, packagesWrite: true, declared: true });
  });

  it('catches the exact shape that broke the asteroids build: no block at all', () => {
    const r = readPermissions('name: build\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n');
    expect(r).toMatchObject({ contentsRead: false, packagesWrite: false, declared: false });
  });

  it('catches a block that declares packages but forgets contents', () => {
    // The half-right shape: the push would work, the checkout of a PRIVATE
    // repo fails first with "Repository not found".
    const r = readPermissions(wrap('permissions:\n  packages: write\n'));
    expect(r).toMatchObject({ contentsRead: false, packagesWrite: true, declared: true });
  });

  it('reads a job-level block, not only a top-level one', () => {
    const r = readPermissions(
      'name: build\njobs:\n  build:\n    permissions:\n      contents: read\n      packages: write\n',
    );
    expect(r).toMatchObject({ contentsRead: true, packagesWrite: true });
  });

  it('does not accept `contents: none` as read', () => {
    const r = readPermissions(wrap('permissions:\n  contents: none\n  packages: write\n'));
    expect(r.contentsRead).toBe(false);
  });
});

describe('looksLikeImageBuild finds the release workflow, loosely on purpose', () => {
  it.each([
    'uses: docker/build-push-action@v6',
    'run: podman build -t x .',
    'run: docker build .',
    'images: ghcr.io/mdopp/asteroids',
    'uses: redhat-actions/buildah-build@v2',
  ])('recognises %s', (line) => {
    expect(looksLikeImageBuild(`jobs:\n  build:\n    steps:\n      - ${line}\n`)).toBe(true);
  });

  it('does not mistake a test-only workflow for a release path', () => {
    expect(looksLikeImageBuild('jobs:\n  test:\n    steps:\n      - run: npm test\n')).toBe(false);
  });
});

describe('the exit codes stay distinct — that IS the feature', () => {
  it('every named outcome has its own number', () => {
    const codes = Object.values(EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('success is 0 and every failure is not', () => {
    expect(EXIT.ok).toBe(0);
    for (const [name, code] of Object.entries(EXIT)) {
      if (name !== 'ok') expect(code, name).not.toBe(0);
    }
  });

  it('the three a session must tell apart are not the same number', () => {
    expect(EXIT.noWorkflow).not.toBe(EXIT.permissions);
    expect(EXIT.permissions).not.toBe(EXIT.runFailed);
    expect(EXIT.noWorkflow).not.toBe(EXIT.runFailed);
  });

  it('documents each code in the header, so --help and reality agree', () => {
    for (const name of ['noGh', 'noWorkflow', 'permissions', 'runFailed', 'noRun']) {
      expect(src).toMatch(new RegExp(`\\b${EXIT[name]}\\b`));
    }
  });
});
