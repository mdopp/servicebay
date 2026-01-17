import { NextResponse } from 'next/server';
import { DigitalTwinStore } from '@/lib/store/twin';
import { deleteBundleResources } from '@/lib/discovery';
import { listNodes } from '@/lib/nodes';
import type { PodmanConnection } from '@/lib/nodes';

export const dynamic = 'force-dynamic';

interface DismissPayload {
    bundleId?: string;
    nodeName?: string;
}

export async function POST(request: Request) {
    try {
        const body = (await request.json()) as DismissPayload;
        const bundleId = body?.bundleId?.trim();
        const nodeName = body?.nodeName?.trim() || 'Local';

        if (!bundleId) {
            return NextResponse.json({ error: 'bundleId is required' }, { status: 400 });
        }

        const store = DigitalTwinStore.getInstance();
        const node = store.nodes[nodeName];
        const targetBundle = node?.unmanagedBundles.find(bundle => bundle.id === bundleId);

        if (!targetBundle) {
            return NextResponse.json({ error: 'Bundle not found' }, { status: 404 });
        }

        let connection: PodmanConnection | undefined;
        if (nodeName && nodeName.toLowerCase() !== 'local') {
            const nodes = await listNodes();
            connection = nodes.find(n => n.Name === nodeName);
            if (!connection) {
                return NextResponse.json({ error: `Node ${nodeName} not found` }, { status: 404 });
            }
        }

        const result = await deleteBundleResources(targetBundle, connection);
        store.dismissUnmanagedBundle(nodeName, bundleId);

        return NextResponse.json({
            success: true,
            stoppedUnits: result.stoppedUnits,
            removedFiles: result.removedFiles,
            missingFiles: result.missingFiles
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete bundle';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
