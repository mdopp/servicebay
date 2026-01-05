import { NextResponse } from 'next/server';
import { getTemplateYaml } from '@/lib/registry';
import { saveService } from '@/lib/manager';

export async function POST() {
    try {
        // 1. Get the template content
        const templateContent = await getTemplateYaml('nginx-web');
        if (!templateContent) {
            throw new Error('Nginx template not found');
        }

        // 2. Prepare the service configuration
        const name = 'nginx-web';
        // Replace {{PORT}} with 8080 (standard for rootless)
        const yamlContent = templateContent.replace('{{PORT}}', '8080');

        const kubeContent = `[Unit]
Description=Nginx Reverse Proxy
After=network-online.target

[Kube]
Yaml=${name}.yml

[Install]
WantedBy=default.target
`;

        // 3. Save the service
        await saveService(name, kubeContent, yamlContent, `${name}.yml`);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Failed to install nginx container:', error);
        return NextResponse.json({ error: 'Failed to install nginx container' }, { status: 500 });
    }
}
