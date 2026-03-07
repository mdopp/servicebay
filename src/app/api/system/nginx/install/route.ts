import { NextResponse } from 'next/server';
import { getTemplateYaml } from '@/lib/registry';
import { saveService } from '@/lib/manager';
import { getConfig } from '@/lib/config';

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

        // 3. Prepare the service configuration
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

        // 4. Save the service
        await saveService(name, kubeContent, yamlContent, `${name}.yml`);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to install nginx container:', error);
        return NextResponse.json({ error: 'Failed to install nginx container' }, { status: 500 });
    }
}
