
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
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
    }, 10000); // 10s timeout
});
