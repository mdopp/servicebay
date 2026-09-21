/**
 * Gathering what `servicebay verify` reports (#3021).
 *
 * `serviceVerify.ts` holds the judgements as pure functions. This is the part
 * that talks to the box, and its whole job is to turn "could not read it" into
 * an honest `unknown` rather than into a pass or a crash. Every source is
 * wrapped so one unreadable field cannot take the report with it — a
 * verification tool that fails closed on its own plumbing is a tool nobody runs
 * twice.
 */
import { ServiceManager } from './ServiceManager';
import { getServiceImageStatus } from './imageStatus';
import { getContainers, getStoreSnapshot } from '@/lib/store/repository';
import { agentManager } from '@/lib/agent/manager';
import { logger } from '@/lib/logger';
import {
  buildReport,
  checkHealth,
  checkImage,
  checkManifest,
  checkProxyRoute,
  checkPublicUrl,
  checkRestarts,
  type ContainerState,
  type VerifyCheck,
  type VerifyReport,
} from './serviceVerify';

const INSPECT_TIMEOUT_MS = 20 * 1000;
const URL_TIMEOUT_MS = 10 * 1000;

/** Strip a systemd/Quadlet suffix so `media.service` and `media` are one key. */
function baseName(name: string): string {
  return name.replace(/\.(service|kube|container|scope|socket|timer)$/, '');
}

/** The containers this service owns, by the same ownership rule force-update uses. */
function containerNamesFor(nodeName: string, service: string): string[] {
  const owner = baseName(service);
  const names: string[] = [];
  for (const c of getContainers(nodeName)) {
    if (c.isInfra) continue;
    const unit = c.labels?.['PODMAN_SYSTEMD_UNIT'] ?? '';
    if (baseName(unit || c.podName || '') !== owner) continue;
    const name = c.names?.[0];
    if (name) names.push(name);
  }
  return names;
}

interface InspectedState {
  Status?: string;
  StartedAt?: string;
  Health?: { Status?: string; FailingStreak?: number; Log?: { Output?: string }[] };
}

/**
 * Health and restart state for one container.
 *
 * `podman inspect` is the only place `Health.Log` lives, and that last line is
 * the part that says WHY a check fails — a status word alone never does.
 */
/**
 * One `podman inspect` document, reduced to what the checks read.
 *
 * Exported for the tests: the Health block is the part that says WHY a check
 * fails, and its LAST log line is the only place the reason appears — worth
 * pinning against podman's real shape rather than trusting a walk through it.
 */
export function containerStateFrom(name: string, stdout: string): ContainerState {
  const parsed = JSON.parse(stdout) as
    | { State?: InspectedState; RestartCount?: number }
    | Array<{ State?: InspectedState; RestartCount?: number }>;
  const doc = Array.isArray(parsed) ? parsed[0] : parsed;
  const state = doc?.State;
  const health = healthFrom(state?.Health);
  return {
    name,
    status: String(state?.Status ?? ''),
    restartCount: Number(doc?.RestartCount ?? 0),
    ...(state?.StartedAt ? { startedAt: String(state.StartedAt) } : {}),
    ...(health ? { health } : {}),
  };
}

/** The Health block, or undefined when the container declares no check. The
 *  LAST log line is the only place the failure reason appears. */
function healthFrom(h: InspectedState['Health']): ContainerState['health'] | undefined {
  if (!h?.Status) return undefined;
  const log = h.Log;
  const last = Array.isArray(log) && log.length > 0 ? String(log[log.length - 1]?.Output ?? '') : '';
  return {
    status: h.Status,
    failingStreak: Number(h.FailingStreak ?? 0),
    lastOutput: last.trim().slice(0, 300),
  };
}

async function inspectContainers(nodeName: string, names: string[]): Promise<ContainerState[]> {
  if (names.length === 0) return [];
  const out: ContainerState[] = [];
  let agent: { sendCommand: (a: string, p?: unknown, o?: unknown) => Promise<unknown> };
  try {
    agent = await agentManager.ensureAgent(nodeName) as typeof agent;
  } catch (e) {
    logger.warn('serviceVerify', `could not reach node ${nodeName}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  for (const name of names) {
    try {
      const res = await agent.sendCommand(
        'safe_exec',
        { argv: ['podman', 'inspect', '--format', '{{json .}}', '--', name] },
        { timeoutMs: INSPECT_TIMEOUT_MS },
      ) as { code?: number; stdout?: string };
      if (res.code !== 0 || !res.stdout) continue;
      out.push(containerStateFrom(name, res.stdout));
    } catch (e) {
      logger.warn('serviceVerify', `inspect ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/**
 * `podman inspect` reports `Status` as `running` / `restarting` / `exited`,
 * while the restart-loop rule this reuses reads a `podman ps` Status STRING
 * (`Up 2 hours`, `Restarting (1) …`). Translate, using the start time, rather
 * than teaching the rule a second vocabulary.
 */
export function psStatusFrom(status: string, startedAt: string | undefined, now = Date.now()): string {
  if (/restarting/i.test(status)) return 'Restarting (1) 1 second ago';
  if (!/running/i.test(status)) return status || 'Created';
  const started = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(started)) return 'Up 2 hours';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `Up ${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Up ${minutes} minutes`;
  return `Up ${Math.floor(minutes / 60)} hours`;
}

/** Does the public host answer, asked FROM the box? */
async function probePublicUrl(host: string): Promise<{ url: string; status?: number; error?: string }> {
  const url = `https://${host}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    return { url, status: res.status };
  } catch (e) {
    return { url, error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

/** Injected so the gathering can be driven without a box. */
export interface VerifyDeps {
  inspect?: (nodeName: string, names: string[]) => Promise<ContainerState[]>;
  probeUrl?: (host: string) => Promise<{ url: string; status?: number; error?: string }>;
}

/** Measure all six points and judge them. Never throws. */
export async function verifyService(nodeName: string, serviceName: string, deps: VerifyDeps = {}): Promise<VerifyReport> {
  const service = baseName(serviceName);
  const inspect = deps.inspect ?? inspectContainers;
  const probeUrl = deps.probeUrl ?? probePublicUrl;
  const checks: VerifyCheck[] = [];

  const raw = await inspect(nodeName, containerNamesFor(nodeName, service)).catch(() => [] as ContainerState[]);
  // Give the restart rule the vocabulary it expects — WITH the start time, or
  // a container that restarted two seconds ago reads as long-stable and the
  // loop it is in goes unreported.
  const containers = raw.map(c => ({ ...c, status: psStatusFrom(c.status, c.startedAt) }));
  checks.push(checkHealth(raw), checkRestarts(containers));

  const imageReport = await getServiceImageStatus(nodeName, service).catch(() => null);
  checks.push(checkImage(imageReport));

  const files = await ServiceManager.getServiceFiles(nodeName, service).catch(() => null);
  checks.push(checkManifest(files?.quadletKind === 'container' ? null : (files?.yamlContent ?? null)));

  let routes: { host: string; targetService: string; targetPort: number }[] = [];
  let knownServices: string[] = [];
  try {
    routes = (getStoreSnapshot().proxyState?.routes ?? []).map(r => ({ host: r.host, targetService: r.targetService, targetPort: r.targetPort }));
    knownServices = (await ServiceManager.listServices(nodeName)).map(s => s.name);
  } catch (e) {
    logger.warn('serviceVerify', `could not read proxy routes / services: ${e instanceof Error ? e.message : String(e)}`);
  }
  checks.push(checkProxyRoute(service, routes, knownServices));

  const mine = routes.find(r => r.targetService === service);
  checks.push(checkPublicUrl(mine ? await probeUrl(mine.host) : null));

  return buildReport(service, nodeName, checks);
}
