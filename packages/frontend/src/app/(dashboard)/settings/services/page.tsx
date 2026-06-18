'use client';

import Link from 'next/link';
import { Box, ChevronRight, RefreshCw } from 'lucide-react';
import GroupIntro from '../_lib/GroupIntro';
import { SETTINGS_GROUPS } from '../_lib/ia';
import { useOperateServices } from './_lib/useOperateServices';

const GROUP = SETTINGS_GROUPS.find(g => g.id === 'services')!;

/**
 * Services index (#1957). Lists every managed service, each linking to its
 * per-service Operate page (Health + Settings + Actions). A service is the
 * grouping unit — one tile, one Operate page (feedback_services_are_the_grouping_unit).
 */
export default function ServicesIndexPage() {
  const { services, loading } = useOperateServices();

  return (
    <div className="space-y-6">
      <GroupIntro intent={GROUP.intent} />

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-8 text-gray-500">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading services…
        </div>
      ) : services.length === 0 ? (
        <div className="p-8 text-center text-gray-500 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
          <Box className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p>No managed services found.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {services.map(service => (
            <Link
              key={`${service.nodeName}:${service.name}`}
              href={`/settings/services/${encodeURIComponent(service.id || service.name)}`}
              className="flex items-center justify-between gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    service.active ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                  title={service.active ? 'Active' : 'Inactive'}
                />
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{service.displayName}</p>
                  {service.nodeName && service.nodeName !== 'Local' && (
                    <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{service.nodeName}</p>
                  )}
                </div>
              </div>
              <ChevronRight size={18} className="text-gray-400 shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
