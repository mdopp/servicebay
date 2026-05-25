'use client';

import Link from 'next/link';
import { useEffect } from 'react';

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
        <div className="flex gap-2 justify-center pt-2">
          <button
            onClick={() => reset()}
            className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm transition"
          >
            Try again
          </button>
          <Link
            href="/"
            className="px-4 py-2 rounded-md border border-current/30 hover:bg-current/10 text-sm transition"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
