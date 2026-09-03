/**
 * Thin client for the box-side install PLAN (#1520 / #1537).
 *
 * `POST /api/install/plan` is the single source of truth for the
 * desired-state diff: given the stacks the operator wants installed
 * (`desired`) and which installed ones to redeploy (`reinstall`), the
 * box returns `{ install, reinstall, uninstall, blocked, ... }` computed
 * from the catalog + live twin health. The wizard and the `sb` CLI both
 * render this instead of each re-deriving the rules, so they can't drift.
 *
 * This hook is a deliberately dumb renderer-side wrapper:
 *   - `fetchPlan(desired, reinstall, node)` → resolved `InstallPlan`
 *   - `uninstall(stack, node)` → `POST /api/system/stacks/[name]/wipe`
 *     with the `WIPE-<stack>` confirmation token the endpoint requires.
 *
 * It owns no desired-state itself — callers pass the desired set in. The
 * uncheck-to-uninstall gesture in the wizard reads `plan.uninstall` /
 * `plan.blocked` from here to decide whether a row is wipeable (feature
 * stack) or blocked (core / `atomic-wipe`, Factory-Reset-only).
 */

'use client';

import { useCallback, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@servicebay/api-client';

/** Frontend mirror of the backend `InstallPlan` shape (see
 *  `packages/backend/src/lib/install/installPlan.ts`). Declared locally
 *  because the backend type lives behind the `@/lib` alias (which maps
 *  to the backend package, not importable from the browser bundle). */
interface InstallPlanChange {
  stack: string;
  templates: string[];
}

export interface InstallPlan {
  /** Desired stacks not yet installed — deploy their templates. */
  install: InstallPlanChange[];
  /** Installed stacks the operator explicitly wants redeployed over data. */
  reinstall: InstallPlanChange[];
  /** Installed stacks no longer desired — tear them down (wipeable only). */
  uninstall: { stack: string }[];
  /** Desired/undesired changes that can't be applied, with why
   *  (unknown stack, or core/`atomic-wipe` uninstall — Factory Reset only). */
  blocked: { stack: string; reason: string }[];
  /** De-duplicated template names to deploy this apply (install ∪ reinstall). */
  templatesToDeploy: string[];
  /** True when nothing changes (desired set already matches reality). */
  noop: boolean;
}

interface UninstallResult {
  ok: boolean;
  error?: string;
}

const InstallPlanChangeSchema = z.object({
  stack: z.string(),
  templates: z.array(z.string()),
});

const InstallPlanSchema = z.object({
  install: z.array(InstallPlanChangeSchema).optional(),
  reinstall: z.array(InstallPlanChangeSchema).optional(),
  uninstall: z.array(z.object({ stack: z.string() })).optional(),
  blocked: z.array(z.object({ stack: z.string(), reason: z.string() })).optional(),
  templatesToDeploy: z.array(z.string()).optional(),
  noop: z.boolean().optional(),
});

const UninstallResponseSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  failed: z.array(z.object({ template: z.string(), error: z.string() })).optional(),
  deleted: z.array(z.string()).optional(),
}).passthrough();

export interface UseInstallPlanReturn {
  /** Last resolved plan, or null before the first fetch. */
  plan: InstallPlan | null;
  loading: boolean;
  error: string | null;
  /** Resolve the desired-state diff on the box. Stores it in `plan`. */
  fetchPlan: (
    desired: string[],
    reinstall?: string[],
    node?: string,
  ) => Promise<InstallPlan | null>;
  /** Tear down an installed feature stack. The box refuses core /
   *  `atomic-wipe` stacks (Factory-Reset-only), so callers should gate
   *  the uncheck gesture on the plan's `uninstall`/`blocked` lists. */
  uninstall: (stack: string, node?: string) => Promise<UninstallResult>;
}

/** POST the desired-state diff request. Throws on a non-2xx response so
 *  the hook can route the message into `error`. Normalizes a missing
 *  array (truncated/legacy body) to `[]` so callers iterate safely. */
async function postPlan(desired: string[], reinstall: string[], node?: string): Promise<InstallPlan> {
  const res = await apiFetch('/api/install/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desired, reinstall, node }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
  }
  const raw = (await res.json()) as Partial<z.infer<typeof InstallPlanSchema>>;
  const parsed = InstallPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Invalid response format from /api/install/plan');
  }
  return {
    install: parsed.data.install ?? [],
    reinstall: parsed.data.reinstall ?? [],
    uninstall: parsed.data.uninstall ?? [],
    blocked: parsed.data.blocked ?? [],
    templatesToDeploy: parsed.data.templatesToDeploy ?? [],
    noop: parsed.data.noop ?? true,
  };
}

/** POST the `WIPE-<stack>` teardown for an installed feature stack. The
 *  box refuses core/atomic-wipe stacks (Factory-Reset-only) with a 400. */
async function postUninstall(stack: string, node?: string): Promise<UninstallResult> {
  try {
    const url = `/api/system/stacks/${encodeURIComponent(stack)}/wipe`;
    const res = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: `WIPE-${stack}`, node }),
    });
    const raw = (await res.json().catch(() => ({}))) as z.infer<typeof UninstallResponseSchema>;

    // Validate against schema
    const parsed = UninstallResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: `Failed to uninstall: invalid response format` };
    }
    const data = parsed.data;

    if (!res.ok || data.ok === false) {
      const failedMsg = Array.isArray(data.failed) && data.failed.length > 0
        ? data.failed.map((f) => `${f.template}: ${f.error}`).join('; ')
        : undefined;
      return { ok: false, error: (typeof data.error === 'string' ? data.error : failedMsg) ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function useInstallPlan(): UseInstallPlanReturn {
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPlan = useCallback(
    async (desired: string[], reinstall: string[] = [], node?: string): Promise<InstallPlan | null> => {
      setLoading(true);
      setError(null);
      try {
        const resolved = await postPlan(desired, reinstall, node);
        setPlan(resolved);
        return resolved;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const uninstall = useCallback(
    (stack: string, node?: string): Promise<UninstallResult> => postUninstall(stack, node),
    [],
  );

  return { plan, loading, error, fetchPlan, uninstall };
}
