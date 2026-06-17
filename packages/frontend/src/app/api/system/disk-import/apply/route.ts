import { NextResponse } from 'next/server';
import { z } from 'zod';
import { startApply } from '@/lib/diskImport/service';
import { resolveImmichAdminConfig } from '@/lib/diskImport/immichLibraries';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { makeExec, resolveNode, SHARE_GID, immichServerUrl } from '../wiring';

export const dynamic = 'force-dynamic';

/** One node's edited routing rule (#1915) — every axis optional (inherits). */
const RuleSchema = z.object({
  disposition: z
    .enum([
      'auto',
      'photos_immich',
      'movies_jellyfin',
      'music',
      'audiobooks',
      'podcasts',
      'documents_merge',
      'code_parallel',
      'archive_1to1',
      'skip',
    ])
    .optional(),
  mode: z.enum(['merge', 'parallel']).optional(),
  /** `shared` or a box-user id. */
  owner: z.string().min(1).optional(),
});

const Body = z.object({
  /** The token from a prior `scan` — REQUIRED. The review gate. */
  sessionId: z.string().min(1),
  /** Explicit confirmation of the reviewed plan — required before any write. */
  confirmed: z.literal(true),
  node: z.string().optional(),
  /**
   * The user's edited routing tree (#1915): a per-relative-dir map of explicit
   * rules. Present only when the user changed something in the review; the apply
   * re-resolves the plan against it so owner/disposition edits move the targets.
   */
  rules: z.record(z.string(), RuleSchema).optional(),
  /** The disk-default owner seeding the tree root (`shared` or a box user). */
  defaultOwner: z.string().min(1).optional(),
});

/**
 * POST — start a background apply of a previously-scanned + reviewed plan and
 * return the `jobId` IMMEDIATELY (#1897). The copy/chown/upload over a large
 * plan far exceeds the HTTP timeout, so it runs detached and the card polls
 * `GET ./status?id=<jobId>` for live copy progress. The review gate is checked
 * SYNCHRONOUSLY before the job is kicked off: it requires both the `sessionId`
 * of a reviewed (not-yet-applied) plan AND an explicit `confirmed: true`, so no
 * unreviewed plan can ever write. Resumable (catalog-backed). Photos land in
 * `data/<owner>/photos` and Immich indexes them via per-user External Libraries
 * (#1904); the rest go into file-share/data/.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body, tokenScope: 'mutate' },
  async ({ body }) => {
    try {
      const node = resolveNode(body.node);
      // #1904: best-effort resolve the single stored Immich admin key so a
      // photo-writing import can auto-provision the External Libraries + scan.
      // null (Immich absent / no key) → photos still land on disk, scan skipped.
      const immich = await resolveImmichAdminConfig(immichServerUrl()).catch(() => null);
      const { jobId } = await startApply({
        exec: makeExec(node),
        sessionId: body.sessionId,
        shareGid: SHARE_GID,
        immich: immich ?? undefined,
        // #1915: thread the user's review edits through so the plan is re-resolved
        // against them before the copy. Omitted (no `rules`) → apply as reviewed.
        routing: body.rules ? { rules: body.rules, defaultOwner: body.defaultOwner } : undefined,
      });
      return NextResponse.json({ ok: true, jobId });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:apply', status: 400, exposeMessage: true });
    }
  },
);
