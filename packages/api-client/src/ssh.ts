// SSH reachability / key-setup contracts — #2745.
//
// Replaced `packages/frontend/src/app/actions/ssh.ts`. Every result is a
// domain outcome carried on HTTP 200: "the box is unreachable" is an
// answer, not a failed request.

import { z } from 'zod';
import { mutateApi } from './client';

export const SshCheckRequestSchema = z.object({
  host: z.string(),
  port: z.number(),
});

export const SshCheckResultSchema = z.object({
  success: z.boolean(),
  isOpen: z.boolean().optional(),
  error: z.string().optional(),
});

export const SshVerifyRequestSchema = z.object({
  host: z.string(),
  port: z.number(),
  user: z.string(),
  identity: z.string(),
});

/** `stage` says how far the probe got: `tcp` = port shut, `auth` = key rejected. */
export const SshVerifyResultSchema = z.object({
  success: z.boolean(),
  stage: z.enum(['tcp', 'auth']).optional(),
  error: z.string().optional(),
});

export const SshInstallKeyRequestSchema = z.object({
  host: z.string(),
  port: z.number(),
  user: z.string(),
  pass: z.string(),
});

export const SshInstallKeyResultSchema = z.object({
  success: z.boolean(),
  logs: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export const SshGenerateKeyResultSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  error: z.string().optional(),
});

/** POST /api/system/ssh/check — TCP reachability only. */
export function checkConnection(host: string, port: number) {
  return mutateApi('/api/system/ssh/check', SshCheckResultSchema, { host, port });
}

/** POST /api/system/ssh/verify — TCP + public-key authentication. */
export function checkFullConnection(host: string, port: number, user: string, identity: string) {
  return mutateApi('/api/system/ssh/verify', SshVerifyResultSchema, { host, port, user, identity });
}

/** POST /api/system/ssh/install-key — copy the managed key to the remote host. */
export function installSSHKey(host: string, port: number, user: string, pass: string) {
  return mutateApi('/api/system/ssh/install-key', SshInstallKeyResultSchema, { host, port, user, pass });
}

/** POST /api/system/ssh/key — generate the managed local key pair if absent. */
export function generateLocalKey() {
  return mutateApi('/api/system/ssh/key', SshGenerateKeyResultSchema);
}
