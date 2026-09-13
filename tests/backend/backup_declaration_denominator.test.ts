/**
 * CLASS GATE A (#2950) — a template whose backup declaration does not resolve
 * stays in the run's DENOMINATOR as a failure. It never leaves the tally.
 *
 * The bug this gate exists for: the nightly run built its service list out of
 * the manifests that RESOLVED (`(await selectInstalledBackupManifests()).map(m
 * => m.service)`). A template with no `servicebay.backup`, an unreadable one,
 * or one every path of which the ADR 0002 checks refuse, produced no manifest —
 * so it never entered `status.results`, so `total = results.length` shrank with
 * it. Numerator and denominator dropped together and the run recorded
 * `success`: "12/12 services backed up" over a set the operator believes has
 * thirteen in it, with one service's config nowhere on the NAS. That is the
 * house failure form — check the denominator — sitting in the one path where
 * you find out about it at restore time.
 *
 * Why the gate is written this way. A test that covers "a parse error" proves
 * one branch and leaves the class open. So the enumeration is DERIVED from the
 * module: `DECLARATION_PROBLEM_CODES` is the code set, every problem in
 * `backupDeclaration.ts` is built through the one `problem(code, …)`
 * constructor, and this file scans the source to prove both — a new failure
 * branch cannot be added without a new code, and a new code cannot be added
 * without a fixture here (the fixture table is a `Record` over the union, so a
 * missing key is a typecheck error).
 *
 * One nuance worth recording. Three codes (`unparseable`, `path_boundary`,
 * `data_subdir_escape`) are producer-side RE-CHECKS: `parseTemplateManifest`
 * already refuses those declarations, so on the real read path the template
 * arrives as "no readable annotation" instead. They stay enumerated because the
 * re-check is the defence for a declaration that reached the runtime by another
 * route (a hand-edited local template, a registry clone updated under us) — and
 * the law under test is the same either way: the template is counted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { mockCfg, mockRegistry, mockWorker, mockNas } = vi.hoisted(() => ({
  mockCfg: { getConfig: vi.fn(), updateConfig: vi.fn() },
  mockRegistry: { getTemplateYaml: vi.fn() },
  mockWorker: {
    runBackupForServices: vi.fn(),
    runBackupForInstalled: vi.fn(),
    readBackupTar: vi.fn(),
    cleanupBackupRun: vi.fn(),
  },
  mockNas: {
    nasUpload: vi.fn(),
    nasList: vi.fn(),
    nasRemove: vi.fn(),
    withNasSession: vi.fn(<T,>(fn: () => Promise<T>): Promise<T> => fn()),
  },
}));
vi.mock('@/lib/config', () => mockCfg);
vi.mock('@/lib/registry', () => mockRegistry);
vi.mock('@/lib/backupWorker/service', () => mockWorker);
vi.mock('@/lib/externalBackup/nasClient', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/externalBackup/nasClient')>()),
  ...mockNas,
}));

import {
  DECLARATION_PROBLEM_CODES,
  resolveTemplateBackupDeclaration,
  unresolvedDeclarationReason,
  type DeclarationProblemCode,
  type TemplateBackupResolution,
} from '@/lib/externalBackup/backupDeclaration';
import { resolveInstalledBackupDeclarations } from '@/lib/externalBackup/templateManifests';
import { backupInstalledServicesToNas } from '@/lib/externalBackup/producer';

const DECLARATION_SOURCE = readFileSync(
  path.resolve(__dirname, '../../packages/backend/src/lib/externalBackup/backupDeclaration.ts'),
  'utf8',
);

const ALL_CODES = Object.keys(DECLARATION_PROBLEM_CODES) as DeclarationProblemCode[];

// ─── A1: the enumeration comes from the module, not from a list kept here ──

describe('CLASS GATE A — the failure reasons are derived from the module (#2950)', () => {
  it('every code in the map is emitted by a branch, and every branch names a code', () => {
    const emitted = new Set(
      [...DECLARATION_SOURCE.matchAll(/\bproblem\(\s*'([a-z_]+)'/g)].map(m => m[1]),
    );
    // Both directions: a code nobody emits is dead weight in the enumeration; a
    // branch emitting a code the map does not carry cannot compile, but the
    // check is cheap and says so out loud.
    expect([...emitted].sort()).toEqual([...ALL_CODES].sort());
  });

  it('funnels EVERY problem through the one constructor, so none can be built without a code', () => {
    // The single place a problem object is constructed.
    expect(DECLARATION_SOURCE.match(/\{ code, message \}/g) ?? []).toHaveLength(1);
    // …so no branch can assemble one inline with a code of its own choosing…
    expect(DECLARATION_SOURCE).not.toMatch(/code:\s*'/);
    // …and no branch can push a bare string (which would carry no code at all).
    expect(DECLARATION_SOURCE).not.toMatch(/problems\.push\(\s*[`'"]/);
  });
});

// ─── A2: for EVERY code, the template does not leave the denominator ───────

describe('CLASS GATE A — no reason lets a template out of the tally (#2950)', () => {
  const resolutionWith = (code: DeclarationProblemCode): TemplateBackupResolution => ({
    manifests: [],
    optOut: null,
    problems: [{ code, message: `probe: ${DECLARATION_PROBLEM_CODES[code]}` }],
  });

  it.each(ALL_CODES)(
    '%s: a template that resolved to nothing for this reason is reported, never treated as fine',
    code => {
      const reason = unresolvedDeclarationReason(resolutionWith(code));
      expect(reason, `"${code}" would let the template leave the denominator`).not.toBeNull();
      expect(reason).toContain(DECLARATION_PROBLEM_CODES[code]);
    },
  );

  it('a resolution that produced nothing and named no reason is STILL reported', () => {
    // The hole the codes cannot cover: no manifests, no opt-out, no problem.
    // "Nothing to say" is not "nothing to back up".
    expect(unresolvedDeclarationReason({ manifests: [], optOut: null, problems: [] })).not.toBeNull();
  });

  it('a deliberate `backup: none` with a reason is NOT a failure', () => {
    const r = resolveTemplateBackupDeclaration('mosquitto', 'backup: none\nreason: Re-rendered every deploy.\n');
    expect(r.optOut).toBe('Re-rendered every deploy.');
    expect(unresolvedDeclarationReason(r)).toBeNull();
  });

  it('a template that lost one path to a clamp but still built a manifest is not a failure', () => {
    const r = resolveTemplateBackupDeclaration('immich', 'include:\n  - upload\n  - config.json\n');
    expect(r.problems.map(p => p.code)).toContain('bulk_clamp');
    expect(r.manifests).toHaveLength(1);
    // Its surviving store IS backed up; the dropped path is reported through
    // `problems` and refused by the CI coverage gate, not by failing the run.
    expect(unresolvedDeclarationReason(r)).toBeNull();
  });
});

// ─── A3: the recorded run counts it ────────────────────────────────────────

/** A template.yml carrying one `servicebay.backup` declaration body. */
function templateYaml(name: string, declaration: string | null): string {
  const annotation = declaration === null
    ? ''
    : `    servicebay.backup: |\n${declaration.trimEnd().split('\n').map(l => `      ${l}`).join('\n')}\n`;
  return [
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    `  name: ${name}`,
    '  annotations:',
    `    servicebay.label: "${name}"`,
    annotation,
    'spec:',
    '  containers:',
    `  - name: ${name}`,
    '    image: docker.io/library/busybox:1',
  ].join('\n');
}

/**
 * One installed template per failure code. Keyed by the union, so a new code
 * added to `DECLARATION_PROBLEM_CODES` fails to TYPECHECK until it has a
 * fixture here — that is what makes the enumeration binding rather than
 * decorative. `declaration: null` means the template carries no annotation.
 *
 * The clamp fixtures must be named `immich`: a store's bulk check resolves the
 * include against the SERVICE's own data root, so `upload` is the multi-GB
 * photo library only under `immich/`.
 */
const FIXTURES: Record<DeclarationProblemCode, { template: string; declaration: string | null }> = {
  no_annotation: { template: 'rogue', declaration: null },
  unparseable: { template: 'rogue', declaration: 'include:\n  - "not\u0000a\u0000path"\n' },
  data_subdir_escape: { template: 'rogue', declaration: 'dataSubdir: ../../etc\ninclude:\n  - x.conf\n' },
  bulk_volume: { template: 'rogue', declaration: 'volume: immich/upload\ninclude:\n  - anything\n' },
  path_boundary: { template: 'rogue', declaration: 'include:\n  - ../../etc/shadow\n' },
  bulk_clamp: { template: 'immich', declaration: 'include:\n  - upload\n  - config.json\n' },
  no_include_survived: { template: 'immich', declaration: 'include:\n  - upload\n' },
};

/** The healthy template every run in this block also has installed. */
const HEALTHY = 'adguard';
const HEALTHY_DECLARATION = 'include:\n  - conf/AdGuardHome.yaml\n';

function armInstalled(templates: Record<string, string | null>): void {
  mockCfg.getConfig.mockResolvedValue({
    installedTemplates: Object.fromEntries(Object.keys(templates).map(t => [t, { version: '1' }])),
  });
  mockRegistry.getTemplateYaml.mockImplementation(async (name: string) =>
    name in templates ? templateYaml(name, templates[name]) : null,
  );
  mockWorker.runBackupForServices.mockImplementation(async (services: string[]) => ({
    exec: vi.fn(),
    run: { runId: 'r', outDir: '/out/r', container: 'backup-worker-r' },
    status: {
      version: 1, runId: 'r', phase: 'done', step: 'done',
      total: services.length, processed: services.length,
      results: services.map(service => ({
        service, ok: true, tarName: `${service}.tar`, bytes: 1, files: 1, outcome: 'ok', detail: null,
      })),
      error: null, updatedAt: 0, startedAt: 0,
    },
  }));
}

const recorded = () => mockCfg.updateConfig.mock.calls.at(-1)?.[0]?.externalBackup;

describe('CLASS GATE A — the recorded total never shrinks (#2950)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCfg.updateConfig.mockResolvedValue({});
    mockNas.nasUpload.mockResolvedValue(undefined);
    mockNas.nasList.mockResolvedValue([]);
    mockNas.nasRemove.mockResolvedValue(undefined);
    mockNas.withNasSession.mockImplementation(<T,>(fn: () => Promise<T>) => fn());
    mockWorker.readBackupTar.mockResolvedValue(Buffer.from('tarbytes'));
    mockWorker.cleanupBackupRun.mockResolvedValue(undefined);
  });

  it.each(ALL_CODES)(
    '%s: the template stays in the recorded total, and is a visible failure when it backs nothing up',
    async code => {
      const { template, declaration } = FIXTURES[code];
      armInstalled({ [HEALTHY]: HEALTHY_DECLARATION, [template]: declaration });

      const resolved = await resolveInstalledBackupDeclarations();
      const results = await backupInstalledServicesToNas();

      // THE LAW: the denominator holds BOTH installed templates. The whole bug
      // was the broken one leaving it and taking its own absence with it.
      expect(recorded().servicesTotal, `the recorded total shrank for reason "${code}"`).toBe(2);
      expect(
        results.map(r => r.service).sort(),
        `"${template}" left the tally for reason "${code}"`,
      ).toEqual([HEALTHY, template].sort());

      // A template that contributed no backing store at all must not leave the
      // run reading as a success — that is the "12/12 · ok" shape itself.
      if (!resolved.manifests.some(m => m.service === template)) {
        expect(recorded().lastStatus).not.toBe('success');
        expect(recorded().servicesUndeclared).toContain(template);
        const entry = results.find(r => r.service === template);
        expect(entry).toMatchObject({ ok: false });
        expect(entry!.error).toMatch(/no backup declaration this run could use/);
      }
    },
  );

  it('a deliberate `backup: none` opt-out does not degrade the run', async () => {
    armInstalled({
      [HEALTHY]: HEALTHY_DECLARATION,
      mosquitto: 'backup: none\nreason: Config is re-rendered on every deploy.\n',
    });

    await backupInstalledServicesToNas();

    // Opted out ⇒ not attempted, not counted, not a failure. This is the line
    // that has to stay drawn: a recorded decision reads differently from a
    // declaration that simply does not resolve.
    expect(recorded()).toMatchObject({ lastStatus: 'success', servicesOk: 1, servicesTotal: 1 });
    expect(recorded().servicesUndeclared).toEqual([]);
  });

  it('separates the opt-outs from the unresolved when it resolves the installed set', async () => {
    armInstalled({
      [HEALTHY]: HEALTHY_DECLARATION,
      mosquitto: 'backup: none\nreason: Stateless.\n',
      rogue: null,
    });

    const declarations = await resolveInstalledBackupDeclarations();

    expect(declarations.manifests.map(m => m.service)).toEqual([HEALTHY]);
    expect(declarations.optedOut).toEqual([{ template: 'mosquitto', reason: 'Stateless.' }]);
    expect(declarations.unresolved.map(u => u.template)).toEqual(['rogue']);
  });

  it('still records the run when EVERY installed template declares nothing', async () => {
    armInstalled({ rogue: null, other: null });

    await backupInstalledServicesToNas();

    // 0/2, not 0/0 — "nothing installed ships a manifest" is a different fact
    // from "two templates never said what to keep".
    expect(recorded()).toMatchObject({ servicesOk: 0, servicesTotal: 2, lastStatus: 'partial' });
    expect(recorded().servicesUndeclared).toEqual(['rogue', 'other']);
    expect(mockWorker.runBackupForServices).not.toHaveBeenCalled();
  });
});
