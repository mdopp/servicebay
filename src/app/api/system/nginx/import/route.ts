import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { getConfig } from '@/lib/config';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { files } = body as { files: Record<string, string> };

        if (!files || typeof files !== 'object') {
            return NextResponse.json({ error: 'Invalid payload: expected { files: { "filename.conf": "content" } }' }, { status: 400 });
        }

        const config = await getConfig();
        const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data';
        const confDir = `${dataDir}/nginx/conf.d`;

        const executor = getExecutor('Local');
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

        return NextResponse.json({ success: true, imported });
    } catch (error) {
        console.error('Failed to import nginx config:', error);
        return NextResponse.json({ error: 'Failed to import nginx config' }, { status: 500 });
    }
}
