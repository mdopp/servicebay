/**
 * Runtime validation for Pod manifests submitted via the API.
 *
 * Two write paths feed `ServiceManager.deployKubeService` / `saveService`:
 *   1. POST /api/services — wizard + InstallerModal + MCP deploy_service
 *   2. PUT  /api/services/[name] — Settings → Services edit panel
 *
 * Until this module landed, both paths accepted whatever `yamlContent` the
 * caller sent and called `js-yaml.loadAll` with `as any[]`. A typoed
 * `apiVersion`, missing `spec.containers`, malformed `volumeMounts.name`,
 * or a port with no `hostPort` outside a `hostNetwork` pod surfaces only
 * when systemd reloads and `podman play kube` fails — at which point the
 * operator gets a cryptic systemd-journal entry and no breadcrumb back to
 * the API call that produced it.
 *
 * `validatePodManifest` parses the YAML, finds the Pod doc (templates may
 * ship a Pod + PersistentVolumeClaim multi-doc since 3.6.4), validates a
 * deliberately narrow subset of the K8s Pod spec we actually use, and
 * returns either { ok: true } or a structured error pointing at the
 * offending path. The two API routes call this before the agent write
 * and 400 with the structured error if it fails.
 *
 * Scope:
 *   - We don't try to chase the full upstream Kubernetes JSON schema.
 *     `podman play kube` itself implements the long tail; we just want
 *     to catch the things the operator can recover from in the wizard.
 *   - The consistency suite (tests/backend/template_consistency.test.ts)
 *     uses a similar shape at PR-time for shipped templates. This module
 *     is the runtime equivalent for *user* input — bundle imports, manual
 *     edits, MCP calls.
 */

import { z } from 'zod';
import yaml from 'js-yaml';

// DNS-1123 label rules: lowercase, digits, hyphens, must start + end with
// alphanumeric, max 63 chars. systemd unit names follow the same shape via
// our template generator, so this is what we use throughout.
const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const dns1123 = z
    .string()
    .min(1, 'must not be empty')
    .max(63, 'must be at most 63 characters')
    .regex(DNS1123_LABEL, 'must be a DNS-1123 label (lowercase alphanumeric + hyphens, start/end with alphanumeric)');

const ContainerPortSchema = z.object({
    containerPort: z.number().int().positive(),
    hostPort: z.number().int().positive().optional(),
    protocol: z.enum(['TCP', 'UDP']).optional(),
    hostIp: z.string().optional(),
}).passthrough();

const VolumeMountSchema = z.object({
    name: z.string().min(1, 'volumeMount.name is required'),
    mountPath: z.string().startsWith('/', 'mountPath must be absolute'),
    readOnly: z.boolean().optional(),
    subPath: z.string().optional(),
}).passthrough();

const ContainerSchema = z.object({
    name: dns1123,
    image: z.string().min(1, 'container.image is required'),
    command: z.array(z.string()).optional(),
    args: z.array(z.string()).optional(),
    env: z.array(z.object({
        name: z.string().min(1),
        value: z.string().optional(),
    }).passthrough()).optional(),
    ports: z.array(ContainerPortSchema).optional(),
    volumeMounts: z.array(VolumeMountSchema).optional(),
    securityContext: z.object({}).passthrough().optional(),
}).passthrough();

const HostPathVolumeSchema = z.object({
    name: z.string().min(1),
    hostPath: z.object({
        path: z.string().startsWith('/', 'hostPath.path must be absolute'),
        type: z.string().optional(),
    }),
}).passthrough();

const PvcVolumeSchema = z.object({
    name: z.string().min(1),
    persistentVolumeClaim: z.object({
        claimName: z.string().min(1),
    }),
}).passthrough();

const EmptyDirVolumeSchema = z.object({
    name: z.string().min(1),
    emptyDir: z.object({}).passthrough(),
}).passthrough();

const VolumeSchema = z.union([HostPathVolumeSchema, PvcVolumeSchema, EmptyDirVolumeSchema]);

const PodSchema = z.object({
    apiVersion: z.literal('v1'),
    kind: z.literal('Pod'),
    metadata: z.object({
        name: dns1123,
        labels: z.record(z.string(), z.string()).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
    }).passthrough(),
    spec: z.object({
        hostNetwork: z.boolean().optional(),
        containers: z.array(ContainerSchema).min(1, 'spec.containers must contain at least one entry'),
        initContainers: z.array(ContainerSchema).optional(),
        volumes: z.array(VolumeSchema).optional(),
    }).passthrough(),
}).passthrough();

const PvcSchema = z.object({
    apiVersion: z.literal('v1'),
    kind: z.literal('PersistentVolumeClaim'),
    metadata: z.object({
        name: dns1123,
    }).passthrough(),
}).passthrough();

interface PodValidationError {
    path: string;
    message: string;
}

export interface PodValidationResult {
    ok: boolean;
    error?: PodValidationError;
}

/**
 * Validate that every volumeMount.name matches a declared volume.
 * Catches typographical bugs where a mount points at a non-existent volume.
 */
function validateVolumeMounts(
    pod: z.infer<typeof PodSchema>,
): PodValidationError | null {
    const declared = new Set((pod.spec.volumes ?? []).map(v => v.name));
    const containers = [...pod.spec.containers, ...(pod.spec.initContainers ?? [])];
    for (const c of containers) {
        for (const vm of c.volumeMounts ?? []) {
            if (!declared.has(vm.name)) {
                return {
                    path: `spec.containers[${c.name}].volumeMounts[${vm.name}]`,
                    message: `references volume "${vm.name}" which is not declared in spec.volumes`,
                };
            }
        }
    }
    return null;
}

/**
 * Validate that every container port either has hostPort, or the pod
 * is hostNetwork. The same rule the consistency suite enforces for
 * shipped templates — moved to runtime so user-uploaded YAML can't
 * produce a service that "deploys" but is unreachable from the host.
 */
function validatePortReachability(
    pod: z.infer<typeof PodSchema>,
): PodValidationError | null {
    const hostNetwork = pod.spec.hostNetwork === true;
    if (!hostNetwork) {
        for (const c of pod.spec.containers) {
            for (const p of c.ports ?? []) {
                if (!p.hostPort) {
                    return {
                        path: `spec.containers[${c.name}].ports[containerPort=${p.containerPort}].hostPort`,
                        message: 'port has no hostPort and pod is not hostNetwork — would be unreachable from the host',
                    };
                }
            }
        }
    }
    return null;
}

/**
 * Validate PVC documents in a multi-doc YAML. Basic shape only;
 * podman creates the volume on first deploy regardless of most fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validatePvcDocs(docs: any[]): PodValidationError | null {
    for (const doc of docs) {
        if (doc?.kind === 'PersistentVolumeClaim') {
            const pvcResult = PvcSchema.safeParse(doc);
            if (!pvcResult.success) {
                const issue = pvcResult.error.issues[0];
                return {
                    path: `(PVC).${issue.path.join('.')}`,
                    message: issue.message,
                };
            }
        }
    }
    return null;
}

/** Parse + validate a YAML Pod manifest. Multi-doc support: a Pod + PVC
 *  bundle is normal (file-share since 3.6.4), the validator finds the Pod
 *  by `kind` and validates the PVC alongside if present. */
export function validatePodManifest(yamlContent: string): PodValidationResult {
    if (typeof yamlContent !== 'string' || yamlContent.trim().length === 0) {
        return { ok: false, error: { path: '$', message: 'yamlContent is empty' } };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let docs: any[];
    try {
        docs = yaml.loadAll(yamlContent);
    } catch (e) {
        return { ok: false, error: { path: '$', message: `not valid YAML: ${e instanceof Error ? e.message : String(e)}` } };
    }
    if (docs.length === 0 || docs.every(d => !d)) {
        return { ok: false, error: { path: '$', message: 'no documents found in YAML' } };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pod = docs.find((d: any) => d?.kind === 'Pod');
    if (!pod) {
        return { ok: false, error: { path: 'kind', message: 'no kind=Pod document in YAML' } };
    }

    const podResult = PodSchema.safeParse(pod);
    if (!podResult.success) {
        const issue = podResult.error.issues[0];
        return {
            ok: false,
            error: {
                path: issue.path.length ? issue.path.join('.') : '$',
                message: issue.message,
            },
        };
    }

    // Cross-reference: every volumeMount.name must match a declared volume.
    const vmError = validateVolumeMounts(podResult.data);
    if (vmError) {
        return { ok: false, error: vmError };
    }

    // Reachability: every container port either has hostPort, or the pod
    // is hostNetwork.
    const portError = validatePortReachability(podResult.data);
    if (portError) {
        return { ok: false, error: portError };
    }

    // PVC docs (if any)
    const pvcError = validatePvcDocs(docs);
    if (pvcError) {
        return { ok: false, error: pvcError };
    }

    return { ok: true };
}
