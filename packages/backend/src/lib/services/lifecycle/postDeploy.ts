/**
 * Template post-deploy script execution (#2741).
 *
 * Moved verbatim out of `serviceLifecycle.ts`: the durable read-token mint, the
 * env-file build, the streamed `python3 post-deploy.py` run and the result
 * audit. Unlike a migration, a post-deploy failure is non-fatal — the service
 * is already running.
 *
 * Reached through `ServiceLifecycle` (and therefore `ServiceManager`); the
 * depcruise `service-manager-single-mutation-path` rule forbids importing this
 * module from outside `lib/services/`.
 */

import { logger } from '../../logger';
import { agentManager } from '../../agent/manager';
import { updateConfig } from '../../config';

/**
 * Mint a durable, read-scoped Bearer token for a service's post-deploy to
 * hand to its long-running consumers (#818). The token is minted HERE, in
 * ServiceBay — NOT by the external post-deploy script — because minting a
 * `neverExpires` credential idempotently is the platform's job, not a
 * template's: the post-deploy can't recover a lost secret, can't dedupe
 * without a round-trip, and lives in an external registry that may ship a
 * stale copy (the #818 failure mode — the read token was never minted).
 *
 * Fresh each deploy (prior same-named tokens revoked → no accumulation, no
 * plaintext-secret persistence). The token never expires, so it stays valid
 * between deploys; the consumer just re-reads the injected value each deploy.
 * Read scope only — the route-level `neverExpires ⇒ read-only` guard (#2299)
 * is honoured here too (fail-closed to `read`). Best-effort: a mint failure
 * returns null and the post-deploy simply runs without SB_READ_TOKEN.
 */
async function mintDurableReadToken(serviceName: string): Promise<string | null> {
    try {
        const { listTokens, createToken, revokeToken } = await import('@/lib/auth/apiTokens');
        const tokenName = `postdeploy-read:${serviceName}`;
        for (const t of (await listTokens()).filter(t => t.name === tokenName)) {
            await revokeToken(t.id);
        }
        const { secret } = await createToken({
            name: tokenName,
            scopes: ['read'],
            neverExpires: true,
            createdBy: `internal:post-deploy:${serviceName}`,
        });
        return secret;
    } catch (e) {
        logger.warn('ServiceManager', `Could not mint durable read token for ${serviceName}:`, e);
        return null;
    }
}

/**
 * Build post-deploy script env file content with SB metadata.
 */
export async function buildPostDeployEnvLines(
    nodeName: string,
    serviceName: string,
    env: Record<string, string>,
): Promise<string> {
    const sbPort = process.env.PORT || '5888';
    const sbApiUrl = `http://localhost:${sbPort}`;
    const { getInternalApiToken } = await import('@/lib/auth/internalToken');
    const sbApiToken = getInternalApiToken();
    // Durable, read-scoped Bearer for the service's long-running consumers
    // (#818). Distinct from SB_API_TOKEN (the all-scopes internal HMAC, sent
    // as X-SB-Internal-Token) — this is a real, least-privilege sb_ token the
    // consumer presents as `Authorization: Bearer` and that never lapses.
    const sbReadToken = await mintDurableReadToken(serviceName);
    const envLines = [
        `SB_NODE=${nodeName}`,
        `SB_API_URL=${sbApiUrl}`,
        `SB_API_TOKEN=${sbApiToken}`,
        ...(sbReadToken ? [`SB_READ_TOKEN=${sbReadToken}`] : []),
        ...Object.entries(env).map(([k, v]) => {
            if (typeof v !== 'string') return null;
            const esc = v.replace(/'/g, `'\\''`);
            return `${k}='${esc}'`;
        }).filter((l): l is string => l !== null),
    ].join('\n');
    return envLines;
}

/**
 * Persist post-deploy run result to config.
 */
async function persistPostDeployResult(
    name: string,
    result: { code: number; stdout: string },
): Promise<void> {
    try {
        const stdoutTail = (result.stdout ?? '').slice(-1024) || undefined;
        await updateConfig({
            servicePostDeploy: {
                [name]: {
                    lastRunAt: new Date().toISOString(),
                    exitCode: result.code,
                    stdoutTail,
                },
            },
        });
    } catch (e) {
        logger.warn('ServiceManager', `Could not persist post-deploy result for ${name}:`, e);
    }
}

/**
 * Execute a post-deploy script and stream output.
 */
async function executePostDeployScript(
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
 * Run a template's post-deploy.py on the agent host. Writes the script
 * to a stable per-template path (so reruns overwrite cleanly), exports
 * the wizard's variables as env vars + SB_NODE, then `python3` it. The
 * script's stdout is collected and replayed line-by-line through
 * `onProgress` so it interleaves with the rest of the install log.
 *
 * Failures are non-fatal: a misbehaving post-deploy script doesn't roll
 * back the service deploy. We log a warning + a "post-deploy exit N"
 * line and continue. Restart-loop / config-broken issues will surface
 * via the diagnose probe instead.
 */
export async function runPostDeployScript(
    nodeName: string,
    name: string,
    scriptContent: string,
    env: Record<string, string>,
    onProgress?: (message: string) => void,
): Promise<void> {
    const agent = await agentManager.ensureAgent(nodeName);
    const scriptDir = `~/.local/share/servicebay/post-deploy`;
    const scriptPath = `${scriptDir}/${name}.py`;
    try {
        await agent.sendCommand('exec', { command: `mkdir -p ${scriptDir}` });
    } catch (e) {
        logger.warn('ServiceManager', `Could not prepare post-deploy dir for ${name}:`, e);
        onProgress?.(`⚠️ ${name} post-deploy: could not prepare script dir, skipping.`);
        return;
    }
    const writeRes = await agent.sendCommand('write_file', { path: scriptPath, content: scriptContent });
    if (writeRes !== 'ok') {
        logger.warn('ServiceManager', `Could not write post-deploy script for ${name}:`, writeRes);
        onProgress?.(`⚠️ ${name} post-deploy: write_file returned ${JSON.stringify(writeRes)}, skipping.`);
        return;
    }

    const envLines = await buildPostDeployEnvLines(nodeName, name, env);
    const envPath = `${scriptDir}/${name}.env`;
    const envWrite = await agent.sendCommand('write_file', { path: envPath, content: envLines + '\n' });
    if (envWrite !== 'ok') {
        logger.warn('ServiceManager', `Could not write post-deploy env for ${name}:`, envWrite);
        onProgress?.(`⚠️ ${name} post-deploy: env file write failed, skipping.`);
        return;
    }

    onProgress?.(`Running ${name} post-deploy script...`);
    const result = await executePostDeployScript(agent, scriptPath, envPath, onProgress);
    if (result.code !== 0) {
        onProgress?.(`⚠️ ${name} post-deploy exited ${result.code}. Service is deployed; the seed step did not finish — check the log lines above for the cause.`);
    }

    await persistPostDeployResult(name, result);
}
