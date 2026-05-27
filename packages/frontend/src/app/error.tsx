'use client';

import { useEffect } from 'react';
import ErrorActions from '@/components/ErrorActions';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App route error:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12 bg-[var(--background)] text-[var(--foreground)]">
      <div className="max-w-md w-full text-center space-y-4">
        <div className="text-5xl">⚠</div>
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="opacity-70 text-sm">
          The page hit an unexpected error. The full details have been logged.
        </p>
        {error.digest && (
          <p className="text-xs opacity-50 font-mono">ref: {error.digest}</p>
        )}
        <ErrorActions reset={reset} retryLabel="Try again" includeGoHome />
      </div>
    </div>
  );
}
