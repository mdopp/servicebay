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
    const isConnectionError = e.message && (e.message.includes('Agent not connected') || e.message.includes('ECONNREFUSED') || e.message.includes('timeout'));

    return (
      <div className="p-8 text-center bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 m-8">
        <div className="text-red-600 text-xl font-bold mb-2">
            {isConnectionError ? 'Connection Failed' : 'Service Not Found'}
        </div>
        <div className="text-gray-600 dark:text-gray-400 mb-6 max-w-md mx-auto">
            {isConnectionError 
                ? `Could not communicate with the node "${node || 'Local'}". The agent might be restarting or the node is unreachable.` 
                : e.message
            }
        </div>
        
        {isConnectionError && (
            <div className="flex gap-4 justify-center">
                 <a 
                    href={`/services?node=${node || 'Local'}`}
                    className="px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-800 dark:hover:bg-gray-700 rounded-lg text-sm font-medium transition-colors"
                >
                    Back to Services
                </a>
                <a 
                    href={`/edit/${encodeURIComponent(name)}?node=${node || 'Local'}`}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
                    Retry Connection
                </a>
            </div>
        )}
        
        <div className="mt-8 text-xs text-gray-400 font-mono">
          Target: {name} @ {node || 'Local'}
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
