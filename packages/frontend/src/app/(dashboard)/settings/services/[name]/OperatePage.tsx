'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Activity, Settings as SettingsIcon, Zap, ArrowLeft, RefreshCw } from 'lucide-react';
import { useOperateService } from '../_lib/useOperateServices';
import OperateHealthTab from '../_lib/OperateHealthTab';
import OperateSettingsTab from '../_lib/OperateSettingsTab';
import OperateActionsTab from '../_lib/OperateActionsTab';

type OperateTab = 'health' | 'settings' | 'actions';

const TABS: { id: OperateTab; label: string; Icon: typeof Activity }[] = [
  { id: 'health', label: 'Health', Icon: Activity },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
  { id: 'actions', label: 'Actions', Icon: Zap },
];

/**
 * Per-service Operate page (#1957 / slice 2 of #1950): Health + Settings +
 * Actions for ONE service on ONE page. A service is the grouping unit
 * (feedback_services_are_the_grouping_unit); the diagnose/health surface is
 * merged in here (project_diagnose_health_rework) rather than living in a
 * separate global dashboard.
 */
export default function OperatePage({ name }: { name: string }) {
  const { service, loading } = useOperateService(name);
  const [tab, setTab] = useState<OperateTab>('health');

  return (
    <div className="space-y-6">
      <Link
        href="/settings/services"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
      >
        <ArrowLeft size={16} /> All services
      </Link>

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-8 text-gray-500">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading service…
        </div>
      ) : !service ? (
        <div className="p-8 text-center text-gray-500 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
          <p>Service <strong>{name}</strong> was not found.</p>
          <Link href="/settings/services" className="text-blue-600 dark:text-blue-400 hover:underline text-sm mt-2 inline-block">
            Back to all services
          </Link>
        </div>
      ) : (
        <>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{service.displayName}</h2>
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  service.active
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                }`}
              >
                {service.active ? 'Active' : 'Inactive'}
              </span>
              {service.nodeName && service.nodeName !== 'Local' && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                  {service.nodeName}
                </span>
              )}
            </div>
            {service.description && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{service.description}</p>
            )}
          </div>

          <div className="flex border-b border-gray-200 dark:border-gray-700">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  tab === id
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>

          <div>
            {tab === 'health' && <OperateHealthTab service={service} />}
            {tab === 'settings' && <OperateSettingsTab service={service} />}
            {tab === 'actions' && <OperateActionsTab service={service} />}
          </div>
        </>
      )}
    </div>
  );
}
