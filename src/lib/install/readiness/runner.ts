/**
 * Readiness probe orchestration (#613).
 *
 * Called by `install/runner.ts` between deploying the unit and invoking
 * `post-deploy.py`. The loop polls every probe in the template's
 * `servicebay.readiness` list until each succeeds, or until its declared
 * `timeout` expires.
 *
 * Behavior contract:
 *   - All probes run in parallel — one slow probe doesn't block the
 *     others. Each owns its own deadline.
 *   - A probe that succeeds is done; we stop retrying it but keep waiting
 *     on the rest.
 *   - The loop emits a heartbeat log line every HEARTBEAT_MS so the
 *     wizard's stream doesn't go silent during long waits.
 *   - On any probe's deadline lapsing without success, the whole call
 *     fails with structured `ProbeResult[]` — the install runner then
 *     blocks the deploy (no post-deploy invocation).
 *   - The structured failure is what the install log + diagnose panel
 *     read to render operator-facing breadcrumbs.
 */
import { parseReadinessYaml } from './parse';
import { runProbe, type ProbeAttempt, type ProbeContext } from './probes';
import type { ProbeResult, ReadinessProbe } from './types';

const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_MS = 15_000;

export interface WaitForReadinessOptions {
  /** Already-Mustache-rendered YAML body from the template's
   *  `servicebay.readiness` annotation. The outer template render happens
   *  in `install/runner.ts:deployItem`, so by the time we get here the
   *  body has concrete values for every `{{VAR}}`. */
  readinessRaw: string;
  /** Pod name (template name) — required for `command` probe container
   *  resolution and used in log lines. */
  podName: string;
  /** Install target node (defaults to "Local"). */
  node?: string;
  /** Sink for human-readable progress lines (mirrors `install/runner.ts`
   *  log()). */
  onLog: (line: string) => void;
  /** Abort flag — checked between polls so a user-initiated abort exits
   *  promptly. */
  isAborted?: () => boolean;
}

export type WaitForReadinessResult =
  | { ok: true; results: ProbeResult[] }
  | { ok: false; results: ProbeResult[]; parseErrors?: string[] };

/** Parse the rendered readiness body, run all probes in parallel, return
 *  once every probe has either succeeded or hit its own deadline. */
export async function waitForReadiness(opts: WaitForReadinessOptions): Promise<WaitForReadinessResult> {
  const parse = parseReadinessYaml(opts.readinessRaw);
  if (!parse.ok) {
    // Template-author bug surfaced at install time — the contract.ts
    // lint check should have caught this before the template shipped,
    // but emit a clear breadcrumb either way.
    const msg = `Readiness annotation is malformed: ${parse.errors.join('; ')}`;
    opts.onLog(`⚠️ ${opts.podName}: ${msg} — skipping readiness wait.`);
    return { ok: false, results: [], parseErrors: parse.errors };
  }

  const probes = parse.probes;
  if (probes.length === 0) return { ok: true, results: [] };

  opts.onLog(`Waiting for ${opts.podName} to become ready (${probes.length} probe${probes.length === 1 ? '' : 's'})...`);
  const ctx: ProbeContext = { node: opts.node, podName: opts.podName };
  const results = await Promise.all(probes.map((p, i) => waitOne(p, i, probes.length, ctx, opts)));

  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) {
    opts.onLog(`✅ ${opts.podName} ready (${probes.length}/${probes.length} probe${probes.length === 1 ? '' : 's'} passed).`);
    return { ok: true, results };
  }
  return { ok: false, results };
}

/** Poll a single probe until success or deadline. Heartbeats every
 *  HEARTBEAT_MS so long waits don't look like a hang. */
async function waitOne(
  probe: ReadinessProbe,
  idx: number,
  total: number,
  ctx: ProbeContext,
  opts: WaitForReadinessOptions,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const deadline = startedAt + probe.timeoutMs;
  let attempts = 0;
  let lastAttempt: ProbeAttempt = { ok: false, reason: 'network-error', detail: 'not yet attempted' };
  let lastHeartbeat = startedAt;

  while (Date.now() < deadline) {
    if (opts.isAborted?.()) {
      return finalize(probe, attempts, startedAt, lastAttempt);
    }
    attempts++;
    lastAttempt = await runProbe(probe, ctx);
    if (lastAttempt.ok) {
      const elapsedMs = Date.now() - startedAt;
      return { ok: true, probe, attempts, elapsedMs };
    }
    // `config-error` results are non-transient — fail fast.
    if (lastAttempt.reason === 'config-error') {
      return finalize(probe, attempts, startedAt, lastAttempt);
    }
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_MS && now < deadline - POLL_INTERVAL_MS) {
      const elapsedSec = Math.floor((now - startedAt) / 1000);
      const remainingSec = Math.ceil((deadline - now) / 1000);
      opts.onLog(`  …probe ${idx + 1}/${total} (${probe.kind}) still waiting after ${elapsedSec}s — last attempt: ${lastAttempt.detail} (timeout in ${remainingSec}s)`);
      lastHeartbeat = now;
    }
    const sleepBudget = Math.min(POLL_INTERVAL_MS, deadline - Date.now());
    if (sleepBudget > 0) await new Promise(r => setTimeout(r, sleepBudget));
  }
  return finalize(probe, attempts, startedAt, lastAttempt);
}

function finalize(
  probe: ReadinessProbe,
  attempts: number,
  startedAt: number,
  lastAttempt: ProbeAttempt,
): ProbeResult {
  return {
    ok: false,
    probe,
    attempts,
    elapsedMs: Date.now() - startedAt,
    reason: lastAttempt.reason ?? 'timeout',
    message: lastAttempt.detail,
    lastResponse: lastAttempt.detail,
  };
}

/** Human-readable description for log lines. Avoids dumping the raw probe
 *  JSON — uses the key identifier (url, host:port, container/command). */
export function describeProbe(probe: ReadinessProbe): string {
  switch (probe.kind) {
    case 'http':    return `http ${probe.method ?? 'GET'} ${probe.url}`;
    case 'tcp':     return `tcp ${probe.host}:${probe.port}`;
    case 'ldap':    return `ldap ${probe.host}:${probe.port}${probe.bindDn ? ` (bind as ${probe.bindDn})` : ''}`;
    case 'command': return `command \`${probe.command}\`${probe.container ? ` in ${probe.container}` : ''}`;
  }
}
