'use server';

import { checkTcpConnection, setupSSHKey, verifySSHConnection } from '@/lib/ssh';
import { SSH_DIR } from '@/lib/dirs';

export async function checkConnection(host: string, port: number) {
    try {
        const isOpen = await checkTcpConnection(host, port);
        return { success: true, isOpen };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

export async function checkFullConnection(host: string, port: number, user: string, identity: string) {
    try {
        const isOpen = await checkTcpConnection(host, port);
        if (!isOpen) return { success: false, stage: 'tcp', error: 'TCP Connection Failed' };

        const auth = await verifySSHConnection(host, port, user, identity);
        if (!auth) return { success: false, stage: 'auth', error: 'SSH Authentication Failed' };

        return { success: true };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}

export async function installSSHKey(host: string, port: number, user: string, pass: string) {
    try {
        const result = await setupSSHKey(host, port, user, pass);
        return result;
    } catch (e) {
        return { success: false, logs: [String(e)] };
    }
}

export async function generateLocalKey() {
    try {
        const fs = await import('fs');
        const path = await import('path');
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        const sshDir = SSH_DIR;
          
        const keyPath = path.join(sshDir, 'id_rsa');

        if (fs.existsSync(keyPath)) {
            return { success: true, message: 'Key already exists' };
        }

        if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
        
        await execAsync(`ssh-keygen -t rsa -b 4096 -f "${keyPath}" -N ""`);
        return { success: true, message: 'Key generated' };
    } catch (e) {
        return { success: false, error: String(e) };
    }
}
