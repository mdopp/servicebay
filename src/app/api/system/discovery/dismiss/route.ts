import { NextResponse } from 'next/server';
import { DigitalTwinStore } from '@/lib/store/twin';
import { deleteBundleResources } from '@/lib/discovery';
import { listNodes } from '@/lib/nodes';
import type { PodmanConnection } from '@/lib/nodes';
import { apiError } from '@/lib/api/errors';

import { requireSession } from '@/lib/api/requireSession';
export const dynamic = 'force-dynamic';

interface DismissPayload {
    bundleId?: string;
    nodeName?: string;
}

export async function POST(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

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
        return apiError(error, { tag: 'api:system:discovery:dismiss', status: 500 });
    }
}
