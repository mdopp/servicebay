/**
 * Template migration scripts + pre-rename predecessor cleanup (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`. Runs BEFORE the new pod spec
 * lands, and is fail-fast on purpose: a migration transforms on-disk data the
 * new container shape depends on.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import { logger } from '../../logger';
import { agentManager } from '../../agent/manager';
import { getConfig, updateConfig } from '../../config';
import { SYSTEMD_DIR } from './quadletFiles';
import { deleteService } from './trash';

/**
 * Stacks that were renamed or merged at some point. Mapping: new name →
 * the OLD systemd-unit names whose quadlet files should be soft-deleted
 * before re-deploy.
 *
 * Without this, an in-place upgrade from a pre-rename release leaves
 * orphan `<old>.kube` units running alongside the new merged pod. The
 * wizard surfaces them as restart-looping ghosts (because the *new* pod
 * grabs the host ports the old one wanted) and the operator has to
 * clean up by hand. The trashed predecessor files are recoverable from
 * `~/.config/containers/systemd/.trash/` for 7 days, so this is safe.
 */
export const STACK_MIGRATIONS: Record<string, string[]> = {
    'auth':           ['authelia', 'lldap'],
    'media':          ['audiobookshelf', 'navidrome'],
    'home-assistant': ['home-assistant-stack'],
    'file-share':     ['filebrowser'],
    // D19-PR2 (#259) renamed `nginx` → `nginx`. Existing
    // installs that ran the old template have a `nginx.kube`
    // unit on disk; deploying the new `nginx` template trashes
    // the predecessor so the host ports are free.
    'nginx': ['nginx-web'],
};

export async function migratePredecessors(
    nodeName: string,
    newName: string,
    onProgress?: (message: string) => void,
): Promise<void> {
    const predecessors = STACK_MIGRATIONS[newName] ?? [];
    if (predecessors.length === 0) return;
    const agent = await agentManager.ensureAgent(nodeName);
    for (const old of predecessors) {
        // Cheap existence check — if the kube unit isn't on disk there's
        // nothing to migrate. Skip silently to keep fresh-install logs clean.
        const check = await agent.sendCommand('exec', {
            command: `test -f ~/${SYSTEMD_DIR}/${old}.kube && echo present || echo absent`,
        });
        if ((check.stdout || '').trim() !== 'present') continue;
        onProgress?.(`Migrating predecessor: soft-deleting ${old} (replaced by ${newName})`);
        logger.info('ServiceManager', `Soft-deleting predecessor "${old}" before deploying "${newName}"`);
        try {
            // No capability events: this is a rename-in-place, not an
            // uninstall. The successor's own `feature.installed` owns the
            // OIDC client / proxy host / firewall rule the predecessor
            // registered, and tearing them down mid-migration would only
            // race the re-registration (#2541).
            await deleteService(nodeName, old, { emitCapabilityEvents: false });
        } catch (e) {
            // Non-fatal — if the old unit can't be cleaned, the deploy
            // below either succeeds (different ports / pod name) or
            // fails loudly via the port-collision pre-flight.
            logger.warn('ServiceManager', `Failed to soft-delete predecessor ${old}:`, e);
        }
    }
}

/**
 * Build migration script env file content with SB metadata.
 */
async function buildMigrationEnvLines(
    nodeName: string,
    script: { fromVersion: number; toVersion: number },
    env: Record<string, string>,
): Promise<string> {
    const sbPort = process.env.PORT || '5888';
    const sbApiUrl = `http://localhost:${sbPort}`;
    const { getInternalApiToken } = await import('@/lib/auth/internalToken');
    const sbApiToken = getInternalApiToken();
    const dataDir = env.DATA_DIR || env.NEW_DATA_DIR || '/mnt/data';
    const envLines = [
        `SB_NODE=${nodeName}`,
        `SB_API_URL=${sbApiUrl}`,
        `SB_API_TOKEN=${sbApiToken}`,
        `OLD_DATA_DIR=${env.OLD_DATA_DIR || dataDir}`,
        `NEW_DATA_DIR=${env.NEW_DATA_DIR || dataDir}`,
        `OLD_SCHEMA_VERSION=${script.fromVersion}`,
        `NEW_SCHEMA_VERSION=${script.toVersion}`,
        ...Object.entries(env).map(([k, v]) => {
            if (k === 'OLD_DATA_DIR' || k === 'NEW_DATA_DIR' || k === 'OLD_SCHEMA_VERSION' || k === 'NEW_SCHEMA_VERSION') return null;
            if (typeof v !== 'string') return null;
            const esc = v.replace(/'/g, `'\\''`);
            return `${k}='${esc}'`;
        }).filter((l): l is string => l !== null),
    ].join('\n');
    return envLines;
}

/**
 * Persist migration audit to config.
 */
async function persistMigrationAudit(
    serviceName: string,
    script: { filename: string; fromVersion: number; toVersion: number },
    result: { code: number; stdout: string },
): Promise<void> {
    try {
        const cfg = await getConfig();
        const existing = cfg.serviceMigrations?.[serviceName] ?? [];
        const stdoutTail = (result.stdout ?? '').slice(-1024) || undefined;
        const next = [
            {
                ranAt: new Date().toISOString(),
                fromVersion: script.fromVersion,
                toVersion: script.toVersion,
                exitCode: result.code,
                stdoutTail,
            },
            ...existing,
        ].slice(0, 20);
        await updateConfig({
            serviceMigrations: {
                ...(cfg.serviceMigrations ?? {}),
                [serviceName]: next,
            },
        });
    } catch (e) {
        logger.warn('ServiceManager', `Could not persist migration audit for ${serviceName} ${script.filename}:`, e);
    }
}

/**
 * Execute a migration script and stream output.
 */
async function executeMigrationScript(
    agent: import('../../agent/handler').AgentHandler,
    scriptPath: string,
    envPath: string,
    onProgress?: (message: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
    let streamed = false;
    let result: { code: number; stdout: string; stderr: string };
    try {
        result = await agent.sendCommand(
            'exec_stream',
            {
                command: `set -a; source ${envPath}; set +a; python3 ${scriptPath} 2>&1`,
                timeout: 1200,
            },
            {
                timeoutMs: 1_200_000,
                onChunk: (line: string) => {
                    streamed = true;
                    if (line.length > 0) onProgress?.(line);
                },
            },
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/exec_stream|Unknown|action/i.test(msg)) {
            result = await agent.sendCommand('exec', {
                command: `set -a; source ${envPath}; set +a; python3 ${scriptPath} 2>&1`,
                timeout: 1200,
            }, { timeoutMs: 1_200_000 });
        } else {
            throw e;
        }
    }
    if (!streamed) {
        const stdout = (result.stdout || '').replace(/\r/g, '');
        for (const line of stdout.split('\n')) {
            if (line.length > 0) onProgress?.(line);
        }
    }
    return result;
}

/**
 * Run a single template migration script on the host (#352 phase 3).
 *
 * Mirrors `runPostDeployScript` for transport (env file → bash
 * `source` → python3, optionally streaming), but with two important
 * differences:
 *
 *   1. **Fail-fast.** A non-zero exit *aborts the deploy*. Migration
 *      scripts move/transform on-disk data the new container shape
 *      depends on; continuing past a failed migration would deploy
 *      a service into an inconsistent state with no breadcrumb to
 *      the cause. The caller catches the throw, surfaces it in the
 *      install log, and leaves the operator at the old running unit.
 *
 *   2. **Audit log persisted to `config.serviceMigrations[name]`.**
 *      Both successful and failed runs land in the append-only list
 *      so the diagnose page can surface "v2-to-v3 failed" later
 *      without trawling install logs. Capped at 20 entries.
 *
 * Script env includes everything `post-deploy.py` gets plus:
 *   - `OLD_DATA_DIR` / `NEW_DATA_DIR`  — defaults to the wizard's
 *     `DATA_DIR` for both (today they're always the same; the slot
 *     is reserved for future migrations that need to move data
 *     between distinct roots).
 *   - `OLD_SCHEMA_VERSION` / `NEW_SCHEMA_VERSION` — the hop we're
 *     running (e.g. `1` / `2` for `v1-to-v2.py`).
 */
export async function runMigrationScript(
    nodeName: string,
    serviceName: string,
    script: { filename: string; fromVersion: number; toVersion: number; content: string },
    env: Record<string, string>,
    onProgress?: (message: string) => void,
): Promise<void> {
    const agent = await agentManager.ensureAgent(nodeName);
    const scriptDir = `~/.local/share/servicebay/migrations/${serviceName}`;
    const scriptPath = `${scriptDir}/${script.filename}`;
    try {
        await agent.sendCommand('exec', { command: `mkdir -p ${scriptDir}` });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onProgress?.(`❌ ${serviceName} migration ${script.filename}: could not prepare script dir (${msg}).`);
        throw new Error(`migration ${script.filename}: agent could not create ${scriptDir}: ${msg}`);
    }
    const writeRes = await agent.sendCommand('write_file', { path: scriptPath, content: script.content });
    if (writeRes !== 'ok') {
        const msg = JSON.stringify(writeRes);
        onProgress?.(`❌ ${serviceName} migration ${script.filename}: write_file returned ${msg}.`);
        throw new Error(`migration ${script.filename}: write_file failed: ${msg}`);
    }

    const envLines = await buildMigrationEnvLines(nodeName, script, env);
    const envPath = `${scriptDir}/${script.filename}.env`;
    const envWrite = await agent.sendCommand('write_file', { path: envPath, content: envLines + '\n' });
    if (envWrite !== 'ok') {
        const msg = JSON.stringify(envWrite);
        onProgress?.(`❌ ${serviceName} migration ${script.filename}: env file write failed (${msg}).`);
        throw new Error(`migration ${script.filename}: env write_file failed: ${msg}`);
    }

    onProgress?.(`Running ${serviceName} migration ${script.filename} (v${script.fromVersion}→v${script.toVersion})...`);
    const result = await executeMigrationScript(agent, scriptPath, envPath, onProgress);

    // Persist the audit entry before deciding whether to throw — even
    // failed migrations should land in the log.
    await persistMigrationAudit(serviceName, script, result);

    if (result.code !== 0) {
        const msg = `migration ${script.filename} (v${script.fromVersion}→v${script.toVersion}) exited ${result.code}; deploy aborted to avoid landing the new container on un-migrated data. Investigate the log above, fix the on-disk state, then re-run the install.`;
        onProgress?.(`❌ ${msg}`);
        throw new Error(msg);
    }
    onProgress?.(`✅ Migration ${script.filename} complete.`);
}
