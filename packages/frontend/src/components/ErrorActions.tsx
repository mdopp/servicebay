'use client';

import Link from 'next/link';

interface ErrorActionsProps {
  reset: () => void;
  retryLabel: string;
  includeGoHome?: boolean;
}

const PRIMARY_BTN =
  'px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm transition';
const SECONDARY_BTN =
  'px-4 py-2 rounded-md border border-current/30 hover:bg-current/10 text-sm transition';

export default function ErrorActions({ reset, retryLabel, includeGoHome }: ErrorActionsProps) {
  return (
    <div className="flex flex-wrap gap-2 justify-center pt-2">
      <button onClick={() => reset()} className={PRIMARY_BTN} title="Re-render this view">
        {retryLabel}
      </button>
      <button
        onClick={() => window.location.reload()}
        className={SECONDARY_BTN}
        title="Reload the page from the server"
      >
        Reload page
      </button>
      <Link
        href="/health"
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
