'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Template } from '@/lib/registry';
import { fetchReadme } from '@/app/actions';
import ReactMarkdown from 'react-markdown';
import { Download, Loader2, Folder, Layers, Server, Link as LinkIcon, Shield } from 'lucide-react';
import InstallerModal from './InstallerModal';
import ExternalLinkConfig from './ExternalLinkConfig';
import ManualServiceForm from './ManualServiceForm';
import ReverseProxyConfig from './ReverseProxyConfig';

type SpecialItem = {
    id: string;
    name: string;
    description: string;
    icon: React.ReactNode;
    type: 'special';
    component?: React.ReactNode;
};

const specialItems: SpecialItem[] = [
    {
        id: 'proxy',
        name: 'Reverse Proxy',
        description: 'Nginx Proxy Manager',
        icon: <Shield size={18} className="text-green-500" />,
        type: 'special',
        component: <ReverseProxyConfig />
    },
    {
        id: 'manual',
        name: 'Manual Service',
        description: 'Create from Docker image',
        icon: <Server size={18} className="text-blue-500" />,
        type: 'special',
        component: <ManualServiceForm />
    },
    {
        id: 'link',
        name: 'External Link',
        description: 'Add shortcut to dashboard',
        icon: <LinkIcon size={18} className="text-gray-500" />,
        type: 'special',
        component: <ExternalLinkConfig />
    }
];

export default function RegistryBrowser({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<Template | SpecialItem | null>(null);
  const [readme, setReadme] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Initialize selection
  useEffect(() => {
      const paramSelected = searchParams?.get('selected');
      if (paramSelected) {
          // Avoid re-setting if already selected
          if (selected) {
              const currentId = 'id' in selected ? selected.id : selected.name;
              if (currentId === paramSelected) return;
          }

          // Check special items first
          const special = specialItems.find(i => i.id === paramSelected);
          if (special) {
              // eslint-disable-next-line react-hooks/set-state-in-effect
              setSelected(special);
              return;
          }
          // Check templates
          const tmpl = templates.find(t => t.name === paramSelected);
          if (tmpl) {
               
              setSelected(tmpl);
              return;
          }
      }

      if (!selected && templates.length > 0) {
           
          setSelected(templates[0]);
      }
  }, [templates, searchParams, selected]);

  useEffect(() => {
    if (selected && selected.type !== 'special') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(true);
      fetchReadme(selected.name, selected.type, selected.source).then((content) => {
        setReadme(content || '# No README found');
        setLoading(false);
      });
    }
  }, [selected]);

  const handleSpecialClick = (item: SpecialItem) => {
      setSelected(item);
      router.push(`${pathname}?selected=${item.id}`);
  };

  const handleTemplateClick = (t: Template) => {
      setSelected(t);
      router.push(`${pathname}?selected=${t.name}`);
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar List */}
      <div className="w-80 flex-shrink-0 border-r border-gray-200 dark:border-gray-800 flex flex-col bg-gray-50/50 dark:bg-gray-900/50">
        <div className="overflow-y-auto flex-1 p-2 space-y-1">
            
            {/* Special Items Section */}
            <div className="mb-2 pb-2 border-b border-gray-200 dark:border-gray-800">
                <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Create New</div>
                {specialItems.map(item => (
                    <button
                        key={item.id}
                        onClick={() => handleSpecialClick(item)}
                        className={`w-full text-left px-4 py-3 rounded-md flex items-center gap-3 transition-colors ${
                            selected && 'id' in selected && selected.id === item.id
                            ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700' 
                            : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                        }`}
                    >
                        {item.icon}
                        <div className="flex flex-col items-start min-w-0 flex-1">
                            <span className="font-medium truncate w-full">{item.name}</span>
                            <span className="text-xs text-gray-500 dark:text-gray-400 truncate w-full">{item.description}</span>
                        </div>
                    </button>
                ))}
            </div>

            <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Templates</div>
            {templates.map(t => (
                <button
                    key={`${t.source}-${t.name}`}
                    onClick={() => handleTemplateClick(t)}
                    className={`w-full text-left px-4 py-3 rounded-md flex items-center gap-3 transition-colors ${
                        selected && !('id' in selected) && selected.name === t.name && selected.source === t.source
                        ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700' 
                        : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                    }`}
                >
                    {t.type === 'stack' ? (
                        <Layers size={18} className={selected && !('id' in selected) && selected.name === t.name ? 'text-purple-500 dark:text-purple-400' : 'text-purple-400 dark:text-purple-500'} />
                    ) : (
                        <Folder size={18} className={selected && !('id' in selected) && selected.name === t.name ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'} />
                    )}
                    <div className="flex flex-col items-start min-w-0 flex-1">
                        <span className="font-medium truncate w-full">{t.name}</span>
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate w-full">{t.source}</span>
                    </div>
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
            'id' in selected ? (
                // Render Special Item Component
                <div className="h-full overflow-y-auto">
                    {selected.component}
                </div>
            ) : (
                // Render Template Details
                <>
                    <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center bg-white dark:bg-gray-900">
                        <div className="flex flex-col">
                            <h2 className="font-bold text-xl text-gray-900 dark:text-white flex items-center gap-2">
                                {selected.type === 'stack' && <Layers className="text-purple-600 dark:text-purple-400" />}
                                {selected.name}
                            </h2>
                            <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1">
                                Source: <span className="font-mono">{selected.source}</span>
                            </span>
                        </div>
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
            )
        ) : (
            <div className="flex items-center justify-center h-full text-gray-400">
                Select an item to view details
            </div>
        )}
      </div>
    </div>
  );
}
