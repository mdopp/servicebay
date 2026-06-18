'use client';

/** One-line intent banner for a goal-based settings group (#1956). */
export default function GroupIntro({ intent }: { intent: string }) {
  return (
    <p className="text-sm text-gray-600 dark:text-gray-400 px-1">{intent}</p>
  );
}
