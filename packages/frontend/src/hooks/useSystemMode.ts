'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { typedFetch } from '@servicebay/api-client';

// Narrow view of GET /api/system/mode — only the fields the domain tag
// needs. `localOnly` and other fields stay out until a caller needs them.
const SystemModeSchema = z.object({
  mode: z.enum(['lan', 'public']),
  activeDomain: z.string(),
  publicDomain: z.string().nullable(),
  lanDomain: z.string().nullable(),
});

export type SystemMode = z.infer<typeof SystemModeSchema>;

/**
 * Reads the install-mode classification (#249) once on mount. Shared by
 * the Sidebar and the mobile top bar via <DomainTag>. Returns `null`
 * while loading or on error — the domain tag is non-essential chrome and
 * renders nothing until the mode lands.
 */
export function useSystemMode(): SystemMode | null {
  const [mode, setMode] = useState<SystemMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    typedFetch('/api/system/mode', SystemModeSchema)
      .then(data => { if (!cancelled) setMode(data); })
      .catch(() => { /* non-essential — leave null */ });
    return () => { cancelled = true; };
  }, []);

  return mode;
}
