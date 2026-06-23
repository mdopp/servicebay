'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Activity, Settings as SettingsIcon, Zap, Box, ArrowLeft, RefreshCw } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import { useOperateService } from '../../../settings/services/_lib/useOperateServices';
import OperateHealthTab from '../../../settings/services/_lib/OperateHealthTab';
import OperateSettingsTab from '../../../settings/services/_lib/OperateSettingsTab';
import OperateActionsTab from '../../../settings/services/_lib/OperateActionsTab';
import OperateContainersTab from './OperateContainersTab';
import ServiceDetailSummary from '@/components/serviceDetail/ServiceDetailSummary';
import { PageScroll } from '@/components/ui';

type OperateTab = 'health' | 'settings' | 'containers' | 'actions';

const TABS: { id: OperateTab; label: string; Icon: typeof Activity }[] = [
  { id: 'health', label: 'Health', Icon: Activity },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
  { id: 'containers', label: 'Containers', Icon: Box },
  { id: 'actions', label: 'Actions', Icon: Zap },
];

function isTab(v: string | null): v is OperateTab {
  return v === 'health' || v === 'settings' || v === 'containers' || v === 'actions';
}

/**
 * The per-service **Operate page** — the keystone of IA slice 1 (#2029, spec
 * §4.2). One service = one page: status + health + settings + containers +
 * actions, all co-located (feedback_services_are_the_grouping_unit). This is
 * THE per-service surface at `/services/[name]`; it absorbs the old
 * `/settings/services`, the per-service half of `/settings/system`, the
 * per-service rows of `/health?tab=containers`, and the bespoke network-map
 * sidebar — which now all reuse the same shared ServiceDetailSummary header.
 */
export default function OperatePage({ name }: { name: string }) {
  const { service, loading } = useOperateService(name);

  return (
    // Canonical scroll pattern (#2077): the dashboard <main> is overflow-hidden,
    // so the page must own its own scroll region or overlong tabs (e.g. Settings)
    // clip with no scrollbar. PageScroll = h-full min-h-0 overflow-y-auto.
    <PageScroll spacing="lg" className="pb-8">
      <Link
        href="/services"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
      >
        <ArrowLeft size={16} /> Services
      </Link>

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-8 text-gray-500">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading service…
        </div>
      ) : !service ? (
        <div className="p-8 text-center text-gray-500 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
          <p>Service <strong>{name}</strong> was not found.</p>
          <Link href="/services" className="text-blue-600 dark:text-blue-400 hover:underline text-sm mt-2 inline-block">
            Back to all services
          </Link>
        </div>
      ) : (
        <OperateBody service={service} />
      )}
    </PageScroll>
  );
}

function OperateBody({ service }: { service: ServiceViewModel }) {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<OperateTab>(isTab(initialTab) ? initialTab : 'health');

  return (
    <>
      {/* The shared per-service detail — identical to the one shown in the
          network-map node sidebar, so the two never drift. */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
        <ServiceDetailSummary service={service} showOperateLink={false} />
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
        {tab === 'containers' && <OperateContainersTab service={service} />}
        {tab === 'actions' && <OperateActionsTab service={service} deletedHref="/services" />}
      </div>
    </>
  );
}
