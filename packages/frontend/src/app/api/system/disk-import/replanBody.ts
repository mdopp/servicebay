// Disk-import — re-plan request body schema (#2000, the routing-tree review UI).
//
// The review page POSTs the operator's per-folder routing picks (owner +
// disposition/target per source folder) so servicebay can RE-PLAN with them:
// re-route + re-dedup PER OWNER in the worker (over the live mount) so files land
// in `data/<owner>/<category>/…`. Shared by the apply route (re-plan-then-apply)
// and the replan route (preview without applying). Validates the rule map shape so
// a malformed body fails fast; the engine's `assertOwnerSegment` is the real
// path-traversal guard at apply time (the owner becomes a path segment).

import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { DISPOSITIONS, type ReplanRequest } from '@servicebay/disk-import-worker';

/** A single folder's explicit (partial) routing rule — every axis optional. */
const ruleSchema = z
  .object({
    disposition: z.enum(DISPOSITIONS as unknown as [string, ...string[]]).optional(),
    mode: z.enum(['merge', 'parallel']).optional(),
    // owner is `shared` or a box-user id (free string); the engine clamps it to a
    // single clean path segment before it ever forms a target (#1929).
    owner: z.string().optional(),
    // Base-root mark: drop this folder's own name, keep the structure below it
    // (#2006 follow-up — strips redundant backup wrappers).
    base: z.boolean().optional(),
  })
  .strict();

/** The re-plan request: explicit rules keyed by source-relative dir + root default. */
export const replanBodySchema = z
  .object({
    /** relDir → the (partial) Rule the operator set on that folder (`''` = root). */
    rules: z.record(z.string(), ruleSchema).default({}),
    /** The disk-default owner / root default applied where no folder sets one. */
    rootDefault: ruleSchema.optional(),
  })
  .strict();

export type ReplanBody = z.infer<typeof replanBodySchema>;

/** Map the validated body to the worker's {@link ReplanRequest} wire shape. The
 *  zod enums validate the values at runtime; the cast narrows the inferred
 *  `string` to the engine's literal-union types (`Disposition`/`Owner`). */
export function toReplanRequest(body: ReplanBody): ReplanRequest {
  return {
    explicit: body.rules as ReplanRequest['explicit'],
    rootDefault: body.rootDefault as ReplanRequest['rootDefault'],
  };
}

/**
 * Parse the apply/replan body from a raw request, returning the worker request or
 * `undefined` when the body is empty (a plain apply of the auto-sorted plan). The
 * apply route reads the body directly (its handler has no `body` schema so it can
 * also be called with no body at all).
 */
export async function parseReplanBody(req: NextRequest): Promise<ReplanRequest | undefined> {
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return undefined;
  const text = await req.text();
  if (!text.trim()) return undefined;
  const parsed = replanBodySchema.parse(JSON.parse(text));
  // No rules and no root default → nothing to re-plan; apply the auto-sorted plan.
  if (Object.keys(parsed.rules).length === 0 && !parsed.rootDefault) return undefined;
  return toReplanRequest(parsed);
}
