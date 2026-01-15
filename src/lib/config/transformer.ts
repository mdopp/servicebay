import fs from 'fs/promises';
import path from 'path';
import { logger } from '../logger';

interface JsonRecord {
    [key: string]: unknown;
}

type ConfigTransform = {
    name: string;
    run: (config: JsonRecord) => boolean;
};

const renameExternalLinkTargets: ConfigTransform = {
    name: 'external-links-ipTargets',
    run: (config) => {
        const links = config.externalLinks;
        if (!Array.isArray(links)) return false;

        let changed = false;
        links.forEach(link => {
            if (!link || typeof link !== 'object') return;
            const linkRecord = link as JsonRecord;
            if ('ip_targets' in linkRecord) {
                // Only promote legacy value when the camelCase version is missing
                if (linkRecord.ipTargets === undefined) {
                    linkRecord.ipTargets = linkRecord.ip_targets;
                }
                delete linkRecord.ip_targets;
                changed = true;
            }
        });
        return changed;
    }
};

const transforms: ConfigTransform[] = [renameExternalLinkTargets];

export class ConfigTransformer {
    constructor(private readonly configPath: string) {}

    async run(): Promise<boolean> {
        try {
            await fs.access(this.configPath);
        } catch {
            // Nothing to transform if the config does not exist yet
            return false;
        }

        let rawContent: string;
        try {
            rawContent = await fs.readFile(this.configPath, 'utf-8');
        } catch (error) {
            logger.warn('ConfigTransformer', `Failed to read config at ${this.configPath}`, error);
            return false;
        }

        let configData: JsonRecord;
        try {
            configData = JSON.parse(rawContent);
        } catch (error) {
            logger.warn('ConfigTransformer', 'Config file is not valid JSON; skipping transformation', error);
            return false;
        }

        let modified = false;
        for (const transform of transforms) {
            try {
                if (transform.run(configData)) {
                    modified = true;
                    logger.info('ConfigTransformer', `Applied ${transform.name}`);
                }
            } catch (error) {
                logger.warn('ConfigTransformer', `Transform ${transform.name} failed`, error);
            }
        }

        if (!modified) {
            return false;
        }

        await this.createBackup();
        await fs.writeFile(this.configPath, JSON.stringify(configData, null, 2));
        logger.info('ConfigTransformer', `Config normalized at ${this.configPath}`);
        return true;
    }

    private async createBackup() {
        const timestamp = new Date().toISOString().replace(/[:]/g, '-');
        const backupName = `${path.basename(this.configPath)}.${timestamp}.bak`;
        const backupPath = path.join(path.dirname(this.configPath), backupName);
        await fs.copyFile(this.configPath, backupPath);
        logger.info('ConfigTransformer', `Backup written to ${backupPath}`);
    }
}
