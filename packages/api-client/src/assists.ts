// Knowledge (assists catalog) editor API contracts (#2228) — the HTTP twins
// of the backend catalog + editor endpoints under /api/assists/*. Every
// route here shapes its own body with NextResponse.json(...), never wrapped
// in withApiHandler's `{ ok, data }` envelope, so rawApi/mutateRawApi
// throughout (see the note on settings.ts's Access Requests methods for the
// same pattern).

import { z } from 'zod';
import { rawApi, mutateRawApi } from './client';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const AssistSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  whenToUse: z.string(),
  // `kind` is a closed union backend-side (guide|recipe|adr|template|
  // checklist|footgun|snippet) — tolerate an unrecognised value here rather
  // than dropping the whole catalog entry over one drifted tag.
  kind: z.string(),
  tags: z.array(z.string()),
  /** 'Built-in' | 'Local'. */
  source: z.string(),
});

export type AssistSummaryView = z.infer<typeof AssistSummarySchema>;

export const AssistListResponseSchema = z.object({
  assists: z.array(AssistSummarySchema),
});

export const AssistContentResponseSchema = z.object({
  id: z.string(),
  content: z.string(),
});

export const AssistHistoryEntrySchema = z.object({
  version: z.number(),
  author: z.string(),
  timestamp: z.string(),
  message: z.string(),
});

export type AssistHistoryEntryView = z.infer<typeof AssistHistoryEntrySchema>;

export const AssistHistoryResponseSchema = z.object({
  id: z.string().optional(),
  history: z.array(AssistHistoryEntrySchema),
});

export const AssistProposeResponseSchema = z.object({
  requestId: z.string(),
});

export const AssistApprovalActionResponseSchema = z.object({
  ok: z.boolean(),
  id: z.string(),
  version: z.number().optional(),
});

export const AssistRevertResponseSchema = z.object({
  requestId: z.string(),
  revertOf: z.number(),
});

// ---------------------------------------------------------------------------
// API Methods
// ---------------------------------------------------------------------------

/** GET /api/assists */
export function fetchAssistsList(params?: { query?: string; kind?: string }) {
  const search = new URLSearchParams();
  if (params?.query) search.set('query', params.query);
  if (params?.kind) search.set('kind', params.kind);
  const qs = search.toString();
  return rawApi(`/api/assists${qs ? `?${qs}` : ''}`, AssistListResponseSchema);
}

/** GET /api/assists/:id */
export function fetchAssistContent(id: string) {
  return rawApi(`/api/assists/${encodeURIComponent(id)}`, AssistContentResponseSchema);
}

/** GET /api/assists/:id/history */
export function fetchAssistHistory(id: string) {
  return rawApi(`/api/assists/${encodeURIComponent(id)}/history`, AssistHistoryResponseSchema);
}

/** POST /api/assists/:id/propose */
export function proposeAssistEdit(id: string, content: string, message: string) {
  return mutateRawApi(
    `/api/assists/${encodeURIComponent(id)}/propose`,
    AssistProposeResponseSchema,
    { content, message },
  );
}

/** POST /api/assists/:id/approve/:requestId or /reject/:requestId */
export function decideAssistEdit(id: string, requestId: string, decision: 'approve' | 'reject') {
  return mutateRawApi(
    `/api/assists/${encodeURIComponent(id)}/${decision}/${encodeURIComponent(requestId)}`,
    AssistApprovalActionResponseSchema,
    undefined,
  );
}

/** POST /api/assists/:id/revert/:version */
export function revertAssist(id: string, version: number) {
  return mutateRawApi(
    `/api/assists/${encodeURIComponent(id)}/revert/${version}`,
    AssistRevertResponseSchema,
    undefined,
  );
}
