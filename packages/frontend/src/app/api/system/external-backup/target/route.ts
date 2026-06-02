import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getExternalBackupTargetView,
  saveExternalBackupTarget,
} from '@/lib/externalBackup/registerSource';
import { testCandidateTarget } from '@/lib/externalBackup/nasClient';
import type { ExternalBackupTarget } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * Settings → Backups destination config (#1525/#1527).
 *
 * GET — the configured destination with secrets masked (`hasPassword` only).
 * The `fritzbox` default inherits `config.gateway`, so a web-only operator can
 * confirm/override the FritzBox NAS creds in one place instead of the CLI.
 */
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    const view = await getExternalBackupTargetView();
    return NextResponse.json({ ok: true, target: view });
  } catch (e) {
    return apiError(e, { tag: 'api:system:external-backup:target:get', status: 400, exposeMessage: true });
  }
});

// The target union has a richer shape than is worth fully duplicating in zod;
// validate the discriminator + required string fields per branch, the rest is
// optional and trusted (mirrors backup-sync's loose target validation).
const FritzboxTarget = z.object({
  type: z.literal('fritzbox'),
  host: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  secure: z.boolean().optional(),
});
const FtpTarget = z.object({
  type: z.literal('ftp'),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  username: z.string().min(1),
  password: z.string(),
  secure: z.boolean().optional(),
  dir: z.string().optional(),
});
const SshTarget = z.object({
  type: z.literal('ssh'),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  username: z.string().min(1),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  dir: z.string().optional(),
});
const PostBody = z.object({
  action: z.enum(['save', 'test']),
  target: z.discriminatedUnion('type', [FritzboxTarget, FtpTarget, SshTarget]),
});

/**
 * POST { action: 'save' | 'test', target } — persist or probe the destination.
 * A blank `ftp`/`ssh` password on save keeps the stored secret. `tokenScope:
 * 'mutate'` so the sb CLI can drive it; a browser cookie also works.
 */
export const POST = withApiHandler({ tokenScope: 'mutate', body: PostBody }, async ({ body }) => {
  try {
    const target = body.target as ExternalBackupTarget;
    if (body.action === 'test') {
      const result = await testCandidateTarget(target);
      return NextResponse.json(result);
    }
    await saveExternalBackupTarget(target);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e, { tag: 'api:system:external-backup:target:post', status: 400, exposeMessage: true });
  }
});
