import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';

import { parseApplyBody, parseReplanBody } from './replanBody';

/** A minimal request stand-in — the parsers only read `headers` + `text()`. */
function req(body?: unknown, contentType: string | null = 'application/json'): NextRequest {
  return {
    headers: new Headers(contentType ? { 'content-type': contentType } : {}),
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as NextRequest;
}

/**
 * The apply body carries the REVIEW GATE (#2383) — the locked
 * device → scan → review → CONFIRM → apply decision in docs/UX_DECISIONS.md.
 * The #1949-#2009 worker-container rewrite let a bare POST apply whatever plan sat in
 * the single global active run; these pin the schema-level half of the gate back.
 */
describe('parseApplyBody — review gate (#2383)', () => {
  it('refuses a body-less POST (the pre-#2383 "apply the auto-sorted plan" path)', async () => {
    await expect(parseApplyBody(req(undefined, null))).rejects.toThrow('apply refused');
    await expect(parseApplyBody(req())).rejects.toThrow('apply refused');
  });

  it('refuses a rules-only body with no proof of review', async () => {
    await expect(parseApplyBody(req({ rules: { docs: { owner: 'mdopp' } } }))).rejects.toThrow();
  });

  it('refuses confirmed:false and a missing/empty runId', async () => {
    await expect(parseApplyBody(req({ runId: 'r1', confirmed: false }))).rejects.toThrow();
    await expect(parseApplyBody(req({ confirmed: true }))).rejects.toThrow();
    await expect(parseApplyBody(req({ runId: '', confirmed: true }))).rejects.toThrow();
  });

  it('accepts a confirmed runId with no rules — apply the plan as auto-sorted', async () => {
    const parsed = await parseApplyBody(req({ runId: 'r1', confirmed: true }));

    expect(parsed.confirm).toEqual({ runId: 'r1', confirmed: true });
    // No rules → nothing to re-plan (the reviewed plan is applied unchanged).
    expect(parsed.replan).toBeUndefined();
  });

  it('carries the routing rules through alongside the confirmation', async () => {
    const parsed = await parseApplyBody(
      req({ runId: 'r1', confirmed: true, rules: { docs: { owner: 'mdopp' } }, rootDefault: { owner: 'shared' } }),
    );

    expect(parsed.confirm.runId).toBe('r1');
    expect(parsed.replan).toEqual({ explicit: { docs: { owner: 'mdopp' } }, rootDefault: { owner: 'shared' } });
  });
});

// The replan/tree routes are previews (nothing is written), so they keep the lenient
// "absent body = no rules" contract — the gate is on apply only.
describe('parseReplanBody stays lenient (preview routes)', () => {
  it('returns undefined for an absent body and for rules-free bodies', async () => {
    expect(await parseReplanBody(req(undefined, null))).toBeUndefined();
    expect(await parseReplanBody(req({ rules: {} }))).toBeUndefined();
  });

  it('maps rules to the worker request shape', async () => {
    expect(await parseReplanBody(req({ rules: { pics: { disposition: 'photos_immich' } } }))).toEqual({
      explicit: { pics: { disposition: 'photos_immich' } },
      rootDefault: undefined,
    });
  });
});
