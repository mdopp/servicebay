'use client';

/** One-line intent banner for a goal-based settings group (#1956). */
export default function GroupIntro({ intent }: { intent: string }) {
  return (
    <p className="text-sm text-text-muted px-1">{intent}</p>
  );
}
