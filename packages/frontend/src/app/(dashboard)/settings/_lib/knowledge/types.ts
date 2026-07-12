// Shared types for the Knowledge (assists catalog) editor UI (#2228).
// The HTTP twins of the backend catalog + editor shapes.

import type { AssistKind } from './validation';

export type { AssistKind };

/** GET /api/assists → { assists: AssistSummary[] }. Mirrors backend AssistSummary. */
export interface AssistSummary {
  id: string;
  title: string;
  whenToUse: string;
  kind: AssistKind;
  tags: string[];
  /** 'Built-in' | 'Local'. */
  source: string;
}

/** GET /api/assists/:id/history → { history: HistoryEntry[] }. */
export interface HistoryEntry {
  version: number;
  author: string;
  timestamp: string;
  message: string;
}

/** A pending assist-edit approval request, derived from GET /api/approvals. */
export interface AssistApproval {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  status: 'pending' | 'approved' | 'rejected';
  payload: {
    kind?: string;
    assistId?: string;
    message?: string;
    revertOf?: number;
    [key: string]: unknown;
  };
}
