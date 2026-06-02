/**
 * Probe registry (#592) — replaces the 17-arm `switch (check.type)` in
 * CheckRunner with an Open/Closed-friendly interface.
 *
 * Each `Probe` lives in its own file under `src/lib/health/probes/`
 * and self-registers via a top-level `registerProbe({...})` at module
 * import time. The barrel (`probes/index.ts`) pulls every probe in so
 * the registry is populated before `CheckRunner.run` dispatches.
 *
 * Adding a new probe is now purely additive: drop a file in probes/,
 * add it to the barrel, no edits to runner.ts.
 */

import type { CheckConfig, CheckType } from '../types';
import type { Executor } from '../../executor';

/** Mirrors the legacy runner's per-arm return shape. Probes can
 *  throw to signal failure (the dispatcher catches and reports
 *  `status: 'fail'`), return `{ status, message }` for the plain
 *  status+text cases, or attach a typed `payload` (#1539) the diagnose
 *  reader pulls off directly instead of decoding a string.
 *  Kept module-local — probes that want to type their `ctx` param
 *  pick it up via the Probe interface signature automatically. */
type ProbeResult =
  | void
  | { status: 'ok' | 'fail'; message?: string; payload?: unknown }
  | { message: string; payload?: unknown };

interface ProbeContext {
  /** Executor bound to the node the check targets (Local or remote
   *  via SSH pool). Probes that don't need shell access ignore it. */
  executor: Executor;
}

export interface Probe {
  type: CheckType;
  run(check: CheckConfig, ctx: ProbeContext): Promise<ProbeResult>;
}

const probes = new Map<CheckType, Probe>();

export function registerProbe(p: Probe): void {
  if (probes.has(p.type)) {
    // Idempotent: silently overwrite on re-register so vitest's
    // module-cache resets between tests don't crash on duplicate
    // registration.
    probes.set(p.type, p);
    return;
  }
  probes.set(p.type, p);
}

export function getProbe(type: CheckType): Probe | undefined {
  return probes.get(type);
}

export function registeredProbeTypes(): CheckType[] {
  return Array.from(probes.keys());
}
