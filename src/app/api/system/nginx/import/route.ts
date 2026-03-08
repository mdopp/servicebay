import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { getConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';

async function findNginxNode(): Promise<string> {
    const twinStore = DigitalTwinStore.getInstance();
    const nodeNames = Object.keys(twinStore.nodes);
    if (nodeNames.length === 0) nodeNames.push('Local');

    for (const nodeName of nodeNames) {
        const services = await ServiceManager.listServices(nodeName);
        const nginxService = services.find(s =>
            s.name === 'nginx-web' ||
            s.name.includes('nginx') ||
            s.description?.toLowerCase().includes('nginx')
        );
        if (nginxService) return nodeName;
    }
    return 'Local';
}

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const nodeParam = searchParams.get('node');

        const body = await request.json();
        const { files } = body as { files: Record<string, string> };

        if (!files || typeof files !== 'object') {
            return NextResponse.json({ error: 'Invalid payload: expected { files: { "filename.conf": "content" } }' }, { status: 400 });
        }

        const nodeName = nodeParam || await findNginxNode();
        const config = await getConfig();
        const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data';
        const confDir = `${dataDir}/nginx/conf.d`;

        const executor = getExecutor(nodeName);

        // Ensure conf.d directory exists on the target node
        try {
            await executor.mkdir(confDir);
        } catch {
            // may already exist
        }

        const imported: string[] = [];

        for (const [filename, content] of Object.entries(files)) {
            // Only allow .conf files to prevent path traversal
            if (!filename.endsWith('.conf') || filename.includes('/') || filename.includes('..')) {
                continue;
            }
            await executor.writeFile(`${confDir}/${filename}`, content);
            imported.push(filename);
        }

        // Reload nginx if it's running
        try {
            await executor.exec('podman exec nginx-web nginx -s reload');
        } catch {
            // nginx might not be running yet
        }

        return NextResponse.json({ success: true, imported, node: nodeName });
    } catch (error) {
        console.error('Failed to import nginx config:', error);
        return NextResponse.json({ error: 'Failed to import nginx config' }, { status: 500 });
    }
}
