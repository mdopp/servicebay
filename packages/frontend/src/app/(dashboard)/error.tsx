'use client';

import { useEffect } from 'react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard route error:', error);
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-12">
      <div className="max-w-md w-full text-center space-y-4">
        <div className="text-4xl">⚠</div>
        <h2 className="text-xl font-semibold">This view failed to load</h2>
        <p className="opacity-70 text-sm">
          {error.message || 'An unexpected error occurred while rendering this page.'}
        </p>
        {error.digest && (
          <p className="text-xs opacity-50 font-mono">ref: {error.digest}</p>
        )}
        <button
          onClick={() => reset()}
          className="mt-2 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm transition"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
