import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { findNginxConfDir } from '@/lib/nginx/confDir';

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const nodeParam = searchParams.get('node');

        const body = await request.json();
        const { files } = body as { files: Record<string, string> };

        if (!files || typeof files !== 'object') {
            return NextResponse.json({ error: 'Invalid payload: expected { files: { "filename.conf": "content" } }' }, { status: 400 });
        }

        const result = await findNginxConfDir();
        const nodeName = nodeParam || result?.nodeName || 'Local';
        const confDir = result?.confDir;

        if (!confDir) {
            return NextResponse.json({ error: 'Could not locate nginx conf.d directory' }, { status: 404 });
        }

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
