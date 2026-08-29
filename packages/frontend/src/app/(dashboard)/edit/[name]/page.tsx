import ServiceForm from '@/components/ServiceForm';
import PageHeader from '@/components/PageHeader';
import { ServiceManager } from '@/lib/services/ServiceManager';

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
  const nodeName = (typeof node === 'string' && node !== 'local') ? node : 'Local';

  let initialData;

  try {
    const files = await ServiceManager.getServiceFiles(nodeName, name);
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
  } catch (e) {
    const err = e as Error;
    const isConnectionError = err.message && (err.message.includes('Agent not connected') || err.message.includes('ECONNREFUSED') || err.message.includes('timeout'));

    return (
      <div className="p-8 text-center bg-surface dark:bg-surface rounded-lg border border-border dark:border-border m-8">
        <div className="text-status-fail text-xl font-bold mb-2">
            {isConnectionError ? 'Connection Failed' : 'Service Not Found'}
        </div>
        <div className="text-text-muted dark:text-text-muted mb-6 max-w-md mx-auto">
            {isConnectionError
                ? `Could not communicate with the node "${nodeName}". The agent might be restarting or the node is unreachable.`
                : (e instanceof Error ? e.message : String(e))
            }
        </div>

        {isConnectionError && (
            <div className="flex gap-4 justify-center">
                 <a
                    href={`/services?node=${nodeName}`}
                    className="px-4 py-2 bg-surface-2 hover:bg-border dark:bg-surface-2 dark:hover:bg-border rounded-lg text-sm font-medium transition-colors"
                >
                    Back to Services
                </a>
                <a
                    href={`/edit/${encodeURIComponent(name)}?node=${nodeName}`}
                    className="px-4 py-2 bg-accent hover:bg-accent-strong text-on-accent rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>
                    Retry Connection
                </a>
            </div>
        )}

        <div className="mt-8 text-xs text-text-subtle font-mono">
          Target: {name} @ {nodeName}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <PageHeader title={`Edit Service: ${name}`} showBack />
      <div className="p-6">
        {/*
          `defaultNode` is REQUIRED here, not decoration. ServiceForm seeds
          `selectedNode` from `defaultNode ?? (?node= || '')`, disables the node
          <select> whenever `isEdit`, and disables Save while `!selectedNode`.
          Omitting it on a URL without `?node=` therefore produced a form whose
          node field was empty AND locked, with Save permanently greyed out and
          no way to recover from the UI. This page already resolved `nodeName`
          (defaulting to 'Local') to read the service files — it just never
          handed it on. Same defect #2392 fixed in OperateSettingsTab; this
          entry point was missed.

          Passing the resolved value rather than letting ServiceForm default to
          'Local' on its own is deliberate: on a multi-node box a silent
          fallback would save the service to the wrong node.
        */}
        <ServiceForm initialData={initialData} isEdit defaultNode={nodeName} />
      </div>
    </div>
  );
}
