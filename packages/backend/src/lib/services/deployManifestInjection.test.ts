import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * #2928 — caller-supplied pod-manifest fields must never reach a shell.
 *
 * The bug: `preStartHooks.chownContainerMounts` built
 * `podman unshare chown -R ${uid}:${gid} ${hostPath}` as a *command string*
 * and handed it to the agent's legacy `exec`, while `podSchema` let
 * `securityContext` through as `z.object({}).passthrough()` and constrained
 * `hostPath.path` only with `startsWith('/')`. `validatePodManifest` was
 * called from the two HTTP routes and nowhere else, so the MCP tools
 * (`deploy_service`, `update_service_yaml`) reached `deployKubeService`
 * in-process with no validation at all. Net effect: a `mutate`-scoped
 * principal got command execution as the agent user — a direct defeat of the
 * mutate-vs-exec scope split of #591/#2623.
 *
 * This file gates the CLASS, not the one crafted path, on three axes:
 *
 *   A. Dynamic taint sweep. Drive the REAL `deployKubeService` over each
 *      branch of the deploy path with a manifest whose every caller-supplied
 *      field carries a marker, and assert the marker appears in no `exec`
 *      command string — only in `safe_exec` argv entries and `write_file`
 *      payloads. Adding a new shell sink that interpolates a manifest field
 *      fails this test on the day it is written.
 *   B. Static backstop for the code the sweep cannot reach. Every `command:`
 *      template literal in the two manifest-consuming lifecycle modules is
 *      parsed and each `${…}` interpolation must be on a named allow-list of
 *      non-manifest expressions.
 *   C. Refusal at the choke point, table-driven over the injectable fields,
 *      asserting the MCP sink (`ServiceLifecycle.deployKubeService`) throws
 *      and nothing at all reaches the agent.
 *
 * Honest limit of the machine proof: axis A covers the branches a deploy
 * actually walks (ordinary pod, the FileBrowser DB seed, the Home Assistant
 * self-heal, the `.container` GPU shadow reconcile). It does NOT cover
 * template-supplied `post-deploy.py` / migration script bodies, which are
 * executed as scripts by design and are a different trust surface (the
 * template author, not the manifest writer). Axis B is what stands in for
 * unexercised code inside the two manifest-consuming modules.
 */

const mockSendCommand = vi.fn();
const mockPullImage = vi.fn(async () => undefined);
vi.mock('../agent/manager', () => ({
    agentManager: {
        ensureAgent: async () => ({ sendCommand: mockSendCommand, pullImage: mockPullImage }),
    },
}));
vi.mock('../history', () => ({ saveSnapshot: vi.fn() }));

import { ServiceLifecycle } from './serviceLifecycle';
import { validatePodManifest } from './podSchema';

// ── The marker ───────────────────────────────────────────────────────────────
//
// Every marker is *schema-legal*, so the manifest sails through validation and
// the sweep tests the argv plumbing rather than the refusal (axis C tests the
// refusal). `31337`/`31338` stand in for the numeric fields.
const MARK = /sbtaint/i;
const TAINT_UID = 31337;
const TAINT_GID = 31338;
const TAINT_HOSTPATH = '/mnt/sbtaint-hostpath';
const SERVICE = 'spike';
const GENERATED_KUBE = `[Kube]\nYaml=${SERVICE}.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;

function taintedPod(opts: { image: string; mountPath: string }): string {
    return [
        'apiVersion: v1',
        'kind: Pod',
        'metadata:',
        '  name: sbtaint-podname',
        '  labels:',
        '    app: sbtaint-label',
        '  annotations:',
        '    servicebay.label: "sbtaint annotation"',
        'spec:',
        '  containers:',
        '  - name: sbtaint-container',
        `    image: ${opts.image}`,
        '    securityContext:',
        `      runAsUser: ${TAINT_UID}`,
        `      runAsGroup: ${TAINT_GID}`,
        '    env:',
        '    - name: SBTAINT_KEY',
        '      value: sbtaint-envvalue',
        '    volumeMounts:',
        '    - name: sbtaint-volume',
        `      mountPath: ${opts.mountPath}`,
        '  volumes:',
        '  - name: sbtaint-volume',
        '    hostPath:',
        `      path: ${TAINT_HOSTPATH}`,
        '      type: DirectoryOrCreate',
        '',
    ].join('\n');
}

// ── The fake node ────────────────────────────────────────────────────────────

interface StubOptions {
    /** Host files that exist, path → content. */
    files?: Record<string, string>;
    /** Simulate a `.container` Quadlet on disk (the #2174 shadow reconcile). */
    containerQuadletPresent?: boolean;
}

function stubAgent(opts: StubOptions = {}): void {
    const files = opts.files ?? {};
    mockSendCommand.mockImplementation(async (action: string, params?: Record<string, unknown>) => {
        if (action === 'write_file') return 'ok';
        if (action === 'read_file') return { content: '' };
        if (action === 'safe_exec') {
            const argv = (params?.argv as string[] | undefined) ?? [];
            if (argv[0] === 'test' && argv[1] === '-f') {
                return { code: files[argv[2]] !== undefined ? 0 : 1, stdout: '', stderr: '' };
            }
            if (argv[0] === 'cat') {
                const body = files[argv[1]];
                return body === undefined
                    ? { code: 1, stdout: '', stderr: 'No such file' }
                    : { code: 0, stdout: body, stderr: '' };
            }
            return { code: 0, stdout: '', stderr: '' };
        }
        if (action === 'exec') {
            const cmd = String(params?.command ?? '');
            if (/\.container /.test(cmd) || cmd.includes('.container &&')) {
                return { code: 0, stdout: opts.containerQuadletPresent ? 'present' : 'absent', stderr: '' };
            }
            return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    });
}

/** Every legacy shell command string the deploy sent to the node. */
function shellCommands(): string[] {
    return mockSendCommand.mock.calls
        .filter(([action]) => action === 'exec' || action === 'exec_stream')
        .map(([, params]) => String((params as { command?: unknown } | undefined)?.command ?? ''));
}

/** Every structured argv the deploy sent to the node. */
function argvCalls(): string[][] {
    return mockSendCommand.mock.calls
        .filter(([action]) => action === 'safe_exec')
        .map(([, params]) => ((params as { argv?: string[] } | undefined)?.argv ?? []));
}

function writeFileCalls(): { path: string; content: string }[] {
    return mockSendCommand.mock.calls
        .filter(([action]) => action === 'write_file')
        .map(([, params]) => {
            const p = params as { path?: unknown; content?: unknown } | undefined;
            return { path: String(p?.path ?? ''), content: String(p?.content ?? '') };
        });
}

/** Does this string carry any of the manifest markers? */
function isTainted(s: string): boolean {
    return MARK.test(s) || s.includes(String(TAINT_UID)) || s.includes(String(TAINT_GID));
}

async function deploy(podYaml: string): Promise<void> {
    await ServiceLifecycle.deployKubeService(
        'Local', SERVICE, GENERATED_KUBE, podYaml, `${SERVICE}.yml`,
    );
}

// ── Axis A: the dynamic taint sweep ──────────────────────────────────────────

const HA_CFG = `${TAINT_HOSTPATH}/configuration.yaml`;

const SWEEP_BRANCHES: {
    label: string;
    image: string;
    mountPath: string;
    stub?: StubOptions;
}[] = [
    {
        label: 'an ordinary pod (the volume-ownership fixup)',
        image: 'ghcr.io/sbtaint-org/app:sbtaint-tag',
        mountPath: '/data',
    },
    {
        label: 'the FileBrowser DB seed hook',
        image: 'docker.io/sbtaint-org/filebrowser:sbtaint-tag',
        mountPath: '/database',
    },
    {
        label: 'the Home Assistant configuration.yaml self-heal hook',
        image: 'ghcr.io/sbtaint-org/home-assistant:sbtaint-tag',
        mountPath: '/config',
        stub: { files: { [HA_CFG]: 'default_config:\n' } },
    },
    {
        label: 'the .container GPU shadow reconcile (#2174 force-recreate)',
        image: 'ghcr.io/sbtaint-org/llama:sbtaint-tag',
        mountPath: '/data',
        stub: { containerQuadletPresent: true },
    },
];

describe('#2928 axis A — no manifest field reaches a shell command string on the deploy path', () => {
    beforeEach(() => {
        mockSendCommand.mockReset();
        mockPullImage.mockClear();
    });

    for (const branch of SWEEP_BRANCHES) {
        it(`keeps every tainted field out of every exec command string: ${branch.label}`, async () => {
            stubAgent(branch.stub);
            await deploy(taintedPod({ image: branch.image, mountPath: branch.mountPath }));

            const leaked = shellCommands().filter(isTainted);
            expect(leaked).toEqual([]);
        });

        it(`still carries the tainted fields to the node structurally: ${branch.label}`, async () => {
            // The denominator. Without this, the assertion above would pass
            // just as happily on a deploy that did nothing at all.
            stubAgent(branch.stub);
            await deploy(taintedPod({ image: branch.image, mountPath: branch.mountPath }));

            const structural = [
                ...argvCalls().filter(argv => argv.some(isTainted)),
                ...writeFileCalls().filter(w => isTainted(w.path) || isTainted(w.content)),
            ];
            expect(structural.length).toBeGreaterThan(0);
            // …and the node was actually driven, not short-circuited.
            expect(shellCommands().length).toBeGreaterThan(0);
        });
    }

    it('argv-passes the ownership fixup itself — uid, gid and hostPath are three arguments', async () => {
        stubAgent();
        await deploy(taintedPod({ image: 'ghcr.io/sbtaint-org/app:sbtaint-tag', mountPath: '/data' }));

        const chown = argvCalls().find(argv => argv[0] === 'podman' && argv[1] === 'unshare');
        expect(chown).toEqual([
            'podman', 'unshare', 'chown', '-R', `${TAINT_UID}:${TAINT_GID}`, TAINT_HOSTPATH,
        ]);
    });

    it('argv-passes the .container force-remove — the container name is one argument', async () => {
        stubAgent({ containerQuadletPresent: true });
        await deploy(taintedPod({ image: 'ghcr.io/sbtaint-org/llama:sbtaint-tag', mountPath: '/data' }));

        const removals = argvCalls().filter(argv => argv[0] === 'podman' && argv[1] === 'rm');
        expect(removals.length).toBeGreaterThan(0);
        for (const argv of removals) {
            expect(argv.slice(0, 3)).toEqual(['podman', 'rm', '-f']);
            expect(argv).toHaveLength(4);
        }
        // The manifest-derived names DID reach it (denominator again).
        expect(removals.some(argv => MARK.test(argv[3]))).toBe(true);
    });
});

// ── Axis B: the static backstop ──────────────────────────────────────────────
//
// The sweep can only assert about branches it walks. These two modules are the
// ones that read the caller's manifest, so every legacy `exec` command string
// they still build is enumerated here and each interpolation must be a named,
// non-manifest expression. A new `${somethingFromTheManifest}` in either file
// fails this test even if no test drives that line.

const LIFECYCLE_DIR = path.resolve(__dirname, 'lifecycle');

/**
 * Interpolations allowed inside a legacy `exec` command string in these
 * modules. Each is either a compile-time constant, the service name (which
 * every caller validates with the `ServiceName`/DNS-1123 schema before it gets
 * here), a filename the tool schema constrains, or a value explicitly gated by
 * `isSafeShellName` at the call site.
 */
const NON_MANIFEST_EXPRESSIONS = new Set([
    'SYSTEMD_DIR',                              // module constant
    'name',                                     // the service name — ServiceName-validated
    'trashDestArg',                             // built from TRASH_DIR + service name
    'trashEntryArg(shadowId)',                  // ditto
    'shellPath(`${SYSTEMD_DIR}/${name}.kube`)', // ditto
    'shellPath(`${SYSTEMD_DIR}/${yamlName}`)',  // yamlName — QuadletFileName-validated
    'containerName',                            // read off the on-disk unit, isSafeShellName-gated
    'imageRef',                                 // read off the on-disk unit, isSafeShellName-gated
]);

/**
 * `command: \`…\`` template literals, with their top-level `${…}` expressions.
 *
 * Hand-rolled rather than regexed because these literals nest: `mv -f
 * ${shellPath(\`${SYSTEMD_DIR}/${name}.kube\`)} …` is one command literal whose
 * single top-level interpolation is the whole `shellPath(…)` call. A regex that
 * stops at the first inner backtick reports garbage.
 */
function execCommandLiterals(source: string): { literal: string; expressions: string[] }[] {
    const out: { literal: string; expressions: string[] }[] = [];
    const re = /command:\s*`/g;
    while (re.exec(source) !== null) {
        let i = re.lastIndex;
        let literal = '';
        const expressions: string[] = [];
        while (i < source.length && source[i] !== '`') {
            if (source[i] === '\\') { literal += source.slice(i, i + 2); i += 2; continue; }
            if (source[i] === '$' && source[i + 1] === '{') {
                // Consume the interpolation, tracking brace depth and any
                // nested template literal inside it.
                let depth = 0;
                let j = i + 1;
                let inTick = false;
                for (; j < source.length; j++) {
                    const c = source[j];
                    if (c === '\\') { j++; continue; }
                    if (c === '`') { inTick = !inTick; continue; }
                    if (inTick) continue;
                    if (c === '{') depth++;
                    else if (c === '}') { depth--; if (depth === 0) break; }
                }
                expressions.push(source.slice(i + 2, j));
                literal += `\${${source.slice(i + 2, j)}}`;
                i = j + 1;
                continue;
            }
            literal += source[i];
            i++;
        }
        out.push({ literal, expressions });
        re.lastIndex = i + 1;
    }
    return out;
}

describe('#2928 axis B — the manifest-consuming lifecycle modules build no manifest-derived shell string', () => {
    it('preStartHooks.ts sends no legacy `exec` at all — it is entirely argv/write_file now', () => {
        const src = fs.readFileSync(path.join(LIFECYCLE_DIR, 'preStartHooks.ts'), 'utf-8');
        // This module reads hostPath.path, runAsUser/runAsGroup and image on
        // every deploy. It has no business holding a shell open.
        expect(src.includes("sendCommand('exec'")).toBe(false);
        expect(src.includes('sendCommand("exec"')).toBe(false);
    });

    it('every `exec` command literal in containerQuadlet.ts interpolates only named non-manifest expressions', () => {
        const src = fs.readFileSync(path.join(LIFECYCLE_DIR, 'containerQuadlet.ts'), 'utf-8');
        const literals = execCommandLiterals(src);
        // Denominator: this module DOES still build shell strings, so a
        // vacuous pass would be a lie.
        expect(literals.length).toBeGreaterThan(0);

        const offenders = literals.flatMap(({ literal, expressions }) =>
            expressions
                .filter(e => !NON_MANIFEST_EXPRESSIONS.has(e))
                .map(e => `\${${e}} in \`${literal}\``),
        );
        expect(offenders).toEqual([]);
    });

    it('the two isSafeShellName gates the allow-list leans on are still there', () => {
        // `containerName` and `imageRef` are allow-listed *because* they are
        // gated. If the gate goes, the allow-list entry is a lie.
        const src = fs.readFileSync(path.join(LIFECYCLE_DIR, 'containerQuadlet.ts'), 'utf-8');
        expect(src).toContain('if (!isSafeShellName(containerName))');
        expect(src).toContain('if (isSafeShellName(imageRef))');
    });

    it('no `command:` in those modules hides behind a variable the scan cannot read', () => {
        for (const file of ['preStartHooks.ts', 'containerQuadlet.ts']) {
            const src = fs.readFileSync(path.join(LIFECYCLE_DIR, file), 'utf-8');
            const heads = [...src.matchAll(/command:\s*(\S)/g)].map(m => m[1]);
            for (const head of heads) {
                expect(['`', "'", '"']).toContain(head);
            }
        }
    });
});

// ── Axis C: refusal at the choke point, on the MCP path ──────────────────────

function podWith(fields: { hostPath?: string; runAsUser?: string; runAsGroup?: string }): string {
    return [
        'apiVersion: v1',
        'kind: Pod',
        'metadata:',
        '  name: victim',
        'spec:',
        '  containers:',
        '  - name: app',
        '    image: docker.io/library/nginx:latest',
        '    securityContext:',
        `      runAsUser: ${fields.runAsUser ?? '1000'}`,
        `      runAsGroup: ${fields.runAsGroup ?? '1000'}`,
        '    volumeMounts:',
        '    - name: data',
        '      mountPath: /data',
        '  volumes:',
        '  - name: data',
        '    hostPath:',
        `      path: ${fields.hostPath ?? '/mnt/data/victim'}`,
        '',
    ].join('\n');
}

const INJECTION_VECTORS: { field: string; yaml: string }[] = [
    { field: 'hostPath.path — command separator', yaml: podWith({ hostPath: '"/mnt/data/x; touch /tmp/pwn"' }) },
    { field: 'hostPath.path — command substitution', yaml: podWith({ hostPath: '"/mnt/data/$(id)"' }) },
    { field: 'hostPath.path — backtick substitution', yaml: podWith({ hostPath: '"/mnt/data/`id`"' }) },
    { field: 'hostPath.path — pipe', yaml: podWith({ hostPath: '"/mnt/data/x | id"' }) },
    { field: 'hostPath.path — redirection', yaml: podWith({ hostPath: '"/mnt/data/x > /etc/passwd"' }) },
    { field: 'hostPath.path — embedded newline', yaml: podWith({ hostPath: '"/mnt/data/x\\ntouch /tmp/pwn"' }) },
    { field: 'hostPath.path — tilde expansion', yaml: podWith({ hostPath: '"/mnt/data/~/x"' }) },
    { field: 'securityContext.runAsUser — string with a separator', yaml: podWith({ runAsUser: '"0; touch /tmp/pwn"' }) },
    { field: 'securityContext.runAsUser — string with a substitution', yaml: podWith({ runAsUser: '"$(id -u)"' }) },
    { field: 'securityContext.runAsGroup — string with a separator', yaml: podWith({ runAsGroup: '"0; touch /tmp/pwn"' }) },
    { field: 'securityContext.runAsUser — negative', yaml: podWith({ runAsUser: '-1' }) },
    { field: 'securityContext.runAsUser — fractional', yaml: podWith({ runAsUser: '1.5' }) },
];

describe('#2928 axis C — a crafted manifest is refused at the deploy choke point, not only in the HTTP routes', () => {
    beforeEach(() => {
        mockSendCommand.mockReset();
        stubAgent();
    });

    for (const vector of INJECTION_VECTORS) {
        it(`refuses ${vector.field}`, async () => {
            expect(validatePodManifest(vector.yaml).ok).toBe(false);

            // `deployKubeService` is the in-process sink BOTH MCP tools call
            // (`deploy_service` → serviceTools.ts, `update_service_yaml` →
            // serviceTools.ts). Refusing here is what closes the MCP path.
            await expect(deploy(vector.yaml)).rejects.toThrow(/Invalid Pod manifest/);

            // And nothing at all reached the node: no write, no exec, no argv.
            expect(mockSendCommand).not.toHaveBeenCalled();
        });
    }

    it('the MCP tools have no second sink that bypasses the choke point', () => {
        // `deploy_service` and `update_service_yaml` may only reach the node
        // through `deployKubeService` (validated above) or
        // `deployContainerQuadlet` (a `.container` unit body — not a pod
        // manifest, and it only ever writes a file). A third sink would be a
        // way around the validation.
        const src = fs.readFileSync(
            path.resolve(__dirname, '..', 'mcp', 'tools', 'serviceTools.ts'), 'utf-8',
        );
        const sinks = [...src.matchAll(/ServiceManager\.(deploy\w+|saveService)\(/g)].map(m => m[1]);
        expect(new Set(sinks)).toEqual(new Set(['deployKubeService', 'deployContainerQuadlet']));
    });
});

// ── Criterion 4: the common case must still deploy ───────────────────────────

describe('#2928 — an ordinary template still deploys (the regression this fix must not cause)', () => {
    // The exact shape the issue names as the trigger: a non-zero runAsUser and
    // a writable volumeMount. That is most of the catalog, so a fix that
    // hardens the path and breaks this is worse than the bug.
    const ORDINARY_POD = [
        'apiVersion: v1',
        'kind: Pod',
        'metadata:',
        '  name: jellyfin',
        '  annotations:',
        '    servicebay.label: "Media"',
        'spec:',
        '  hostNetwork: true',
        '  containers:',
        '  - name: jellyfin',
        '    image: docker.io/jellyfin/jellyfin:latest',
        '    securityContext:',
        '      runAsUser: 1000',
        '      runAsGroup: 1000',
        '    ports:',
        '    - containerPort: 8096',
        '    volumeMounts:',
        '    - name: config',
        '      mountPath: /config',
        '    - name: media',
        '      mountPath: /media',
        '      readOnly: true',
        '  volumes:',
        '  - name: config',
        '    hostPath:',
        '      path: /mnt/data/media/jellyfin-config',
        '      type: DirectoryOrCreate',
        '  - name: media',
        '    hostPath:',
        '      path: /mnt/data/file-share/data/My Media',
        '      type: Directory',
        '',
    ].join('\n');

    beforeEach(() => {
        mockSendCommand.mockReset();
        stubAgent();
    });

    it('validates', () => {
        expect(validatePodManifest(ORDINARY_POD)).toEqual({ ok: true });
    });

    it('deploys: the Quadlet unit and the pod spec both land on the node', async () => {
        await deploy(ORDINARY_POD);
        const written = writeFileCalls().map(w => w.path);
        expect(written).toContain(`~/.config/containers/systemd/${SERVICE}.kube`);
        expect(written).toContain(`~/.config/containers/systemd/${SERVICE}.yml`);
    });

    it('still fixes ownership of the writable mount, and still leaves the read-only one alone', async () => {
        await deploy(ORDINARY_POD);
        const chowns = argvCalls().filter(a => a[0] === 'podman' && a[1] === 'unshare');
        expect(chowns).toEqual([
            ['podman', 'unshare', 'chown', '-R', '1000:1000', '/mnt/data/media/jellyfin-config'],
        ]);
    });

    it('accepts a hostPath with a space — the deny-list must not over-reach', () => {
        // `/mnt/data/file-share/data/My Media` is in the pod above and is a
        // perfectly ordinary operator path. Argv-passing is what makes it safe;
        // refusing it would break real installs for no security gain.
        const r = validatePodManifest(ORDINARY_POD);
        expect(r.ok).toBe(true);
    });
});

describe('#2928 — the shipped template catalog still passes the new field constraints', () => {
    const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'templates');

    function templateFiles(): { name: string; content: string }[] {
        return fs.readdirSync(TEMPLATES_DIR)
            .filter(n => fs.statSync(path.join(TEMPLATES_DIR, n)).isDirectory())
            .map(n => ({ name: n, content: fs.readFileSync(path.join(TEMPLATES_DIR, n, 'template.yml'), 'utf-8') }))
            .filter(t => t.content.includes('kind: Pod'));
    }

    /** Substitute Mustache placeholders with a plausible rendered value. */
    function render(value: string): string {
        return value.replace(/\{\{\{?\s*[A-Z0-9_]+\s*\}?\}\}/g, '/mnt/data/rendered');
    }

    function minimalPodWithHostPath(p: string): string {
        return [
            'apiVersion: v1', 'kind: Pod',
            'metadata:', '  name: probe',
            'spec:', '  containers:', '  - name: app',
            '    image: docker.io/library/nginx:latest',
            '    volumeMounts:', '    - name: data', '      mountPath: /data',
            '  volumes:', '  - name: data', '    hostPath:', `      path: ${JSON.stringify(p)}`,
            '',
        ].join('\n');
    }

    it('every hostPath.path a shipped template declares is still accepted', () => {
        const rejected: string[] = [];
        let checked = 0;
        for (const t of templateFiles()) {
            for (const m of t.content.matchAll(/hostPath:\s*\n\s*path:\s*(.+)/g)) {
                const raw = m[1].trim().replace(/^["']|["']$/g, '');
                const rendered = render(raw);
                checked++;
                const r = validatePodManifest(minimalPodWithHostPath(rendered));
                if (!r.ok) rejected.push(`${t.name}: ${raw} → ${rendered} (${r.error?.message})`);
            }
        }
        expect(checked).toBeGreaterThan(10); // denominator
        expect(rejected).toEqual([]);
    });

    it('every runAsUser/runAsGroup a shipped template declares is a plain integer', () => {
        const bad: string[] = [];
        let checked = 0;
        for (const t of templateFiles()) {
            for (const m of t.content.matchAll(/^\s*runAs(?:User|Group):\s*(\S+)\s*$/gm)) {
                checked++;
                if (!/^\d+$/.test(m[1])) bad.push(`${t.name}: ${m[0]}`);
            }
        }
        expect(checked).toBeGreaterThan(0); // denominator
        expect(bad).toEqual([]);
    });
});
