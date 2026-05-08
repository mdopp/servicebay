'use client';

import Link from 'next/link';
import { Stethoscope, ArrowRight } from 'lucide-react';
import LogLevelControl from '@/components/LogLevelControl';
import ServerIdentitySection from '../_lib/sections/ServerIdentitySection';
import UpdatesSection from '../_lib/sections/UpdatesSection';

export default function SystemSettingsPage() {
  return (
    <>
      {/* Self-Diagnose moved to Health → Self-Diagnose so the operator
          sees probes alongside the live health checks instead of buried
          in Settings. Leave a small breadcrumb here for muscle-memory
          users who came looking for it under System. */}
      <Link
        href="/health?tab=diagnose"
        className="block bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
            <Stethoscope size={18} className="text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-gray-900 dark:text-white">Self-Diagnose</p>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-bold">moved</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Probe battery (containers stable, dangling proxy routes, failed units, …) lives next to the live Health checks.
            </p>
          </div>
          <ArrowRight size={16} className="text-gray-400 shrink-0" />
        </div>
      </Link>
      <ServerIdentitySection />
      <UpdatesSection />
      <LogLevelControl />
    </>
  );
}
