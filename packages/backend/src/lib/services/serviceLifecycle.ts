/**
 * Service lifecycle operations (#589 follow-up).
 *
 * Extracted from the monolithic ServiceManager.ts via the reviewer's
 * planned split. Contains every mutating operation on managed
 * services: deploy / start / stop / restart / delete / rename /
 * save + the entangled private helpers (migratePredecessors,
 * runMigrationScript, runPostDeployScript, runPreStartHooks,
 * fixVolumeOwnership, backupQuadlets, refreshAgent, prePullImages,
 * ensurePodmanSocket, ensureUnprivilegedPorts).
 *
 * Exposed as a class with static methods so the existing
 * `ServiceManager.deployKubeService(...)` etc. facade in
 * ServiceManager.ts can re-alias them with one line each — public
 * API unchanged.
 */

import { agentManager } from '../agent/manager';
import { logger } from '../logger';
import yaml from 'js-yaml';
import { getConfig, updateConfig } from '../config';
import { saveSnapshot } from '../history';
import { injectServiceDirectives } from './quadletDirectives';
import { ServiceListing } from './serviceListing';
import type { PodLikeDoc, PodLikeVolumeMount } from './containerNameMatcher';

const SYSTEMD_DIR = '.config/containers/systemd';

/** Extract string content from agent read_file response. */
function extractFileContent(res: unknown): string {
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && 'content' in res && typeof (res as { content: unknown }).content === 'string') {
        return (res as { content: string }).content;
    }
    return '';
}

/**
 * Walk a parsed kube/pod YAML doc and collect every `image:` field
 * reachable through `containers[]`, `initContainers[]`, `spec`, and
 * `template`. Used by `updateAndRestartService` to know which images
 * to pull before restarting the unit.
 *
 * Returns a deduped Set so callers can iterate without re-pulling
 * the same image twice if it appears in both initContainers and
 * containers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectImagesFromKubeYaml(parsed: any): Set<string> {
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
    agent: import('../agent/handler').AgentHandler,
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

export class ServiceLifecycle {
    static async startService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: `systemctl --user --no-block start ${serviceName}.service` });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async stopService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: `systemctl --user --no-block stop ${serviceName}.service` });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async restartService(nodeName: string, serviceName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
         const res = await agent.sendCommand('exec', { command: `systemctl --user --no-block restart ${serviceName}.service` });
         if (res.code !== 0) throw new Error(res.stderr);
    }

    static async reloadDaemon(nodeName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: 'systemctl --user daemon-reload' });
        if (res.code !== 0) throw new Error(res.stderr);
    }

    static async writeFile(nodeName: string, filename: string, content: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const targetPath = `~/.config/containers/systemd/${filename}`;
        const res = await agent.sendCommand('write_file', { path: targetPath, content });
        if (res !== "ok") throw new Error('Failed to write ' + filename);
    }

    static async ensurePodmanSocket(nodeName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        try {
            const res = await agent.sendCommand('exec', { command: 'systemctl --user enable --now podman.socket' });
            if (res.code === 0) {
                logger.info('ServiceManager', 'podman.socket enabled');
            } else {
                logger.warn('ServiceManager', 'Failed to enable podman.socket:', res.stderr);
            }
        } catch (e) {
            logger.warn('ServiceManager', 'Error enabling podman.socket:', e);
        }
    }

    /** Allow rootless Podman to bind privileged ports (e.g. 445 for SMB). Idempotent. */
    static async ensureUnprivilegedPorts(nodeName: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        try {
            const check = await agent.sendCommand('exec', { command: 'cat /proc/sys/net/ipv4/ip_unprivileged_port_start' });
            if (check.code === 0 && parseInt(check.stdout.trim(), 10) === 0) return;
            // Set at runtime
            await agent.sendCommand('exec', { command: 'sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0' });
            // Persist across reboots
            await agent.sendCommand('exec', {
                command: 'echo "net.ipv4.ip_unprivileged_port_start=0" | sudo tee /etc/sysctl.d/99-unprivileged-ports.conf > /dev/null'
            });
            logger.info('ServiceManager', 'Enabled unprivileged port binding (sysctl)');
        } catch (e) {
            logger.warn('ServiceManager', 'Error setting unprivileged port sysctl:', e);
        }
    }

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
    static readonly STACK_MIGRATIONS: Record<string, string[]> = {
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

    private static async migratePredecessors(
        nodeName: string,
        newName: string,
        onProgress?: (message: string) => void,
    ): Promise<void> {
        const predecessors = ServiceLifecycle.STACK_MIGRATIONS[newName] ?? [];
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
                await ServiceLifecycle.deleteService(nodeName, old);
            } catch (e) {
                // Non-fatal — if the old unit can't be cleaned, the deploy
                // below either succeeds (different ports / pod name) or
                // fails loudly via the port-collision pre-flight.
                logger.warn('ServiceManager', `Failed to soft-delete predecessor ${old}:`, e);
            }
        }
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
    private static async runMigrationScript(
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

        // Mirror the post-deploy env shape — same wizard variables, same
        // SB_NODE / SB_API_URL / SB_API_TOKEN. Adds OLD/NEW DATA_DIR +
        // SCHEMA_VERSION so the script can branch on which hop it's
        // running. DATA_DIR slot stays the same for OLD and NEW today;
        // future migrations that move data between roots can pass distinct
        // values via the env arg.
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
                // Skip the OLD/NEW slots we've already written explicitly,
                // and skip anything non-string (same filter as post-deploy).
                if (k === 'OLD_DATA_DIR' || k === 'NEW_DATA_DIR' || k === 'OLD_SCHEMA_VERSION' || k === 'NEW_SCHEMA_VERSION') return null;
                if (typeof v !== 'string') return null;
                const esc = v.replace(/'/g, `'\\''`);
                return `${k}='${esc}'`;
            }).filter((l): l is string => l !== null),
        ].join('\n');
        const envPath = `${scriptDir}/${script.filename}.env`;
        const envWrite = await agent.sendCommand('write_file', { path: envPath, content: envLines + '\n' });
        if (envWrite !== 'ok') {
            const msg = JSON.stringify(envWrite);
            onProgress?.(`❌ ${serviceName} migration ${script.filename}: env file write failed (${msg}).`);
            throw new Error(`migration ${script.filename}: env write_file failed: ${msg}`);
        }

        onProgress?.(`Running ${serviceName} migration ${script.filename} (v${script.fromVersion}→v${script.toVersion})...`);
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

        // Persist the audit entry before deciding whether to throw — even
        // failed migrations should land in the log.
        const stdoutTail = (result.stdout ?? '').slice(-1024) || undefined;
        try {
            const cfg = await getConfig();
            const existing = cfg.serviceMigrations?.[serviceName] ?? [];
            // Most-recent-first; cap at 20 so config.json stays small.
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

        if (result.code !== 0) {
            const msg = `migration ${script.filename} (v${script.fromVersion}→v${script.toVersion}) exited ${result.code}; deploy aborted to avoid landing the new container on un-migrated data. Investigate the log above, fix the on-disk state, then re-run the install.`;
            onProgress?.(`❌ ${msg}`);
            throw new Error(msg);
        }
        onProgress?.(`✅ Migration ${script.filename} complete.`);
    }

    private static async runPostDeployScript(
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

        // Build a sourceable env file alongside the script so we don't have
        // to worry about quoting every value through the shell. `set -a` +
        // `source` exports each line to the python child. The ServiceBay
        // node identity is added so scripts can self-identify in multi-node
        // installs.
        //
        // SB_API_URL is critical: scripts call back into ServiceBay to
        // probe LLDAP, persist credentials, etc. Without it the script
        // defaults to http://localhost:3000 which is *not* ServiceBay
        // (the container listens on PORT, default 5888 from the install
        // script's Quadlet). On the FCoS host where the script runs,
        // ServiceBay is reachable as http://localhost:${PORT} thanks to
        // Network=host. This was the silent reason auth's post-deploy
        // hit its 10-minute LLDAP-wait deadline on every install — the
        // probe couldn't reach back, even though LLDAP itself came up
        // in <1 s.
        //
        // SB_API_TOKEN authenticates server-to-server calls. The
        // scripts attach it as `X-SB-Internal-Token` so proxy.ts can
        // bypass the browser-flow CSRF + session checks (urllib has
        // no Origin header, so the same-origin guard rejected every
        // POST with 403 — even though the call was reaching the
        // ServiceBay container as intended).
        const sbPort = process.env.PORT || '5888';
        const sbApiUrl = `http://localhost:${sbPort}`;
        const { getInternalApiToken } = await import('@/lib/auth/internalToken');
        const sbApiToken = getInternalApiToken();
        const envLines = [
            `SB_NODE=${nodeName}`,
            `SB_API_URL=${sbApiUrl}`,
            `SB_API_TOKEN=${sbApiToken}`,
            ...Object.entries(env).map(([k, v]) => {
                // Only export string-shaped values; skip empty entries the
                // wizard sometimes carries for variables the user hasn't
                // resolved yet (the deploy step's strict-render check
                // catches the cases where empty values would actually
                // matter).
                if (typeof v !== 'string') return null;
                // Single-quote escape for bash `source`: replace ' with '\''
                const esc = v.replace(/'/g, `'\\''`);
                return `${k}='${esc}'`;
            }).filter((l): l is string => l !== null),
        ].join('\n');
        const envPath = `${scriptDir}/${name}.env`;
        const envWrite = await agent.sendCommand('write_file', { path: envPath, content: envLines + '\n' });
        if (envWrite !== 'ok') {
            logger.warn('ServiceManager', `Could not write post-deploy env for ${name}:`, envWrite);
            onProgress?.(`⚠️ ${name} post-deploy: env file write failed, skipping.`);
            return;
        }

        onProgress?.(`Running ${name} post-deploy script...`);
        // Long timeout — scripts wait for HTTP services that can take a
        // minute or two to come up after image pull. The auth script's
        // LLDAP wait deadline is 10 min on its own (image pull on a
        // fresh install + database init); we give a 20 min client
        // timeout so it outlasts the agent-side process budget plus
        // generous slack.
        //
        // NB on the unquoted paths: scriptPath / envPath start with `~/`.
        // Bash only expands `~` when it's an *unquoted* token at the
        // beginning of a word — `'~/x'` and `"~/x"` both stay literal.
        // The earlier single-quoted form failed every script with
        // `sh: line 1: ~/.local/share/...: No such file or directory` and
        // every migrated stack reported `post-deploy exited 1`. Paths are
        // framework-controlled (no spaces, no shell metas) so unquoted is
        // safe and the simplest form that does the right thing.
        //
        // exec_stream forwards each stdout line to onProgress as soon
        // as the script prints it — without it, ServiceBay buffered the
        // whole 10-min run and the wizard sat showing "Running auth
        // post-deploy script..." with no signal that LLDAP was actually
        // coming up. Falls back to the legacy `exec` action if the
        // remote agent is older than 3.8.2.
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
            // Older agent that doesn't know exec_stream — fall back.
            if (/exec_stream|Unknown|action/i.test(msg)) {
                result = await agent.sendCommand('exec', {
                    command: `set -a; source ${envPath}; set +a; python3 ${scriptPath} 2>&1`,
                    timeout: 1200,
                }, { timeoutMs: 1_200_000 });
            } else {
                throw e;
            }
        }
        // If we didn't get any chunks (legacy fallback path or empty
        // stream), surface the buffered stdout the way we used to.
        if (!streamed) {
            const stdout = (result.stdout || '').replace(/\r/g, '');
            for (const line of stdout.split('\n')) {
                if (line.length > 0) onProgress?.(line);
            }
        }
        if (result.code !== 0) {
            onProgress?.(`⚠️ ${name} post-deploy exited ${result.code}. Service is deployed; the seed step did not finish — check the log lines above for the cause.`);
        }

        // Persist the run so the diagnose page can surface failed seeds
        // long after the install log scrolled away (#252). Bound the
        // stdout tail to ~1KB so config.json stays small. Failures here
        // are best-effort — the seed result itself was already logged
        // and shown to the user; losing the persistence just means B8
        // can't surface this run later.
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

    static async deployKubeService(
        nodeName: string,
        name: string,
        kubeContent: string,
        yamlContent: string,
        yamlName: string,
        extraFiles?: { path: string; content: string }[],
        onProgress?: (message: string) => void,
        postDeployScript?: string,
        postDeployEnv?: Record<string, string>,
        /**
         * Ordered chain of migration scripts to run before the new yaml
         * lands. Built client-side by `selectMigrationChain` from the
         * delta between `config.installedTemplates[name].schemaVersion`
         * and the target template's schema-version. Each script is
         * pre-rendered (Mustache placeholders already substituted) so
         * the server only has to execute. Non-zero exit on any step
         * aborts the deploy. See #352 phase 3.
         */
        migrations?: { filename: string; fromVersion: number; toVersion: number; content: string }[],
    ) {
        // Migrate any pre-rename predecessor units first so their host-port
        // ownership is released before the port-collision pre-flight runs.
        await ServiceLifecycle.migratePredecessors(nodeName, name, onProgress);

        // Pre-flight: refuse to deploy if the YAML claims a host port that
        // another service on the same node already owns. Without this check,
        // the second deploy "succeeds" but the unit fails to start because the
        // bind() races; users only notice when the new service stays
        // permanently inactive in the dashboard.
        const collisions = await ServiceListing.findHostPortCollisions(nodeName, name, yamlContent);
        if (collisions.length > 0) {
            const detail = collisions
                .map(c => `port ${c.hostPort} already in use by ${c.serviceName}`)
                .join('; ');
            throw new Error(`Port collision on node "${nodeName}": ${detail}. Change the host port and retry.`);
        }

        // Inject the default systemd directives (TimeoutStartSec for slow
        // image pulls + Restart=on-failure with exponential backoff) into
        // every .kube unit, single-image or multi-image. The previous
        // multi-image-only gate was a leftover from when only the
        // TimeoutStartSec was injected; it caused single-image services
        // (radicale, filebrowser, nginx, …) to land *without* any
        // restart directives, so a transient image-pull failure or any
        // crash put the unit permanently in `failed` state with no auto-
        // recovery. injectServiceDirectives is idempotent per-directive,
        // so re-deploys never duplicate keys.
        kubeContent = injectServiceDirectives(kubeContent);

        const images = ServiceListing.extractImages(yamlContent);

        // Run the template's migration chain BEFORE the new yaml lands so
        // the existing service (still on the old unit) doesn't already see
        // moved/transformed data while the migration is in flight. The
        // chain is fail-fast: any non-zero exit throws and the deploy
        // never touches the existing unit. See #352 phase 3.
        if (migrations && migrations.length > 0) {
            onProgress?.(`Running ${migrations.length} migration step(s) for ${name}...`);
            for (const m of migrations) {
                await ServiceLifecycle.runMigrationScript(nodeName, name, m, postDeployEnv ?? {}, onProgress);
            }
        }

        await ServiceLifecycle.writeFile(nodeName, yamlName, yamlContent);
        await ServiceLifecycle.writeFile(nodeName, `${name}.kube`, kubeContent);
        await ServiceLifecycle.ensurePodmanSocket(nodeName);

        // Defensive: if the template ships any *.mustache config files but the
        // caller (wizard / MCP / installer) didn't pass them through as
        // extraFiles, abort the deploy. The live failure mode this guards
        // against: the OnboardingWizard's resolver returns an empty
        // configFiles list (e.g. transient template-fetch error) and the
        // wizard happily writes the kube + yaml without the rendered config.
        // The container starts, finds /config/ empty, and either crashes
        // (radicale-shape) or auto-creates an upstream-sample default
        // (authelia-shape, 71KB of commented-out boilerplate). Both leave
        // the operator with a permanently-failed pod and no breadcrumb to
        // the missing seed.
        try {
            const { getTemplateConfigFiles } = await import('@/lib/registry');
            const expected = await getTemplateConfigFiles(name);
            if (expected.length > 0) {
                const got = new Set((extraFiles ?? []).map(f => f.path.split('/').pop()).filter(Boolean));
                const missing = expected.filter(e => !got.has(e.filename));
                if (missing.length > 0) {
                    throw new Error(
                        `Template "${name}" ships ${expected.length} mustache config file(s) but ${missing.length} weren't sent to the deploy step:\n  ${missing.map(m => m.filename).join(', ')}\n\n` +
                        `This usually means the wizard's resolver couldn't map a config file to a hostPath — check that the pod manifest declares servicebay.config-mount: <mountPath> and that the mountPath has a matching volume.`,
                    );
                }
            }
            // Belt-and-suspenders: every extraFile path must be absolute. The
            // earlier failure mode (#PR for this) had the wizard's resolver
            // poison `{{DATA_DIR}}` to the literal `0`, producing a relative
            // path like `0/auth/authelia-config/configuration.yml`. The
            // agent's `mkdir -p` resolved it under ~ — so configs landed at
            // `/var/home/core/0/...` and the actual mount stayed empty.
            // Authelia's image then auto-created a 71KB upstream sample
            // there, crash-looped, and the operator had no obvious cause.
            const relative = (extraFiles ?? []).filter(f => !f.path.startsWith('/'));
            if (relative.length > 0) {
                throw new Error(
                    `Template "${name}" extraFiles include ${relative.length} relative path(s) — the agent will resolve these under ~ and the file will land in the wrong place:\n  ${relative.map(f => f.path).join('\n  ')}\n\n` +
                    `This usually means the wizard's resolver substituted a Mustache placeholder (e.g. {{DATA_DIR}}) with junk before parsing. Check that targetPath preserves the {{...}} placeholder until deploy-time render.`,
                );
            }
        } catch (e) {
            // Re-throw deploy-blocking errors; swallow only registry-level
            // issues (e.g. node-side template dir missing in the container).
            if (e instanceof Error && e.message.startsWith('Template "')) throw e;
            logger.debug('ServiceManager', 'Could not verify template configFiles parity:', e);
        }

        // Write extra config files (e.g. Authelia configuration.yml) to the node filesystem.
        // Failures here are FATAL — the previous behaviour was to log a warning
        // and continue, which produced the radicale crash-loop class of bug:
        // service starts, looks for a config file that's not there, dies, and
        // the operator has no breadcrumb back to the real cause (the silent
        // write_file failure during deploy). Raising here surfaces the
        // problem at deploy time with a useful path.
        if (extraFiles?.length) {
            const agent = await agentManager.ensureAgent(nodeName);
            const failures: string[] = [];
            for (const f of extraFiles) {
                // Ensure parent directory exists
                const dir = f.path.substring(0, f.path.lastIndexOf('/'));
                if (dir) {
                    await agent.sendCommand('exec', { command: `mkdir -p ${dir}` });
                }
                const res = await agent.sendCommand('write_file', { path: f.path, content: f.content });
                if (res !== 'ok') {
                    failures.push(f.path);
                    logger.error('ServiceManager', `Failed to write extra file ${f.path}: agent returned ${JSON.stringify(res)}`);
                } else {
                    logger.info('ServiceManager', `Wrote extra config file: ${f.path}`);
                }
            }
            if (failures.length > 0) {
                throw new Error(
                    `Failed to write ${failures.length} required config file(s) for service "${name}":\n  ${failures.join('\n  ')}\n\n` +
                    `The service was not started. Re-run the deploy or check the agent's write permissions on the target paths.`,
                );
            }
        }

        // Ensure unprivileged port binding if any port < 1024 is used
        if (ServiceListing.hasPrivilegedPorts(yamlContent)) {
            await ServiceLifecycle.ensureUnprivilegedPorts(nodeName);
        }

        await ServiceLifecycle.reloadDaemon(nodeName);

        // Pre-pull all images before starting to avoid systemd timeout
        await ServiceLifecycle.prePullImages(nodeName, images, onProgress ? (image, idx, total, evt) => {
            if (evt.id && evt.status) {
                if (evt.total && evt.current !== undefined) {
                    const pct = Math.round(evt.current / evt.total * 100);
                    const currentMB = (evt.current / 1048576).toFixed(1);
                    const totalMB = (evt.total / 1048576).toFixed(1);
                    onProgress(`Pulling image ${idx + 1}/${total}: ${image} — ${evt.id.slice(0, 12)}: ${evt.status} ${currentMB} MB / ${totalMB} MB (${pct}%)`);
                } else {
                    onProgress(`Pulling image ${idx + 1}/${total}: ${image} — ${evt.id.slice(0, 12)}: ${evt.status}`);
                }
            }
        } : undefined);

        // Fix volume ownership for containers running as non-root UIDs
        await ServiceLifecycle.fixVolumeOwnership(nodeName, yamlContent);

        // Run pre-start hooks (e.g. initialize databases with known credentials)
        await ServiceLifecycle.runPreStartHooks(nodeName, name, yamlContent);

        // Attempt start, but don't fail deployment if start fails (user can check logs)
        try {
             await ServiceLifecycle.startService(nodeName, name);
        } catch(e) {
             logger.warn('ServiceManager', `Service ${name} deployed but start failed:`, e);
        }

        // Parse the manifest once — both the readiness wait (#613) and the
        // requiresApi gate (#588) read from it. The yamlContent passed in
        // is already Mustache-rendered, so probe values are concrete.
        const { tryParseTemplateManifest } = await import('@/lib/template/contract');
        const { assertApiCompat } = await import('@/lib/template/apiVersions');
        const manifest = tryParseTemplateManifest(yamlContent);

        // #628 retired the per-template readiness-probe gate that used
        // to run here. Continuous health is now the single source of
        // truth: the install runner's settleWait reads `twin.health.
        // ready` (populated by the service-health poller from the
        // `servicebay.healthcheck` annotation) AFTER post-deploy runs.
        // Post-deploy scripts that need to block on their own service
        // being responsive still do so via in-script helpers (e.g.
        // ollama's wait_for_ready, immich's wait_pod_running) which
        // are local to each script and don't depend on ServiceBay's
        // install layer.

        // Run the template's post-deploy.py if it shipped one. Convention:
        // see lib/registry.ts:getTemplatePostDeployScript for the protocol.
        // The script can talk to the now-running container directly (e.g.
        // POST to its /init on the host port) or call ServiceBay's own
        // admin endpoints. Stdout streams to onProgress; lines starting with
        // `__SB_CREDENTIAL__ ` are the structured credential markers the
        // wizard parses for the SAVE-THESE-NOW banner.
        if (postDeployScript) {
            // requiresApi gate (#588): if the template's manifest declares
            // a `servicebay.requires-api.<name>` annotation that this core
            // can't satisfy, refuse to invoke post-deploy.py instead of
            // letting it silently break against a renamed endpoint. The
            // unit is already running and stays running — only the script
            // is skipped, with a clear error in the install log.
            if (manifest?.requiresApi) {
                assertApiCompat(name, manifest.requiresApi);
            }
            await ServiceLifecycle.runPostDeployScript(nodeName, name, postDeployScript, postDeployEnv ?? {}, onProgress);
        }

        // Stamp the template's schema version so future re-deploys can
        // detect breaking-change deltas vs. the version that's actually
        // running on the box. See #353 / #354. Best-effort: a failure
        // here just means the breaking-change banner can't fire on the
        // next deploy, which is no worse than the pre-tracking state.
        try {
            const { parseTemplateSchemaVersion } = await import('@/lib/templateSchemaVersion');
            const schemaVersion = parseTemplateSchemaVersion(yamlContent);
            await updateConfig({
                installedTemplates: {
                    [name]: {
                        schemaVersion,
                        installedAt: new Date().toISOString(),
                    },
                },
            });
        } catch (e) {
            logger.warn('ServiceManager', `Could not stamp installedTemplates[${name}]:`, e);
        }

        ServiceLifecycle.backupQuadlets(nodeName);

        // Create health check for the new service if one doesn't exist
        try {
            const { HealthStore } = await import('../health/store');
            const checks = HealthStore.getChecks();
            const alreadyMonitored = checks.some(c =>
                (c.type === 'service' && c.target === name) ||
                (c.name === `Service: ${name}`)
            );
            if (!alreadyMonitored) {
                const crypto = await import('crypto');
                HealthStore.saveCheck({
                    id: crypto.randomUUID(),
                    name: `Service: ${name}`,
                    type: 'service',
                    target: name,
                    interval: 60,
                    enabled: true,
                    created_at: new Date().toISOString(),
                    nodeName: nodeName !== 'Local' ? nodeName : undefined,
                });
                logger.info('ServiceManager', `Created health check for ${name}`);
            }
        } catch (e) {
            logger.warn('ServiceManager', `Failed to create health check for ${name}:`, e);
        }
    }

    /**
     * Pull every hostPort declared in a kube YAML. Tolerates malformed YAML
     * (returns empty rather than throwing) so a parse error never blocks a
     * deploy via the collision check.
     */
    static async prePullImages(
        nodeName: string,
        images: string[],
        onProgress?: (image: string, imageIndex: number, total: number, event: import('../agent/handler').PullProgressEvent) => void
    ) {
        const agent = await agentManager.ensureAgent(nodeName);
        for (let i = 0; i < images.length; i++) {
            const image = images[i];
            try {
                logger.info('ServiceManager', `Pre-pulling image: ${image}`);
                await agent.pullImage(image, onProgress ? (evt) => onProgress(image, i, images.length, evt) : undefined);
            } catch (e) {
                logger.warn('ServiceManager', `Failed to pre-pull ${image} (will retry on start):`, e);
            }
        }
    }

    /** Fix volume ownership for containers with explicit runAsUser/runAsGroup.
     *  In rootless podman, host UIDs map differently inside the user namespace.
     *  Uses `podman unshare chown` to translate container UIDs to correct host UIDs. */
    private static async chownContainerMounts(
        nodeName: string,
        container: NonNullable<NonNullable<PodLikeDoc['spec']>['containers']>[number],
        volumePaths: Map<string, string>,
    ): Promise<void> {
        const uid = container.securityContext?.runAsUser;
        const gid = container.securityContext?.runAsGroup ?? uid;
        if (uid == null || uid === 0) return; // Skip root or unset

        const mounts = container.volumeMounts || [];
        for (const mount of mounts) {
            if (!mount.name) continue;
            const hostPath = volumePaths.get(mount.name);
            if (!hostPath || mount.readOnly) continue;

            const agent = await agentManager.ensureAgent(nodeName);
            try {
                await agent.sendCommand('exec', {
                    command: `podman unshare chown -R ${uid}:${gid} ${hostPath}`
                });
                logger.info('ServiceManager', `Fixed volume ownership: ${hostPath} -> ${uid}:${gid}`);
            } catch (e) {
                logger.warn('ServiceManager', `Failed to fix ownership for ${hostPath}:`, e);
            }
        }
    }

    private static async fixVolumeOwnership(nodeName: string, yamlContent: string) {
        try {
            const docs = yaml.loadAll(yamlContent) as PodLikeDoc[];
            for (const doc of docs) {
                if (!doc?.spec) continue;
                const containers = doc.spec.containers || [];
                const volumes = doc.spec.volumes || [];

                // Build volume name -> hostPath map
                const volumePaths = new Map<string, string>();
                for (const vol of volumes) {
                    if (vol.name && vol.hostPath?.path) {
                        volumePaths.set(vol.name, vol.hostPath.path);
                    }
                }

                for (const container of containers) {
                    await this.chownContainerMounts(nodeName, container, volumePaths);
                }
            }
        } catch (e) {
            logger.debug('ServiceManager', 'Volume ownership fix skipped:', e);
        }
    }

    /**
     * Run pre-start hooks for known images that need initialization (e.g. filebrowser DB).
     * This runs AFTER files are written and images are pulled, but BEFORE the service starts.
     */
    private static async runPreStartHooks(nodeName: string, name: string, yamlContent: string) {
        try {            const docs = yaml.loadAll(yamlContent) as PodLikeDoc[];
            for (const doc of docs) {
                if (!doc?.spec) continue;
                const containers = doc.spec.containers || [];
                const volumes = doc.spec.volumes || [];

                const volumePaths = new Map<string, string>();
                for (const vol of volumes) {
                    if (vol.name && vol.hostPath?.path) volumePaths.set(vol.name, vol.hostPath.path);
                }

                for (const container of containers) {
                    const image = container.image || '';

                    // Home Assistant self-healing trusted_proxies hook.
                    // HA's `http.forwarded` middleware rejects every
                    // reverse-proxied request with HTTP 400 unless
                    // configuration.yaml contains an `http:` block with
                    // `use_x_forwarded_for: true` and a trusted_proxies
                    // list including NPM's source IP.
                    //
                    // We seed this block at install time via the template's
                    // configuration.yaml.mustache (template v3+), but a
                    // backup-restore via HA's UI overwrites
                    // /config/configuration.yaml with the snapshot version
                    // — which usually has no `http:` block. The result:
                    // home.<domain> goes back to 400 after every restore.
                    //
                    // Run on every deploy: if configuration.yaml is missing
                    // an `http:` block, append our default. Idempotent —
                    // skips when the block already exists. Self-heals after
                    // restores at the next service redeploy.
                    if (image.includes('home-assistant') && container.name !== 'matter-server' && container.name !== 'zwave-js') {
                        const configMount = (container.volumeMounts || []).find(                            (m: PodLikeVolumeMount) => m.mountPath === '/config'
                        );
                        const configHostPath = configMount ? volumePaths.get(configMount.name!) : null;
                        if (!configHostPath) continue;
                        const cfgFile = `${configHostPath}/configuration.yaml`;

                        const agent = await agentManager.ensureAgent(nodeName);

                        // Only act when the file already exists. On a
                        // first-install the template's mustache config is
                        // about to be written by the deploy flow — let that
                        // path own initial seeding. On every subsequent
                        // deploy (including post-restore), the file is
                        // there and we get to fix it.
                        const exists = await agent.sendCommand('exec', { command: `test -f ${cfgFile} && echo yes` });
                        if (exists.stdout?.trim() !== 'yes') continue;

                        // grep -E for an unindented `http:` key. Multiline
                        // anchors would be cleaner but the shell context
                        // here is simpler.
                        const probe = await agent.sendCommand('exec', { command: `grep -E '^http:' ${cfgFile} || echo MISSING` });
                        if (!probe.stdout?.includes('MISSING')) {
                            logger.debug('ServiceManager', `HA configuration.yaml already has http: block, leaving it alone`);
                            continue;
                        }

                        logger.info('ServiceManager', `HA configuration.yaml has no http: block — appending trusted_proxies (likely after a backup-restore)`);
                        const trustedProxiesBlock = [
                            '',
                            '# Re-added by ServiceBay: NPM forwards X-Forwarded-For; HA needs',
                            '# trusted_proxies to accept proxied requests. Safe to edit, but',
                            '# ServiceBay will re-append this block on every deploy when the',
                            '# `http:` key is missing (e.g. after a HA backup-restore).',
                            'http:',
                            '  use_x_forwarded_for: true',
                            '  trusted_proxies:',
                            '    - 127.0.0.1',
                            '    - 192.168.0.0/16',
                            '    - 10.0.0.0/8',
                            '    - 172.16.0.0/12',
                        ].join('\n');
                        // Heredoc keeps the YAML indentation intact and
                        // avoids shell-quote escaping. >> appends, so any
                        // restored content above stays untouched.
                        const appendCmd = `cat >> ${cfgFile} <<'EOF'\n${trustedProxiesBlock}\nEOF`;
                        const res = await agent.sendCommand('exec', { command: appendCmd, timeout: 10 });
                        if (res.code === 0) {
                            logger.info('ServiceManager', 'HA trusted_proxies block appended');
                        } else {
                            logger.warn('ServiceManager', `HA trusted_proxies append failed: ${res.stderr || res.stdout}`);
                        }
                        continue;
                    }

                    if (!image.includes('filebrowser')) continue;

                    // Find the database volume mount. file-share/template.yml
                    // mounts the DB at `/database` (legacy templates used
                    // `/db`); accept either so a wider set of layouts hit
                    // this hook.
                    const dbMount = (container.volumeMounts || []).find(                        (m: PodLikeVolumeMount) => m.mountPath === '/db' || m.mountPath === '/database'
                    );
                    const dbHostPath = dbMount ? volumePaths.get(dbMount.name!) : null;
                    if (!dbHostPath) continue;

                    const dbFile = 'filebrowser.db';
                    const fullDbPath = `${dbHostPath}/${dbFile}`;

                    const agent = await agentManager.ensureAgent(nodeName);

                    // Check if DB already exists (don't overwrite on redeploy)
                    const check = await agent.sendCommand('exec', { command: `test -f ${fullDbPath} && echo exists` });
                    if (check.stdout?.trim() === 'exists') {
                        logger.debug('ServiceManager', `FileBrowser DB already exists at ${fullDbPath}, skipping init`);
                        continue;
                    }

                    // Initialize the FileBrowser BoltDB *before* the main
                    // container starts. Three steps inside a transient
                    // container that mounts the host DB dir at /db:
                    //
                    //   1. `config init` — creates the empty DB schema.
                    //   2. `config set --auth.method=proxy --auth.header=Remote-User`
                    //      switches the DB's runtime auth method to
                    //      proxy mode. Without this step the FileBrowser
                    //      v2 binary ignores the `.filebrowser.json` JSON
                    //      file's `auth.method` field (that field is
                    //      legacy v1) and falls back to password ('json')
                    //      auth, which makes every Remote-User header
                    //      mute and /api/login return 403 for the
                    //      install-time admin-promote call.
                    //   3. `users add admin <known-pwd> --perm.admin` —
                    //      seeds an admin user the proxy-auth path can
                    //      look up when ServiceBay's filebrowser/init
                    //      handler comes calling with `Remote-User: admin`.
                    logger.info('ServiceManager', `Initializing FileBrowser DB at ${fullDbPath} (config init + auth.method=proxy + admin user)`);
                    await agent.sendCommand('exec', { command: `mkdir -p ${dbHostPath}` });

                    const initCmd = [
                        `podman run --rm --user 0:0`,
                        `-v ${dbHostPath}:/db`,
                        `${image}`,
                        `config init --database /db/${dbFile}`,
                    ].join(' ');
                    const initRes = await agent.sendCommand('exec', { command: initCmd, timeout: 60 });
                    if (initRes.code !== 0) {
                        logger.warn('ServiceManager', `FileBrowser config init failed (code ${initRes.code}): ${initRes.stderr || initRes.stdout}`);
                        continue;
                    }

                    const setCmd = [
                        `podman run --rm --user 0:0`,
                        `-v ${dbHostPath}:/db`,
                        `${image}`,
                        `config set --auth.method=proxy --auth.header=Remote-User --database /db/${dbFile}`,
                    ].join(' ');
                    const setRes = await agent.sendCommand('exec', { command: setCmd, timeout: 60 });
                    if (setRes.code !== 0) {
                        logger.warn('ServiceManager', `FileBrowser config set --auth.method=proxy failed (code ${setRes.code}): ${setRes.stderr || setRes.stdout}`);
                    }

                    const userCmd = [
                        `podman run --rm --user 0:0`,
                        `-v ${dbHostPath}:/db`,
                        `${image}`,
                        `users add admin admin1234admin --perm.admin --database /db/${dbFile}`,
                    ].join(' ');
                    const result = await agent.sendCommand('exec', { command: userCmd, timeout: 60 });
                    if (result.code === 0) {
                        logger.info('ServiceManager', 'FileBrowser DB initialized: proxy-auth + admin user (password unused under proxy auth).');
                    } else {
                        logger.warn('ServiceManager', `FileBrowser users add failed: ${result.stderr || result.stdout}`);
                    }
                }
            }
        } catch (e) {
            logger.debug('ServiceManager', 'Pre-start hooks skipped:', e);
        }
    }

    static async deployService(nodeName: string, filename: string, content: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        const targetPath = `~/.config/containers/systemd/${filename}`;

        // agent.py "write_file" returns "ok"
        const res = await agent.sendCommand('write_file', { path: targetPath, content });
        if (res !== "ok") {
             throw new Error('Failed to write service file');
        }

        await ServiceLifecycle.ensurePodmanSocket(nodeName);
        await ServiceLifecycle.reloadDaemon(nodeName);
        ServiceLifecycle.backupQuadlets(nodeName);
    }

    static async removeService(nodeName: string, filename: string) {
        const agent = await agentManager.ensureAgent(nodeName);
        // Use variable to avoid quoting issues
        const cmd = `
        f="$HOME/.config/containers/systemd/${filename}"
        if [ -f "$f" ]; then rm -f "$f"; fi
        `;
        const res = await agent.sendCommand('exec', { command: cmd });
         if (res.code !== 0) throw new Error(res.stderr);

        await ServiceLifecycle.reloadDaemon(nodeName);
        ServiceLifecycle.backupQuadlets(nodeName);
    }

    /** Backup Quadlet files to data directory (survives OS reinstall).
     *  Note: nginx config already lives on DATA_DIR (RAID) and needs no extra backup here.
     *  It is included in the downloadable full system backup (systemBackup.ts). */
    private static async backupQuadlets(nodeName: string) {
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
    private static async refreshAgent(nodeName: string) {
        try {
            const agent = await agentManager.ensureAgent(nodeName);
            await agent.sendCommand('refresh');
        } catch { /* agent may not be connected */ }
    }

    static async saveService(nodeName: string, serviceName: string, kubeContent: string, yamlContent: string, yamlFileName: string) {
        // Save snapshots of existing files before overwriting
        try {
            const existing = await ServiceListing.getServiceFiles(nodeName, serviceName);
            if (existing.kubeContent) await saveSnapshot(`${serviceName}.kube`, existing.kubeContent);
            if (existing.yamlContent) await saveSnapshot(yamlFileName, existing.yamlContent);
        } catch { /* ignore if new file */ }

        await ServiceLifecycle.writeFile(nodeName, `${serviceName}.kube`, kubeContent);
        await ServiceLifecycle.writeFile(nodeName, yamlFileName, yamlContent);
        await ServiceLifecycle.reloadDaemon(nodeName);
        await ServiceLifecycle.refreshAgent(nodeName);
        ServiceLifecycle.backupQuadlets(nodeName);
    }

    /**
     * Soft-delete a service: stop the unit, then *move* its .kube and .yml
     * files into ~/.config/containers/systemd/.trash/<ts>-<name>/ instead
     * of deleting them. The operator (or an MCP client) can `restore_from_trash`
     * to undo within 7 days; `purge_trash` actually removes them. Auto-purge
     * older than 7 days runs on server startup.
     *
     * Why "move, don't rm": delete-by-mistake is the easiest way to lose
     * service config, and the existing system-backup mechanism only takes
     * snapshots periodically. A trash bucket gives an immediate one-step
     * recovery without restoring from a backup tarball.
     */
    static async deleteService(nodeName: string, serviceName: string) {
        const { yamlPath } = await ServiceListing.getServiceFiles(nodeName, serviceName);
        const agent = await agentManager.ensureAgent(nodeName);

        // Stop
        try {
            await agent.sendCommand('exec', { command: `systemctl --user stop ${serviceName}.service` });
        } catch { /* ignore if already stopped */ }

        // Move the files into the trash bucket. ISO-8601 with no colons in
        // the name so it sorts by timestamp and survives shells that hate
        // colons in paths.
        const trashStamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashDir = `~/${SYSTEMD_DIR}/.trash/${trashStamp}-${serviceName}`;
        await agent.sendCommand('exec', { command: `mkdir -p '${trashDir}'` });

        // Move kube file
        await agent.sendCommand('exec', {
            command: `mv -f ~/${SYSTEMD_DIR}/${serviceName}.kube '${trashDir}/' 2>/dev/null || true`
        });

        // Move yaml file
        if (yamlPath) {
            const resolvedYaml = yamlPath.startsWith('/') ? yamlPath : `~/${yamlPath}`;
            await agent.sendCommand('exec', {
                command: `mv -f ${resolvedYaml} '${trashDir}/' 2>/dev/null || true`,
            });
        }

        // Stash a small manifest so restore knows the original yaml path
        // even if it lived outside the systemd dir (legacy migrations did).
        const manifest = JSON.stringify({
            service: serviceName,
            deletedAt: new Date().toISOString(),
            originalYamlPath: yamlPath || null,
            originalKubePath: `~/${SYSTEMD_DIR}/${serviceName}.kube`,
        });
        await agent.sendCommand('exec', {
            command: `printf '%s' ${JSON.stringify(manifest)} > '${trashDir}/.manifest.json'`,
        });

        await ServiceLifecycle.reloadDaemon(nodeName);

        // Clear failed state
        try {
            await agent.sendCommand('exec', { command: `systemctl --user reset-failed ${serviceName}.service` });
        } catch { /* unit may not be in failed state */ }

        await ServiceLifecycle.refreshAgent(nodeName);
        ServiceLifecycle.backupQuadlets(nodeName);

        logger.info('ServiceManager', `Soft-deleted ${serviceName} on ${nodeName} → ${trashDir}`);
    }

    /** Recursive listing of the trash bucket for one node. Each entry maps
     *  to a single soft-deleted service. */
    static async restoreTrashedService(nodeName: string, trashId: string): Promise<{ service: string }> {
        const agent = await agentManager.ensureAgent(nodeName);
        const trashRoot = `~/${SYSTEMD_DIR}/.trash`;
        const trashDir = `${trashRoot}/${trashId}`;

        // Read manifest. Manifest is the source of truth for original
        // paths because the service may have referenced a yaml file
        // outside SYSTEMD_DIR.
        const m = await agent.sendCommand('exec', {
            command: `cat '${trashDir}/.manifest.json' 2>/dev/null`,
        });
        let manifest: { service?: string; originalYamlPath?: string | null; originalKubePath?: string };
        try {
            manifest = JSON.parse(((m?.stdout ?? '') as string) || '{}');
        } catch {
            throw new Error(`Trash entry ${trashId} is missing or has a corrupt manifest — restore manually`);
        }
        if (!manifest.service) {
            throw new Error(`Trash entry ${trashId} has no service name in manifest`);
        }

        const kubePath = manifest.originalKubePath || `~/${SYSTEMD_DIR}/${manifest.service}.kube`;
        const yamlPath = manifest.originalYamlPath
            ? (manifest.originalYamlPath.startsWith('/') ? manifest.originalYamlPath : `~/${manifest.originalYamlPath}`)
            : null;

        await agent.sendCommand('exec', {
            command: `mv '${trashDir}/${manifest.service}.kube' ${kubePath} 2>/dev/null || true`,
        });
        if (yamlPath) {
            // The yaml lives in the trash dir under its basename.
            const yamlBasename = manifest.originalYamlPath?.split('/').pop();
            if (yamlBasename) {
                await agent.sendCommand('exec', {
                    command: `mv '${trashDir}/${yamlBasename}' ${yamlPath} 2>/dev/null || true`,
                });
            }
        }
        // Wipe the now-empty trash dir.
        await agent.sendCommand('exec', { command: `rm -rf '${trashDir}'` });

        await ServiceLifecycle.reloadDaemon(nodeName);
        await ServiceLifecycle.refreshAgent(nodeName);
        ServiceLifecycle.backupQuadlets(nodeName);

        logger.info('ServiceManager', `Restored ${manifest.service} from trash on ${nodeName}`);
        return { service: manifest.service };
    }

    /** Permanently delete one trash entry, or all entries older than the
     *  given retention (in milliseconds). */
    static async purgeTrash(nodeName: string, opts: { trashId?: string; olderThanMs?: number }): Promise<{ purged: string[] }> {
        const agent = await agentManager.ensureAgent(nodeName);
        const trashRoot = `~/${SYSTEMD_DIR}/.trash`;
        if (opts.trashId) {
            // Strict basename — no traversal allowed.
            if (!/^[a-zA-Z0-9._-]+$/.test(opts.trashId)) {
                throw new Error(`Invalid trash id: ${opts.trashId}`);
            }
            await agent.sendCommand('exec', { command: `rm -rf '${trashRoot}/${opts.trashId}'` });
            logger.info('ServiceManager', `Purged trash entry ${opts.trashId} on ${nodeName}`);
            return { purged: [opts.trashId] };
        }
        if (opts.olderThanMs !== undefined) {
            const list = await ServiceListing.listTrashedServices(nodeName);
            const now = Date.now();
            const toPurge = list.filter(e => {
                const ts = Date.parse(e.deletedAt);
                if (!isFinite(ts)) return false;
                return (now - ts) > opts.olderThanMs!;
            });
            for (const entry of toPurge) {
                await agent.sendCommand('exec', { command: `rm -rf '${trashRoot}/${entry.id}'` });
            }
            if (toPurge.length > 0) {
                logger.info('ServiceManager', `Purged ${toPurge.length} trash entr${toPurge.length === 1 ? 'y' : 'ies'} older than ${Math.round(opts.olderThanMs / 86_400_000)}d on ${nodeName}`);
            }
            return { purged: toPurge.map(e => e.id) };
        }
        return { purged: [] };
    }

    static async renameService(nodeName: string, oldName: string, newName: string) {
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
        await ServiceLifecycle.writeFile(nodeName, `${newName}.kube`, newKubeContent);
        await agent.sendCommand('exec', { command: `rm -f ${oldKubePath}` });

        // 4. Reload and start
        await ServiceLifecycle.reloadDaemon(nodeName);
        try {
            await agent.sendCommand('exec', { command: `systemctl --user enable --now ${newName}.service` });
        } catch (e) {
            throw new Error(`Failed to start new service: ${e}`);
        }

        await ServiceLifecycle.refreshAgent(nodeName);
        ServiceLifecycle.backupQuadlets(nodeName);
    }

     
    static async updateAndRestartService(nodeName: string, serviceName: string): Promise<{ logs: string[]; status: string }> {
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
        await ServiceLifecycle.reloadDaemon(nodeName);

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

    static async updateServiceDescription(nodeName: string, serviceName: string, description: string) {
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

        await ServiceLifecycle.writeFile(nodeName, `${serviceName}.kube`, content);
        await ServiceLifecycle.reloadDaemon(nodeName);
    }

}
