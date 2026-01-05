import { CheckConfig, CheckResult } from './types';
import { MonitoringStore } from './store';
import { spawn } from 'child_process';
import vm from 'vm';
import { getExecutor, Executor } from '../executor';
import { listNodes, verifyNodeConnection } from '../nodes';

export class CheckRunner {
  static async run(check: CheckConfig): Promise<CheckResult> {
    const start = Date.now();
    let status: 'ok' | 'fail' = 'fail';
    let message = '';

    let connection;
    if (check.nodeName && check.nodeName !== 'Local') {
        const nodes = await listNodes();
        connection = nodes.find(n => n.Name === check.nodeName);
    }
    const executor = getExecutor(connection);

    try {
      switch (check.type) {
        case 'http':
          await this.runHttpCheck(check);
          status = 'ok';
          break;
        case 'ping':
          await this.runPingCheck(check.target);
          status = 'ok';
          break;
        case 'script':
          await this.runScriptCheck(check.target);
          status = 'ok';
          break;
        case 'podman':
          await this.runPodmanCheck(check.target, executor);
          status = 'ok';
          break;
        case 'service':
          await this.runServiceCheck(check.target, executor);
          status = 'ok';
          break;
        case 'systemd':
          await this.runSystemdCheck(check.target, executor);
          status = 'ok';
          break;
        case 'node':
          await this.runNodeCheck(check.target);
          status = 'ok';
          break;
        case 'fritzbox':
          const fbMsg = await this.runFritzboxCheck(check);
          if (fbMsg) message = fbMsg;
          status = 'ok';
          break;
      }
    } catch (e: unknown) {
      status = 'fail';
      message = e instanceof Error ? e.message : String(e);
    }

    const latency = Date.now() - start;
    const result: CheckResult = {
      check_id: check.id,
      timestamp: new Date().toISOString(),
      status,
      latency,
      message
    };

    MonitoringStore.saveResult(result);
    return result;
  }

  private static async runHttpCheck(check: CheckConfig) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    try {
      const res = await fetch(check.target, { signal: controller.signal });
      
      // Check Status
      const expectedStatus = check.httpConfig?.expectedStatus;
      if (expectedStatus) {
        if (res.status !== expectedStatus) {
          throw new Error(`HTTP Status ${res.status} (expected ${expectedStatus})`);
        }
      } else {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
      }

      // Check Body
      if (check.httpConfig?.bodyMatch) {
        const body = await res.text();
        const pattern = check.httpConfig.bodyMatch;
        const type = check.httpConfig.bodyMatchType || 'contains';

        if (type === 'regex') {
          const regex = new RegExp(pattern);
          if (!regex.test(body)) {
            throw new Error(`Body did not match regex: ${pattern}`);
          }
        } else {
          if (!body.includes(pattern)) {
            throw new Error(`Body did not contain: ${pattern}`);
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private static async runPingCheck(host: string) {
    return new Promise<void>((resolve, reject) => {
      const ping = spawn('ping', ['-c', '1', '-W', '2', host]);
      
      ping.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Ping failed with code ${code}`));
      });
      
      ping.on('error', (err) => reject(err));
    });
  }

  private static async runPodmanCheck(containerName: string, executor: Executor) {
    try {
        const { stdout } = await executor.exec(`podman inspect ${containerName} --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'`);
        const [status, health] = stdout.trim().split('|');
        
        if (status !== 'running') {
            throw new Error(`Container is ${status}`);
        }
        
        if (health !== 'none' && health !== 'healthy') {
            throw new Error(`Container health is ${health}`);
        }
    } catch (e) {
        // If the container is not found, podman inspect returns exit code 125 or 1
        throw new Error(`Container ${containerName} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private static async runServiceCheck(serviceName: string, executor: Executor) {
    // Managed service (user service)
    // If the user didn't provide .service extension, add it
    const unit = serviceName.endsWith('.service') ? serviceName : `${serviceName}.service`;
    
    try {
        const { stdout } = await executor.exec(`systemctl --user is-active ${unit}`);
        const status = stdout.trim();
        if (status !== 'active') {
            throw new Error(`Service is ${status}`);
        }
    } catch (e) {
        throw new Error(`Service ${unit} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private static async runSystemdCheck(unitName: string, executor: Executor) {
    // System service (system-wide)
    try {
        const { stdout } = await executor.exec(`systemctl is-active ${unitName}`);
        const status = stdout.trim();
        if (status !== 'active') {
            throw new Error(`System unit is ${status}`);
        }
    } catch (e) {
        throw new Error(`System unit ${unitName} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private static async runScriptCheck(script: string) {
    const sandbox = {
        fetch: global.fetch,
        console: { log: () => {} },
        setTimeout,
        clearTimeout,
        Buffer,
    };
    
    const context = vm.createContext(sandbox);
    
    // Wrap in async IIFE
    const code = `(async () => {
        ${script}
    })()`;
    
    try {
        const result = vm.runInContext(code, context, { timeout: 5000 });
        if (result instanceof Promise) {
            await result;
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Script failed: ${msg}`);
    }
  }

  private static async runNodeCheck(nodeName: string) {
    const result = await verifyNodeConnection(nodeName);
    if (!result.success) {
        throw new Error(`Node connection failed: ${result.error || 'Unknown error'}`);
    }
  }

  private static async runFritzboxCheck(check: CheckConfig): Promise<string> {
    const host = check.fritzboxConfig?.host || check.target || 'fritz.box';
    const port = 49000;
    const service = 'urn:schemas-upnp-org:service:WANIPConnection:1';
    const action = 'GetStatusInfo';
    const url = `http://${host}:${port}/igdupnp/control/WANIPConn1`;

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body>
<u:${action} xmlns:u="${service}" />
</s:Body>
</s:Envelope>`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SoapAction': `${service}#${action}`
            },
            body: soapBody,
            signal: controller.signal
        });

        if (!res.ok) {
            if (res.status === 401) {
                 throw new Error('FritzBox requires authentication. Please check if "Status information over UPnP" is enabled in Home Network > Network > Network Settings.');
            }
            if (res.status === 500) {
                // SOAP Fault?
                const text = await res.text();
                if (text.includes('Invalid Action')) {
                     throw new Error('FritzBox API: Invalid Action. The device might not support WANIPConnection:1.');
                }
            }
            throw new Error(`FritzBox API Error: ${res.status} ${res.statusText}`);
        }

        const text = await res.text();
        // Parse XML for NewConnectionStatus
        const match = text.match(/<NewConnectionStatus>(.*?)<\/NewConnectionStatus>/);
        if (!match) throw new Error('Invalid response from FritzBox (missing NewConnectionStatus)');
        
        const status = match[1];
        if (status !== 'Connected') {
            throw new Error(`Internet connection is ${status}`);
        }

        // Parse Uptime
        const uptimeMatch = text.match(/<NewUptime>(.*?)<\/NewUptime>/);
        const uptime = uptimeMatch ? parseInt(uptimeMatch[1], 10) : 0;
        
        // Format uptime
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        
        let uptimeStr = '';
        if (days > 0) uptimeStr += `${days}d `;
        if (hours > 0) uptimeStr += `${hours}h `;
        uptimeStr += `${minutes}m`;

        return `Connected (Uptime: ${uptimeStr})`;
    } finally {
        clearTimeout(timeout);
    }
  }
}
