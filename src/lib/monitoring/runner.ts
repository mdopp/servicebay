import { CheckConfig, CheckResult } from './types';
import { MonitoringStore } from './store';
import { spawn } from 'child_process';
import vm from 'vm';

export class CheckRunner {
  static async run(check: CheckConfig): Promise<CheckResult> {
    const start = Date.now();
    let status: 'ok' | 'fail' = 'fail';
    let message = '';

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
          await this.runPodmanCheck(check.target);
          status = 'ok';
          break;
        case 'service':
          await this.runServiceCheck(check.target);
          status = 'ok';
          break;
        case 'systemd':
          await this.runSystemdCheck(check.target);
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

  private static async runPodmanCheck(containerName: string) {
    return new Promise<void>((resolve, reject) => {
      const inspect = spawn('podman', ['inspect', containerName, '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}']);
      
      let output = '';
      if (inspect.stdout) {
        inspect.stdout.on('data', d => output += d.toString());
      }
      
      inspect.on('close', (code) => {
        if (code !== 0) {
            return reject(new Error(`Container ${containerName} not found or error inspecting`));
        }
        
        const [status, health] = output.trim().split('|');
        
        if (status !== 'running') {
            return reject(new Error(`Container is ${status}`));
        }
        
        if (health !== 'none' && health !== 'healthy') {
            return reject(new Error(`Container health is ${health}`));
        }
        
        resolve();
      });
    });
  }

  private static async runServiceCheck(serviceName: string) {
    // Managed service (user service)
    // If the user didn't provide .service extension, add it
    const unit = serviceName.endsWith('.service') ? serviceName : `${serviceName}.service`;
    
    return new Promise<void>((resolve, reject) => {
      const cmd = spawn('systemctl', ['--user', 'is-active', unit]);
      
      let output = '';
      if (cmd.stdout) {
        cmd.stdout.on('data', d => output += d.toString());
      }
      
      cmd.on('close', () => {
        const status = output.trim();
        if (status === 'active') {
          resolve();
        } else {
          reject(new Error(`Service is ${status}`));
        }
      });
      
      cmd.on('error', (err) => reject(err));
    });
  }

  private static async runSystemdCheck(unitName: string) {
    // System service (system-wide)
    return new Promise<void>((resolve, reject) => {
      const cmd = spawn('systemctl', ['is-active', unitName]);
      
      let output = '';
      if (cmd.stdout) {
        cmd.stdout.on('data', d => output += d.toString());
      }
      
      cmd.on('close', () => {
        const status = output.trim();
        if (status === 'active') {
          resolve();
        } else {
          reject(new Error(`System unit is ${status}`));
        }
      });
      
      cmd.on('error', (err) => reject(err));
    });
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
}
