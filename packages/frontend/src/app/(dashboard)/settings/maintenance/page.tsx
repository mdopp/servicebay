'use client';

// Settings → Maintenance: occasional one-off tools that don't warrant a permanent
// primary-nav entry (#1958 follow-up). Disk import (run once or twice ever) is a
// LAUNCH CARD here → the resource-capped worker app at /disk-import; the heavy job
// still runs in its own worker container, this is just the entry point.

import Link from 'next/link';
import { Download, ChevronRight } from 'lucide-react';

import GroupIntro from '../_lib/GroupIntro';
import { SETTINGS_GROUPS } from '../_lib/ia';

const GROUP = SETTINGS_GROUPS.find(g => g.id === 'maintenance')!;

export default function MaintenanceSettingsPage() {
  const launchers = GROUP.entries.filter(e => e.launchHref);

  return (
    <div className="space-y-6">
      <GroupIntro intent={GROUP.intent} />

      <div className="space-y-3">
        {launchers.map(entry => (
          <Link
            key={entry.id}
            href={entry.launchHref!}
            id={entry.id}
            data-testid={`maintenance-launch-${entry.id}`}
            className="flex items-center gap-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-sm transition-colors"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
              <Download className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-gray-900 dark:text-gray-100">{entry.label}</span>
              <span className="block text-sm text-gray-500 dark:text-gray-400">
                Sort a USB disk or drive into the box (photos, music, documents…). Runs in a one-shot worker — opens the importer.
              </span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-gray-400" />
          </Link>
        ))}
      </div>
    </div>
  );
}
