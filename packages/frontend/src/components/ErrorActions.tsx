'use client';

import Link from 'next/link';
import { Button } from '@/components/ui';

interface ErrorActionsProps {
  reset: () => void;
  retryLabel: string;
  includeGoHome?: boolean;
}

const SECONDARY_BTN =
  'px-4 py-2 rounded-md border border-current/30 hover:bg-current/10 text-sm transition';

export default function ErrorActions({ reset, retryLabel, includeGoHome }: ErrorActionsProps) {
  return (
    <div className="flex flex-wrap gap-2 justify-center pt-2">
      <Button variant="primary" onClick={() => reset()} title="Re-render this view">
        {retryLabel}
      </Button>
      <Button
        variant="secondary"
        onClick={() => window.location.reload()}
        title="Reload the page from the server"
      >
        Reload page
      </Button>
      <Link
        href="/status"
        className={SECONDARY_BTN}
        title="Run self-diagnostics to find the root cause"
      >
        Run diagnostics
      </Link>
      {includeGoHome && (
        <Link href="/" className={SECONDARY_BTN}>
          Go home
        </Link>
      )}
    </div>
  );
}
