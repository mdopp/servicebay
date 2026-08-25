import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * #2590 — the deploy path must honour `servicebay.seed-only-configs`.
 *
 * The unit-level guard lives in `serviceLifecycle.writeExtraConfigFiles.test.ts`.
 * THIS file covers the seam that actually failed on the owner's box: the guard
 * exists but nothing tells the deploy which files it protects. It drives
 * `deployKubeService` with the REAL `templates/home-assistant/template.yml`, so
 * a fix that lands only in the write helper — or a template that stops
 * declaring the annotation — fails here.
 */

const mockSendCommand = vi.fn();
vi.mock('../agent/manager', () => ({
    agentManager: {
        ensureAgent: async () => ({ sendCommand: mockSendCommand }),
    },
}));
// The deploy path snapshots history and reads config; neither is under test.
vi.mock('../history', () => ({ saveSnapshot: vi.fn() }));

import { ServiceLifecycle } from './serviceLifecycle';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const HA_TEMPLATE = path.join(REPO_ROOT, 'templates', 'home-assistant', 'template.yml');

/** The shipped manifest with `{{VAR}}` placeholders substituted, i.e. what a
 *  real deploy hands to `deployKubeService`. */
function renderedHomeAssistantYaml(): string {
    return fs.readFileSync(HA_TEMPLATE, 'utf-8').replace(/\{\{[^}]*\}\}/g, 'x');
}

const HA_CONFIG_DIR = '/mnt/data/stacks/home-assistant/homeassistant';

/** Every companion file the HA template ships, as the runner assembles them. */
const EXTRA_FILES = [
    { path: `${HA_CONFIG_DIR}/configuration.yaml`, content: '# rendered base config\n' },
    { path: `${HA_CONFIG_DIR}/automations.yaml`, content: '# seed\n[]\n' },
    { path: `${HA_CONFIG_DIR}/scenes.yaml`, content: '# seed\n[]\n' },
    { path: `${HA_CONFIG_DIR}/scripts.yaml`, content: '# seed\n{}\n' },
];

/**
 * Agent stub. `filesOnBox` decides what `test -e` reports; everything else
 * answers the generic success shape the deploy path expects.
 */
function stubAgent(filesOnBox: Set<string>) {
    mockSendCommand.mockImplementation(async (action: string, params?: { command?: string; path?: string }) => {
        if (action === 'write_file') return 'ok';
        if (action === 'read_file') return { content: '' };
        const command = params?.command ?? '';
        const probe = /^test -e (\S+) &&/.exec(command);
        if (probe) {
            return { code: 0, stdout: filesOnBox.has(probe[1]) ? 'sb-present\n' : 'sb-absent\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    });
}

/** Paths the deploy asked the agent to write. */
function writtenPaths(): string[] {
    return mockSendCommand.mock.calls
        .filter(([action]) => action === 'write_file')
        .map(([, params]) => (params as { path: string }).path);
}

async function deployHomeAssistant() {
    await ServiceLifecycle.deployKubeService(
        'Local',
        'home-assistant',
        '[Kube]\nYaml=home-assistant.yml\n',
        renderedHomeAssistantYaml(),
        'home-assistant.yml',
        EXTRA_FILES,
    );
}

describe('deployKubeService honours servicebay.seed-only-configs (#2590)', () => {
    beforeEach(() => {
        mockSendCommand.mockReset();
    });

    it('leaves a populated automations.yaml alone on a redeploy/convergence pass', async () => {
        // The incident: the operator's 11 automations (6729 B) were replaced by
        // the 324 B seed by a routine convergence pass, silently.
        stubAgent(new Set(EXTRA_FILES.map(f => f.path)));

        await deployHomeAssistant();

        const written = writtenPaths();
        expect(written).not.toContain(`${HA_CONFIG_DIR}/automations.yaml`);
        expect(written).not.toContain(`${HA_CONFIG_DIR}/scenes.yaml`);
        expect(written).not.toContain(`${HA_CONFIG_DIR}/scripts.yaml`);
    });

    it('still seeds all three include targets on a first install', async () => {
        stubAgent(new Set());

        await deployHomeAssistant();

        const written = writtenPaths();
        expect(written).toContain(`${HA_CONFIG_DIR}/automations.yaml`);
        expect(written).toContain(`${HA_CONFIG_DIR}/scenes.yaml`);
        expect(written).toContain(`${HA_CONFIG_DIR}/scripts.yaml`);
    });

    it('leaves an existing configuration.yaml alone on a redeploy (#2597)', async () => {
        // The file's header always promised "edit freely — re-deploys don't
        // overwrite" while every deploy re-rendered it, so an operator's
        // `sensor:` / `mqtt:` / `logger:` block was silently discarded.
        stubAgent(new Set(EXTRA_FILES.map(f => f.path)));

        await deployHomeAssistant();

        expect(writtenPaths()).not.toContain(`${HA_CONFIG_DIR}/configuration.yaml`);
    });

    it('still seeds configuration.yaml on a first install (#2597)', async () => {
        stubAgent(new Set());

        await deployHomeAssistant();

        expect(writtenPaths()).toContain(`${HA_CONFIG_DIR}/configuration.yaml`);
    });

    it('protects every config file the shipped template declares', () => {
        // Pins template ↔ code: the promise in the mustache headers ("ServiceBay
        // only seeds it on first install") is now carried by an annotation
        // the deploy path reads, not by prose.
        const yamlText = fs.readFileSync(HA_TEMPLATE, 'utf-8');
        expect(yamlText).toMatch(
            /servicebay\.seed-only-configs:\s*"automations\.yaml,scenes\.yaml,scripts\.yaml,configuration\.yaml"/,
        );
    });
});
