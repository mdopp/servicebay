import { describe, it, expect, vi, beforeEach } from 'vitest';
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

            return { code: 0, stdout: '' };
        }),
    };
    return agent;
}

const CFG = '/mnt/data/home-assistant/homeassistant/configuration.yaml';
const DIR = '/mnt/data/home-assistant/homeassistant';

describe('runHomeAssistantHook (#1687 config-survival self-heal)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('re-adds http: + the 3 includes after a restore brought back a bare user config', async () => {
        // Simulate a restored user configuration.yaml: user content, but none
        // of ServiceBay's wiring and no automation/script/scene includes.
        const agent = makeHaAgent({ [CFG]: 'default_config:\n\nfrontend:\n' });

        await ServiceLifecycle.runHomeAssistantHook(agent as never, CFG);

        const out = agent.files[CFG];
        expect(out).toContain('frontend:');                 // user content preserved
        expect(out).toMatch(/^http:/m);                     // trusted_proxies re-added
        expect(out).toContain('use_x_forwarded_for: true');
        expect(out).toMatch(/^automation: !include automations\.yaml$/m);
        expect(out).toMatch(/^script: !include scripts\.yaml$/m);
        expect(out).toMatch(/^scene: !include scenes\.yaml$/m);

        // The include target files were seeded empty so the includes don't dangle.
        expect(agent.files[`${DIR}/automations.yaml`]).toBe('[]\n');
        expect(agent.files[`${DIR}/scripts.yaml`]).toBe('{}\n');
        expect(agent.files[`${DIR}/scenes.yaml`]).toBe('[]\n');
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
});
