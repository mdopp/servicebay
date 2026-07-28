'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui';
import PortalUnavailableNotice from './PortalUnavailableNotice';

/**
 * Route-segment error boundary for `/portal` and everything under it
 * (`/portal/requests`, …) — #2421.
 *
 * Without it the nearest boundary is the app-root `app/error.tsx`, whose
 * "Something went wrong" / "Run diagnostics" / `ref: <digest>` framing is
 * aimed at the operator. The portal segment is anonymous and family-facing:
 * a visitor there has no admin recourse, so any throw below `/portal`
 * renders the portal's own temporarily-unavailable notice instead.
 *
 * The pages catch `ConfigReadError` themselves (server-rendered, no client
 * flash); this is the backstop for everything else that can throw in the
 * segment.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Portal route error:', error);
  }, [error]);

  return (
    <PortalUnavailableNotice>
      <div className="mt-space-6 flex justify-center">
        <Button onClick={() => reset()}>Try again</Button>
      </div>
    </PortalUnavailableNotice>
  );
}
