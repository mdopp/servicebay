import ServiceForm from '@/components/ServiceForm';
import PageHeader from '@/components/PageHeader';
import { getServiceFiles } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';

export default async function EditPage({ 
  params, 
  searchParams 
}: { 
  params: Promise<{ name: string }>, 
  searchParams: Promise<{ [key: string]: string | string[] | undefined }> 
}) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const { node } = await searchParams;
  
  let connection;
  if (typeof node === 'string' && node !== 'local') {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === node);
  }

  let initialData;
  
  try {
    const files = await getServiceFiles(name, connection);
    const yamlFileName = files.yamlPath.split('/').pop() || 'pod.yml';
    
    initialData = {
      name,
      kubeContent: files.kubeContent,
      yamlContent: files.yamlContent,
      yamlFileName,
      serviceContent: files.serviceContent,
      kubePath: files.kubePath,
      yamlPath: files.yamlPath,
      servicePath: files.servicePath
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    return (
      <div className="p-8 text-center">
        <div className="text-red-600 text-xl font-bold mb-2">Service not found</div>
        <div className="text-gray-600 dark:text-gray-400">{e.message}</div>
        <div className="mt-4 text-sm text-gray-500">
          Attempted to load: {name} on node {node || 'Local'}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <PageHeader title={`Edit Service: ${name}`} />
      <div className="p-6">
        <ServiceForm initialData={initialData} isEdit />
      </div>
    </div>
  );
}
