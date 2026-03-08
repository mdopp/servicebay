import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { getConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';

export const dynamic = 'force-dynamic';

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

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const nodeParam = searchParams.get('node');
        const nodeName = nodeParam || await findNginxNode();

        const config = await getConfig();
        const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data';
        const confDir = `${dataDir}/nginx/conf.d`;

        const executor = getExecutor(nodeName);
        let files: string[];
        try {
            files = await executor.readdir(confDir);
        } catch {
            return NextResponse.json({ files: {}, node: nodeName });
        }

        const confFiles = files.filter(f => f.endsWith('.conf'));
        const result: Record<string, string> = {};

        for (const file of confFiles) {
            try {
                result[file] = await executor.readFile(`${confDir}/${file}`);
            } catch {
                // skip unreadable files
            }
        }

        return NextResponse.json({ files: result, node: nodeName });
    } catch (error) {
        console.error('Failed to export nginx config:', error);
        return NextResponse.json({ error: 'Failed to export nginx config' }, { status: 500 });
    }
}
