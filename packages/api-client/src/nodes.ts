// Node (Podman connection) contracts — #2745.
//
// These replaced `packages/frontend/src/app/actions/nodes.ts`. The server
// actions were the only implementation of node CRUD and could not use the
// api-client's 401 → /login seam; the routes under `/api/system/nodes`
// carry the same behaviour behind a zod contract both sides import.

import { z } from 'zod';
import { callApi, mutateApi } from './client';

export const PodmanConnectionSchema = z.object({
  Name: z.string(),
  URI: z.string(),
  Identity: z.string(),
  Default: z.boolean(),
});

/**
 * Result shape of every node mutation. `success: true` with a `warning`
 * means the node was stored but the follow-up connection check failed —
 * the settings UI turns that into the "password-less SSH is not
 * configured" prompt, so it is a domain outcome (HTTP 200), not a
 * transport error.
 */
export const NodeMutationResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  warning: z.string().optional(),
});
export type NodeMutationResult = z.infer<typeof NodeMutationResultSchema>;

export const NodeWriteRequestSchema = z.object({
  name: z.string(),
  destination: z.string(),
  identity: z.string(),
});

const nodePath = (name: string) => `/api/system/nodes/${encodeURIComponent(name)}`;

/** GET /api/system/nodes */
export function fetchNodes() {
  return callApi('/api/system/nodes', z.array(PodmanConnectionSchema));
}

/** POST /api/system/nodes */
export function createNode(name: string, destination: string, identity: string) {
  return mutateApi('/api/system/nodes', NodeMutationResultSchema, { name, destination, identity });
}

/** PATCH /api/system/nodes/:oldName */
export function editNode(oldName: string, name: string, destination: string, identity: string) {
  return mutateApi(nodePath(oldName), NodeMutationResultSchema, { name, destination, identity }, 'PATCH');
}

/** DELETE /api/system/nodes/:name */
export function deleteNode(name: string) {
  return mutateApi(nodePath(name), NodeMutationResultSchema, undefined, 'DELETE');
}

/** POST /api/system/nodes/:name/default */
export function setNodeAsDefault(name: string) {
  return mutateApi(`${nodePath(name)}/default`, NodeMutationResultSchema);
}
