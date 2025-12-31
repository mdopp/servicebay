import ServiceMonitor from '@/components/ServiceMonitor';

export default async function MonitorPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <ServiceMonitor serviceName={name} />;
}
