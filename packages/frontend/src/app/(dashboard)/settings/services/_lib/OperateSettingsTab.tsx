'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ServiceViewModel } from '@servicebay/api-client';
import ServiceForm, { type ServiceFormInitialData } from '@/components/ServiceForm';
import { useToast } from '@/providers/ToastProvider';
import { Card, SectionHeading, Button } from '@/components/ui';

/**
 * Settings tab of a service's Operate page (#1957). The service's own config
 * (Quadlet kube/yaml) edited in place — this is where a service's settings now
 * live, co-located with its Health and Actions, instead of the global Settings
 * page (feedback_services_are_the_grouping_unit). Non-kube services are not
 * file-editable; we say so rather than hiding the tab.
 */
export default function OperateSettingsTab({ service }: { service: ServiceViewModel }) {
  const { addToast } = useToast();
  const serviceName = service.id || service.name;
  const [initialData, setInitialData] = useState<ServiceFormInitialData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const editable = service.type === 'kube';

  const load = useCallback(async () => {
    if (!editable) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nodeParam = service.nodeName && service.nodeName !== 'Local' ? `?node=${service.nodeName}` : '';
      const res = await fetch(`/api/services/${encodeURIComponent(serviceName)}${nodeParam}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load service configuration');
      const files = await res.json();
      setInitialData({
        name: service.displayName,
        kubeContent: files.kubeContent || '',
        yamlContent: files.yamlContent || '',
        yamlFileName: service.yamlBasename || `${service.displayName}.yml`,
        serviceContent: files.serviceContent,
        kubePath: files.kubePath,
        yamlPath: files.yamlPath,
        servicePath: files.servicePath,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load configuration';
      setError(message);
      addToast('error', message);
    } finally {
      setLoading(false);
    }
  }, [addToast, editable, serviceName, service.nodeName, service.displayName, service.yamlBasename]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async config load on mount/service change
    void load();
  }, [load]);

  if (!editable) {
    return (
      <Card padding="lg" className="text-sm text-text-muted max-w-2xl">
        This service is not managed via a Quadlet kube manifest, so its configuration
        cannot be edited here. Use the Actions tab for lifecycle controls.
      </Card>
    );
  }

  if (loading || (!initialData && !error)) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-text-muted">
        <RefreshCw className="w-4 h-4 animate-spin" /> Loading configuration…
      </div>
    );
  }

  if (error || !initialData) {
    return (
      <Card padding="lg" className="text-sm text-status-fail max-w-2xl flex items-center gap-2">
        <span>{error || 'Configuration unavailable.'}</span>
        <Button variant="secondary" size="sm" onClick={load}>Retry</Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeading description="Edit this service's Quadlet manifest in place">
        Configuration
      </SectionHeading>
      <Card padding="lg">
        <ServiceForm
          key={`${serviceName}-${service.nodeName || 'Local'}`}
          initialData={initialData}
          isEdit
          defaultNode={service.nodeName && service.nodeName !== 'Local' ? service.nodeName : ''}
          onClose={load}
          variant="embedded"
        />
      </Card>
    </div>
  );
}
