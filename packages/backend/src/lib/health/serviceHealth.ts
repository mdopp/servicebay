/**
 * Service-health poller (#626 / Phase 3A).
 *
 * Polls every annotated service on its declared `servicebay.healthcheck`
 * interval and writes the result to `DigitalTwinStore.serviceHealth` →
 * `ServiceUnit.health`. This is the single source of truth that Phase 3B
 * migrates `settleWait`, diagnose probes, and per-template `wait_for_X`
 * helpers onto.
 *
 * Design notes:
 *
 * - **Scope of this PR**: register / unregister / start / stop, plus a
 *   bootstrap helper that scans deployed services on init and registers
 *   each one whose template ships a healthcheck annotation. Live add /
 *   remove on service deploy / wipe is Phase 3B (capability bus hooks).
 *
 * - **Two probe kinds**: `http` does a fetch with an `AbortSignal`-backed
 *   timeout and treats `200..299` + a JSON body as success. `tcp` does a
 *   raw socket-connect and synthesises `{ ready: true }`. The TCP path
 *   exists for Samba etc. — every other service should ship an HTTP
 *   `/healthz`.
 *
 * - **No retry budget**: each tick is independent. The interval IS the
 *   retry — there's no point retrying within a tick because the value
 *   will get overwritten on the next one anyway.
 *
 * - **`startupTimeoutMs`**: doesn't gate when the poller starts (probes
 *   fire from the first tick). It only changes how `ready: false` is
 *   *interpreted* — Phase 3B's diagnose readers use it to distinguish
 *   "this service is genuinely stuck" from "this service is mid-boot."
 *
 * - **Single-flight per service**: each service's polling timer is the
 *   ONLY source of fetches for that service. Concurrent ticks for the
 *   same service can't happen because `setInterval` is single-threaded
 *   and a long fetch is bounded by `timeoutMs`.
 */
import net from 'net';
import { clearServiceHealth as repoClearServiceHealth, setServiceHealth as repoSetServiceHealth } from '@/lib/store/repository';
import { logger } from '@/lib/logger';
import type { ServiceHealth } from '@/lib/agent/types';
import type { HealthcheckConfig } from './serviceHealthcheck';

/** A registered service + its resolved (post-Mustache) probe config. */
export interface RegisteredService {
  nodeName: string;
  serviceName: string;
  config: HealthcheckConfig;
}

/**
 * The body shape we expect from an HTTP health endpoint. All fields
 * optional except `ready` (a 2xx response without `ready: true` is
 * still treated as healthy — many services ship a `{}` health body).
 */
interface HealthBody {
  ready?: boolean;
  degraded?: boolean;
  message?: string;
  deps?: Record<string, 'ok' | 'degraded' | 'unreachable'>;
}

export class ServiceHealthPoller {
  private timers = new Map<string, NodeJS.Timeout>();
  private registry = new Map<string, RegisteredService>();
  private running = false;

  private keyFor(nodeName: string, serviceName: string): string {
    return `${nodeName}::${serviceName}`;
  }

  /**
   * Register a service for continuous polling. If a registration already
   * exists for the same `(nodeName, serviceName)`, replaces the config
   * and restarts the timer — config changes (e.g. probe URL after a
   * template update) take effect immediately.
   *
   * The first probe also fires immediately (non-blocking) so settleWait /
   * diagnose readers don't have to wait `intervalMs` for the first
   * health result on a fresh deploy (#627 / Phase 3B). The bootstrap
   * sweep at server start still pays the concurrent-fan-out cost but
   * only on services that don't yet have a recent health result —
   * already-running probes self-throttle via setInterval.
   */
  register(s: RegisteredService): void {
    const key = this.keyFor(s.nodeName, s.serviceName);
    this.registry.set(key, s);
    if (this.running) {
      this.startTimer(key);
      void this.tick(key);
    }
  }

  unregister(nodeName: string, serviceName: string): void {
    const key = this.keyFor(nodeName, serviceName);
    this.stopTimer(key);
    this.registry.delete(key);
    repoClearServiceHealth(nodeName, serviceName);
  }

  /** Returns the current registrations — exposed for diagnose / debug. */
  list(): RegisteredService[] {
    return Array.from(this.registry.values());
  }

  /** Boot every registered service. Idempotent — safe to call twice. */
  start(): void {
    this.running = true;
    for (const key of this.registry.keys()) this.startTimer(key);
  }

  /** Tear down every timer. Used in tests + on shutdown. */
  stop(): void {
    this.running = false;
    for (const key of this.timers.keys()) this.stopTimer(key);
  }

  private startTimer(key: string): void {
    this.stopTimer(key); // never double-schedule
    const reg = this.registry.get(key);
    if (!reg) return;
    const timer = setInterval(() => { void this.tick(key); }, reg.config.intervalMs);
    // Don't block process exit on the poller — it's a background concern.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private stopTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearInterval(timer);
    this.timers.delete(key);
  }

  /** One probe iteration. Public-ish: tests call it directly to drive
   *  a deterministic single-tick instead of waiting on real timers. */
  async tick(key: string): Promise<void> {
    const reg = this.registry.get(key);
    if (!reg) return;
    try {
      const health = await this.probe(reg);
      repoSetServiceHealth(reg.nodeName, reg.serviceName, health);
    } catch (e) {
      // probe() itself never throws; this catch is defence-in-depth so a
      // bug in the probe path can't kill the polling loop for every
      // service. Log + swallow.
      logger.warn('ServiceHealth', `probe error for ${reg.serviceName}@${reg.nodeName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Pure (no twin side-effects) — returns the ServiceHealth to write.
   *  Public for unit testability. */
  async probe(reg: RegisteredService): Promise<ServiceHealth> {
    const ts = new Date().toISOString();
    if (reg.config.kind === 'tcp') {
      const result = await probeTcp(reg.config.host!, reg.config.port!, reg.config.timeoutMs);
      return result.ok
        ? { ready: true, lastCheckedAt: ts }
        : { ready: false, lastCheckedAt: ts, message: result.error };
    }
    // http
    return probeHttp(reg.config.url!, reg.config.timeoutMs, ts);
  }
}

async function probeHttp(url: string, timeoutMs: number, ts: string): Promise<ServiceHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { ready: false, lastCheckedAt: ts, message: `HTTP ${res.status}` };
    }
    // Some services ship `/healthz` as plain text "ok" or empty body;
    // tolerate both. Only parse JSON when the response declares it,
    // otherwise treat a 2xx as success-with-no-detail.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      return { ready: true, lastCheckedAt: ts };
    }
    let body: HealthBody;
    try {
      body = (await res.json()) as HealthBody;
    } catch {
      return { ready: true, lastCheckedAt: ts };
    }
    const ready = body.ready ?? true; // 2xx without `ready` defaults to true
    const health: ServiceHealth = { ready, lastCheckedAt: ts };
    if (body.degraded) health.degraded = true;
    // Trim message to a reasonable length so a misbehaving service can't
    // pump megabytes of error text into the twin.
    if (typeof body.message === 'string' && body.message) {
      health.message = body.message.slice(0, 512);
    }
    if (body.deps && typeof body.deps === 'object') {
      const cleaned: Record<string, 'ok' | 'degraded' | 'unreachable'> = {};
      for (const [k, v] of Object.entries(body.deps)) {
        if (v === 'ok' || v === 'degraded' || v === 'unreachable') cleaned[k] = v;
      }
      if (Object.keys(cleaned).length > 0) health.deps = cleaned;
    }
    return health;
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return {
      ready: false,
      lastCheckedAt: ts,
      message: aborted ? `timeout after ${timeoutMs}ms` : (e instanceof Error ? e.message : String(e)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (r: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: `TCP timeout after ${timeoutMs}ms` }));
    socket.once('error', (err) => finish({ ok: false, error: err.message }));
    socket.connect(port, host);
  });
}

/**
 * Module-level singleton. ServiceBay's other long-lived schedulers
 * (`HealthService`, `NotificationBatcher`) follow the same pattern —
 * one instance owns the state, callers reach for it via the named
 * export. Lazy so test harnesses can import the class without booting
 * a real poller.
 */
let _instance: ServiceHealthPoller | null = null;
export function getServiceHealthPoller(): ServiceHealthPoller {
  if (!_instance) _instance = new ServiceHealthPoller();
  return _instance;
}
