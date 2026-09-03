/**
 * Quadlet file I/O on the node (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`: reading/writing the
 * `~/.config/containers/systemd` unit files, the raw single-file
 * deploy/remove/save entry points, the RAID-side quadlet backup and the
 * agent refresh. Everything that touches the *files* a service is made of,
 * with no template or capability knowledge.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import { agentManager } from '../../agent/manager';
import { logger } from '../../logger';
import { getConfig } from '../../config';
import { saveSnapshot } from '../../history';
import { ServiceListing } from '../serviceListing';
import { ensurePodmanSocket, reloadDaemon } from './units';

export const SYSTEMD_DIR = '.config/containers/systemd';

/** Extract string content from agent read_file response. */
export function extractFileContent(res: unknown): string {
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && 'content' in res && typeof (res as { content: unknown }).content === 'string') {
        return (res as { content: string }).content;
    }
    return '';
}

/**
 * Read a quadlet/pod file currently on the node, or `null` if it isn't
 * there yet (first install). Best-effort: any read error → `null`, so
 * the caller treats it as "no prior content" and the deploy proceeds.
 */
export async function readExistingQuadletFile(nodeName: string, filename: string): Promise<string | null> {
    try {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('read_file', {
            path: `~/${SYSTEMD_DIR}/${filename}`,
        });
        if (typeof res === 'string') return res;
        if (res && typeof res === 'object' && 'content' in res) {
            const c = (res as { content?: unknown }).content;
            return typeof c === 'string' ? c : null;
        }
        return null;
    } catch {
        return null;
    }
}

export async function writeFile(nodeName: string, filename: string, content: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    const targetPath = `~/.config/containers/systemd/${filename}`;
    const res = await agent.sendCommand('write_file', { path: targetPath, content });
    if (res !== "ok") throw new Error('Failed to write ' + filename);
}

/** Backup Quadlet files to data directory (survives OS reinstall).
 *  Note: nginx config already lives on DATA_DIR (RAID) and needs no extra backup here.
 *  It is included in the downloadable full system backup (systemBackup.ts). */
export async function backupQuadlets(nodeName: string) {
    try {
        const config = await getConfig();
        const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data';
        const backupDir = `${dataDir}/servicebay/quadlet-backup`;
        const quadletDir = '$HOME/.config/containers/systemd';
        const agent = await agentManager.ensureAgent(nodeName);
        await agent.sendCommand('exec', {
            command: `mkdir -p ${backupDir} && rsync -a --delete --include='*.kube' --include='*.yml' --include='*.container' --exclude='*' ${quadletDir}/ ${backupDir}/ 2>/dev/null || true`
        });
        logger.info('ServiceManager', `Quadlet backup synced for ${nodeName}`);
    } catch (e) {
        logger.debug('ServiceManager', 'Quadlet backup skipped:', e);
    }
}

/** Trigger an agent refresh so the Digital Twin picks up changes immediately */
export async function refreshAgent(nodeName: string) {
    try {
        const agent = await agentManager.ensureAgent(nodeName);
        await agent.sendCommand('refresh');
    } catch { /* agent may not be connected */ }
}

export async function deployService(nodeName: string, filename: string, content: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    const targetPath = `~/.config/containers/systemd/${filename}`;

    // agent.py "write_file" returns "ok"
    const res = await agent.sendCommand('write_file', { path: targetPath, content });
    if (res !== "ok") {
        throw new Error('Failed to write service file');
    }

    await ensurePodmanSocket(nodeName);
    await reloadDaemon(nodeName);
    backupQuadlets(nodeName);
}

export async function removeService(nodeName: string, filename: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    // Use variable to avoid quoting issues
    const cmd = `
        f="$HOME/.config/containers/systemd/${filename}"
        if [ -f "$f" ]; then rm -f "$f"; fi
        `;
    const res = await agent.sendCommand('exec', { command: cmd });
    if (res.code !== 0) throw new Error(res.stderr);

    await reloadDaemon(nodeName);
    backupQuadlets(nodeName);
}

export async function saveService(nodeName: string, serviceName: string, kubeContent: string, yamlContent: string, yamlFileName: string) {
    // Save snapshots of existing files before overwriting
    try {
        const existing = await ServiceListing.getServiceFiles(nodeName, serviceName);
        if (existing.kubeContent) await saveSnapshot(`${serviceName}.kube`, existing.kubeContent);
        if (existing.yamlContent) await saveSnapshot(yamlFileName, existing.yamlContent);
    } catch { /* ignore if new file */ }

    await writeFile(nodeName, `${serviceName}.kube`, kubeContent);
    await writeFile(nodeName, yamlFileName, yamlContent);
    await reloadDaemon(nodeName);
    await refreshAgent(nodeName);
    backupQuadlets(nodeName);
}
