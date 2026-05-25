import ServiceMonitor from '@/components/ServiceMonitor';

export default async function ServiceDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  return <ServiceMonitor serviceName={name} />;
}
