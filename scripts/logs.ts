
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import readline from 'readline';

const LOG_DIR = path.join(process.cwd(), 'data', 'logs');

async function main() {
    if (!fs.existsSync(LOG_DIR)) {
        console.error('Log directory not found.');
        process.exit(1);
    }

    // List log files
    const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith('servicebay-') && f.endsWith('.log'))
        .sort()
        .reverse();

    if (files.length === 0) {
        console.log('No log files found.');
        process.exit(0);
    }

    // Pick latest
    const latest = files[0];
    const fullPath = path.join(LOG_DIR, latest);

    console.clear();
    console.log(`\x1b[36mServiceBay Log Viewer\x1b[0m`);
    console.log(`Latest File: \x1b[33m${latest}\x1b[0m`);
    console.log(`Path: ${fullPath}`);
    
    // Check if lnav exists
    let hasLnav = false;
    try {
        // Use 'command -v' for broader compatibility than 'which'
        const check = spawn('sh', ['-c', 'command -v lnav']);
        await new Promise((resolve) => check.on('close', code => {
             hasLnav = code === 0;
             resolve(null);
        }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    } catch(e) { /* ignore */ }

    // If lnav is found, skip the menu and launch it directly
    if (hasLnav) {
        console.log(`\n\x1b[32mLnav detected! Launching automatically...\x1b[0m`);
        spawn('lnav', [LOG_DIR], { stdio: 'inherit' }).on('close', () => {
             console.clear();
             console.log('Log viewer closed.');
        });
        return;
    }

    // Fallback Menu
    console.log(`\nSelect tool:`);
    console.log(`1. \x1b[32mless\x1b[0m (Built-in pager)`);
    console.log(`2. Monitor (tail -f)`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('\nOption [1-2] (default: 1): ', (ans) => {
        rl.close();
        
        let cmd = 'less';
        let args = ['+G', fullPath]; // Go to end

        if (ans === '2') {
             cmd = 'tail';
             args = ['-f', fullPath];
        }

        console.log(`Launching ${cmd}...`);
        
        const proc = spawn(cmd, args, { stdio: 'inherit' });
        proc.on('close', () => {
            console.clear();
            console.log('Log viewer closed.');
        });
    });
}

main().catch(console.error);
