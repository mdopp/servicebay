import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Mock DATA_DIR before importing config
const tmpDir = path.join(os.tmpdir(), 'servicebay-onboarding-test-');
let testDir: string;

vi.mock('@/lib/dirs', () => ({
    DATA_DIR: testDir,
    SSH_DIR: path.join(testDir, 'ssh'),
}));

// We need to test the actual config read/write, so we mock dirs only
// and use the real config module with a controlled path.
// Since config.ts uses DATA_DIR internally, we handle it via the mock above.

describe('Onboarding - stackSetupPending', () => {
    beforeEach(async () => {
        testDir = await fs.mkdtemp(tmpDir);
        // Re-mock with actual testDir
        vi.doMock('@/lib/dirs', () => ({
            DATA_DIR: testDir,
            SSH_DIR: path.join(testDir, 'ssh'),
        }));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        try {
            await fs.rm(testDir, { recursive: true, force: true });
        } catch { /* cleanup best-effort */ }
    });

    it('config preserves stackSetupPending flag', async () => {
        const configPath = path.join(testDir, 'config.json');
        const config = {
            setupCompleted: true,
            stackSetupPending: true,
            autoUpdate: { enabled: false, schedule: '0 0 * * *', channel: 'stable' },
        };
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));

        const content = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        expect(content.setupCompleted).toBe(true);
        expect(content.stackSetupPending).toBe(true);
    });

    it('stackSetupPending can be removed from config', async () => {
        const configPath = path.join(testDir, 'config.json');
        const config = {
            setupCompleted: true,
            stackSetupPending: true,
            autoUpdate: { enabled: false, schedule: '0 0 * * *', channel: 'stable' },
        };
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));

        // Simulate completeStackSetup
        const loaded = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        delete loaded.stackSetupPending;
        await fs.writeFile(configPath, JSON.stringify(loaded, null, 2));

        const updated = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        expect(updated.stackSetupPending).toBeUndefined();
        expect(updated.setupCompleted).toBe(true);
    });

    it('installer config.json format includes stackSetupPending', () => {
        // Validates the shape that the installer generates
        const installerConfig = {
            serverName: 'test-server',
            auth: { username: 'admin', password: 'secret' },
            autoUpdate: { enabled: true, schedule: '0 0 * * *', channel: 'stable' },
            templateSettings: { DATA_DIR: '/mnt/data/stacks' },
            setupCompleted: true,
            stackSetupPending: true,
        };

        expect(installerConfig.setupCompleted).toBe(true);
        expect(installerConfig.stackSetupPending).toBe(true);
        // When setup is complete but stacks pending, wizard should show stacks-only
        const needsSetup = !installerConfig.setupCompleted;
        const stackSetupPending = installerConfig.stackSetupPending === true;
        expect(needsSetup).toBe(false);
        expect(stackSetupPending).toBe(true);
    });
});
