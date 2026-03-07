import { NextResponse } from 'next/server';
import { getTemplateYaml } from '@/lib/registry';
import { saveService, startService } from '@/lib/manager';
import { getConfig } from '@/lib/config';
import { listNodes } from '@/lib/nodes';

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

        return NextResponse.json({ success: true, node: targetNode?.Name });
    } catch (error) {
        console.error('Failed to install nginx container:', error);
        return NextResponse.json({ error: 'Failed to install nginx container' }, { status: 500 });
    }
}
