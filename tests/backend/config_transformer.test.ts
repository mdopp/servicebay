import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ConfigTransformer } from '@/lib/config/transformer';

const createTempDir = async () => {
    const prefix = path.join(os.tmpdir(), 'servicebay-config-transformer-');
    return fs.mkdtemp(prefix);
};

describe('ConfigTransformer', () => {
    let tmpDir: string;
    let configPath: string;

    beforeEach(async () => {
        tmpDir = await createTempDir();
        configPath = path.join(tmpDir, 'config.json');
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('renames legacy ip_targets fields and writes a backup', async () => {
        const legacyConfig = {
            externalLinks: [
                { id: 'legacy', name: 'Legacy', url: 'https://example.com', ip_targets: ['10.0.0.1:80'] }
            ]
        };
        await fs.writeFile(configPath, JSON.stringify(legacyConfig, null, 2));

        const transformer = new ConfigTransformer(configPath);
        const changed = await transformer.run();

        expect(changed).toBe(true);
        const updated = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        expect(updated.externalLinks[0].ipTargets).toEqual(['10.0.0.1:80']);
        expect(updated.externalLinks[0].ip_targets).toBeUndefined();

        const files = await fs.readdir(tmpDir);
        const backup = files.find(file => file.startsWith('config.json.') && file.endsWith('.bak'));
        expect(backup).toBeDefined();
    });

    it('skips transformation when no legacy data is present', async () => {
        const config = {
            externalLinks: [
                { id: 'modern', name: 'Modern', url: 'https://modern.example.com', ipTargets: ['192.168.1.2:443'] }
            ]
        };
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));

        const transformer = new ConfigTransformer(configPath);
        const changed = await transformer.run();

        expect(changed).toBe(false);
        const updated = JSON.parse(await fs.readFile(configPath, 'utf-8'));
        expect(updated).toEqual(config);

        const files = await fs.readdir(tmpDir);
        const backupCount = files.filter(file => file.endsWith('.bak')).length;
        expect(backupCount).toBe(0);
    });
});
