import { NetworkNode } from './types';

/**
 * NodeFactory enforces the Single Source of Truth pattern.
 * Visual properties of a NetworkNode (label, status, etc.) MUST be derived
 * strictly from the provided rawData object.
 */
export class NodeFactory {

    /**
     * Create a NetworkNode representing a Podman Container.
     * @param id Unique Node ID (prefixed)
     * @param rawData Complete Container Data Object (must include name, State, etc.)
     * @param nodeName Code specific node name (e.g. 'local', 'pi4')
     * @param metadata Additional metadata not present in rawData (e.g. source, links)
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static createContainerNode(id: string, rawData: any, nodeName: string, metadata: Record<string, unknown> = {}, parentId?: string): NetworkNode {
        // Enforce derivation
        const label = rawData.name || rawData.Names?.[0]?.replace(/^\//, '') || id.substring(0, 12);
        const subLabel = rawData.ip || (rawData.Networks ? Object.values(rawData.Networks)[0] : null) || null;
        const finalIp: string | null = typeof subLabel === 'object' ? (subLabel as { IPAddress?: string })?.IPAddress : subLabel;
        
        // Status derivation strictly from rawData
        // Accept 'running' (Podman) or boolean active (Services) - but this is container node
        const dockerStateObj = rawData.State || rawData.state;
        const booleanRunning = dockerStateObj?.Running ?? dockerStateObj?.running ?? rawData.Running ?? rawData.running;
        const stringStates = [rawData.State, rawData.state, rawData.Status, rawData.status]
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.toLowerCase());
        const status = (booleanRunning === true || stringStates.some((value) => value === 'running' || value.startsWith('up')))
            ? 'up'
            : 'down';

        return {
            id,
            type: 'container',
            label,
            subLabel: finalIp, // Handle Network object strictness
            ip: finalIp,
            status,
            node: nodeName,
            // Parent/Extent are structural, passed in
            parentNode: parentId,
            extent: parentId ? 'parent' : undefined,
            metadata,
            rawData // The Source of Truth
        };
    }

    /**
     * Create a NetworkNode representing a Systemd Managed Service.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static createServiceNode(id: string, rawData: any, nodeName: string, metadata: Record<string, any> = {}): NetworkNode {
        
        const label = rawData.name;
        // Sublabel derivation
        const ips = metadata.nodeIPs || [];
        const host = ips[0] || 'localhost';
        const subLabel = nodeName === 'local' 
            ? `Managed Service (${host})` 
            : `Service (${nodeName} - ${host})`;

        // Status derivation
        const status = rawData.active ? 'up' : 'down';

        return {
            id,
            type: 'service',
            label,
            subLabel,
            status,
            node: nodeName,
            metadata,
            rawData
        };
    }

    /**
     * Create a NetworkNode representing the Reverse Proxy (Nginx).
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static createProxyNode(id: string, rawData: any, nodeName: string, metadata: Record<string, any> = {}): NetworkNode {
        const label = rawData.name || 'nginx-web';
        const ips = metadata.nodeIPs || [];
        const host = ips[0] || 'localhost';
        const subLabel = nodeName === 'local' 
            ? `Reverse Proxy (${host})` 
            : `Proxy (${nodeName} - ${host})`;

        // Proxy status usually depends on the container/service being active
        // rawData for proxy usually includes 'active' or 'status'
        const status = (rawData.active === true || rawData.status === 'running' || rawData.State === 'running') ? 'up' : 'down';

        return {
            id,
            type: 'proxy',
            label,
            subLabel,
            status,
            node: nodeName,
            metadata: {
                ...metadata,
                source: 'Nginx Config'
            },
            rawData
        };
    }

    /**
     * Create a Generic/Device Node (Virtual, External, etc.)
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static createDeviceNode(id: string, rawData: any, nodeName: string, metadata: Record<string, any> = {}): NetworkNode {
         return {
            id,
            type: rawData.type || 'device',
            label: rawData.name || rawData.label || id,
            subLabel: rawData.subLabel || null,
            status: rawData.active ? 'up' : 'down', // Default
            node: nodeName,
            metadata,
            rawData
         };
    }
}
