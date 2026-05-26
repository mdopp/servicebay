
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'path';

describe('Python Agent V4', () => {
    const agentScript = path.resolve(__dirname, 'agent.py');

    it('should output valid JSON on startup with --once flag', async () => {
        const output = await new Promise<string>((resolve, reject) => {
            const python = spawn('python3', [agentScript, '--once']);
            let data = '';
            let error = '';

            python.stdout.on('data', (chunk) => {
                data += chunk.toString();
            });

            python.stderr.on('data', (chunk) => {
                error += chunk.toString();
            });

            python.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Agent exited with code ${code}. Error: ${error}`));
                } else {
                    resolve(data);
                }
            });
        });

        // Output should be null-byte separated JSONs (or newline if local test environment behaves differently, but agent uses \0)
        // We split by \0 to be safe
        const messages = output.split('\0')
            .filter(str => str.trim().length > 0)
            .map(str => JSON.parse(str));

        expect(messages.length).toBeGreaterThan(0);
        
        // Check if we received the expected partial updates
        const containerMsg = messages.find(m => m.type === 'SYNC_PARTIAL' && m.payload?.containers);
        const serviceMsg = messages.find(m => m.type === 'SYNC_PARTIAL' && m.payload?.services);
        const volumeMsg = messages.find(m => m.type === 'SYNC_PARTIAL' && m.payload?.volumes);
        
        expect(containerMsg).toBeDefined();
        expect(serviceMsg).toBeDefined();
        expect(volumeMsg).toBeDefined();
        
        // Check data types
        expect(Array.isArray(containerMsg.payload.containers)).toBe(true);
        expect(Array.isArray(serviceMsg.payload.services)).toBe(true);
        expect(Array.isArray(volumeMsg.payload.volumes)).toBe(true);
    }, 30000); // 30s timeout — spawning python3 + podman ps under parallel-test load can take >10s on a loaded host

    it('handle_command must not shadow the module-level subprocess import', async () => {
        // Regression for the bug observed live on 192.168.178.100 today:
        // a function-local `import subprocess` inside handle_command made
        // Python treat `subprocess` as a local name throughout the
        // function, so the earlier `subprocess.Popen` in the exec_stream
        // branch UnboundLocalError'd on every post-deploy that used
        // exec_stream. Every install of open-webui died with "cannot
        // access local variable 'subprocess'".
        //
        // The only legitimate import is the module-level one at the top
        // of agent.py. Any other `import subprocess` line anywhere in
        // the file is a regression that breaks post-deploy.
        const fs = await import('node:fs/promises');
        const content = await fs.readFile(agentScript, 'utf-8');
        const lines = content.split('\n');
        const importLines: Array<{ lineNum: number; line: string }> = [];
        lines.forEach((line, idx) => {
            // Match `import subprocess` or `from subprocess import ...`,
            // tolerate any leading whitespace (would catch function-scope
            // re-imports) — but the module-level one starts at column 0.
            if (/^\s*(import\s+subprocess|from\s+subprocess\s+import)\b/.test(line)) {
                importLines.push({ lineNum: idx + 1, line: line.trim() });
            }
        });
        // Exactly one import expected, and it must be unindented (module-level).
        expect(importLines.length, `Found ${importLines.length} subprocess imports — only the module-level one at line 4 should exist. Extras: ${JSON.stringify(importLines)}`).toBe(1);
        expect(/^import subprocess/.test(importLines[0].line), `subprocess import must be at module-level (no leading whitespace). Got: ${JSON.stringify(importLines[0])}`).toBe(true);
    });
});
