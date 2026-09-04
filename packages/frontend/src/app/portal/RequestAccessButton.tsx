'use client';

import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui';
import RequestAccessDialog from './RequestAccessDialog';

/**
 * "Don't have an account?" affordance on the family portal (#242
 * follow-up). Renders a small button below the card grid; clicking
 * opens the request-access modal (RequestAccessDialog), which collects
 * the profile data and POSTs it to /api/system/access-requests.
 *
 * The modal lives in its own component since #2405 so `/portal/requests`
 * can render it already open for a deep link from the companion app.
 * Mounting it == open; unmounting == closed, which resets the form.
 */
export default function RequestAccessButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="mt-space-7 text-center">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOpen(true)}
          className="h-auto inline-flex items-center gap-space-2 px-space-4 py-2.5 bg-surface border border-border hover:border-accent hover:bg-surface hover:text-accent text-sm font-medium text-text-muted rounded-full transition-colors"
        >
          <UserPlus size={16} />
          Don&apos;t have an account yet?
        </Button>
      </div>

      {open && <RequestAccessDialog onClose={() => setOpen(false)} />}
    </>
  );
}
