/**
 * Rename a service + edit its unit `Description=` (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`. A rename is a four-step dance on
 * the node — stop the old unit, move the pod spec, rewrite the `.kube`'s
 * `Yaml=` reference, enable the new unit — and is the reason `ServiceManager`
 * has to stay the single mutation path: doing any of the four out of order
 * leaves two units generating the same `<name>.service`.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import { agentManager } from '../../agent/manager';
import { logger } from '../../logger';
import { reloadDaemon } from './units';
import {
    SYSTEMD_DIR,
    backupQuadlets,
    extractFileContent,
    refreshAgent,
    writeFile,
} from './quadletFiles';

export async function renameService(nodeName: string, oldName: string, newName: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    const oldKubePath = `~/${SYSTEMD_DIR}/${oldName}.kube`;
    const newKubePath = `~/${SYSTEMD_DIR}/${newName}.kube`;

    // Check if new service already exists
    const checkRes = await agent.sendCommand('exec', { command: `test -f ${newKubePath} && echo exists` });
    if (checkRes.stdout?.trim() === 'exists') {
        throw new Error(`Service ${newName} already exists`);
    }

    // Read old kube file
    const rawContent = await agent.sendCommand('read_file', { path: oldKubePath });
    const content = extractFileContent(rawContent);
    if (!content) throw new Error(`Could not read ${oldName}.kube`);

    const yamlMatch = content.match(/Yaml=(.+)/);
    const oldYamlFile = yamlMatch ? yamlMatch[1].trim() : null;
    if (!oldYamlFile) throw new Error('Could not determine YAML file from .kube file');

    const oldYamlPath = oldYamlFile.startsWith('/') ? oldYamlFile : `~/${SYSTEMD_DIR}/${oldYamlFile}`;
    const newYamlFile = `${newName}.yml`;
    const newYamlPath = `~/${SYSTEMD_DIR}/${newYamlFile}`;

    // 1. Stop old service
    try {
        await agent.sendCommand('exec', { command: `systemctl --user disable --now ${oldName}.service` });
    } catch (e) {
        logger.warn('ServiceManager', 'Failed to stop old service', e);
    }

    // 2. Rename YAML file
    const mvRes = await agent.sendCommand('exec', { command: `mv ${oldYamlPath} ${newYamlPath}` });
    if (mvRes.code !== 0) throw new Error(`Failed to rename YAML file: ${mvRes.stderr}`);

    // 3. Write new kube file with updated Yaml= reference, then remove old
    const newKubeContent = content.replace(/Yaml=.+/, `Yaml=${newYamlFile}`);
    await writeFile(nodeName, `${newName}.kube`, newKubeContent);
    await agent.sendCommand('exec', { command: `rm -f ${oldKubePath}` });

    // 4. Reload and start
    await reloadDaemon(nodeName);
    try {
        await agent.sendCommand('exec', { command: `systemctl --user enable --now ${newName}.service` });
    } catch (e) {
        throw new Error(`Failed to start new service: ${e}`);
    }

    await refreshAgent(nodeName);
    backupQuadlets(nodeName);
}

export async function updateServiceDescription(nodeName: string, serviceName: string, description: string) {
    const agent = await agentManager.ensureAgent(nodeName);
    const kubePath = `~/${SYSTEMD_DIR}/${serviceName}.kube`;

    const raw = await agent.sendCommand('read_file', { path: kubePath });
    let content = extractFileContent(raw);
    const lines = content.split('\n');
    let unitIndex = -1;
    let descIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '[Unit]') {
            unitIndex = i;
        } else if (unitIndex !== -1 && line.startsWith('[') && line.endsWith(']')) {
            break;
        } else if (unitIndex !== -1 && line.startsWith('Description=')) {
            descIndex = i;
        }
    }

    if (unitIndex === -1) {
        content = `[Unit]\nDescription=${description}\n\n${content}`;
    } else if (descIndex !== -1) {
        lines[descIndex] = `Description=${description}`;
        content = lines.join('\n');
    } else {
        lines.splice(unitIndex + 1, 0, `Description=${description}`);
        content = lines.join('\n');
    }

    await writeFile(nodeName, `${serviceName}.kube`, content);
    await reloadDaemon(nodeName);
}
