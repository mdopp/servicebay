/**
 * The edge passes that run after the structural edges exist: duplicate merge,
 * then the three "extra truth" sources — observed socket flows (#505), declared
 * template dependencies (#505 PR-2) and env-target inference (#2175).
 *
 * Extracted verbatim from `service.ts` (#2740). All three are best-effort by
 * design: a store read or parse failure must never break the graph, so each
 * swallows its own error with the same warning it always logged.
 */
import type { NetworkNode, NetworkEdge } from './types';
import type { ServiceUnit } from '../agent/types';
import type { NodeTwin } from '../store/twin';
import { getActiveEdges } from './flowsStore';
import { parseTemplateDependencies } from '../stackInstall/dependencies';
import { logger } from '../logger';
import {
    inferEnvEdges,
    buildEnvInferenceTarget,
    extractPodEnv,
    type EnvSource,
    type EnvInferenceTarget,
} from './inferredEdges';

/**
 * 7. Post-Processing: Merge duplicate edges (same source/target).
 * This cleans up the graph by combining multiple port connections into a single edge.
 */
export function mergeDuplicateEdges(edges: NetworkEdge[]): NetworkEdge[] {
    const mergedEdges: NetworkEdge[] = [];
    const edgeMap = new Map<string, NetworkEdge[]>();

    edges.forEach(edge => {
        const key = `${edge.source}|${edge.target}`;
        if (!edgeMap.has(key)) edgeMap.set(key, []);
        edgeMap.get(key)!.push(edge);
    });

    edgeMap.forEach((group) => {
        if (group.length === 1) {
            mergedEdges.push(group[0]);
        } else {
            const primary = group[0];
            const labels = Array.from(new Set(group.map(e => e.label))).filter(Boolean).sort().join(', ');

            mergedEdges.push({
                ...primary,
                id: `merged-${primary.source}-${primary.target}`,
                label: labels,
                // Use the first port as primary — the graph mainly renders 'label'.
                port: primary.port
            });
        }
    });

    return mergedEdges;
}

/**
 * #505 — observed service↔service edges from the socket-flow sampler. Appended
 * after the structural-edge merge so they stay visually distinct
 * (`kind: 'observed'`) instead of being folded into a proxy/container edge for
 * the same pair. Best-effort: a store read failure must never break the graph.
 */
export async function appendObservedEdges(
    mergedEdges: NetworkEdge[],
    nodes: NetworkNode[],
    prefix: (id: string) => string,
): Promise<void> {
    try {
        const observed = await getActiveEdges();
        if (observed.length === 0) return;
        const nodeIds = new Set(nodes.map(n => n.id));
        for (const f of observed) {
            const source = prefix(`service-${f.srcService}`);
            const target = prefix(`service-${f.dstService}`);
            // Only draw an edge between service nodes that exist in this node's graph.
            if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
            mergedEdges.push({
                id: `observed-${source}-${target}-${f.dstPort}`,
                source,
                target,
                label: `${f.dstPort}`,
                protocol: 'tcp',
                port: f.dstPort,
                state: 'active',
                kind: 'observed',
                lastSeen: f.lastSeen,
                observedCount: f.count,
            });
        }
    } catch (e) {
        logger.warn('NetworkService', `observed-edge synthesis skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * #505 PR-2 — declared dependency edges. Each managed service's rendered
 * template.yml carries a `servicebay.dependencies` annotation; we emit an edge
 * per (src, dep) pair so the network map can render dashed "author intent"
 * lines alongside the observed traffic. The FE rendering of `kind: 'declared'`
 * shipped in #813. Best-effort — a parse failure must never break the graph.
 */
export function appendDeclaredEdges(params: {
    mergedEdges: NetworkEdge[];
    nodes: NetworkNode[];
    services: ServiceUnit[];
    twinNode: NodeTwin;
    prefix: (id: string) => string;
}): void {
    const { mergedEdges, nodes, services, twinNode, prefix } = params;
    try {
        const nodeIds = new Set(nodes.map(n => n.id));
        const fileMap = twinNode.files || {};
        // Build a baseName → service.name lookup so a dep "auth" resolves
        // to the deployed service "auth.service".
        const serviceByBase = new Map<string, string>();
        for (const svc of services) {
            if (!svc.isManaged) continue;
            const base = svc.name.replace(/\.service$/, '');
            serviceByBase.set(base, svc.name);
        }

        const readRenderedYaml = (baseName: string) => readKubeChainYaml(fileMap, baseName);

        // Cache target → port so the inner loop doesn't re-parse for every
        // dependency declaration pointing at the same target.
        const portByTargetBase = new Map<string, number>();
        const portFor = (baseName: string): number => {
            if (portByTargetBase.has(baseName)) return portByTargetBase.get(baseName)!;
            const content = readRenderedYaml(baseName);
            const port = content ? readPrimaryTcpPort(content) : 0;
            portByTargetBase.set(baseName, port);
            return port;
        };

        for (const svc of services) {
            if (!svc.isManaged) continue;
            const base = svc.name.replace(/\.service$/, '');
            const yamlContent = readRenderedYaml(base);
            if (!yamlContent) continue;

            const deps = parseTemplateDependencies(yamlContent);
            if (deps.length === 0) continue;

            const srcId = prefix(`service-${svc.name}`);
            if (!nodeIds.has(srcId)) continue;

            for (const depBase of deps) {
                const depServiceName = serviceByBase.get(depBase);
                if (!depServiceName) continue;
                const dstId = prefix(`service-${depServiceName}`);
                if (!nodeIds.has(dstId)) continue;
                if (srcId === dstId) continue;
                const targetPort = portFor(depBase);
                mergedEdges.push({
                    id: `declared-${srcId}-${dstId}`,
                    source: srcId,
                    target: dstId,
                    // Label drives the on-edge text; the FE's `labelForEdgeKind`
                    // adds the "(declared)" suffix when kind === 'declared', so
                    // a non-empty label here becomes e.g. "9091 (declared)".
                    label: targetPort > 0 ? `${targetPort}` : 'declared',
                    protocol: 'tcp',
                    port: targetPort,
                    state: 'active',
                    kind: 'declared',
                });
            }
        }
    } catch (e) {
        logger.warn('NetworkService', `declared-edge synthesis skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * #2175 — env-target inference. Services that bind localhost and declare
 * nothing (claude-dev, solaris-tts/whisper, exhibitor-dashboard) produce zero
 * edges from the four sources above and float as loose components. Scan each
 * service node's env for a `http(s)://host:port` / `host:port` value naming
 * another node and emit a `kind: 'inferred'` edge labelled with the env-var
 * name, deduped against the edges above. Best-effort.
 */
export function appendInferredEnvEdges(params: {
    mergedEdges: NetworkEdge[];
    nodes: NetworkNode[];
    services: ServiceUnit[];
    twinNode: NodeTwin;
    prefix: (id: string) => string;
}): void {
    const { mergedEdges, nodes, services, twinNode, prefix } = params;
    try {
        // Build resolvable targets from every node: aliases = base service
        // name, container names, bound host IPs; hostPorts = its host-side
        // published ports (for the localhost-bound port-only match).
        const targets: EnvInferenceTarget[] = nodes.map(node =>
            buildEnvInferenceTarget(node),
        );

        // Collect env from each managed service's rendered pod yaml.
        const envSources: EnvSource[] = [];
        const fileMapEnv = twinNode.files || {};
        const readYamlForBase = (baseName: string): string | null => {
            const kubeKey = Object.keys(fileMapEnv).find(k => k.endsWith(`/${baseName}.kube`));
            if (kubeKey) {
                const kubeContent = fileMapEnv[kubeKey]?.content;
                const yamlMatch = kubeContent?.match(/^Yaml=(.+)$/m);
                if (yamlMatch) {
                    const yamlKey = Object.keys(fileMapEnv).find(k => k.endsWith(`/${yamlMatch[1].trim()}`));
                    if (yamlKey) return fileMapEnv[yamlKey]?.content ?? null;
                }
            }
            // Fallback: a direct <base>.yml (kube-less single-pod templates).
            const ymlKey = Object.keys(fileMapEnv).find(k => k.endsWith(`/${baseName}.yml`) || k.endsWith(`/${baseName}.yaml`));
            return ymlKey ? (fileMapEnv[ymlKey]?.content ?? null) : null;
        };

        for (const svc of services) {
            if (!svc.isManaged) continue;
            const base = svc.name.replace(/\.service$/, '');
            const srcId = prefix(`service-${svc.name}`);
            if (!nodes.some(n => n.id === srcId)) continue;
            const yamlContent = readYamlForBase(base);
            if (!yamlContent) continue;
            for (const env of extractPodEnv(yamlContent)) {
                envSources.push({ nodeId: srcId, name: env.name, value: env.value });
            }
        }

        const inferred = inferEnvEdges(envSources, targets, mergedEdges);
        mergedEdges.push(...inferred);
    } catch (e) {
        logger.warn('NetworkService', `inferred-edge synthesis skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * Resolve a service's rendered pod-manifest yaml, following the
 * .kube → Yaml= → .yml chain (same path serviceViewModel.ts uses).
 * Returns null if any link in the chain is missing.
 */
function readKubeChainYaml(fileMap: NodeTwin['files'], baseName: string): string | null {
    const kubeKey = Object.keys(fileMap).find(k => k.endsWith(`/${baseName}.kube`));
    if (!kubeKey) return null;
    const kubeContent = fileMap[kubeKey]?.content;
    if (!kubeContent) return null;
    const yamlMatch = kubeContent.match(/^Yaml=(.+)$/m);
    if (!yamlMatch) return null;
    const yamlFileName = yamlMatch[1].trim();
    const yamlKey = Object.keys(fileMap).find(k => k.endsWith(`/${yamlFileName}`));
    if (!yamlKey) return null;
    return fileMap[yamlKey]?.content ?? null;
}

/**
 * Parse the first TCP port out of `servicebay.ports` so a declared edge carries
 * the port consumers actually talk to. Templates that expose multiple ports
 * list the consumer-facing one first by convention (e.g. `auth` puts
 * AUTHELIA_PORT before LLDAP_PORT because cross-pod consumers are doing OIDC /
 * forward-auth, not LDAP binds — see templates/auth/template.yml). Returns 0
 * when the annotation is missing or has no TCP entry.
 */
function readPrimaryTcpPort(yamlContent: string): number {
    const m = yamlContent.match(/servicebay\.ports:\s*['"]?([^\n'"]+)['"]?/);
    if (!m) return 0;
    for (const entry of m[1].split(',')) {
        const [portStr, proto] = entry.trim().split('/');
        const port = Number.parseInt(portStr, 10);
        if (Number.isFinite(port) && port > 0 && (!proto || proto === 'tcp')) {
            return port;
        }
    }
    return 0;
}
