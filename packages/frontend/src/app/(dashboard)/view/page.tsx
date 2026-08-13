import { readFileContent } from '@/app/actions/system';
import PageHeader from '@/components/PageHeader';
import FileViewer from '@/components/FileViewer';
import { FileText, AlertCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface ViewPageProps {
  searchParams: Promise<{
    path?: string;
    node?: string;
  }>;
}

export default async function ViewPage({ searchParams }: ViewPageProps) {
  const { path, node } = await searchParams;

  if (!path) {
    return (
      <div className="p-6">
        <div className="bg-status-fail/30 text-status-fail p-4 rounded-lg flex items-center gap-2">
          <AlertCircle size={20} />
          Missing file path
        </div>
      </div>
    );
  }

  let content = '';
  let error = null;

  try {
    content = await readFileContent(path, node);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const isMarkdown = path.endsWith('.md');
  const isYaml = path.endsWith('.yml') || path.endsWith('.yaml');
  const isService = path.endsWith('.service') || path.endsWith('.container') || path.endsWith('.kube') || path.endsWith('.network') || path.endsWith('.volume');
  
  // Determine language for Prism
  let language = 'text';
  if (isYaml) language = 'yaml';
  else if (isService) language = 'ini';
  else if (path.endsWith('.json')) language = 'json';
  else if (path.endsWith('.sh')) language = 'bash';

  return (
    // Page width comes from <PageFrame> in the dashboard layout (#2548).
    <div className="p-6">
      <PageHeader
        title="File Viewer"
        showBack
      >
        <div className="flex items-center gap-2 text-sm text-text-muted">
            <FileText size={16} />
            Viewing <code className="bg-surface-2 px-1 rounded">{path}</code> on {node || 'Local'}
        </div>
      </PageHeader>

      {error ? (
        <div className="bg-status-fail/30 text-status-fail p-4 rounded-lg flex items-center gap-2 mt-6">
          <AlertCircle size={20} />
          {error}
        </div>
      ) : (
        <div className="mt-6 bg-surface rounded-lg shadow border border-border overflow-hidden">
          {isMarkdown ? (
            <div className="p-8 prose dark:prose-invert max-w-none">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          ) : (
            <div className="relative font-mono text-sm">
               <FileViewer content={content} language={language} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
