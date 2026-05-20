/**
 * Basic probes (#592) — the simple cases that don't need their own
 * file. Each registers via `registerProbe` at module import time.
 *
 * If any of these grows beyond ~40 lines of body, split it out into
 * its own probe file (mirror the pattern in domain.ts / letsdebug.ts).
 */

import vm from 'vm';
import { registerProbe } from './registry';
import { assertHttpTargetAllowed } from '../ssrfGuard';
import { ContainerId, ServiceName, HostString } from '../../api/schemas';
import { verifyNodeConnection } from '../../nodes/verify';
import { agentManager } from '../../agent/manager';
import { getConfig } from '../../config';

registerProbe({
  type: 'http',
  async run(check) {
    await assertHttpTargetAllowed(check.target);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(check.target, { signal: controller.signal });
      const expectedStatus = check.httpConfig?.expectedStatus;
      if (expectedStatus) {
        if (res.status !== expectedStatus) {
          throw new Error(`HTTP Status ${res.status} (expected ${expectedStatus})`);
        }
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      if (check.httpConfig?.bodyMatch) {
        const body = await res.text();
        const pattern = check.httpConfig.bodyMatch;
        const type = check.httpConfig.bodyMatchType || 'contains';
        if (type === 'regex') {
          if (!new RegExp(pattern).test(body)) throw new Error(`Body did not match regex: ${pattern}`);
        } else if (!body.includes(pattern)) {
          throw new Error(`Body did not contain: ${pattern}`);
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  },
});

registerProbe({
  type: 'ping',
  async run(check, ctx) {
    const validatedHost = HostString.parse(check.target);
    try {
      const { stdout } = await ctx.executor.execArgv(['ping', '-c', '1', '-W', '2', validatedHost]);
      if (!stdout.includes('1 received')) throw new Error('Ping failed: no reply');
    } catch (e) {
      throw new Error(`Ping ${validatedHost} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});

registerProbe({
  type: 'podman',
  async run(check, ctx) {
    const validated = ContainerId.parse(check.target);
    try {
      const { stdout } = await ctx.executor.execArgv([
        'podman', 'inspect', validated,
        '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      ]);
      const [status, health] = stdout.trim().split('|');
      if (status !== 'running') throw new Error(`Container is ${status}`);
      if (health !== 'none' && health !== 'healthy') throw new Error(`Container health is ${health}`);
    } catch (e) {
      throw new Error(`Container ${validated} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});

registerProbe({
  type: 'service',
  async run(check, ctx) {
    const validated = ServiceName.parse(check.target);
    const unit = validated.includes('.') ? validated : `${validated}.service`;
    try {
      const { stdout } = await ctx.executor.execArgv(['systemctl', '--user', 'is-active', unit]);
      const status = stdout.trim();
      if (status !== 'active') throw new Error(`Service is ${status}`);
    } catch (e) {
      throw new Error(`Service ${unit} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});

registerProbe({
  type: 'systemd',
  async run(check, ctx) {
    const validated = ServiceName.parse(check.target);
    try {
      const { stdout } = await ctx.executor.execArgv(['systemctl', 'is-active', validated]);
      const status = stdout.trim();
      if (status !== 'active') throw new Error(`System unit is ${status}`);
    } catch (e) {
      throw new Error(`System unit ${validated} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});

registerProbe({
  type: 'script',
  async run(check) {
    const safeSetTimeout = (fn: (...args: unknown[]) => void, ms: number) => setTimeout(fn, Math.min(ms, 5000));
    const safeClearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
    const sandbox = { fetch: global.fetch, console: { log: () => {} }, setTimeout: safeSetTimeout, clearTimeout: safeClearTimeout };
    const context = vm.createContext(sandbox);
    const code = `(async () => { ${check.target} })()`;
    try {
      const result = vm.runInContext(code, context, { timeout: 5000 });
      if (result && typeof result.then === 'function') await result;
    } catch (e: unknown) {
      throw new Error(`Script failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
});

registerProbe({
  type: 'node',
  async run(check) {
    const result = await verifyNodeConnection(check.target);
    if (!result.success) throw new Error(`Node connection failed: ${result.error || 'Unknown error'}`);
  },
});

registerProbe({
  type: 'agent',
  async run(check) {
    const agent = agentManager.getAgent(check.target);
    let health = agent.getHealth();
    if (!health.isConnected) {
      try {
        await agent.start();
        health = agent.getHealth();
      } catch (e) {
        throw new Error(`Agent disconnected & restart failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!health.isConnected) throw new Error(`Agent is disconnected (Last error: ${health.lastError || 'None'})`);
    const silence = Date.now() - health.lastSync;
    if (silence > 300000) throw new Error(`Agent connection stalled? No data for ${Math.floor(silence/1000)}s`);
    let status = 'Connected.';
    if (health.messageCount > 0) status += ` Msgs: ${health.messageCount}`;
    if (health.errorCount > 0) status += ` Errs: ${health.errorCount}`;
    return { message: status };
  },
});

registerProbe({
  type: 'backup',
  async run() {
    const config = await getConfig();
    const backup = config.backup;
    if (!backup?.enabled) throw new Error('Backup sync is not enabled');
    if (!backup.lastRun) throw new Error('No backup has been run yet');
    if (backup.lastStatus === 'error') throw new Error(`Last backup failed: ${backup.lastMessage || 'Unknown error'}`);
    const lastRun = new Date(backup.lastRun).getTime();
    const now = Date.now();
    const intervalMs = {
      hourly: 60 * 60 * 1000,
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 31 * 24 * 60 * 60 * 1000,
    }[backup.schedule] || 24 * 60 * 60 * 1000;
    if (now - lastRun > intervalMs * 2) {
      throw new Error(`Backup is overdue: last run ${Math.round((now - lastRun) / 3600000)}h ago`);
    }
    const durationStr = backup.lastDuration ? ` in ${backup.lastDuration}s` : '';
    return { message: `Last backup OK${durationStr} (${new Date(backup.lastRun).toLocaleString()})` };
  },
});

registerProbe({
  type: 'fritzbox',
  async run(check) {
    const host = check.fritzboxConfig?.host || check.target || 'fritz.box';
    const port = 49000;
    const service = 'urn:schemas-upnp-org:service:WANIPConnection:1';
    const action = 'GetStatusInfo';
    const url = `http://${host}:${port}/igdupnp/control/WANIPConn1`;
    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body><u:${action} xmlns:u="${service}" /></s:Body></s:Envelope>`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SoapAction': `${service}#${action}` },
        body: soapBody,
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error('FritzBox requires authentication. Please check if "Status information over UPnP" is enabled in Home Network > Network > Network Settings.');
        if (res.status === 500) {
          const text = await res.text();
          if (text.includes('Invalid Action')) throw new Error('FritzBox API: Invalid Action. The device might not support WANIPConnection:1.');
        }
        throw new Error(`FritzBox API Error: ${res.status} ${res.statusText}`);
      }
      const text = await res.text();
      const match = text.match(/<NewConnectionStatus>(.*?)<\/NewConnectionStatus>/);
      if (!match) throw new Error('Invalid response from FritzBox (missing NewConnectionStatus)');
      if (match[1] !== 'Connected') throw new Error(`Internet connection is ${match[1]}`);
      const uptimeMatch = text.match(/<NewUptime>(.*?)<\/NewUptime>/);
      const uptime = uptimeMatch ? parseInt(uptimeMatch[1], 10) : 0;
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      let uptimeStr = '';
      if (days > 0) uptimeStr += `${days}d `;
      if (hours > 0) uptimeStr += `${hours}h `;
      uptimeStr += `${minutes}m`;
      return { message: `Connected (Uptime: ${uptimeStr})` };
    } finally {
      clearTimeout(timeout);
    }
  },
});
