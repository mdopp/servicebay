'use server';

import { checkTcpConnection, setupSSHKey } from '@/lib/ssh';

export async function checkConnection(host: string, port: number) {
    try {
        const isOpen = await checkTcpConnection(host, port);
        return { success: true, isOpen };
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
