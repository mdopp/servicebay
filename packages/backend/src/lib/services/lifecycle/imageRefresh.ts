/**
 * Image refresh + stop/start cycle for an already-installed service (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`: the pod-spec image walker (also
 * used by `forceUpdate.ts`, #2397 — one walker, two callers, so the force
 * update can't drift from what the restart path pulls) and the
 * `updateAndRestartService` sequence behind the dashboard's Update button.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import yaml from 'js-yaml';
import { agentManager } from '../../agent/manager';
import { logger } from '../../logger';
import { ServiceListing } from '../serviceListing';
import { reloadDaemon } from './units';
import { extractFileContent } from './quadletFiles';

/**
 * Walk a parsed kube/pod YAML doc and collect every `image:` field
 * reachable through `containers[]`, `initContainers[]`, `spec`, and
 * `template`. Used by `updateAndRestartService` to know which images
 * to pull before restarting the unit.
 *
 * Returns a deduped Set so callers can iterate without re-pulling
 * the same image twice if it appears in both initContainers and
 * containers.
 *
 * Exported for `forceUpdate.ts` (#2397), which needs the same
 * pod-spec → image-refs answer for the operator-triggered force
 * update. One walker, two callers — the force-update path must not
 * drift from what the restart path pulls.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectImagesFromKubeYaml(parsed: any): Set<string> {
    const images = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (obj: any) => {
        if (!obj) return;
        if (obj.image && typeof obj.image === 'string') images.add(obj.image);
        if (Array.isArray(obj.containers)) obj.containers.forEach(walk);
        if (Array.isArray(obj.initContainers)) obj.initContainers.forEach(walk);
        if (obj.spec) walk(obj.spec);
        if (obj.template) walk(obj.template);
    };
    walk(parsed);
    return images;
}

/**
 * Parse `yamlContent` as a kube/pod doc, pull every referenced image
 * via `agent.pullImage`, and append human-readable progress lines to
 * `logs`. Used by `updateAndRestartService` so the parent method
 * stays focused on the start/stop dance.
 *
 * Failures (YAML parse error, per-image pull failure) are caught
 * here — the caller continues with the restart sequence even if an
 * image refresh missed, matching the prior in-line behavior.
 */
async function pullServiceImagesFromYaml(
    agent: import('../../agent/handler').AgentHandler,
    yamlContent: string,
    logs: string[]
): Promise<void> {
    let images: Set<string>;
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = yaml.load(yamlContent) as any;
        images = collectImagesFromKubeYaml(parsed);
    } catch (e) {
        logger.warn('ServiceManager', 'Error parsing YAML for images', e);
        logs.push('Error parsing YAML to find images.');
        return;
    }
    for (const image of images) {
        logs.push(`Pulling image: ${image}`);
        try {
            await agent.pullImage(image, (evt) => {
                if (evt.status && evt.id) {
                    const pct = evt.total ? ` ${Math.round((evt.current || 0) / evt.total * 100)}%` : '';
                    logs.push(`  ${evt.id}: ${evt.status}${pct}`);
                }
            });
            logs.push(`Successfully pulled ${image}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logs.push(`Failed to pull ${image}: ${msg}`);
        }
    }
}

export async function updateAndRestartService(nodeName: string, serviceName: string): Promise<{ logs: string[]; status: string }> {
    const agent = await agentManager.ensureAgent(nodeName);
    const { yamlPath } = await ServiceListing.getServiceFiles(nodeName, serviceName);
    const logs: string[] = [];

    if (yamlPath) {
        const res = await agent.sendCommand('read_file', { path: yamlPath.startsWith('/') ? yamlPath : `~/${yamlPath}` });
        const content = extractFileContent(res);
        await pullServiceImagesFromYaml(agent, content, logs);
    } else {
        logs.push('No YAML file found for this service.');
    }

    logs.push('Reloading systemd daemon...');
    await reloadDaemon(nodeName);

    const unit = serviceName.endsWith('.service') ? serviceName : `${serviceName}.service`;
    logs.push(`Stopping service ${unit}...`);
    try { await agent.sendCommand('exec', { command: `systemctl --user --no-block stop ${unit}` }); } catch { /* ok */ }

    logs.push(`Starting service ${unit}...`);
    try {
        await agent.sendCommand('exec', { command: `systemctl --user --no-block start ${unit}` });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logs.push(`Error starting service: ${msg}`);
    }

    const status = await ServiceListing.getServiceStatus(nodeName, serviceName);
    return { logs, status };
}
