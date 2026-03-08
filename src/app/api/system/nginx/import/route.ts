import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { findNginxConfDir } from '@/lib/nginx/confDir';
import { extractNginxConfFromBackup } from '@/lib/nginx/backupExtract';

export async function POST(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const nodeParam = searchParams.get('node');

        const contentType = request.headers.get('content-type') || '';
        let files: Record<string, string>;

        if (contentType.includes('multipart/form-data')) {
            // Full backup tar.gz upload
            const formData = await request.formData();
            const file = formData.get('file') as File | null;
            if (!file) {
                return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
            }
            const buffer = Buffer.from(await file.arrayBuffer());
            const extracted = await extractNginxConfFromBackup(buffer);
            if (!extracted || Object.keys(extracted).length === 0) {
                return NextResponse.json({
                    error: 'No nginx .conf files found in backup. '
                        + 'Expected service-data with nginx conf.d contents (e.g. service-data/etc-nginx-conf.d/*.conf).'
                }, { status: 400 });
            }
            files = extracted;
        } else {
            // JSON import (existing format)
            const body = await request.json();
            files = body.files as Record<string, string>;
            if (!files || typeof files !== 'object') {
                return NextResponse.json({ error: 'Invalid payload: expected { files: { "filename.conf": "content" } }' }, { status: 400 });
            }
        }

        const result = await findNginxConfDir();
        const nodeName = nodeParam || result?.nodeName || 'Local';
        const confDir = result?.confDir;

        if (!confDir) {
            return NextResponse.json({
                error: result?.reason || 'Could not locate nginx conf.d directory',
                debug: result?.debug || [],
                node: nodeName
            }, { status: 404 });
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
