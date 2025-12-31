import { getTemplates } from '@/lib/registry';
import RegistryBrowser from '@/components/RegistryBrowser';
import PageHeader from '@/components/PageHeader';

export default async function RegistryPage() {
  const templates = await getTemplates();

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-black">
      <PageHeader title="Service Registry" />
      <div className="flex-1 min-h-0 p-8 max-w-7xl mx-auto w-full">
         <RegistryBrowser templates={templates} />
      </div>
    </div>
  );
}
