import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { findNginxConfDir } from '@/lib/nginx/confDir';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const nodeParam = searchParams.get('node');

        const result = await findNginxConfDir();
        const nodeName = nodeParam || result?.nodeName || 'Local';
        const confDir = result?.confDir;

        if (!confDir) {
            return NextResponse.json({ files: {}, node: nodeName });
        }

        const executor = getExecutor(nodeName);
        let files: string[];
        try {
            files = await executor.readdir(confDir);
        } catch {
            return NextResponse.json({ files: {}, node: nodeName });
        }

        const confFiles = files.filter(f => f.endsWith('.conf'));
        const fileContents: Record<string, string> = {};

        for (const file of confFiles) {
            try {
                fileContents[file] = await executor.readFile(`${confDir}/${file}`);
            } catch {
                // skip unreadable files
            }
        }

        return NextResponse.json({ files: fileContents, node: nodeName, confDir });
    } catch (error) {
        console.error('Failed to export nginx config:', error);
        return NextResponse.json({ error: 'Failed to export nginx config' }, { status: 500 });
    }
}
