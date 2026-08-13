'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Activity, Settings as SettingsIcon, Zap, Box, ArrowLeft, RefreshCw } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import { useOperateService } from '../../../settings/services/_lib/useOperateServices';
import OperateHealthTab from '../../../settings/services/_lib/OperateHealthTab';
import OperateSettingsTab from '../../../settings/services/_lib/OperateSettingsTab';
import OperateActionsTab from '../../../settings/services/_lib/OperateActionsTab';
import OperateContainersTab, { type ContainersDrawerRequest } from './OperateContainersTab';
import ServiceDetailSummary from '@/components/serviceDetail/ServiceDetailSummary';
import { Card, PageScroll, Tabs, tabPanelProps, type TabItem } from '@/components/ui';

type OperateTab = 'health' | 'settings' | 'containers' | 'actions';

const TABS: readonly TabItem<OperateTab>[] = [
  { id: 'health', label: 'Health', icon: Activity },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  { id: 'containers', label: 'Containers', icon: Box },
  { id: 'actions', label: 'Actions', icon: Zap },
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
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text"
      >
        <ArrowLeft size={16} /> Services
      </Link>

      {loading ? (
        <div className="flex items-center justify-center gap-2 p-8 text-text-muted">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading service…
        </div>
      ) : !service ? (
        <Card padding="lg" className="text-center text-text-muted">
          <p>Service <strong>{name}</strong> was not found.</p>
          <Link href="/services" className="text-accent hover:underline text-sm mt-2 inline-block">
            Back to all services
          </Link>
        </Card>
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

  // "Logs" is a real log view, not a tab link (#2391). `?drawer=logs[&container=]`
  // opens the container log panel on arrival (that's the cross-page link other
  // surfaces use), and the summary's Logs quick action re-fires it in place from
  // whichever tab the user is on — the nonce makes a repeat click re-open a
  // drawer that was closed.
  const [logsRequest, setLogsRequest] = useState<ContainersDrawerRequest | null>(() =>
    searchParams.get('drawer') === 'logs'
      ? { containerId: searchParams.get('container') ?? undefined, mode: 'logs', nonce: 1 }
      : null,
  );

  const showLogs = useCallback(() => {
    setTab('containers');
    setLogsRequest(prev => ({
      containerId: prev?.containerId,
      mode: 'logs',
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, []);

  return (
    <>
      {/* The shared per-service detail — identical to the one shown in the
          network-map node sidebar, so the two never drift. It carries the
          page's one labelled quick-action row (#2393). */}
      <Card padding="lg">
        <ServiceDetailSummary service={service} showOperateLink={false} onShowLogs={showLogs} />
      </Card>

      <Tabs label="Service views" idBase="operate" value={tab} onChange={setTab} items={TABS} />

      <div {...tabPanelProps('operate', tab)}>
        {tab === 'health' && <OperateHealthTab service={service} />}
        {tab === 'settings' && <OperateSettingsTab service={service} />}
        {tab === 'containers' && <OperateContainersTab service={service} initialDrawer={logsRequest} />}
        {tab === 'actions' && <OperateActionsTab service={service} deletedHref="/services" />}
      </div>
    </>
  );
}
