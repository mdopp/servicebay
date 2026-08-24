import { describe, it, expect, vi, beforeEach } from 'vitest';

// runPreStartHooks resolves the agent itself; the rest of this file passes a
// fake agent in directly and is unaffected by the mock.
const ensureAgentMock = vi.fn();
vi.mock('../agent/manager', () => ({
    agentManager: { ensureAgent: (...args: unknown[]) => ensureAgentMock(...args) },
}));

import { ServiceLifecycle } from './serviceLifecycle';

vi.mock('../logger', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

type Params = { command?: string } | undefined;

/**
 * Fake agent that simulates a host `configuration.yaml` against which the
 * HA self-heal hook (#1687) runs shell commands. We interpret the handful of
 * commands the hook issues (`test -f`, `grep -E '^key'`, the `cat >> heredoc`
 * append, and the `test -f file || printf > file` include-seed) so the test
 * asserts the resulting file content, not just the command strings.
 */
function makeHaAgent(initialFiles: Record<string, string>) {
    const files: Record<string, string> = { ...initialFiles };
    const calls: string[] = [];
    const agent = {
        files,
        calls,
        sendCommand: vi.fn(async (_action: string, params?: unknown) => {
            const cmd = (params as Params)?.command ?? '';
            calls.push(cmd);

            // test -f <path> && echo yes
            let m = cmd.match(/^test -f (\S+) && echo yes$/);
            if (m) return { code: 0, stdout: files[m[1]] !== undefined ? 'yes' : '' };

            // grep -E '^key' <path> || echo MISSING
            m = cmd.match(/^grep -E '\^([^']+)' (\S+) \|\| echo MISSING$/);
            if (m) {
                const [, pattern, path] = m;
                const body = files[path] ?? '';
                const re = new RegExp('^' + pattern, 'm');
                return { code: 0, stdout: re.test(body) ? 'match' : 'MISSING' };
            }

            // cat >> <path> <<'EOF'\n<block>\nEOF
            m = cmd.match(/^cat >> (\S+) <<'EOF'\n([\s\S]*)\nEOF$/);
            if (m) {
                const [, path, block] = m;
                files[path] = (files[path] ?? '') + block + '\n';
                return { code: 0 };
            }

            // test -f <file> || printf '%s\n' '<seed>' > <file>
            m = cmd.match(/^test -f (\S+) \|\| printf '%s\\n' '([^']*)' > (\S+)$/);
            if (m) {
                const [, testPath, seed, outPath] = m;
                if (files[testPath] === undefined) files[outPath] = seed + '\n';
                return { code: 0 };
            }

            // cat <path> 2>/dev/null || echo MISSING  (integrity-guard reads)
            m = cmd.match(/^cat (\S+) 2>\/dev\/null \|\| echo MISSING$/);
            if (m) {
                const body = files[m[1]];
                return { code: 0, stdout: body !== undefined ? body : 'MISSING' };
            }

            return { code: 0, stdout: '' };
        }),
    };
    return agent;
}

const CFG = '/mnt/data/home-assistant/homeassistant/configuration.yaml';
const DIR = '/mnt/data/home-assistant/homeassistant';

describe('runHomeAssistantHook (#1687 config-survival self-heal)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('re-adds the 3 includes after a restore brought back a bare user config', async () => {
        // Simulate a restored user configuration.yaml: user content, but none
        // of ServiceBay's wiring and no automation/script/scene includes.
        const agent = makeHaAgent({ [CFG]: 'default_config:\n\nfrontend:\n' });

        await ServiceLifecycle.runHomeAssistantHook(agent as never, CFG);

        const out = agent.files[CFG];
        expect(out).toContain('frontend:');                 // user content preserved
        expect(out).toMatch(/^automation: !include automations\.yaml$/m);
        expect(out).toMatch(/^script: !include scripts\.yaml$/m);
        expect(out).toMatch(/^scene: !include scenes\.yaml$/m);

        // The include target files were seeded empty so the includes don't dangle.
        expect(agent.files[`${DIR}/automations.yaml`]).toBe('[]\n');
        expect(agent.files[`${DIR}/scripts.yaml`]).toBe('{}\n');
        expect(agent.files[`${DIR}/scenes.yaml`]).toBe('[]\n');
    });

    it('#2573: never writes an http: block — HA 2026.8 owns that setting now', async () => {
        // Same bare restored config as above. Before #2573 this hook appended a
        // trusted_proxies block on every deploy, which re-triggered HA's
        // "HTTP YAML configuration is ignored after migration" repair issue
        // however often the operator removed it. The hook runs BEFORE HA
        // starts, so it cannot tell which HA era the box is on; the trust list
        // is post-deploy.py's job now.
        const agent = makeHaAgent({ [CFG]: 'default_config:\n\nfrontend:\n' });

        await ServiceLifecycle.runHomeAssistantHook(agent as never, CFG);

        expect(agent.files[CFG]).not.toMatch(/^http:/m);
        expect(agent.files[CFG]).not.toContain('use_x_forwarded_for');
        expect(agent.files[CFG]).not.toContain('trusted_proxies');
        // …and it never even probed for the key, so no command can re-add it.
        expect(agent.calls.some((c) => c.includes("grep -E '^http:'"))).toBe(false);
    });

    it('#2573: leaves an operator/legacy http: block in place — removal is post-deploy.py\'s call', async () => {
        // The hook must not delete it either: only a running HA can confirm the
        // setting has been migrated into `.storage/http` first.
        const withHttp = 'default_config:\n\nhttp:\n  use_x_forwarded_for: true\n';
        const agent = makeHaAgent({ [CFG]: withHttp });

        await ServiceLifecycle.runHomeAssistantHook(agent as never, CFG);

        expect(agent.files[CFG]).toContain('http:');
        expect(agent.files[CFG]).toContain('use_x_forwarded_for: true');
    });

    it('is idempotent: a config that already has everything is left untouched', async () => {
        const full = [
            'default_config:',
            'automation: !include automations.yaml',
            'script: !include scripts.yaml',
            'scene: !include scenes.yaml',
            'http:',
            '  use_x_forwarded_for: true',
            '',
        ].join('\n');
        const agent = makeHaAgent({
            [CFG]: full,
            // include targets already restored with real content — must NOT be clobbered.
            [`${DIR}/automations.yaml`]: '- id: real\n',
        });

        await ServiceLifecycle.runHomeAssistantHook(agent as never, CFG);

        expect(agent.files[CFG]).toBe(full);
        expect(agent.files[`${DIR}/automations.yaml`]).toBe('- id: real\n');
    });

    it('does nothing on a first install where configuration.yaml does not exist yet', async () => {
        const agent = makeHaAgent({});
        await ServiceLifecycle.runHomeAssistantHook(agent as never, CFG);
        // Only the existence probe ran; no append/seed.
        expect(agent.calls).toEqual([`test -f ${CFG} && echo yes`]);
        expect(agent.files[CFG]).toBeUndefined();
    });

    const REGISTRY = `${DIR}/.storage/core.entity_registry`;
    const fullCfg = [
        'default_config:',
        'automation: !include automations.yaml',
        'script: !include scripts.yaml',
        'scene: !include scenes.yaml',
        'http:',
        '  use_x_forwarded_for: true',
        '',
    ].join('\n');

    it('#1864: ABORTS loudly when the registry lists automations but automations.yaml is empty', async () => {
        const agent = makeHaAgent({
            [CFG]: fullCfg,
            // Registry remembers 2 automations…
            [REGISTRY]: JSON.stringify({
                data: {
                    entities: [
                        { platform: 'automation', entity_id: 'automation.morning' },
                        { platform: 'automation', entity_id: 'automation.night' },
                        { platform: 'sun', entity_id: 'sun.sun' },
                    ],
                },
            }),
            // …but the file was emptied (the incident).
            [`${DIR}/automations.yaml`]: '[]',
            [`${DIR}/scripts.yaml`]: '{}',
            [`${DIR}/scenes.yaml`]: '[]',
        });

        await expect(ServiceLifecycle.runHomeAssistantHook(agent as never, CFG)).rejects.toThrow(
            /integrity check FAILED/i,
        );
        // The guard must NOT mutate the emptied file.
        expect(agent.files[`${DIR}/automations.yaml`]).toBe('[]');
    });

    it('#1864: passes silently when registry counts match the populated config files', async () => {
        const agent = makeHaAgent({
            [CFG]: fullCfg,
            [REGISTRY]: JSON.stringify({
                data: { entities: [{ platform: 'automation', entity_id: 'automation.morning' }] },
            }),
            [`${DIR}/automations.yaml`]: '- id: morning\n  alias: Morning\n',
            [`${DIR}/scripts.yaml`]: '{}',
            [`${DIR}/scenes.yaml`]: '[]',
        });

        await expect(
            ServiceLifecycle.runHomeAssistantHook(agent as never, CFG),
        ).resolves.toBeUndefined();
    });

    it('#1864: does not raise when there is no entity registry yet', async () => {
        const agent = makeHaAgent({
            [CFG]: fullCfg,
            [`${DIR}/automations.yaml`]: '[]',
        });
        await expect(
            ServiceLifecycle.runHomeAssistantHook(agent as never, CFG),
        ).resolves.toBeUndefined();
    });
});

/**
 * #2590 — `runPreStartHooks` wraps every hook in a catch-all that logs at
 * `debug` and lets the deploy continue. That is right for an incidental hook
 * failure and WRONG for the #1864 integrity guard, whose only job is to refuse
 * the deploy: on the owner's box the guard's condition was live for eight
 * consecutive diagnose runs while deploys kept sailing through.
 */
describe('runPreStartHooks — a refusing guard must abort the deploy (#2590)', () => {
    const HA_POD = `
apiVersion: v1
kind: Pod
metadata:
  name: home-assistant
spec:
  containers:
    - name: homeassistant
      image: ghcr.io/home-assistant/home-assistant:stable
      volumeMounts:
        - mountPath: /config
          name: ha-config
  volumes:
    - name: ha-config
      hostPath:
        path: ${DIR}
`;

    const REGISTRY = `${DIR}/.storage/core.entity_registry`;

    /** `runPreStartHooks` is private; production reaches it through deploy. */
    const runPreStartHooks = (yamlContent: string) =>
        (ServiceLifecycle as unknown as {
            runPreStartHooks(node: string, name: string, yaml: string): Promise<void>;
        }).runPreStartHooks('Local', 'home-assistant', yamlContent);

    beforeEach(() => {
        vi.clearAllMocks();
        ensureAgentMock.mockReset();
    });

    it('propagates the integrity refusal instead of swallowing it', async () => {
        const agent = makeHaAgent({
            [CFG]: 'default_config:\nautomation: !include automations.yaml\nscript: !include scripts.yaml\nscene: !include scenes.yaml\n',
            [REGISTRY]: JSON.stringify({
                data: { entities: [{ platform: 'automation', entity_id: 'automation.morning' }] },
            }),
            [`${DIR}/automations.yaml`]: '[]',
            [`${DIR}/scripts.yaml`]: '{}',
            [`${DIR}/scenes.yaml`]: '[]',
        });
        ensureAgentMock.mockResolvedValue(agent);

        await expect(runPreStartHooks(HA_POD)).rejects.toThrow(/integrity check FAILED/i);
    });

    it('still swallows an ordinary hook failure (unchanged behaviour)', async () => {
        ensureAgentMock.mockRejectedValue(new Error('agent unreachable'));
        await expect(runPreStartHooks(HA_POD)).resolves.toBeUndefined();
    });

    it('still swallows unparseable pod yaml (unchanged behaviour)', async () => {
        await expect(runPreStartHooks('::: not yaml :::')).resolves.toBeUndefined();
    });
});
