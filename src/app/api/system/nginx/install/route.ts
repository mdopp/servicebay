import { NextResponse } from 'next/server';
import { getTemplateYaml } from '@/lib/registry';
import { saveService, startService } from '@/lib/manager';
import { getConfig } from '@/lib/config';
import { listNodes } from '@/lib/nodes';
import { getExecutor } from '@/lib/executor';
import { logger } from '@/lib/logger';

export async function POST() {
    try {
        // 1. Get the template content
        const templateContent = await getTemplateYaml('nginx-web');
        if (!templateContent) {
            throw new Error('Nginx template not found');
        }

        // 2. Read DATA_DIR from config
        const config = await getConfig();
        const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data';

        // 3. Find the target node (default node, or first available)
        const nodes = await listNodes();
        const targetNode = nodes.find(n => n.Default) || nodes[0];
        const connection = targetNode?.URI ? targetNode : undefined;

        // 4. Prepare the service configuration
        const name = 'nginx-web';
        // Replace variables (8080/8443 standard for rootless)
        const yamlContent = templateContent
            .replace(/\{\{PORT\}\}/g, '8080')
            .replace(/\{\{SSL_PORT\}\}/g, '8443')
            .replace(/\{\{DATA_DIR\}\}/g, dataDir);

        const kubeContent = `[Unit]
Description=Nginx Reverse Proxy
After=network-online.target

[Kube]
Yaml=${name}.yml

[Install]
WantedBy=default.target
`;

        // 5. Save the service to the target node and start it
        await saveService(name, kubeContent, yamlContent, `${name}.yml`, connection);
        await startService(name, connection);

        // 6. Clean up the install-nginx oneshot service (created by CoreOS install script)
        const nodeName = targetNode?.Name || 'Local';
        await cleanupInstallerService(nodeName);

        return NextResponse.json({ success: true, node: targetNode?.Name });
    } catch (error) {
        console.error('Failed to install nginx container:', error);
        return NextResponse.json({ error: 'Failed to install nginx container' }, { status: 500 });
    }
}

/**
 * Remove the install-nginx oneshot service left behind by the CoreOS install script.
 * Best-effort — failures are logged but don't block the install.
 */
async function cleanupInstallerService(nodeName: string) {
    const executor = getExecutor(nodeName);
    try {
        await executor.exec('systemctl --user stop install-nginx.service');
    } catch { /* may already be stopped */ }
    try {
        await executor.exec('systemctl --user disable install-nginx.service');
    } catch { /* may not be enabled */ }
    try {
        await executor.exec('rm -f ~/.config/systemd/user/install-nginx.service');
        await executor.exec('rm -f ~/.config/systemd/user/default.target.wants/install-nginx.service');
        await executor.exec('systemctl --user daemon-reload');
        await executor.exec('systemctl --user reset-failed install-nginx.service 2>/dev/null || true');
        logger.info('NginxInstall', `Cleaned up install-nginx oneshot on ${nodeName}`);
    } catch (e) {
        logger.warn('NginxInstall', `Could not fully clean up install-nginx service: ${e}`);
    }
}
