'use client';

import { useState, useEffect } from 'react';
import { Template } from '@/lib/registry';
import { fetchReadme } from '@/app/actions';
import ReactMarkdown from 'react-markdown';
import { Download, Loader2, Github, Folder, Layers } from 'lucide-react';
import InstallerModal from './InstallerModal';

export default function RegistryBrowser({ templates }: { templates: Template[] }) {
  const [selected, setSelected] = useState<Template | null>(templates[0] || null);
  const [readme, setReadme] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    if (selected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(true);
      fetchReadme(selected.name, selected.type).then((content) => {
        setReadme(content || '# No README found');
        setLoading(false);
      });
    }
  }, [selected]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar List */}
      <div className="w-80 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 flex flex-col bg-gray-50/50 dark:bg-gray-900/50">
        <div className="overflow-y-auto flex-1 p-2 space-y-1">
            {templates.map(t => (
                <button
                    key={t.name}
                    onClick={() => setSelected(t)}
                    className={`w-full text-left px-4 py-3 rounded-md flex items-center gap-3 transition-colors ${
                        selected?.name === t.name 
                        ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700' 
                        : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                    }`}
                >
                    {t.type === 'stack' ? (
                        <Layers size={18} className={selected?.name === t.name ? 'text-purple-500 dark:text-purple-400' : 'text-purple-400 dark:text-purple-500'} />
                    ) : (
                        <Folder size={18} className={selected?.name === t.name ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'} />
                    )}
                    <span className="font-medium">{t.name}</span>
                    {t.type === 'stack' && <span className="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-2 py-0.5 rounded-full ml-auto">Stack</span>}
                </button>
            ))}
            {templates.length === 0 && (
                <div className="p-4 text-center text-gray-500 dark:text-gray-400 text-sm">
                    No templates found in registry.
                </div>
            )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 bg-white dark:bg-gray-900">
        {selected ? (
            <>
                <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center bg-white dark:bg-gray-900">
                    <h2 className="font-bold text-xl text-gray-900 dark:text-white flex items-center gap-2">
                        {selected.type === 'stack' && <Layers className="text-purple-600 dark:text-purple-400" />}
                        {selected.name}
                    </h2>
                    <button 
                        onClick={() => setIsModalOpen(true)}
                        className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors shadow-sm font-medium"
                    >
                        <Download size={18} /> Install {selected.type === 'stack' ? 'Stack' : 'Template'}
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-8">
                    {loading ? (
                        <div className="flex items-center justify-center h-full text-gray-400">
                            <Loader2 size={32} className="animate-spin" />
                        </div>
                    ) : (
                        <article className="prose prose-slate max-w-none dark:prose-invert mb-8">
                            <ReactMarkdown>{readme}</ReactMarkdown>
                        </article>
                    )}
                </div>
                
                <InstallerModal 
                    template={selected} 
                    readme={readme} 
                    isOpen={isModalOpen} 
                    onClose={() => setIsModalOpen(false)} 
                />
            </>
        ) : (
            <div className="flex items-center justify-center h-full text-gray-400">
                Select a template to view details
            </div>
        )}
      </div>
    </div>
  );
}
